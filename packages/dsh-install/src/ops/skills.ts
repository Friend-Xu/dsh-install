/**
 * Skill operations: add/list/remove/update over the user+project skill
 * roots, each producing an audited report. Pure file logic — the CLI
 * adapter, slash adapter, and tests share this one implementation.
 * @module dsh-install/ops/skills
 */

import { existsSync, lstatSync } from 'node:fs'
import { basename, join } from 'node:path'
import { RegistryError } from '../util/errors.ts'
import { installLogPath, installWorkPath, projectSkillsRootPath, userSkillsManifestPath, userSkillsRootPath } from '../registry/paths.ts'
import { readManifest, writeManifest, type SkillRecord } from '../skills/manifest.ts'
import { frontmatterName, installSkill, removeInstalledSkill, resolveSource } from '../skills/installer.ts'
import { appendAuditLog, CODES, createReport, verdict, type Report } from './report.ts'

/** Skill roots and manifest for one operation, resolved from a cwd. */
export interface SkillFiles {
  manifest: string
  user: string
  /** Absent outside a project. */
  project: string | undefined
}

/** Resolve skill paths for a working directory. */
export function resolveSkillFiles(cwd: string): SkillFiles {
  return { manifest: userSkillsManifestPath(), user: userSkillsRootPath(), project: projectSkillsRootPath(cwd) }
}

function skillRoot(files: SkillFiles, scope: 'user' | 'project'): string {
  if (scope === 'user') return files.user
  if (files.project === undefined) {
    throw new RegistryError('NOT_FOUND', 'project scope requested but cwd is outside any project (no .git ancestor)')
  }
  return files.project
}

function auditAndReturn(action: string, target: string, verdicts: Report['verdicts']): Report {
  const report = createReport(action, target, verdicts)
  try {
    appendAuditLog(installLogPath(), report)
  } catch (error) {
    report.verdicts.push(verdict.failed(CODES.AUDIT_LOG_FAILED, 'audit log append failed', String(error)))
  }
  return report
}

/**
 * Add a skill from a local path or git URL into one scope's root.
 * @param files - resolved skill paths.
 * @param scope - target scope.
 * @param sourceSpec - path or git spec.
 * @param options - explicit name, link mode, and origin label.
 * @returns the audited report.
 */
export function addSkill(
  files: SkillFiles,
  scope: 'user' | 'project',
  sourceSpec: string,
  options: { name?: string; link?: boolean; origin: string },
): Report {
  const action = `skills add ${sourceSpec}`
  try {
    const root = skillRoot(files, scope)
    const source = resolveSource(sourceSpec, installWorkPath())
    try {
      const body = ((): string | undefined => {
        if (lstatSync(source.materialized).isFile()) return source.materialized
        const direct = join(source.materialized, 'SKILL.md')
        return existsSync(direct) ? direct : undefined
      })()
      if (body === undefined) {
        throw new RegistryError('INVALID_ENTRY', `skill source ${JSON.stringify(sourceSpec)} has no SKILL.md (a bundle directory or a flat <name>.md file)`)
      }
      const name = options.name ?? frontmatterName(body) ?? basename(source.materialized).replace(/\.md$/, '')
      const manifest = readManifest(files.manifest)
      if (manifest.skills[name] !== undefined) {
        throw new RegistryError('DUPLICATE_SERVER', `skill ${JSON.stringify(name)} is already tracked in the install manifest — remove it first or use update`)
      }
      const target = installSkill({ source, skillRoot: root, name, link: options.link === true })
      const record: SkillRecord = {
        source: source.provenance,
        ...source.ref === undefined ? {} : { ref: source.ref },
        scope,
        target,
        installedAt: new Date().toISOString(),
        origin: options.origin,
      }
      manifest.skills[name] = record
      writeManifest(files.manifest, manifest)
      return auditAndReturn(action, scope, [
        verdict.imported(CODES.IMPORTED, `installed skill ${JSON.stringify(name)} into ${scope} scope`, `target: ${target}${source.ref === undefined ? '' : ` @ ${source.ref}`}`),
      ])
    } finally {
      source.cleanup?.()
    }
  } catch (error) {
    const code = error instanceof RegistryError ? error.code : CODES.OPERATION_FAILED
    return auditAndReturn(action, scope, [verdict.failed(code, String(error))])
  }
}

/** List manifest-tracked skills, sorted by name. */
export function listSkills(files: SkillFiles): { skills: Record<string, SkillRecord>; report: Report } {
  try {
    const manifest = readManifest(files.manifest)
    const sorted = Object.fromEntries(Object.entries(manifest.skills).sort(([a], [b]) => a.localeCompare(b)))
    const report = createReport('skills list', 'user+project', Object.entries(sorted).map(([name, record]) =>
      verdict.imported(CODES.IMPORTED, `${name} (${record.scope}, ${record.source})`, record.target)))
    return { skills: sorted, report }
  } catch (error) {
    return { skills: {}, report: createReport('skills list', 'user+project', [verdict.failed(CODES.OPERATION_FAILED, String(error))]) }
  }
}

/**
 * Remove a manifest-tracked skill: delete the materialized target and drop
 * the record. Skills not installed by this plugin are never touched.
 */
export function removeSkill(files: SkillFiles, name: string): Report {
  const action = `skills remove ${name}`
  try {
    const manifest = readManifest(files.manifest)
    const record = manifest.skills[name]
    if (record === undefined) {
      return auditAndReturn(action, 'user+project', [
        verdict.failed(CODES.NOT_FOUND, `no skill named ${JSON.stringify(name)} in the install manifest`),
      ])
    }
    removeInstalledSkill(record.target)
    delete manifest.skills[name]
    writeManifest(files.manifest, manifest)
    return auditAndReturn(action, record.scope, [verdict.imported(CODES.IMPORTED, `removed skill ${JSON.stringify(name)} (${record.scope} scope)`)])
  } catch (error) {
    return auditAndReturn(action, 'user+project', [verdict.failed(CODES.OPERATION_FAILED, String(error))])
  }
}

/**
 * Update a manifest-tracked skill from a new source: remove the old target,
 * install the new one, and rewrite the record (keeping scope).
 */
export function updateSkill(
  files: SkillFiles,
  name: string,
  sourceSpec: string,
  options: { link?: boolean; origin: string },
): Report {
  const action = `skills update ${name}`
  try {
    const manifest = readManifest(files.manifest)
    const previous = manifest.skills[name]
    if (previous === undefined) {
      return auditAndReturn(action, 'user+project', [
        verdict.failed(CODES.NOT_FOUND, `no skill named ${JSON.stringify(name)} in the install manifest — use add to create it`),
      ])
    }
    const source = resolveSource(sourceSpec, installWorkPath())
    try {
      removeInstalledSkill(previous.target)
      const target = installSkill({ source, skillRoot: skillRoot(files, previous.scope), name, link: options.link === true })
      const record: SkillRecord = {
        source: source.provenance,
        ...source.ref === undefined ? {} : { ref: source.ref },
        scope: previous.scope,
        target,
        installedAt: new Date().toISOString(),
        origin: options.origin,
      }
      manifest.skills[name] = record
      writeManifest(files.manifest, manifest)
      return auditAndReturn(action, previous.scope, [
        verdict.imported(CODES.IMPORTED, `updated skill ${JSON.stringify(name)} from ${JSON.stringify(sourceSpec)}`, `target: ${target}`),
      ])
    } finally {
      source.cleanup?.()
    }
  } catch (error) {
    const code = error instanceof RegistryError ? error.code : CODES.OPERATION_FAILED
    return auditAndReturn(action, 'user+project', [verdict.failed(code, String(error))])
  }
}

/**
 * Remove every manifest-tracked skill in one scope, one verdict each. Only
 * installs this plugin recorded are touched — manual skills stay.
 * @param files - resolved skill paths.
 * @param scope - target scope.
 * @param dryRun - report what would be removed without writing anything.
 * @returns the aggregated report (dry runs are not audited).
 */
export function removeAllSkills(files: SkillFiles, scope: 'user' | 'project', dryRun = false): Report {
  const action = `skills remove --all (${scope})`
  const verdicts: Report['verdicts'] = []
  try {
    const manifest = readManifest(files.manifest)
    const names = Object.entries(manifest.skills)
      .filter(([, record]) => record.scope === scope)
      .map(([name]) => name)
      .sort()
    if (names.length === 0) {
      return createReport(action, scope, [verdict.imported(CODES.IMPORTED, `no manifest-tracked skills in ${scope} scope — nothing to remove`)])
    }
    for (const name of names) {
      const record = manifest.skills[name]!
      if (!dryRun) removeInstalledSkill(record.target)
      delete manifest.skills[name]
      verdicts.push(verdict.imported(CODES.IMPORTED, `removed skill ${JSON.stringify(name)} (${record.scope} scope)`, record.target))
    }
    if (!dryRun) writeManifest(files.manifest, manifest)
    else verdicts.push(verdict.partial(CODES.SKIP_UNSUPPORTED_FIELD, 'dry run — nothing was written'))
  } catch (error) {
    verdicts.push(verdict.failed(CODES.OPERATION_FAILED, String(error)))
  }
  if (dryRun) return createReport(action, scope, verdicts)
  return auditAndReturn(action, scope, verdicts)
}
