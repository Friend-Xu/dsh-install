/**
 * Registry store: read, merge, and atomic write for `mcp.json` documents.
 * A missing file is a valid empty registry; a present file that cannot be
 * parsed fails loud. Writes are atomic (unique temp file + rename) so a
 * watcher never observes a torn document.
 * @module dsh-install/registry/store
 */

import { readFileSync } from 'node:fs'
import { emptyRegistry, parseRegistry, type McpRegistry, type ServerEntry } from './model.ts'
import { writeFileAtomic } from '../util/atomic-file.ts'

/** One server in the merged user+project view, with its winning scope. */
export interface MergedServer {
  /** The effective entry (project shadows user by name). */
  entry: ServerEntry
  /** Which scope's file supplied the entry. */
  scope: 'user' | 'project'
  /** True when the other scope also had this name but lost the merge. */
  shadowed: boolean
}

/**
 * Read a registry file.
 * @param file - absolute path.
 * @returns the parsed registry; an absent file reads as empty.
 * @throws on any read/parse failure (never silently empty).
 */
export function readRegistry(file: string): McpRegistry {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry()
    throw error
  }
  return parseRegistry(content)
}

/**
 * Atomically write a registry file: unique temp file in the same directory,
 * then rename over the target. Parent directories are created.
 * @param file - absolute path.
 * @param registry - the document to persist.
 */
export function writeRegistry(file: string, registry: McpRegistry): void {
  writeFileAtomic(file, `${JSON.stringify(registry, null, 2)}\n`, 'mcp-registry')
}

/**
 * Merge the user and project views. Project wins by name; a user entry that
 * loses is reported as shadowed, never dropped from disk.
 * @param user - user-scope registry.
 * @param project - project-scope registry (empty when outside a project).
 * @returns effective servers sorted by name.
 */
export function mergeRegistries(user: McpRegistry, project: McpRegistry): Record<string, MergedServer> {
  const merged: Record<string, MergedServer> = {}
  const userNames = new Set(Object.keys(user.servers))
  for (const [name, entry] of Object.entries(project.servers)) {
    merged[name] = { entry, scope: 'project', shadowed: userNames.has(name) }
  }
  for (const [name, entry] of Object.entries(user.servers)) {
    if (merged[name] === undefined) {
      merged[name] = { entry, scope: 'user', shadowed: false }
    } else {
      merged[name] = { ...merged[name]!, shadowed: true }
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)))
}
