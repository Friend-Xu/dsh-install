/**
 * Spawn-dependent e2e: mounts the REAL `mcp-registry` row over the REAL
 * `@deepseek-ai/dsh-mcp-client` against REAL stdio subprocesses —
 * (a) a local fixture server (deterministic), (b) `npx server-everything`
 * (the real npm-download path, no API key needed).
 *
 * Runs ONLY via `vitest run --config vitest.e2e.config.mjs` in an
 * environment that allows spawning piped child processes; the default
 * sandboxed suite excludes this directory.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as registryPlugin from '../src/index.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
const fixtureServer = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))
let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-stdio-e2e-'))
  process.env.DSH_HOME = home
}, 30_000)

afterAll(async () => {
  rmSync(home, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_HOME
})

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(registryPlugin, { watch: false })
  return ctx
}

describe('stdio MCP mount (spawn-dependent)', () => {
  it('discovers and executes tools from a local stdio fixture server', async () => {
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({
      version: 1,
      servers: {
        fx: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureServer],
          env: {},
          cwd: packageDir,
          toolCallTimeoutMs: 15_000,
          enabled: true,
          origin: { source: 'e2e', addedAt: new Date().toISOString() },
        },
      },
    }), 'utf8')
    const ctx = await mountRegistry()

    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('mcp__fx__echo')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('stdio-1'),
      name: 'mcp__fx__echo',
      arguments: { message: 'hello stdio' },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo: hello stdio' })
    await ctx.fiber.dispose()
  }, 60_000)

  it('mounts the official everything server through a real npx download', async () => {
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({
      version: 1,
      servers: {
        everything: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything'],
          env: {},
          cwd: '',
          toolCallTimeoutMs: 60_000,
          enabled: true,
          origin: { source: 'e2e', addedAt: new Date().toISOString() },
        },
      },
    }), 'utf8')
    const ctx = await mountRegistry()

    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names.some(name => name.startsWith('mcp__everything__'))).toBe(true)
    await ctx.fiber.dispose()
  }, 180_000)
})
