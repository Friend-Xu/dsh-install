/**
 * Aggregator orchestration tests: registry projection, diffing, live
 * remount, failure isolation, corrupt-registry resilience, and lifecycle —
 * all against a fake child plugin, so no real MCP servers spawn here.
 * The real protocol path is covered by aggregator.e2e.ts.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { diffMounts, projectConfig, startAggregator, type ChildPlugin, type DesiredMount } from '../src/aggregator.ts'
import type { RegistryFiles } from '../src/ops/mcp.ts'
import { normalizeServer, type ServerEntry, type ServerOrigin } from '../src/registry/model.ts'

const ORIGIN: ServerOrigin = { source: 'test', addedAt: '2026-08-20T00:00:00.000Z' }
const ENV = { TOKEN: 'expanded-token' }

function entry(overrides: Partial<Record<string, unknown>> = {}): ServerEntry {
  return normalizeServer({ transport: 'stdio', command: 'npx', args: ['-y', 'server-x'], ...overrides }, ORIGIN)
}

describe('projectConfig', () => {
  it('projects stdio entries, expanding env and stripping registry extras', () => {
    const projected = projectConfig('gh', 'user', entry({ env: { GITHUB_TOKEN: '${TOKEN}' } }), ENV)
    expect(projected.config).toMatchObject({
      transport: 'stdio',
      serverName: 'gh',
      command: 'npx',
      env: { GITHUB_TOKEN: 'expanded-token' },
    })
    expect(projected.config).not.toHaveProperty('enabled')
    expect(projected.config).not.toHaveProperty('origin')
    expect(projected.missingEnv).toEqual([])
  })

  it('flags missing env vars and omits their keys', () => {
    const projected = projectConfig('gh', 'user', entry({ env: { A: '${GONE}', B: 'literal' } }), ENV)
    expect(projected.missingEnv).toEqual(['GONE'])
    expect(projected.config).toMatchObject({ env: { B: 'literal' } })
  })

  it('projects streamable-http entries with embedded header templates', () => {
    const httpEntry = normalizeServer({
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    }, ORIGIN)
    const projected = projectConfig('web', 'project', httpEntry, ENV)
    expect(projected.config).toMatchObject({ transport: 'streamable-http', headers: { Authorization: 'Bearer expanded-token' } })
  })

  it('bakes scope into the config identity', () => {
    const user = projectConfig('gh', 'user', entry(), ENV)
    const project = projectConfig('gh', 'project', entry(), ENV)
    expect(user.id).not.toBe(project.id)
  })
})

describe('diffMounts', () => {
  const record = (name: string, configId: string): { name: string; configId: string } => ({ name, configId })
  const desired = (name: string, configId: string): DesiredMount => ({
    name, source: 'user', configId, missingEnv: [],
    config: { transport: 'stdio', serverName: name, command: 'x', args: [], env: {}, cwd: '', toolCallTimeoutMs: 60_000, failOnStartupError: false },
  })

  it('keeps identical, remounts changed, unmounts removed, mounts new', () => {
    const previous = new Map<string, { name: string; configId: string }>([
      ['keep', record('keep', 'id-1')],
      ['change', record('change', 'old')],
      ['gone', record('gone', 'id-3')],
    ]) as unknown as Parameters<typeof diffMounts>[0]
    const next = new Map<string, DesiredMount>([
      ['keep', desired('keep', 'id-1')],
      ['change', desired('change', 'new')],
      ['fresh', desired('fresh', 'id-4')],
    ])
    const diff = diffMounts(previous, next)
    expect(diff.unmount.sort()).toEqual(['change', 'gone'])
    expect(diff.mount.map(item => item.name).sort()).toEqual(['change', 'fresh'])
  })
})

describe('startAggregator', () => {
  let dir: string
  let files: RegistryFiles
  let ctx: Context
  const logs: Array<{ level: string; message: string }> = []
  const mounted: Array<{ name: string; config: McpClientConfig }> = []
  const disposed: string[] = []
  let throwFor: string | undefined

  const fakeChild: ChildPlugin = {
    name: 'fake-mcp-client',
    inject: ['tools'],
    apply(_ctx: Context, config: McpClientConfig) {
      if (throwFor !== undefined && config.serverName === throwFor) {
        throw new Error(`fake failure for ${config.serverName}`)
      }
      mounted.push({ name: config.serverName, config })
      const mine = config.serverName
      // ctx.effect runs its callback immediately and its RETURN VALUE at
      // disposal — record unmounts in the returned disposer, not the body.
      _ctx.effect(() => () => { disposed.push(mine) }, `fake.${mine}`)
    },
  }

  function registryOnDisk(servers: Record<string, ServerEntry>): void {
    writeFileSync(files.user, JSON.stringify({ version: 1, servers }, null, 2), 'utf8')
  }

  async function eventually(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`timed out waiting for: ${what}`)
  }

  beforeEach(() => {
    dir = join(tmpdir(), `dsh-aggregator-${process.pid}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    files = { user: join(dir, 'mcp.json'), project: join(dir, '.dsh', 'mcp.json') }
    ctx = new Context()
    ctx.provide('tools', {})
    logs.length = 0
    mounted.length = 0
    disposed.length = 0
    throwFor = undefined
  })

  afterEach(async () => {
    await ctx.fiber.dispose().catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  it('mounts enabled servers and skips disabled ones', async () => {
    registryOnDisk({
      a: entry(),
      b: { ...entry(), enabled: false },
    })
    const handle = startAggregator({ ctx, files, childPlugin: fakeChild, watch: false, env: ENV, log: (level, message) => { logs.push({ level, message }) } })
    await handle.sync()
    expect(handle.mounts().size).toBe(1)
    expect(handle.mounts().get('a')?.source).toBe('user')
    expect(mounted.map(item => item.name)).toEqual(['a'])
    await handle.dispose()
  })

  it('diff-remounts: unchanged fibers stay, changed ones are replaced', async () => {
    registryOnDisk({ a: entry({ args: ['v1'] }), b: entry() })
    const handle = startAggregator({ ctx, files, childPlugin: fakeChild, watch: false, log: (level, message) => { logs.push({ level, message }) } })
    await handle.sync()
    const aFiber = handle.mounts().get('a')!.fiber
    const bFiber = handle.mounts().get('b')!.fiber

    registryOnDisk({ a: entry({ args: ['v2'] }), b: entry() })
    await handle.sync()

    expect(handle.mounts().get('a')!.fiber).not.toBe(aFiber)
    expect(handle.mounts().get('b')!.fiber).toBe(bFiber)
    expect(disposed).toContain('a')
    expect(disposed).not.toContain('b')
    await handle.dispose()
  })

  it('watches the registry file and remounts without an explicit sync', async () => {
    registryOnDisk({ a: entry() })
    const handle = startAggregator({ ctx, files, childPlugin: fakeChild, watch: true, watchIntervalMs: 50, log: (level, message) => { logs.push({ level, message }) } })
    await handle.sync()
    expect(handle.mounts().size).toBe(1)

    registryOnDisk({ a: entry(), b: entry() })
    await eventually(() => handle.mounts().size === 2, 'watch-driven remount')
    expect(mounted.map(item => item.name).sort()).toEqual(['a', 'b'])
    await handle.dispose()
  })

  it('isolates a failing child: others stay mounted, and a later fix retries', async () => {
    registryOnDisk({ good: entry(), bad: entry() })
    throwFor = 'bad'
    const handle = startAggregator({ ctx, files, childPlugin: fakeChild, watch: false, log: (level, message) => { logs.push({ level, message }) } })
    await handle.sync()
    expect(handle.mounts().size).toBe(1)
    expect(handle.mounts().get('good')).toBeDefined()
    expect(logs.some(item => item.level === 'error' && item.message.includes('bad'))).toBe(true)

    throwFor = undefined
    registryOnDisk({ good: entry(), bad: entry({ command: 'fixed' }) })
    await handle.sync()
    expect(handle.mounts().size).toBe(2)
    await handle.dispose()
  })

  it('keeps current mounts on a corrupt registry and recovers on the next good read', async () => {
    registryOnDisk({ a: entry() })
    const handle = startAggregator({ ctx, files, childPlugin: fakeChild, watch: false, log: (level, message) => { logs.push({ level, message }) } })
    await handle.sync()
    expect(handle.mounts().size).toBe(1)

    writeFileSync(files.user, '{ not json', 'utf8')
    await handle.sync()
    expect(handle.mounts().size).toBe(1)
    expect(handle.lastError()).toBeDefined()
    expect(logs.some(item => item.message.includes('keeping'))).toBe(true)

    registryOnDisk({ a: entry(), b: entry() })
    await handle.sync()
    expect(handle.mounts().size).toBe(2)
    expect(handle.lastError()).toBeUndefined()
    await handle.dispose()
  })

  it('prefers the project entry when both scopes define the same name', async () => {
    registryOnDisk({ gh: entry({ command: 'user-npx' }) })
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(files.project!, JSON.stringify({
      version: 1,
      servers: { gh: { ...entry({ command: 'project-npx' }) } },
    }), 'utf8')
    const handle = startAggregator({ ctx, files, childPlugin: fakeChild, watch: false, log: (level, message) => { logs.push({ level, message }) } })
    await handle.sync()
    const record = handle.mounts().get('gh')!
    expect(record.source).toBe('project')
    expect((mounted.find(item => item.name === 'gh')!.config as Extract<McpClientConfig, { transport: 'stdio' }>).command).toBe('project-npx')
    await handle.dispose()
  })

  it('dispose unmounts everything and stops watching', async () => {
    registryOnDisk({ a: entry(), b: entry() })
    const handle = startAggregator({ ctx, files, childPlugin: fakeChild, watch: true, watchIntervalMs: 50, log: (level, message) => { logs.push({ level, message }) } })
    await handle.sync()
    expect(handle.mounts().size).toBe(2)
    await handle.dispose()
    expect(handle.mounts().size).toBe(0)
    expect(disposed.sort()).toEqual(['a', 'b'])

    registryOnDisk({ c: entry() })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(handle.mounts().size).toBe(0)
  })
})
