/**
 * Whole-plugin uninstall: remove every marketplace registration, every
 * manifest-tracked skill, the target scope's MCP registry file, and the
 * leftover archive — as one audited, per-item report.
 *
 * Deliberate boundaries:
 * - Only what this plugin recorded/manages is removed. Manual skills and
 *   anything outside the plugin's own paths are never touched.
 * - The audit log survives by default: an uninstall is itself history, and
 *   deleting the log would erase the only record of what was removed.
 *   `purgeLog` deletes it explicitly.
 * - The bundle package itself is a profile dependency — removal stays the
 *   launcher's job (`dsh plugin --profile X remove dsh-install`); the report
 *   ends with that reminder plus the patch-line cleanup note.
 * @module dsh-install/ops/uninstall
 */

import { existsSync, rmSync } from 'node:fs'
import { RegistryError } from '../util/errors.ts'
import { installLogPath, installWorkPath, leftoverRootPath, marketplacesPath } from '../registry/paths.ts'
import { readMarketRegistry, writeMarketRegistry } from '../market/model.ts'
import { readManifest, writeManifest } from '../skills/manifest.ts'
import { removeInstalledSkill } from '../skills/installer.ts'
import { readRegistry } from '../registry/store.ts'
import type { RegistryFiles } from './mcp.ts'
import type { SkillFiles } from './skills.ts'
import { appendAuditLog, CODES, createReport, verdict, type Report } from './report.ts'

/** Uninstall options. */
export interface UninstallOptions {
  /** Scope whose registry and skills are removed. @default 'user' */
  scope?: 'user' | 'project'
  /** Report what would be removed without writing anything. */
  dryRun?: boolean
  /** Also delete the audit log (`$DSH_HOME/logs/install.jsonl`). */
  purgeLog?: boolean
}

/** One planned file removal (for dry-run preview and real deletion). */
interface PlannedRemoval {
  label: string
  path: string
  /** Optional predicate: only remove when it still exists. */
  kind: 'file' | 'dir'
}

/**
 * Uninstall everything the plugin manages for the scope.
 * @param mcpFiles - resolved registry files.
 * @param skillFiles - resolved skill paths.
 * @param options - scope, dry-run, and log purge.
 * @returns the aggregated report.
 */
export function uninstallAll(
  mcpFiles: RegistryFiles,
  skillFiles: SkillFiles,
  options: UninstallOptions = {},
): Report {
  const scope = options.scope ?? 'user'
  const action = `uninstall (${scope}${options.purgeLog === true ? ', purge-log' : ''})`
  const verdicts: Report['verdicts'] = []
  const planned: PlannedRemoval[] = []

  try {
    // 1. Marketplaces (home-level, all of them).
    const marketRegistry = readMarketRegistry(marketplacesPath())
    for (const name of Object.keys(marketRegistry.marketplaces).sort()) {
      delete marketRegistry.marketplaces[name]
      verdicts.push(verdict.imported(CODES.IMPORTED, `removed marketplace ${JSON.stringify(name)}`))
    }
    if (!options.dryRun) writeMarketRegistry(marketplacesPath(), marketRegistry)

    // 2. Manifest-tracked skills of the target scope.
    const manifest = readManifest(skillFiles.manifest)
    for (const [name, record] of Object.entries(manifest.skills).sort(([a], [b]) => a.localeCompare(b))) {
      if (record.scope !== scope) continue
      if (!options.dryRun) removeInstalledSkill(record.target)
      delete manifest.skills[name]
      verdicts.push(verdict.imported(CODES.IMPORTED, `removed skill ${JSON.stringify(name)}`, record.target))
    }
    if (!options.dryRun) writeManifest(skillFiles.manifest, manifest)

    // 3. The target scope's MCP registry file (delete for a clean state).
    const registryFile = scope === 'user' ? mcpFiles.user : mcpFiles.project
    if (registryFile !== undefined && existsSync(registryFile)) {
      const registry = readRegistry(registryFile)
      const count = Object.keys(registry.servers).length
      if (count > 0) {
        verdicts.push(verdict.imported(CODES.IMPORTED, `removed MCP registry with ${count} server(s)`, registryFile))
      }
      planned.push({ label: 'registry file', path: registryFile, kind: 'file' })
    } else if (registryFile === undefined) {
      verdicts.push(verdict.partial(CODES.NOT_FOUND, `project scope requested but cwd is outside any project — registry untouched`))
    }

    // 4. The leftover archive and the ephemeral clone work directory.
    const leftover = leftoverRootPath()
    if (existsSync(leftover)) {
      verdicts.push(verdict.imported(CODES.IMPORTED, 'removed leftover archive', leftover))
      planned.push({ label: 'leftover archive', path: leftover, kind: 'dir' })
    }
    const work = installWorkPath()
    if (existsSync(work)) {
      verdicts.push(verdict.imported(CODES.IMPORTED, 'removed clone work directory', work))
      planned.push({ label: 'clone work directory', path: work, kind: 'dir' })
    }

    // 5. Audit log: kept by default, deleted only on explicit purge.
    const log = installLogPath()
    if (options.purgeLog === true) {
      planned.push({ label: 'audit log', path: log, kind: 'file' })
      verdicts.push(verdict.imported(CODES.IMPORTED, 'audit log will be purged', log))
    }

    if (options.dryRun) {
      verdicts.push(verdict.partial(CODES.SKIP_UNSUPPORTED_FIELD, 'dry run — nothing was written'))
      for (const removal of planned) {
        verdicts.push(verdict.imported(CODES.IMPORTED, `would remove ${removal.label}`, removal.path))
      }
      return createReport(action, scope, verdicts)
    }

    for (const removal of planned) {
      if (!existsSync(removal.path)) continue
      try {
        if (removal.kind === 'dir') rmSync(removal.path, { recursive: true, force: true })
        else rmSync(removal.path, { force: true })
      } catch (error) {
        verdicts.push(verdict.failed(CODES.OPERATION_FAILED, `cannot remove ${removal.label} ${removal.path}: ${String(error)}`))
      }
    }

    verdicts.push(verdict.partial(
      CODES.SKIP_UNSUPPORTED_FIELD,
      'the bundle package itself is a profile dependency — remove it per profile',
      'run: dsh plugin --profile <name> remove dsh-install, then drop the `mcp-registry` enable lines from each profile\'s cordis.patch.yml',
    ))
  } catch (error) {
    const code = error instanceof RegistryError ? error.code : CODES.OPERATION_FAILED
    verdicts.push(verdict.failed(code, String(error)))
  }

  const report = createReport(action, scope, verdicts)
  if (!options.dryRun && options.purgeLog !== true) {
    try {
      appendAuditLog(installLogPath(), report)
    } catch (error) {
      report.verdicts.push(verdict.failed(CODES.AUDIT_LOG_FAILED, 'audit log append failed', String(error)))
    }
  }
  return report
}
