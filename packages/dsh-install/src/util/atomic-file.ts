/**
 * Atomic file writes: unique temp file in the target directory, then rename
 * over the destination. Shared by the registry store, the skill manifest,
 * and the marketplace manifest so a watcher never observes a torn document.
 * @module dsh-install/util/atomic-file
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Atomically write text content to a file, creating parent directories.
 * @param file - absolute target path.
 * @param content - the full text content.
 * @param label - a distinguishing token for the temp-file name.
 */
export function writeFileAtomic(file: string, content: string, label = 'json'): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = join(dirname(file), `.${process.pid}.${randomBytes(6).toString('hex')}.${label}.tmp`)
  writeFileSync(temp, content, 'utf8')
  try {
    renameSync(temp, file)
  } catch (error) {
    try { writeFileSync(temp, '', 'utf8') } catch { /* best effort */ }
    throw error
  }
}
