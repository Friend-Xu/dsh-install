/**
 * Catalog resolution: shorthand names and URI forms to registry input, plus
 * runtime availability checks over PATH (pure filesystem probing — no child
 * processes, so it works in sandboxed environments too).
 * @module dsh-install/catalog/resolve
 */

import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { RegistryError } from '../util/errors.ts'
import type { RawServerInput } from '../registry/model.ts'
import { builtinEntry } from './builtin.ts'
import type { CatalogEntry } from './model.ts'

/** A URI shorthand: `npx:pkg`, `uvx:pkg`, `docker:image`, or `https://...`. */
export function parseUriShorthand(spec: string): RawServerInput | undefined {
  const match = /^(npx|uvx|docker):(.+)$/.exec(spec)
  if (match === null) return undefined
  const runtime = match[1] as 'npx' | 'uvx' | 'docker'
  const target = match[2]!
  if (target.trim() === '') return undefined
  if (runtime === 'npx') return { transport: 'stdio', command: 'npx', args: ['-y', target] }
  if (runtime === 'uvx') return { transport: 'stdio', command: 'uvx', args: [target] }
  return { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', target] }
}

/**
 * Resolve a shorthand into registry input.
 * @param spec - the shorthand (catalog name or URI form).
 * @returns the resolved input, or `undefined` when not a known shorthand.
 * @throws {@link RegistryError} when a catalog entry demands explicit `--` args.
 */
export function resolveShorthand(spec: string): RawServerInput | undefined {
  const uri = parseUriShorthand(spec)
  if (uri !== undefined) return uri
  const entry = builtinEntry(spec)
  if (entry === undefined) return undefined
  if (entry.requiresArgs === true) {
    throw new RegistryError(
      'INVALID_ENTRY',
      `catalog entry ${JSON.stringify(spec)} needs extra arguments — use the explicit form: mcp add ${spec} -- ${entry.command} ${entry.args.join(' ')} <your-args>`,
    )
  }
  return catalogEntryToInput(entry)
}

function catalogEntryToInput(entry: CatalogEntry): RawServerInput {
  return {
    transport: 'stdio',
    command: entry.command,
    args: entry.args,
    env: Object.fromEntries(entry.env.map(requirement => [requirement.name, `\${${requirement.name}}`])),
  }
}

/**
 * Find an executable on PATH by probing each directory (Windows PATHEXT-aware,
 * case-insensitive). Never spawns a process.
 * @param name - the executable name.
 * @param env - environment snapshot.
 * @returns the resolved path, or `undefined`.
 */
export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? ''
  if (pathValue === '') return undefined
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(ext => ext !== '').map(ext => ext.toLowerCase())
    : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    const candidates = process.platform === 'win32' ? [name, ...extensions.map(ext => `${name}${ext}`)] : [name]
    for (const candidate of candidates) {
      const file = join(dir, candidate)
      try {
        if (existsSync(file) && statSync(file).isFile()) return file
      } catch {
        // Unreadable entries are not a runtime.
      }
    }
  }
  return undefined
}

/**
 * Check which runtimes a catalog entry's `runtime` field requires and
 * whether the executable is available.
 * @param entry - the catalog entry.
 * @param env - environment snapshot.
 * @returns a verdict-ish summary: the runtime name and whether it is found.
 */
export function runtimeStatus(
  entry: CatalogEntry,
  env: Readonly<Record<string, string | undefined>>,
): { runtime: CatalogEntry['runtime']; available: boolean; path?: string } {
  const found = findOnPath(entry.command, env)
  return { runtime: entry.runtime, available: found !== undefined, ...found === undefined ? {} : { path: found } }
}
