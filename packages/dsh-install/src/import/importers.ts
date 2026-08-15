/**
 * Ecosystem importers: translate existing agent configs into registry
 * entries. Parsers are defensive and loud: unsupported shapes produce
 * INCOMPATIBLE_* verdicts instead of silent drops.
 *
 * - `.mcp.json` (Cursor/VS Code/Smithery output; also Claude Code project scope)
 * - `~/.claude.json` (Claude Code user/local scopes)
 * - `~/.codex/config.toml` `[mcp_servers.*]` sections (Codex)
 * - claude-plugin packages (`.claude-plugin/plugin.json`): skills and
 *   mcpServers extract as content; commands/agents/hooks report as
 *   incompatible and archive into `.dsh/install/leftover/`.
 * @module dsh-install/import/importers
 */

import { readFileSync } from 'node:fs'
import { RegistryError } from '../util/errors.ts'
import type { RawServerInput } from '../registry/model.ts'

/** One extracted server entry, before registry write. */
export interface ImportedServer {
  name: string
  input: RawServerInput
}

/**
 * Parse an `.mcp.json`-shaped document.
 * @param content - raw JSON text.
 * @param originLabel - provenance label for the report.
 * @returns extracted servers.
 */
export function fromMcpJson(content: string, originLabel: string): ImportedServer[] {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new RegistryError('INVALID_ENTRY', `${originLabel}: not valid JSON: ${String(error)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryError('INVALID_ENTRY', `${originLabel}: expected a JSON object with "mcpServers"`)
  }
  const doc = raw as Record<string, unknown>
  const servers = doc.mcpServers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new RegistryError('INVALID_ENTRY', `${originLabel}: "mcpServers" must be an object keyed by server name`)
  }
  return Object.entries(servers as Record<string, unknown>).map(([name, value]) => ({
    name,
    input: serverFromMcpConfig(name, value, originLabel),
  }))
}

/** Parse one `.mcp.json` server entry (also the `~/.claude.json` shape). */
function serverFromMcpConfig(name: string, value: unknown, originLabel: string): RawServerInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RegistryError('INVALID_ENTRY', `${originLabel}: server ${JSON.stringify(name)} must be an object`)
  }
  const record = value as Record<string, unknown>
  const type = record.type
  if (type === 'sse' || type === 'http' || type === 'streamableHttp' || type === 'streamable-http') {
    const url = record.url
    if (typeof url !== 'string' || url === '') {
      throw new RegistryError('INVALID_ENTRY', `${originLabel}: server ${JSON.stringify(name)} has http type but no url`)
    }
    return {
      transport: 'streamable-http',
      url,
      ...record.headers !== undefined && typeof record.headers === 'object' && record.headers !== null
        ? { headers: record.headers as Record<string, string> }
        : {},
    }
  }
  if (typeof record.command !== 'string' || record.command === '') {
    throw new RegistryError('INVALID_ENTRY', `${originLabel}: server ${JSON.stringify(name)} has no command (stdio) or url (http)`)
  }
  return {
    transport: 'stdio',
    command: record.command,
    ...Array.isArray(record.args) && record.args.every(item => typeof item === 'string')
      ? { args: record.args as string[] }
      : {},
    ...record.env !== undefined && typeof record.env === 'object' && record.env !== null
      ? { env: record.env as Record<string, string> }
      : {},
  }
}

/**
 * Parse a `~/.claude.json`-shaped document: pick out `mcpServers` from the
 * user and local scopes.
 * @param content - raw JSON text.
 * @param originLabel - provenance label.
 * @returns extracted servers (project-scope sections are skipped with a note in the caller).
 */
export function fromClaudeJson(content: string, originLabel: string): { servers: ImportedServer[]; localServers: ImportedServer[] } {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new RegistryError('INVALID_ENTRY', `${originLabel}: not valid JSON: ${String(error)}`)
  }
  const doc = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const user = doc.mcpServers
  const local = doc.localMcpServers ?? (typeof doc.local === 'object' && doc.local !== null
    ? (doc.local as Record<string, unknown>).mcpServers
    : undefined)
  const parse = (value: unknown): ImportedServer[] => {
    if (value === undefined) return []
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RegistryError('INVALID_ENTRY', `${originLabel}: mcpServers must be an object keyed by server name`)
    }
    return Object.entries(value as Record<string, unknown>).map(([name, entry]) => ({
      name,
      input: serverFromMcpConfig(name, entry, originLabel),
    }))
  }
  return { servers: parse(user), localServers: parse(local) }
}

/**
 * Extract `[mcp_servers.*]` sections from a Codex `config.toml`. A focused
 * line-based extractor: it understands the exact section shape Codex writes
 * (`command`, `args = [...]`, `env = {...}`), not general TOML.
 * @param content - raw TOML text.
 * @param originLabel - provenance label.
 * @returns extracted servers.
 */
export function fromCodexToml(content: string, originLabel: string): ImportedServer[] {
  const servers: ImportedServer[] = []
  let current: { name: string; input: RawServerInput & { command?: string } } | undefined
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const section = /^\[mcp_servers\.([^\]]+)\]$/.exec(line)
    if (section !== null) {
      current = { name: section[1]!.trim(), input: { transport: 'stdio', command: '', args: [], env: {} } }
      servers.push(current as ImportedServer)
      continue
    }
    if (current === undefined) continue
    const command = /^command\s*=\s*"([^"]*)"\s*$/.exec(line)
    if (command !== null) {
      (current.input as RawServerInput & { command?: string }).command = command[1]!
      continue
    }
    const args = /^args\s*=\s*\[(.*)\]$/.exec(line)
    if (args !== null) {
      const parsed = parseTomlStringList(args[1]!)
      if (parsed !== undefined) current.input.args = parsed
      continue
    }
    const env = /^env\s*=\s*\{(.*)\}$/.exec(line)
    if (env !== null) {
      const parsed = parseTomlStringMap(env[1]!)
      if (parsed !== undefined) current.input.env = parsed
      continue
    }
  }
  const result = servers.filter(server => (server.input as RawServerInput & { command?: string }).command !== '')
    .map(server => {
      const input = server.input as RawServerInput & { command?: string }
      return {
        name: server.name,
        input: { transport: 'stdio' as const, command: input.command!, args: input.args, env: input.env },
      }
    })
  return result
}

/** Parse a `["a", "b"]` list of double-quoted strings (no escapes beyond \\\" \n \t). */
function parseTomlStringList(body: string): string[] | undefined {
  const items = body.split(',').map(item => item.trim()).filter(item => item !== '')
  const output: string[] = []
  for (const item of items) {
    const match = /^"((?:\\.|[^"\\])*)"$/.exec(item)
    if (match === null) return undefined
    output.push(unescapeToml(match[1]!))
  }
  return output
}

/** Parse a `{ A = "x", B = "y" }` map of double-quoted strings. */
function parseTomlStringMap(body: string): Record<string, string> | undefined {
  const output: Record<string, string> = {}
  const pairs = splitTopLevel(body, ',')
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq === -1) return undefined
    const key = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    const match = /^"((?:\\.|[^"\\])*)"$/.exec(value)
    if (match === null) return undefined
    output[key] = unescapeToml(match[1]!)
  }
  return output
}

function splitTopLevel(body: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === separator && depth === 0) {
      parts.push(body.slice(start, index))
      start = index + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

function unescapeToml(value: string): string {
  return value.replace(/\\(["\\nt])/g, (_, char: string) => {
    if (char === 'n') return '\n'
    if (char === 't') return '\t'
    return char
  })
}

/** The claude-plugin manifest payloads, after extraction. */
export interface ClaudePluginPayloads {
  /** Manifest `name` (fallback: the source directory basename). */
  name: string
  /** Skills found under `skills/` or declared `skills` entries. */
  skills: string[]
  /** mcpServers declared in the manifest. */
  mcpServers: Record<string, RawServerInput>
  /** Command file paths declared (no DSH runtime). */
  commands: string[]
  /** Agent definitions declared (no DSH runtime). */
  agents: string[]
  /** Hook definitions declared (different event shape). */
  hooks: string[]
}

/**
 * Parse a claude-plugin manifest (`.claude-plugin/plugin.json`).
 * @param content - raw manifest JSON.
 * @param fallbackName - name used when the manifest declares none.
 * @returns the classified payloads.
 */
export function parseClaudePluginManifest(content: string, fallbackName = 'plugin'): ClaudePluginPayloads {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new RegistryError('INVALID_ENTRY', `claude-plugin manifest is not valid JSON: ${String(error)}`)
  }
  const doc = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : fallbackName
  const skills = Array.isArray(doc.skills)
    ? (doc.skills as unknown[]).map(item => typeof item === 'string' ? item : String(item))
    : []
  const mcpServers: Record<string, RawServerInput> = {}
  if (typeof doc.mcpServers === 'object' && doc.mcpServers !== null && !Array.isArray(doc.mcpServers)) {
    for (const [nameKey, value] of Object.entries(doc.mcpServers as Record<string, unknown>)) {
      mcpServers[nameKey] = serverFromMcpConfig(nameKey, value, 'claude-plugin')
    }
  }
  const commands = Array.isArray(doc.commands) ? (doc.commands as unknown[]).map(item => String(item)) : []
  const agents = Array.isArray(doc.agents) ? (doc.agents as unknown[]).map(item => String(item)) : []
  const hooks = Array.isArray(doc.hooks) ? (doc.hooks as unknown[]).map(item => String(item)) : []
  return { name, skills, mcpServers, commands, agents, hooks }
}
