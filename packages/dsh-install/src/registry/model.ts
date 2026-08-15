/**
 * Registry document model: types, validation, and normalization. Validation
 * is hand-rolled and dependency-free so the CLI, slash adapter, and
 * aggregator share one authority for what a well-formed entry is. Failures
 * are `RegistryError` with stable codes — never silent coercion.
 * @module dsh-install/registry/model
 */

import { parseEnvValue } from './envref.ts'
import { RegistryError } from '../util/errors.ts'

/** Registry document version this package writes and reads. */
export const REGISTRY_VERSION = 1 as const

/** Valid server namespace names, identical to the mcp-client contract. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Default per-tool-call timeout in milliseconds (matches mcp-client). */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Where an installed entry came from, kept for audit and `list -v`. */
export interface ServerOrigin {
  /** Free-form source label: `cli`, `slash:web`, `marketplace:<name>`, `import:claude`, ... */
  source: string
  /** ISO timestamp of installation. */
  addedAt: string
}

/** One stdio server entry: a spawned child process over MCP stdio transport. */
export interface StdioServer {
  transport: 'stdio'
  /** Executable used to start the server. */
  command: string
  /** Arguments passed directly, without shell interpolation. */
  args: string[]
  /** Extra env vars: literal strings or full-string `${VAR}` templates. */
  env: Record<string, string>
  /** Working directory for the child process. */
  cwd: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Whether the aggregator mounts this server. */
  enabled: boolean
  /** Install provenance. */
  origin: ServerOrigin
}

/** One Streamable HTTP server entry. */
export interface HttpServer {
  transport: 'streamable-http'
  /** MCP endpoint URL. */
  url: string
  /** Extra request headers: literal strings or full-string `${VAR}` templates. */
  headers: Record<string, string>
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs: number
  /** Whether the aggregator mounts this server. */
  enabled: boolean
  /** Install provenance. */
  origin: ServerOrigin
}

/** Configuration for one installed MCP server. */
export type ServerEntry = StdioServer | HttpServer

/** The registry document persisted in `mcp.json` files. */
export interface McpRegistry {
  version: typeof REGISTRY_VERSION
  servers: Record<string, ServerEntry>
}

/** Raw server input before validation and default-filling. */
export interface RawServerInput {
  transport: string
  command?: string
  args?: unknown
  env?: unknown
  cwd?: string
  url?: string
  headers?: unknown
  toolCallTimeoutMs?: unknown
  enabled?: unknown
}

/** An empty registry document. */
export function emptyRegistry(): McpRegistry {
  return { version: REGISTRY_VERSION, servers: {} }
}

/** Validate a server namespace name. */
export function assertServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new RegistryError(
      'INVALID_NAME',
      `server name ${JSON.stringify(name)} is invalid — must match ${SERVER_NAME_PATTERN}`,
    )
  }
}

function stringRecord(input: unknown, label: string): Record<string, string> {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RegistryError('INVALID_ENTRY', `${label} must be an object of string values`)
  }
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new RegistryError('INVALID_ENTRY', `${label}.${key} must be a string`)
    }
    // Literal strings and full-string ${VAR} templates are both fine.
    parseEnvValue(value)
    output[key] = value
  }
  return output
}

function stringList(input: unknown, label: string): string[] {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.some(item => typeof item !== 'string')) {
    throw new RegistryError('INVALID_ENTRY', `${label} must be an array of strings`)
  }
  return [...input]
}

function timeoutMs(input: unknown): number {
  if (input === undefined) return DEFAULT_TOOL_CALL_TIMEOUT_MS
  if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
    throw new RegistryError('INVALID_ENTRY', 'toolCallTimeoutMs must be a positive integer')
  }
  return input
}

function enabledFlag(input: unknown): boolean {
  if (input === undefined) return true
  if (typeof input !== 'boolean') {
    throw new RegistryError('INVALID_ENTRY', 'enabled must be a boolean')
  }
  return input
}

/**
 * Validate and normalize raw input into a complete entry with defaults.
 * @param input - raw CLI/JSON input.
 * @param origin - install provenance stamped onto the entry.
 * @returns the normalized entry.
 * @throws {@link RegistryError} on any invalid field.
 */
export function normalizeServer(input: RawServerInput, origin: ServerOrigin): ServerEntry {
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      throw new RegistryError('INVALID_ENTRY', 'stdio transport requires a non-empty command')
    }
    return {
      transport: 'stdio',
      command: input.command,
      args: stringList(input.args, 'args'),
      env: stringRecord(input.env, 'env'),
      cwd: input.cwd ?? '',
      toolCallTimeoutMs: timeoutMs(input.toolCallTimeoutMs),
      enabled: enabledFlag(input.enabled),
      origin,
    }
  }
  if (input.transport === 'streamable-http') {
    if (typeof input.url !== 'string' || input.url.trim() === '') {
      throw new RegistryError('INVALID_ENTRY', 'streamable-http transport requires a non-empty url')
    }
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      throw new RegistryError('INVALID_ENTRY', `url ${JSON.stringify(input.url)} is not a valid URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new RegistryError('INVALID_ENTRY', 'url must use http: or https:')
    }
    return {
      transport: 'streamable-http',
      url: input.url,
      headers: stringRecord(input.headers, 'headers'),
      toolCallTimeoutMs: timeoutMs(input.toolCallTimeoutMs),
      enabled: enabledFlag(input.enabled),
      origin,
    }
  }
  throw new RegistryError(
    'INVALID_ENTRY',
    `unknown transport ${JSON.stringify(input.transport)} — expected "stdio" or "streamable-http"`,
  )
}

/**
 * Parse a registry JSON document. Unknown fields are tolerated (forward
 * compatibility), but a wrong `version` or malformed shape fails loud —
 * a present file that cannot be trusted is never silently treated as empty.
 * @param content - raw JSON text.
 * @returns the parsed registry.
 * @throws {@link RegistryError} with code `INVALID_REGISTRY_FILE`.
 */
export function parseRegistry(content: string): McpRegistry {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new RegistryError('INVALID_REGISTRY_FILE', `registry is not valid JSON: ${String(error)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryError('INVALID_REGISTRY_FILE', 'registry must be a JSON object')
  }
  const doc = raw as Record<string, unknown>
  if (doc.version !== REGISTRY_VERSION) {
    throw new RegistryError(
      'INVALID_REGISTRY_FILE',
      `registry version ${JSON.stringify(doc.version)} is unsupported — expected ${REGISTRY_VERSION}`,
    )
  }
  const servers = doc.servers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new RegistryError('INVALID_REGISTRY_FILE', 'registry "servers" must be an object keyed by server name')
  }
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    try {
      assertServerName(name)
    } catch (error) {
      throw new RegistryError('INVALID_REGISTRY_FILE', `registry server key ${JSON.stringify(name)}: ${String(error)}`)
    }
    if (typeof entry !== 'object' || entry === null) {
      throw new RegistryError('INVALID_REGISTRY_FILE', `registry server ${JSON.stringify(name)} must be an object`)
    }
    const record = entry as Record<string, unknown>
    if (record.transport !== 'stdio' && record.transport !== 'streamable-http') {
      throw new RegistryError(
        'INVALID_REGISTRY_FILE',
        `registry server ${JSON.stringify(name)} has unknown transport ${JSON.stringify(record.transport)}`,
      )
    }
  }
  return { version: REGISTRY_VERSION, servers: servers as McpRegistry['servers'] }
}
