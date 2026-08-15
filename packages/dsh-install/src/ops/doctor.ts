/**
 * `mcp doctor`: diagnose one installed server without mounting it — runtime
 * presence on PATH (stdio), env-var availability, and endpoint reachability
 * (http HEAD probe). Pure diagnostics; verdicts only, no mutations.
 * @module dsh-install/ops/doctor
 */

import { expandRecord } from '../registry/envref.ts'
import { getServer, type RegistryFiles } from './mcp.ts'
import { findOnPath } from '../catalog/resolve.ts'
import { CODES, createReport, verdict, type Report } from './report.ts'

/** Diagnose one installed server by name. */
export async function doctorServer(files: RegistryFiles, name: string): Promise<Report> {
  const { server } = getServer(files, name)
  if (server === undefined) {
    return createReport(`mcp doctor ${name}`, 'diagnostics', [
      verdict.failed(CODES.NOT_FOUND, `no server named ${JSON.stringify(name)}`),
    ])
  }
  const entry = server.entry
  const verdicts: Report['verdicts'] = []
  if (entry.transport === 'stdio') {
    const found = findOnPath(entry.command, process.env)
    if (found === undefined) {
      verdicts.push(verdict.partial(CODES.RUNTIME_MISSING, `runtime ${JSON.stringify(entry.command)} not found on PATH`, 'install it, or use `mcp update` to fix the command'))
    } else {
      verdicts.push(verdict.imported(CODES.IMPORTED, `runtime ${JSON.stringify(entry.command)} found at ${found}`))
    }
    const { missing } = expandRecord(entry.env, process.env)
    for (const variable of missing) {
      verdicts.push(verdict.partial(CODES.ENV_UNRESOLVED, `env var ${variable} is not set`, 'export it, or `mcp update` to fix the reference'))
    }
    if (missing.length === 0 && Object.keys(entry.env).length > 0) {
      verdicts.push(verdict.imported(CODES.IMPORTED, `all ${Object.keys(entry.env).length} env reference(s) resolve`))
    }
  } else {
    const { missing } = expandRecord(entry.headers, process.env)
    for (const variable of missing) {
      verdicts.push(verdict.partial(CODES.ENV_UNRESOLVED, `header env var ${variable} is not set`))
    }
    try {
      const response = await fetch(entry.url, { method: 'HEAD', signal: AbortSignal.timeout(8_000) })
      verdicts.push(response.ok
        ? verdict.imported(CODES.IMPORTED, `endpoint ${entry.url} responds (${response.status})`)
        : verdict.partial(CODES.SOURCE_UNREACHABLE, `endpoint ${entry.url} responded ${response.status}`))
    } catch (error) {
      verdicts.push(verdict.failed(CODES.SOURCE_UNREACHABLE, `endpoint ${entry.url} unreachable: ${String(error)}`))
    }
  }
  if (entry.enabled === false) {
    verdicts.push(verdict.partial(CODES.SKIP_UNSUPPORTED_FIELD, 'server is disabled and will not be mounted'))
  }
  return createReport(`mcp doctor ${name}`, 'diagnostics', verdicts)
}

/** Human table of diagnostics. */
export function renderDoctor(report: Report): string {
  return report.verdicts.map(item => `${item.kind === 'imported' ? '✅' : item.kind === 'failed' ? '🚫' : '⚠️'} ${item.message}`).join('\n')
}
