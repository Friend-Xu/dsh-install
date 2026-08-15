/**
 * Registry file paths: one user registry under `$DSH_HOME`, one optional
 * project registry under `<projectRoot>/.dsh`, plus the manifests, audit log,
 * and leftover archive locations. The project root is the nearest `.git`
 * ancestor of `cwd` — the same rule the harness skill provider uses.
 *
 * Path resolution goes through `@deepseek-ai/dsh-home-paths` (a regular
 * dependency) so this plugin and the harness skill provider always agree on
 * where user data lives.
 * @module dsh-install/registry/paths
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Registry document name inside `$DSH_HOME`. */
export const MCP_REGISTRY_FILENAME = 'mcp.json'
/** Skill install manifest name inside `$DSH_HOME`. */
export const SKILLS_MANIFEST_FILENAME = 'skills-manifest.json'
/** Marketplace registry name inside `$DSH_HOME`. */
export const MARKETPLACES_FILENAME = 'marketplaces.json'
/** Plugin provenance manifest name inside `$DSH_HOME`. */
export const PLUGINS_MANIFEST_FILENAME = 'plugins-manifest.json'
/** Audit log directory name inside `$DSH_HOME`. */
export const INSTALL_LOG_DIRNAME = 'logs'
/** Audit log file name. */
export const INSTALL_LOG_FILENAME = 'install.jsonl'
/** Archive directory for un-migrated sources inside `$DSH_HOME`. */
export const INSTALL_DIRNAME = 'install'
/** Leftover archive directory name inside `$DSH_HOME/install`. */
export const LEFTOVER_DIRNAME = 'leftover'
/** Ephemeral git-clone work directory name inside `$DSH_HOME/install`. */
export const WORK_DIRNAME = 'work'
/** Skill root directory name for the project scope (`<projectRoot>/.dsh/skills`). */
export const PROJECT_DSH_DIRNAME = '.dsh'
/** Skill root directory name (user and project scopes). */
export const SKILLS_DIRNAME = 'skills'

/** Absolute path of the user-scope MCP registry (`$DSH_HOME/mcp.json`). */
export function userMcpRegistryPath(): string {
  return dshHomePath(MCP_REGISTRY_FILENAME)
}

/** Absolute path of the user-scope skill install manifest. */
export function userSkillsManifestPath(): string {
  return dshHomePath(SKILLS_MANIFEST_FILENAME)
}

/** Absolute path of the marketplace registry. */
export function marketplacesPath(): string {
  return dshHomePath(MARKETPLACES_FILENAME)
}

/** Absolute path of the plugin provenance manifest. */
export function pluginsManifestPath(): string {
  return dshHomePath(PLUGINS_MANIFEST_FILENAME)
}

/** Absolute path of the audit log (`$DSH_HOME/logs/install.jsonl`). */
export function installLogPath(): string {
  return dshHomePath(INSTALL_LOG_DIRNAME, INSTALL_LOG_FILENAME)
}

/** Absolute path of the leftover archive root (`$DSH_HOME/install/leftover`). */
export function leftoverRootPath(): string {
  return dshHomePath(INSTALL_DIRNAME, LEFTOVER_DIRNAME)
}

/**
 * Absolute path of the ephemeral clone work directory
 * (`$DSH_HOME/install/work`). Materializations live here only while one
 * operation is in flight; the next git clone resets it, and uninstall
 * removes it.
 */
export function installWorkPath(): string {
  return dshHomePath(INSTALL_DIRNAME, WORK_DIRNAME)
}

/** Absolute path of the user-scope skill root (`$DSH_HOME/skills`). */
export function userSkillsRootPath(): string {
  return dshHomePath(SKILLS_DIRNAME)
}

/**
 * Find the nearest `.git` ancestor directory of `cwd`.
 * @param cwd - directory to start the walk from.
 * @returns the project root, or `undefined` when no `.git` ancestor exists.
 */
export function projectRootOf(cwd: string): string | undefined {
  let current = resolve(cwd)
  for (;;) {
    const git = join(current, '.git')
    try {
      if (existsSync(git) && statSync(git).isDirectory()) return current
    } catch {
      // Unreadable entries are not a project marker; keep walking up.
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Absolute path of the project-scope MCP registry, or `undefined` outside a project. */
export function projectMcpRegistryPath(cwd: string): string | undefined {
  const root = projectRootOf(cwd)
  return root === undefined ? undefined : join(root, PROJECT_DSH_DIRNAME, MCP_REGISTRY_FILENAME)
}

/** Absolute path of the project-scope skill root, or `undefined` outside a project. */
export function projectSkillsRootPath(cwd: string): string | undefined {
  const root = projectRootOf(cwd)
  return root === undefined ? undefined : join(root, PROJECT_DSH_DIRNAME, SKILLS_DIRNAME)
}
