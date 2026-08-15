import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { addServer, getServer, listServers, removeServer, setServerEnabled, updateServer, type RegistryFiles } from '../src/ops/mcp.ts'
import { CODES } from '../src/ops/report.ts'
import type { StdioServer } from '../src/registry/model.ts'

const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-install-ops-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HOME = process.env.DSH_HOME
let home: string

beforeAll(() => {
  home = tmp()
  process.env.DSH_HOME = home
})

afterAll(() => {
  // Restore the harness session's own DSH_HOME, if it had one.
  if (HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = HOME
})

afterEach(() => {
  // Each spec starts from an empty user registry; keep the env pointed at the
  // per-run home so dsh-home-paths resolves the fixture, not the real one.
  rmSync(join(home, 'mcp.json'), { force: true })
  rmSync(join(home, 'logs'), { recursive: true, force: true })
})

describe('ops.mcp', () => {
  const origin = { source: 'test', addedAt: '2026-08-20T00:00:00.000Z' }
  const stdio = { transport: 'stdio', command: 'npx', args: ['-y', 'server-x'] }

  function files(projectDir?: string): RegistryFiles {
    return { user: join(home, 'mcp.json'), project: projectDir === undefined ? undefined : join(projectDir, '.dsh', 'mcp.json') }
  }

  function projectDir(): string {
    const dir = tmp()
    mkdirSync(join(dir, '.git'))
    return dir
  }

  it('add/list/get round-trip in user scope', () => {
    const f = files()
    const added = addServer(f, 'user', 'github', stdio, origin)
    expect(added.summary).toMatchObject({ imported: 1, failed: 0 })
    expect(added.verdicts[0]).toMatchObject({ kind: 'imported', code: CODES.IMPORTED })

    const listed = listServers(f)
    expect(listed.servers.github).toMatchObject({ scope: 'user', shadowed: false })
    expect((listed.servers.github!.entry as StdioServer).command).toBe('npx')

    const got = getServer(f, 'github')
    expect(got.server).toBeDefined()
    expect(got.report.summary.failed).toBe(0)
  })

  it('persists to disk and reads back', () => {
    const f = files()
    addServer(f, 'user', 'github', stdio, origin)
    const onDisk = JSON.parse(readFileSync(f.user, 'utf8'))
    expect(onDisk.version).toBe(1)
    expect(onDisk.servers.github.transport).toBe('stdio')
  })

  it('rejects same-scope duplicates without overwriting', () => {
    const f = files()
    addServer(f, 'user', 'github', stdio, origin)
    const again = addServer(f, 'user', 'github', { transport: 'stdio', command: 'other' }, origin)
    expect(again.verdicts[0]).toMatchObject({ kind: 'failed', code: CODES.DUPLICATE_SERVER })
    expect((getServer(f, 'github').server!.entry as StdioServer).command).toBe('npx')
  })

  it('rejects invalid names and entries with verdicts, not throws', () => {
    const f = files()
    expect(addServer(f, 'user', 'bad name!', stdio, origin).verdicts[0]).toMatchObject({ code: CODES.INVALID_NAME })
    expect(addServer(f, 'user', 'x', { transport: 'stdio' }, origin).verdicts[0]).toMatchObject({ code: CODES.INVALID_ENTRY })
  })

  it('project scope shadows user scope, and a later user add reports the conflict', () => {
    const dir = projectDir()
    const f = files(dir)
    addServer(f, 'user', 'gh', stdio, origin)
    const projectAdd = addServer(f, 'project', 'gh', { transport: 'stdio', command: 'project-npx' }, origin)
    expect(projectAdd.verdicts[0]).toMatchObject({ kind: 'imported' })
    expect(listServers(f).servers.gh).toMatchObject({ scope: 'project', shadowed: true })

    // The reverse order: a user-scope add while a project entry already wins.
    addServer(f, 'project', 'other', stdio, origin)
    const userAdd = addServer(f, 'user', 'other', stdio, origin)
    expect(userAdd.verdicts[0]).toMatchObject({ kind: 'partial', code: CODES.CONFLICT_EXISTING })
    expect(userAdd.verdicts[0]!.message).toContain('project-scope entry shadows it')
  })

  it('remove deletes only the target scope entry', () => {
    const dir = projectDir()
    const f = files(dir)
    addServer(f, 'user', 'gh', stdio, origin)
    addServer(f, 'project', 'gh', { transport: 'stdio', command: 'project-npx' }, origin)
    removeServer(f, 'project', 'gh')
    expect(listServers(f).servers.gh).toMatchObject({ scope: 'user', shadowed: false })
  })

  it('on/off toggles enabled and is idempotent', () => {
    const f = files()
    addServer(f, 'user', 'gh', stdio, origin)
    const off = setServerEnabled(f, 'user', 'gh', false)
    expect(off.verdicts[0]).toMatchObject({ kind: 'imported' })
    expect(getServer(f, 'gh').server?.entry.enabled).toBe(false)
    const offAgain = setServerEnabled(f, 'user', 'gh', false)
    expect(offAgain.verdicts[0]!.message).toContain('already')
    setServerEnabled(f, 'user', 'gh', true)
    expect(getServer(f, 'gh').server?.entry.enabled).toBe(true)
  })

  it('update replaces config and preserves origin; missing target fails', () => {
    const f = files()
    const updated = updateServer(f, 'user', 'nope', stdio)
    expect(updated.verdicts[0]).toMatchObject({ code: CODES.NOT_FOUND })

    addServer(f, 'user', 'gh', stdio, origin)
    const result = updateServer(f, 'user', 'gh', { transport: 'streamable-http', url: 'http://localhost:3000/mcp' })
    expect(result.summary.imported).toBe(1)
    const entry = getServer(f, 'gh').server!.entry
    expect(entry.transport).toBe('streamable-http')
    expect(entry.origin).toEqual(origin)
  })

  it('appends an audit report for every mutating operation', () => {
    const f = files()
    addServer(f, 'user', 'gh', stdio, origin)
    setServerEnabled(f, 'user', 'gh', false)
    removeServer(f, 'user', 'gh')
    const log = readFileSync(join(home, 'logs', 'install.jsonl'), 'utf8').trim().split('\n')
    expect(log.length).toBe(3)
    for (const line of log) {
      const record = JSON.parse(line)
      expect(record.action).toMatch(/^mcp (add|on|off|remove)/)
      expect(record.id).toBeTruthy()
    }
  })

  it('reports corrupt registry files instead of silently emptying', () => {
    const f = files()
    writeFileSync(f.user, '{ broken', 'utf8')
    expect(() => listServers(f)).toThrowError(expect.objectContaining({ code: 'INVALID_REGISTRY_FILE' }))
  })
})
