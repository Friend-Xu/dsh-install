/**
 * Skill installer tests: source resolution, git spec parsing, SKILL.md
 * detection, frontmatter names, target shapes, and the ops layer
 * (add/list/remove/update) with manifest tracking.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { findSkillMarkdown, frontmatterName, installSkill, parseGitSpec, removeInstalledSkill, resolveSource, targetFor } from '../src/skills/installer.ts'
import { readManifest } from '../src/skills/manifest.ts'
import { addSkill, removeSkill, resolveSkillFiles, updateSkill } from '../src/ops/skills.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-skills-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let home: string

beforeAll(() => {
  home = tmp()
  dirs.pop()
  process.env.DSH_HOME = home
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_HOME
})

function bundleFixture(name: string, frontmatter?: string): string {
  const dir = tmp()
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), frontmatter === undefined
    ? `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`
    : frontmatter, 'utf8')
  return join(dir, name)
}

describe('parseGitSpec', () => {
  it('parses every supported shape', () => {
    expect(parseGitSpec('github:owner/repo')).toEqual({ url: 'https://github.com/owner/repo' })
    expect(parseGitSpec('owner/repo')).toEqual({ url: 'https://github.com/owner/repo' })
    expect(parseGitSpec('owner/repo#sub@v1.0')).toEqual({ url: 'https://github.com/owner/repo', subdir: 'sub', ref: 'v1.0' })
    expect(parseGitSpec('owner/repo#sub')).toEqual({ url: 'https://github.com/owner/repo', subdir: 'sub' })
    expect(parseGitSpec('owner/repo@main')).toEqual({ url: 'https://github.com/owner/repo', ref: 'main' })
    expect(parseGitSpec('git+https://example.com/x/y#dir')).toEqual({ url: 'https://example.com/x/y', subdir: 'dir' })
  })

  it('rejects an empty ref and returns undefined for non-git specs', () => {
    expect(() => parseGitSpec('owner/repo#sub@')).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY' }))
    expect(parseGitSpec('/abs/local/path')).toBeUndefined()
    expect(parseGitSpec('./relative/path')).toBeUndefined()
  })
})

describe('installer', () => {
  it('finds SKILL.md in bundle directories and flat files', () => {
    const bundle = bundleFixture('find-me')
    expect(findSkillMarkdown(bundle)).toBe(join(bundle, 'SKILL.md'))
    const dir = tmp()
    const flat = join(dir, 'flat.md')
    writeFileSync(flat, '# flat\n', 'utf8')
    expect(findSkillMarkdown(flat)).toBe(flat)
    expect(findSkillMarkdown(dir)).toBeUndefined()
  })

  it('reads frontmatter names and falls back to undefined', () => {
    const bundle = bundleFixture('named', '---\nname: front-name\ndescription: x\n---\n\nbody\n')
    expect(frontmatterName(join(bundle, 'SKILL.md'))).toBe('front-name')
    const dir = tmp()
    const noName = join(dir, 'plain.md')
    writeFileSync(noName, '# plain\n', 'utf8')
    expect(frontmatterName(noName)).toBeUndefined()
  })

  it('computes targets and installs copies and symlinks', () => {
    const root = tmp()
    expect(targetFor(root, 'some-skill', true)).toBe(join(root, 'some-skill'))
    expect(targetFor(root, 'some-skill', false)).toBe(join(root, 'some-skill.md'))

    const bundle = bundleFixture('copy-me')
    const copied = installSkill({ source: resolveSource(bundle, root), skillRoot: root, name: 'copy-me', link: false })
    expect(copied).toBe(join(root, 'copy-me'))
    expect(existsSync(join(copied, 'SKILL.md'))).toBe(true)

    const linked = installSkill({ source: resolveSource(bundle, root), skillRoot: root, name: 'linked-me', link: true })
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)

    removeInstalledSkill(copied)
    removeInstalledSkill(linked)
    expect(existsSync(copied)).toBe(false)
    expect(existsSync(linked)).toBe(false)
  })

  it('rejects invalid names, missing SKILL.md, and existing targets', () => {
    const root = tmp()
    const bundle = bundleFixture('ok-skill')
    expect(() => installSkill({ source: resolveSource(bundle, root), skillRoot: root, name: 'Bad Name', link: false })).toThrowError(
      expect.objectContaining({ code: 'INVALID_NAME' }),
    )
    const empty = tmp()
    expect(() => installSkill({ source: resolveSource(empty, root), skillRoot: root, name: 'nothing', link: false })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENTRY' }),
    )
    installSkill({ source: resolveSource(bundle, root), skillRoot: root, name: 'ok-skill', link: false })
    expect(() => installSkill({ source: resolveSource(bundle, root), skillRoot: root, name: 'ok-skill', link: false })).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_SERVER' }),
    )
  })

  it('fails on missing local sources', () => {
    const root = tmp()
    expect(() => resolveSource(join(root, 'absent'), root)).toThrowError(expect.objectContaining({ code: 'SOURCE_UNREACHABLE' }))
  })
})

describe('ops.skills', () => {
  function files(): ReturnType<typeof resolveSkillFiles> {
    return resolveSkillFiles(home)
  }

  it('tracks installs in the manifest with source and target', () => {
    const bundle = bundleFixture('tracked-skill')
    const report = addSkill(files(), 'user', bundle, { origin: 'test' })
    expect(report.summary).toMatchObject({ imported: 1, failed: 0 })
    const manifest = readManifest(join(home, 'skills-manifest.json'))
    expect(manifest.skills['tracked-skill']).toMatchObject({ scope: 'user', source: bundle })
    expect(manifest.skills['tracked-skill']!.target).toBe(join(home, 'skills', 'tracked-skill'))
  })

  it('honors an explicit --name override', () => {
    const bundle = bundleFixture('original-name')
    const report = addSkill(files(), 'user', bundle, { name: 'renamed-skill', origin: 'test' })
    expect(report.summary.imported).toBe(1)
    expect(existsSync(join(home, 'skills', 'renamed-skill', 'SKILL.md'))).toBe(true)
    expect(readManifest(join(home, 'skills-manifest.json')).skills['renamed-skill']).toBeDefined()
  })

  it('rejects duplicate manifest names', () => {
    const bundle = bundleFixture('dupe')
    addSkill(files(), 'user', bundle, { origin: 'test' })
    const again = addSkill(files(), 'user', bundle, { name: 'dupe', origin: 'test' })
    expect(again.verdicts[0]).toMatchObject({ kind: 'failed', code: 'DUPLICATE_SERVER' })
  })

  it('remove only touches manifest-tracked installs', () => {
    const bundle = bundleFixture('gone-skill')
    addSkill(files(), 'user', bundle, { origin: 'test' })
    const removed = removeSkill(files(), 'gone-skill')
    expect(removed.summary.imported).toBe(1)
    expect(existsSync(join(home, 'skills', 'gone-skill'))).toBe(false)
    expect(readManifest(join(home, 'skills-manifest.json')).skills['gone-skill']).toBeUndefined()
    expect(removeSkill(files(), 'never-installed').verdicts[0]).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('update swaps the source and keeps the record', () => {
    const first = bundleFixture('upgradable')
    addSkill(files(), 'user', first, { origin: 'test' })
    const second = bundleFixture('upgradable-v2')
    const report = updateSkill(files(), 'upgradable', second, { origin: 'test' })
    expect(report.summary.imported).toBe(1)
    const record = readManifest(join(home, 'skills-manifest.json')).skills['upgradable']!
    expect(record.source).toBe(second)
    expect(existsSync(record.target)).toBe(true)
  })
})
