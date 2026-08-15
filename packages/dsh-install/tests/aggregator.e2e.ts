/**
 * Real-protocol e2e for the aggregator: a keyless in-process MCP server over
 * Streamable HTTP, mounted through the REAL `mcp-registry` row plugin and the
 * REAL `@deepseek-ai/dsh-mcp-client`, with tool discovery and a call round
 * trip through the real `ctx.tools` registry. No subprocess spawns — the
 * server lives in-process, so this suite also runs inside sandboxed CI.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as registryPlugin from '../src/index.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
let home: string
let httpServer: Server
let baseUrl: string
const seenAuth: Array<string | undefined> = []
let ctx: Context
let rootCtx: Context

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  seenAuth.push(req.headers.authorization)
  const server = new McpServer(
    { name: 'aggregator-e2e', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.registerTool('ping', {
    description: 'Replies pong.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }))
  server.registerTool('shout', {
    description: 'Upper-cases a message.',
    inputSchema: { message: z.string().describe('Message to upper-case') },
  }, async args => ({
    content: [{ type: 'text', text: String(args.message).toUpperCase() }],
  }))
  const transport = new StreamableHTTPServerTransport({})
  res.on('close', () => { void transport.close(); void server.close() })
  await server.connect(transport as Transport)
  await transport.handleRequest(req, res)
}

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    handleMcpRequest(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  httpServer.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error(`expected a TCP AddressInfo, got ${String(address)}`)
  baseUrl = `http://127.0.0.1:${address.port}/mcp`

  home = mkdtempSync(join(tmpdir(), 'dsh-aggregator-e2e-'))
  process.env.DSH_HOME = home
}, 30_000)

afterAll(async () => {
  await ctx?.fiber.dispose().catch(() => undefined)
  await rootCtx?.fiber.dispose().catch(() => undefined)
  const closed: PromiseWithResolvers<void> = Promise.withResolvers()
  httpServer.close(() => { closed.resolve() })
  await closed.promise
  rmSync(home, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_HOME
})

afterEach(async () => {
  await ctx?.fiber.dispose().catch(() => undefined)
  ctx = undefined as unknown as Context
})

describe('mcp-registry row (real MCP, in-process HTTP server)', () => {
  it('discovers tools, executes a call, and expands env-referenced headers', async () => {
    const token = 'e2e-test-token'
    process.env.AGG_TOKEN = token
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({
      version: 1,
      servers: {
        web: {
          transport: 'streamable-http',
          url: baseUrl,
          headers: { Authorization: 'Bearer ${AGG_TOKEN}' },
          toolCallTimeoutMs: 15_000,
          enabled: true,
          origin: { source: 'e2e', addedAt: new Date().toISOString() },
        },
      },
    }), 'utf8')

    rootCtx = new Context()
    await rootCtx.plugin(SystemPrompt)
    await rootCtx.plugin(ToolRuntime)
    const row = await rootCtx.plugin(registryPlugin, { watch: false })
    ctx = rootCtx
    void row

    const names = rootCtx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('mcp__web__ping')
    expect(names).toContain('mcp__web__shout')

    const result = await rootCtx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('e2e-1'),
      name: 'mcp__web__ping',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'pong' })
    expect(seenAuth).toContain(`Bearer ${token}`)
    delete process.env.AGG_TOKEN
  }, 30_000)

  it('skips disabled servers entirely', async () => {
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({
      version: 1,
      servers: {
        web: {
          transport: 'streamable-http',
          url: baseUrl,
          headers: {},
          toolCallTimeoutMs: 15_000,
          enabled: false,
          origin: { source: 'e2e', addedAt: new Date().toISOString() },
        },
      },
    }), 'utf8')

    rootCtx = new Context()
    await rootCtx.plugin(SystemPrompt)
    await rootCtx.plugin(ToolRuntime)
    await rootCtx.plugin(registryPlugin, { watch: false })
    ctx = rootCtx

    const names = rootCtx.tools.schemas().map(schema => schema.name)
    expect(names.some(name => name.startsWith('mcp__web__'))).toBe(false)
  }, 30_000)
})
