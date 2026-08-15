/**
 * Import operations: bulk-add extracted servers with per-item verdicts, and
 * claude-plugin content extraction (skills/mcpServers install; commands/
 * agents/hooks report as incompatible with a leftover archive copy).
 * @module dsh-install/ops/import
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { RegistryError } from '../util/errors.ts'
import type { ServerOrigin } from '../registry/model.ts'
import { installLogPath, installWorkPath, leftoverRootPath } from '../registry/paths.ts'
import { resolveSource, type ResolvedSource } from '../skills/installer.ts'
import { appendAuditLog, CODES, createReport, verdict, type Report } from './report.ts'
import { addServer, type RegistryFiles } from './mcp.ts'
import { addSkill, type SkillFiles } from './skills.ts'
import { fromClaudeJson, fromCodexToml, fromMcpJson, parseClaudePluginManifest, type ImportedServer } from '../import/importers.ts'

/**
 * Normalize a claude-plugin source spec: plain `https://...` URLs become
 * git-cloneable specs (`git+URL`); git specs and local paths pass through.
 * @param spec - the user-supplied source.
 * @returns the normalized spec.
 */
export function normalizePluginSource(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed === '') throw new RegistryError('INVALID_ENTRY', 'plugin source must not be empty')
  return /^https?:\/\//.test(trimmed) ? `git+${trimmed}` : trimmed
}

/**
 * Resolve a claude-plugin source: a local directory used as-is, anything
 * git-shaped (or a plain URL) shallow-cloned into the ephemeral work
 * directory. Clones live only for this call; cleanup deletes them.
 * @param spec - directory path, git spec, or https URL.
 * @returns the resolved source.
 */
export function resolvePluginSource(spec: string): ResolvedSource {
  return resolveSource(normalizePluginSource(spec), installWorkPath())
}

/** Bulk-add extracted servers, one verdict each. */
export function importServers(
  files: RegistryFiles,
  scope: 'user' | 'project',
  servers: ImportedServer[],
  origin: ServerOrigin,
): Report {
  const action = `mcp import (${servers.length} servers)`
  const verdicts: Report['verdicts'] = []
  for (const server of servers) {
    // addServer audits each single-server report; aggregate its verdicts
    // under this import report without double-auditing.
    const added = addServer(files, scope, server.name, server.input, origin)
    for (const item of added.verdicts) {
      verdicts.push({ ...item, message: `${server.name}: ${item.message}` })
    }
  }
  const report = createReport(action, scope, verdicts)
  try {
    appendAuditLog(installLogPath(), report)
  } catch (error) {
    report.verdicts.push(verdict.failed(CODES.AUDIT_LOG_FAILED, 'audit log append failed', String(error)))
  }
  return report
}

/** Which config kind a file contains, for `mcp import --from auto`. */
export function detectImportKind(content: string): 'mcp-json' | 'claude-json' | 'codex-toml' {
  if (/\[mcp_servers\./.test(content)) return 'codex-toml'
  if (content.includes('"localMcpServers"') || content.includes('"hasCompletedOnboarding"')) return 'claude-json'
  return 'mcp-json'
}

/** Read and convert one config file into servers. */
export function importFromFile(
  kind: 'mcp-json' | 'claude-json' | 'codex-toml' | 'auto',
  path: string,
  originLabel: string,
): ImportedServer[] {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    throw new RegistryError('SOURCE_UNREACHABLE', `cannot read ${path}: ${String(error)}`)
  }
  // Tolerate a UTF-8 BOM (editors on Windows commonly emit one).
  content = content.replace(/^\uFEFF/, '')
  const resolved = kind === 'auto' ? detectImportKind(content) : kind
  if (resolved === 'claude-json') {
    const { servers, localServers } = fromClaudeJson(content, originLabel)
    return [...servers, ...localServers]
  }
  if (resolved === 'codex-toml') return fromCodexToml(content, originLabel)
  return fromMcpJson(content, originLabel)
}

/** Result of extracting one claude-plugin package. */
export interface PluginExtraction {
  installedSkills: string[]
  installedServers: string[]
  incompatible: Report['verdicts']
  leftoverDir: string
}

/**
 * Extract the content layer of a claude-plugin package:
 * - skills → installed into the scope's skills root (manifest-tracked)
 * - mcpServers → added to the scope's registry
 * - commands/agents/hooks → INCOMPATIBLE_* verdicts; the manifest and
 *   payload files are archived under `.dsh/install/leftover/<plugin>/`.
 *
 * The source may be a local directory, a git spec, or a plain https URL:
 * remote sources are shallow-cloned into the ephemeral work directory and
 * deleted again before this call returns.
 * @param mcpFiles - registry files.
 * @param skillFiles - skill roots and manifest.
 * @param scope - target scope.
 * @param pluginSource - directory path, git spec, or https URL containing
 *   `.claude-plugin/plugin.json`.
 * @param origin - provenance labels.
 * @returns the extraction summary.
 */
export function extractClaudePlugin(
  mcpFiles: RegistryFiles,
  skillFiles: SkillFiles,
  scope: 'user' | 'project',
  pluginSource: string,
  origin: { source: string; addedAt: string },
): PluginExtraction {
  const resolved = resolvePluginSource(pluginSource)
  try {
    const manifestPath = join(resolved.materialized, '.claude-plugin', 'plugin.json')
    if (!existsSync(manifestPath)) {
      throw new RegistryError(
        'INVALID_ENTRY',
        `${pluginSource} is not a claude-plugin package (no .claude-plugin/plugin.json${resolved.ref === undefined ? '' : ` at ${resolved.ref}`})`,
      )
    }
    const payloads = parseClaudePluginManifest(readFileSync(manifestPath, 'utf8'), basename(resolved.materialized))
    // Real claude plugins (e.g. obra/superpowers) often declare NOTHING in
    // the manifest and rely on the directory convention: skills live in
    // `skills/<name>/SKILL.md`. Union declared skills with every discovered
    // bundle directory so the common distribution shape extracts correctly.
    const skills = new Set(payloads.skills)
    const skillsDir = join(resolved.materialized, 'skills')
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const body = join(skillsDir, entry.name, 'SKILL.md')
        if (existsSync(body)) skills.add(entry.name)
      }
    }
    const incompatible: Report['verdicts'] = []
    for (const command of payloads.commands) {
      incompatible.push(verdict.skipped(CODES.INCOMPATIBLE_COMMANDS, `command ${JSON.stringify(command)}`, 'DSH has no command-file runtime; convert the prompt into a skill'))
    }
    for (const agent of payloads.agents) {
      incompatible.push(verdict.skipped(CODES.INCOMPATIBLE_AGENTS, `agent ${JSON.stringify(agent)}`, 'subagents need preset adaptation; the source is archived under leftover'))
    }
    for (const hook of payloads.hooks) {
      incompatible.push(verdict.skipped(CODES.INCOMPATIBLE_HOOKS, `hook ${JSON.stringify(hook)}`, 'hook event shapes differ from DSH; the source is archived under leftover'))
    }
    // Archive the manifest + payload sources so nothing is lost.
    const leftoverDir = join(leftoverRootPath(), payloads.name)
    mkdirSync(leftoverDir, { recursive: true })
    cpSync(manifestPath, join(leftoverDir, 'plugin.json'), { force: true })
    for (const sub of ['commands', 'agents', 'hooks']) {
      const source = join(resolved.materialized, sub)
      if (existsSync(source)) cpSync(source, join(leftoverDir, sub), { recursive: true, force: true })
    }
    // Install skills (declared in the manifest or discovered under skills/).
    const installedSkills: string[] = []
    for (const skill of [...skills].sort()) {
      const source = join(resolved.materialized, 'skills', skill)
      if (!existsSync(source)) {
        incompatible.push(verdict.failed(CODES.SOURCE_UNREACHABLE, `skill ${JSON.stringify(skill)}`, `no skills/${skill} directory in the plugin`))
        continue
      }
      const added = addSkill(skillFiles, scope, source, { name: skill, origin: origin.source })
      if (added.summary.failed === 0) installedSkills.push(skill)
      else incompatible.push(...added.verdicts)
    }
    // Install declared MCP servers.
    const servers: ImportedServer[] = Object.entries(payloads.mcpServers).map(([name, input]) => ({ name, input }))
    importServers(mcpFiles, scope, servers, origin)
    return {
      installedSkills,
      installedServers: servers.map(server => server.name),
      incompatible,
      leftoverDir,
    }
  } finally {
    resolved.cleanup?.()
  }
}
