/**
 * Importer parser tests: .mcp.json, ~/.claude.json, config.toml, and the
 * claude-plugin manifest — with fixtures covering both shapes.
 */
import { describe, expect, it } from 'vitest'
import { fromClaudeJson, fromCodexToml, fromMcpJson, parseClaudePluginManifest } from '../src/import/importers.ts'

describe('fromMcpJson', () => {
  it('extracts stdio and http servers', () => {
    const servers = fromMcpJson(JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
        web: { type: 'http', url: 'http://localhost:3000/mcp', headers: { Authorization: 'Bearer ${T}' } },
      },
    }), 'test')
    expect(servers).toHaveLength(2)
    expect(servers[0]).toMatchObject({ name: 'github', input: { transport: 'stdio', command: 'npx' } })
    expect(servers[1]).toMatchObject({ name: 'web', input: { transport: 'streamable-http', url: 'http://localhost:3000/mcp' } })
  })

  it('rejects malformed documents loudly', () => {
    expect(() => fromMcpJson('nope', 'test')).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY' }))
    expect(() => fromMcpJson('{"mcpServers": []}', 'test')).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY' }))
  })
})

describe('fromClaudeJson', () => {
  it('extracts user and local scopes', () => {
    const { servers, localServers } = fromClaudeJson(JSON.stringify({
      mcpServers: { a: { command: 'npx', args: [] } },
      localMcpServers: { b: { command: 'uvx', args: ['mcp-server-git'] } },
    }), 'test')
    expect(servers.map(server => server.name)).toEqual(['a'])
    expect(localServers.map(server => server.name)).toEqual(['b'])
  })

  it('tolerates missing scopes', () => {
    const { servers, localServers } = fromClaudeJson('{}', 'test')
    expect(servers).toEqual([])
    expect(localServers).toEqual([])
  })
})

describe('fromCodexToml', () => {
  it('extracts mcp_servers sections with args and env', () => {
    const content = [
      '# comment',
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      'env = { GITHUB_TOKEN = "${GITHUB_TOKEN}" }',
      '',
      '[model]',
      'provider = "openai"',
    ].join('\n')
    const servers = fromCodexToml(content, 'test')
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({
      name: 'github',
      input: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
    })
  })

  it('skips command-less sections', () => {
    expect(fromCodexToml('[mcp_servers.a]\n', 'test')).toEqual([])
    expect(fromCodexToml('[mcp_servers.a]\nargs = ["x"]\n', 'test')).toEqual([])
  })
})

describe('parseClaudePluginManifest', () => {
  it('classifies all six payload kinds and reads the manifest name', () => {
    const payloads = parseClaudePluginManifest(JSON.stringify({
      name: 'superpowers',
      skills: ['skill-a', 'skill-b'],
      mcpServers: { gh: { command: 'npx', args: ['-y', 'x'] } },
      commands: ['./commands/review.md'],
      agents: ['./agents/qa.md'],
      hooks: ['./hooks/on-session-start.md'],
    }))
    expect(payloads.name).toBe('superpowers')
    expect(payloads.skills).toEqual(['skill-a', 'skill-b'])
    expect(payloads.mcpServers.gh).toMatchObject({ transport: 'stdio' })
    expect(payloads.commands).toEqual(['./commands/review.md'])
    expect(payloads.agents).toEqual(['./agents/qa.md'])
    expect(payloads.hooks).toEqual(['./hooks/on-session-start.md'])
  })

  it('falls back to the provided name and tolerates an empty manifest', () => {
    expect(parseClaudePluginManifest('{}', 'fallback-name').name).toBe('fallback-name')
    expect(parseClaudePluginManifest('{}')).toEqual({ name: 'plugin', skills: [], mcpServers: {}, commands: [], agents: [], hooks: [] })
  })
})
