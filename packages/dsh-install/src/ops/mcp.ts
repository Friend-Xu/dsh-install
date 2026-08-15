/**
 * MCP registry operations: add/list/get/remove/on/off/update over the
 * user+project scope files, each producing an audited report. Pure file
 * logic — no cordis services — so the CLI adapter, slash adapter, and tests
 * share exactly one implementation.
 * @module dsh-install/ops/mcp
 */

import {
  assertServerName,
  emptyRegistry,
  normalizeServer,
  type McpRegistry,
  type RawServerInput,
  type ServerEntry,
  type ServerOrigin,
} from '../registry/model.ts'
import { RegistryError } from '../util/errors.ts'
import { readRegistry, writeRegistry, type MergedServer, mergeRegistries } from '../registry/store.ts'
import { installLogPath, projectMcpRegistryPath, userMcpRegistryPath } from '../registry/paths.ts'
import { appendAuditLog, CODES, createReport, verdict, type Report } from './report.ts'

/** Registry files for one operation, resolved from a cwd. */
export interface RegistryFiles {
  user: string
  /** Absent outside a project. */
  project: string | undefined
}

/** Resolve registry file paths for a working directory. */
export function resolveRegistryFiles(cwd: string): RegistryFiles {
  return { user: userMcpRegistryPath(), project: projectMcpRegistryPath(cwd) }
}

function scopeFile(files: RegistryFiles, scope: 'user' | 'project'): string {
  if (scope === 'user') return files.user
  if (files.project === undefined) {
    throw new RegistryError('NOT_FOUND', 'project scope requested but cwd is outside any project (no .git ancestor)')
  }
  return files.project
}

function auditAndReturn(files: RegistryFiles, action: string, target: string, verdicts: Report['verdicts']): Report {
  const report = createReport(action, target, verdicts)
  try {
    appendAuditLog(installLogPath(), report)
  } catch (error) {
    report.verdicts.push(verdict.failed(CODES.AUDIT_LOG_FAILED, 'audit log append failed', String(error)))
  }
  return report
}

/** List the effective merged view, sorted by name. */
export function listServers(files: RegistryFiles): { servers: Record<string, MergedServer>; report: Report } {
  const servers = mergeRegistries(readRegistry(files.user), files.project === undefined ? emptyRegistry() : readRegistry(files.project))
  const report = createReport('mcp list', 'user+project', Object.entries(servers).map(([name, server]) =>
    verdict.imported(CODES.IMPORTED, `${name} (${server.entry.transport}, ${server.scope}${server.shadowed ? ', shadowed' : ''}${server.entry.enabled ? '' : ', disabled'})`)))
  return { servers, report }
}

/** Read one server from the merged view. */
export function getServer(files: RegistryFiles, name: string): { server: MergedServer | undefined; report: Report } {
  const { servers } = listServers(files)
  const server = servers[name]
  return {
    server,
    report: server === undefined
      ? createReport(`mcp get ${name}`, 'user+project', [verdict.failed(CODES.NOT_FOUND, `no server named ${JSON.stringify(name)}`)])
      : createReport(`mcp get ${name}`, 'user+project', [verdict.imported(CODES.IMPORTED, `${name} → ${JSON.stringify(server.entry)}`)]),
  }
}

/**
 * Add a server to one scope.
 * - Same-scope duplicate → failed (never silently overwrites).
 * - Project-scope add shadowing a user entry → imported, shadowing noted.
 * - User-scope add shadowed by a project entry → partial, the project wins.
 */
export function addServer(
  files: RegistryFiles,
  scope: 'user' | 'project',
  name: string,
  raw: RawServerInput,
  origin: ServerOrigin,
): Report {
  try {
    assertServerName(name)
  } catch (error) {
    return createReport(`mcp add ${name}`, scope, [verdict.failed(CODES.INVALID_NAME, String(error))])
  }
  const action = `mcp add ${name}`
  const file = scopeFile(files, scope)
  const registry: McpRegistry = readRegistry(file)
  if (registry.servers[name] !== undefined) {
    return auditAndReturn(files, action, scope, [
      verdict.failed(CODES.DUPLICATE_SERVER, `server ${JSON.stringify(name)} already exists in ${scope} scope — remove it first or use update`),
    ])
  }
  let entry: ServerEntry
  try {
    entry = normalizeServer(raw, origin)
  } catch (error) {
    const code = error instanceof RegistryError ? error.code : CODES.INVALID_ENTRY
    return auditAndReturn(files, action, scope, [verdict.failed(code, String(error))])
  }
  registry.servers[name] = entry
  writeRegistry(file, registry)
  const otherScope = scope === 'project' ? 'user' : 'project'
  const other = otherScope === 'project' ? files.project : files.user
  const shadowed = other !== undefined && other !== file && readRegistry(other).servers[name] !== undefined
  return auditAndReturn(files, action, scope, [
    shadowed && scope === 'user'
      ? verdict.partial(
        CODES.CONFLICT_EXISTING,
        `added ${name} to ${scope} scope, but a project-scope entry shadows it`,
        'the project registry wins the merge; remove the project entry to unmask this one',
      )
      : shadowed
        ? verdict.imported(CODES.IMPORTED, `added ${name} to ${scope} scope (shadows the user-scope entry of the same name)`)
        : verdict.imported(CODES.IMPORTED, `added ${name} to ${scope} scope (${entry.transport})`),
  ])
}

/** Remove a server from one scope; the other scope's entry (if any) survives. */
export function removeServer(files: RegistryFiles, scope: 'user' | 'project', name: string): Report {
  const action = `mcp remove ${name}`
  try {
    const file = scopeFile(files, scope)
    const registry = readRegistry(file)
    if (registry.servers[name] === undefined) {
      return auditAndReturn(files, action, scope, [
        verdict.failed(CODES.NOT_FOUND, `no server named ${JSON.stringify(name)} in ${scope} scope`),
      ])
    }
    delete registry.servers[name]
    writeRegistry(file, registry)
    return auditAndReturn(files, action, scope, [verdict.imported(CODES.IMPORTED, `removed ${name} from ${scope} scope`)])
  } catch (error) {
    return auditAndReturn(files, action, scope, [verdict.failed(CODES.OPERATION_FAILED, String(error))])
  }
}

/** Enable or disable a server in one scope. */
export function setServerEnabled(files: RegistryFiles, scope: 'user' | 'project', name: string, enabled: boolean): Report {
  const action = `mcp ${enabled ? 'on' : 'off'} ${name}`
  try {
    const file = scopeFile(files, scope)
    const registry = readRegistry(file)
    const entry = registry.servers[name]
    if (entry === undefined) {
      return auditAndReturn(files, action, scope, [
        verdict.failed(CODES.NOT_FOUND, `no server named ${JSON.stringify(name)} in ${scope} scope`),
      ])
    }
    if (entry.enabled === enabled) {
      return auditAndReturn(files, action, scope, [
        verdict.imported(CODES.IMPORTED, `${name} is already ${enabled ? 'enabled' : 'disabled'} in ${scope} scope`),
      ])
    }
    entry.enabled = enabled
    writeRegistry(file, registry)
    return auditAndReturn(files, action, scope, [verdict.imported(CODES.IMPORTED, `${enabled ? 'enabled' : 'disabled'} ${name} in ${scope} scope`)])
  } catch (error) {
    return auditAndReturn(files, action, scope, [verdict.failed(CODES.OPERATION_FAILED, String(error))])
  }
}

/** Replace one server's configuration in one scope, preserving its origin. */
export function updateServer(
  files: RegistryFiles,
  scope: 'user' | 'project',
  name: string,
  raw: RawServerInput,
): Report {
  const action = `mcp update ${name}`
  try {
    assertServerName(name)
    const file = scopeFile(files, scope)
    const registry = readRegistry(file)
    const existing = registry.servers[name]
    if (existing === undefined) {
      return auditAndReturn(files, action, scope, [
        verdict.failed(CODES.NOT_FOUND, `no server named ${JSON.stringify(name)} in ${scope} scope — use add to create it`),
      ])
    }
    const entry = normalizeServer(raw, existing.origin)
    registry.servers[name] = entry
    writeRegistry(file, registry)
    return auditAndReturn(files, action, scope, [verdict.imported(CODES.IMPORTED, `updated ${name} in ${scope} scope (${entry.transport})`)])
  } catch (error) {
    const code = error instanceof RegistryError ? error.code : CODES.INVALID_ENTRY
    return auditAndReturn(files, action, scope, [verdict.failed(code, String(error))])
  }
}

/**
 * Remove every server from one scope, one verdict each.
 * @param files - resolved registry files.
 * @param scope - target scope.
 * @param dryRun - report what would be removed without writing anything.
 * @returns the aggregated report (dry runs are not audited).
 */
export function removeAllServers(files: RegistryFiles, scope: 'user' | 'project', dryRun = false): Report {
  const action = `mcp remove --all (${scope})`
  const verdicts: Report['verdicts'] = []
  try {
    const file = scopeFile(files, scope)
    const registry = readRegistry(file)
    const names = Object.keys(registry.servers).sort()
    if (names.length === 0) {
      return createReport(action, scope, [verdict.imported(CODES.IMPORTED, `no servers in ${scope} scope — nothing to remove`)])
    }
    for (const name of names) {
      const entry = registry.servers[name]!
      delete registry.servers[name]
      verdicts.push(verdict.imported(CODES.IMPORTED, `removed ${name} from ${scope} scope`, `${entry.transport}`))
    }
    if (!dryRun) writeRegistry(file, registry)
    else verdicts.push(verdict.partial(CODES.SKIP_UNSUPPORTED_FIELD, 'dry run — nothing was written'))
  } catch (error) {
    verdicts.push(verdict.failed(CODES.OPERATION_FAILED, String(error)))
  }
  if (dryRun) return createReport(action, scope, verdicts)
  return auditAndReturn(files, action, scope, verdicts)
}
