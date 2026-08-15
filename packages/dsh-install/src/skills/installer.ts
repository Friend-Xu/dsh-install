/**
 * Skill installation: fetch a skill source (local directory or git URL),
 * validate its SKILL.md shape, materialize it under a skills root the
 * harness `skill-filesystem` provider watches (so installs hot-reload with
 * zero restarts), and keep provenance in the install manifest.
 *
 * The provider's discovery contract is one level deep: `<root>/<name>/SKILL.md`
 * or `<root>/<name>.md`. A source directory whose basename is a skill bundle
 * is copied as-is; a source that itself contains `SKILL.md` at its root is
 * installed under the requested (or detected) name.
 * @module dsh-install/skills/installer
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { RegistryError } from '../util/errors.ts'

/** Skill names must be kebab-case (the provider's contract). */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Frontmatter name extraction: a leading `name: <value>` YAML line. */
const FRONTMATTER_NAME = /^---\s*\n(?:[^\n]*\n)*?name:\s*([^\n]+)\s*\n/m

/** One resolved install source. */
export interface ResolvedSource {
  /** Materialized directory or file that contains the skill. */
  materialized: string
  /** Human-readable provenance string for the manifest. */
  provenance: string
  /** Pinned ref for git sources. */
  ref?: string
  /** Cleanup callback for temporary materializations (git checkouts). */
  cleanup?: () => void
}

/**
 * Reset the ephemeral clone work directory: every git materialization starts
 * from a clean slate, so stale checkouts from interrupted runs cannot
 * accumulate. The work dir holds at most one in-flight operation.
 * @param workDir - the work directory to reset.
 */
export function prepareGitWorkDir(workDir: string): void {
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
}

/**
 * Resolve an install source.
 * - Git-shaped specs (`git+URL`, `github:owner/repo`, `owner/repo`, each with
 *   optional `#subdir@ref`) → shallow clone into a fresh temp directory under
 *   `workDir` (the work dir is reset first, so clones never accumulate).
 * - Anything else → a local filesystem path.
 * @param source - the user-supplied source spec.
 * @param workDir - work root for git materializations.
 * @returns the resolved source.
 */
export function resolveSource(source: string, workDir: string): ResolvedSource {
  const spec = source.trim()
  if (spec === '') throw new RegistryError('INVALID_ENTRY', 'skill source must not be empty')
  const gitSpec = parseGitSpec(spec)
  if (gitSpec !== undefined) {
    prepareGitWorkDir(workDir)
    const destination = join(workDir, `git-${Math.random().toString(36).slice(2)}`)
    const args = ['clone', '--depth', '1']
    if (gitSpec.ref !== undefined) args.push('--branch', gitSpec.ref)
    args.push('--', gitSpec.url, destination)
    const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true })
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new RegistryError('RUNTIME_MISSING', 'git is required to install from a git URL but was not found on PATH')
      }
      throw new RegistryError('SOURCE_UNREACHABLE', `git clone failed: ${String(result.error)}`)
    }
    if (result.status !== 0) {
      throw new RegistryError('SOURCE_UNREACHABLE', `git clone failed: ${result.stderr.trim() || `exit ${String(result.status)}`}`)
    }
    const materialized = gitSpec.subdir === undefined ? destination : join(destination, gitSpec.subdir)
    if (!existsSync(materialized)) {
      rmSync(destination, { recursive: true, force: true })
      throw new RegistryError('SOURCE_UNREACHABLE', `git source ${JSON.stringify(spec)} has no subdirectory ${JSON.stringify(gitSpec.subdir)}`)
    }
    return {
      materialized,
      provenance: spec,
      ...gitSpec.ref === undefined ? {} : { ref: gitSpec.ref },
      cleanup: () => rmSync(destination, { recursive: true, force: true }),
    }
  }
  const path = resolve(spec)
  if (!existsSync(path)) throw new RegistryError('SOURCE_UNREACHABLE', `skill source ${JSON.stringify(spec)} does not exist`)
  return { materialized: path, provenance: spec }
}

interface GitSpec {
  url: string
  subdir?: string
  ref?: string
}

/**
 * Parse supported git spec shapes: `git+URL`, `github:owner/repo`,
 * `owner/repo` shorthand, each with optional `#subdir@ref` (either part
 * optional).
 * @param spec - the raw source spec.
 * @returns the parsed git spec, or `undefined` when not git-shaped.
 */
export function parseGitSpec(spec: string): GitSpec | undefined {
  let rest = spec
  let url: string | undefined
  if (rest.startsWith('git+')) {
    url = rest.slice(4)
  } else if (/^github:/i.test(rest)) {
    url = `https://github.com/${rest.slice(7)}`
  } else if (/^[\w.-]+\/[\w.-]+([#@]|$)/.test(rest)) {
    url = `https://github.com/${rest}`
  }
  if (url === undefined) return undefined
  const hash = url.indexOf('#')
  let fragment = ''
  if (hash !== -1) {
    fragment = url.slice(hash + 1)
    url = url.slice(0, hash)
  }
  // An `@ref` may also trail the path without a `#subdir` fragment; only
  // split after the last path segment so `user@host` URLs stay intact.
  const slash = url.lastIndexOf('/')
  const at = url.indexOf('@', slash + 1)
  let ref: string | undefined
  if (at !== -1) {
    ref = url.slice(at + 1)
    if (ref === '') throw new RegistryError('INVALID_ENTRY', `git spec ${JSON.stringify(spec)} has an empty ref after @`)
    url = url.slice(0, at)
  }
  if (fragment === '') return { url, ...ref === undefined ? {} : { ref } }
  const fragAt = fragment.lastIndexOf('@')
  if (fragAt === -1) return { url, subdir: fragment, ...ref === undefined ? {} : { ref } }
  const subdir = fragment.slice(0, fragAt)
  const fragRef = fragment.slice(fragAt + 1)
  if (fragRef === '') throw new RegistryError('INVALID_ENTRY', `git spec ${JSON.stringify(spec)} has an empty ref after @`)
  return { url, ...subdir === '' ? {} : { subdir }, ref: ref ?? fragRef }
}

/**
 * Find the SKILL.md inside a resolved source. The source is either a bundle
 * directory (SKILL.md at its root), a flat `<name>.md` file, or a collection
 * whose basename IS a bundle (its `SKILL.md` found directly).
 * @param source - resolved source directory or file.
 * @returns the skill body file path, or `undefined` when no SKILL.md shape exists.
 */
export function findSkillMarkdown(source: string): string | undefined {
  if (!existsSync(source)) return undefined
  const stat = lstatSync(source)
  if (stat.isFile()) {
    if (!source.endsWith('.md')) return undefined
    return source
  }
  if (!stat.isDirectory()) return undefined
  const direct = join(source, 'SKILL.md')
  if (existsSync(direct)) return direct
  return undefined
}

/**
 * Read the `name` from SKILL.md frontmatter.
 * @param skillFile - path to the SKILL.md (or flat .md) body.
 * @returns the frontmatter name, or `undefined`.
 */
export function frontmatterName(skillFile: string): string | undefined {
  const content = readFileSync(skillFile, 'utf8')
  const match = FRONTMATTER_NAME.exec(content)
  const raw = match?.[1]?.trim()
  if (raw === undefined || raw === '') return undefined
  return raw
}

/** Which shape the install will take. */
export type InstallShape =
  | { kind: 'bundle-directory'; target: string }
  | { kind: 'flat-file'; target: string }

/**
 * Compute the target path for one install.
 * @param skillRoot - the scope's skills root (`~/.dsh/skills` or `<project>/.dsh/skills`).
 * @param name - the skill name (kebab-case).
 * @param sourceIsBundleDir - whether the source dir itself is the bundle.
 * @returns the target path.
 */
export function targetFor(skillRoot: string, name: string, sourceIsBundleDir: boolean): string {
  return sourceIsBundleDir
    ? join(skillRoot, name)
    : join(skillRoot, `${name}.md`)
}

/**
 * Materialize one skill into a skills root.
 * @param options - source, root, name, and link mode.
 * @returns the target path.
 * @throws {@link RegistryError} on invalid names, shapes, or conflicts.
 */
export function installSkill(options: {
  source: ResolvedSource
  skillRoot: string
  name: string
  link: boolean
}): string {
  const { source, skillRoot, name, link } = options
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new RegistryError('INVALID_NAME', `skill name ${JSON.stringify(name)} is invalid — must be kebab-case (${SKILL_NAME_PATTERN})`)
  }
  const skillFile = findSkillMarkdown(source.materialized)
  if (skillFile === undefined) {
    throw new RegistryError(
      'INVALID_ENTRY',
      `skill source ${JSON.stringify(source.provenance)} has no SKILL.md (a bundle directory or a flat <name>.md file)`,
    )
  }
  const isBundleDir = !lstatSync(source.materialized).isFile() && basename(skillFile) === 'SKILL.md'
    && dirname(skillFile) === source.materialized
  const target = targetFor(skillRoot, name, isBundleDir)
  if (existsSync(target)) {
    throw new RegistryError('DUPLICATE_SERVER', `skill ${JSON.stringify(name)} is already installed at ${target} — remove it first or use update`)
  }
  mkdirSync(dirname(target), { recursive: true })
  if (link) {
    const kind = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(resolve(source.materialized), target, isBundleDir ? kind : 'file')
    return target
  }
  if (isBundleDir) {
    cpSync(source.materialized, target, { recursive: true, dereference: true })
  } else {
    cpSync(skillFile, target)
  }
  return target
}

/**
 * Remove an installed skill: delete the materialized target and drop its
 * manifest record. Only manifest-tracked installs are touched.
 * @param target - the recorded target path.
 */
export function removeInstalledSkill(target: string): void {
  if (!existsSync(target)) return
  const stat = lstatSync(target)
  if (stat.isDirectory()) rmSync(target, { recursive: true, force: true })
  else rmSync(target, { force: true })
}
