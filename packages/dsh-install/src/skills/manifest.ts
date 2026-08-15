/**
 * Skill install manifest (`$DSH_HOME/skills-manifest.json`): provenance of
 * every skill this plugin installed — source, ref, scope, target path, and
 * install time. `skills remove`/`update` act only on manifest-tracked
 * installs: files that were not installed by this plugin are never deleted.
 * @module dsh-install/skills/manifest
 */

import { readFileSync } from 'node:fs'
import { RegistryError } from '../util/errors.ts'
import { writeFileAtomic } from '../util/atomic-file.ts'

/** Manifest document version. */
export const MANIFEST_VERSION = 1 as const

/** One installed-skill provenance record. */
export interface SkillRecord {
  /** Install source: path spec, git URL, or later marketplace/catalog name. */
  source: string
  /** Pinned ref for git sources (commit/tag), absent for paths. */
  ref?: string
  /** Which scope's root received the skill. */
  scope: 'user' | 'project'
  /** Absolute target directory (a `<name>/` bundle or `<name>.md` file). */
  target: string
  /** ISO install timestamp. */
  installedAt: string
  /** Origin label for audit (`cli`, `slash:web`, ...). */
  origin: string
}

/** The skills install manifest document. */
export interface SkillsManifest {
  version: typeof MANIFEST_VERSION
  skills: Record<string, SkillRecord>
}

/** An empty manifest. */
export function emptyManifest(): SkillsManifest {
  return { version: MANIFEST_VERSION, skills: {} }
}

/**
 * Read the manifest. A missing file is a valid empty manifest; a corrupt
 * one fails loud — never silently treated as "nothing installed".
 * @param file - absolute manifest path.
 * @returns the parsed manifest.
 */
export function readManifest(file: string): SkillsManifest {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest()
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new RegistryError('INVALID_MANIFEST_FILE', `skills manifest is not valid JSON: ${String(error)}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RegistryError('INVALID_MANIFEST_FILE', 'skills manifest must be a JSON object')
  }
  const doc = raw as Record<string, unknown>
  if (doc.version !== MANIFEST_VERSION) {
    throw new RegistryError('INVALID_MANIFEST_FILE', `skills manifest version ${JSON.stringify(doc.version)} is unsupported — expected ${MANIFEST_VERSION}`)
  }
  if (typeof doc.skills !== 'object' || doc.skills === null || Array.isArray(doc.skills)) {
    throw new RegistryError('INVALID_MANIFEST_FILE', 'skills manifest "skills" must be an object keyed by skill name')
  }
  return { version: MANIFEST_VERSION, skills: doc.skills as SkillsManifest['skills'] }
}

/** Persist the manifest atomically. */
export function writeManifest(file: string, manifest: SkillsManifest): void {
  writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`, 'skills-manifest')
}
