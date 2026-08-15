/**
 * Uninstall system tests: bulk server/skill removal, whole-plugin uninstall
 * with dry-run, log preservation, purge, and the "never touch untracked
 * files" boundary.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { addServer, listServers, removeAllServers, resolveRegistryFiles, type RegistryFiles } from '../src/ops/mcp.ts'
import { addSkill, removeAllSkills, resolveSkillFiles } from '../src/ops/skills.ts'
import { addMarketplace } from '../src/ops/market.ts'
import { uninstallAll } from '../src/ops/uninstall.ts'
import { readManifest } from '../src/skills/manifest.ts'
import { readMarketRegistry } from '../src/market/model.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-uninstall-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  // Reset the suite-wide home state: every test starts from a clean plugin home.
  for (const file of ['mcp.json', 'skills-manifest.json', 'marketplaces.json']) rmSync(join(home, file), { force: true })
  for (const dir of ['skills', 'install', 'logs']) rmSync(join(home, dir), { recursive: true, force: true })
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

const ORIGIN = { source: 'test', addedAt: '2026-08-20T00:00:00.000Z' }

function files(): RegistryFiles {
  return resolveRegistryFiles(home)
}

function bundleFixture(name: string): string {
  const dir = tmp()
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`, 'utf8')
  return join(dir, name)
}

describe('removeAllServers', () => {
  it('removes every server in the scope with one verdict each', () => {
    const f = files()
    addServer(f, 'user', 'a', { transport: 'stdio', command: 'npx', args: [] }, ORIGIN)
    addServer(f, 'user', 'b', { transport: 'stdio', command: 'uvx', args: [] }, ORIGIN)
    const report = removeAllServers(f, 'user')
    expect(report.summary).toMatchObject({ imported: 2, failed: 0 })
    expect(listServers(f).servers).toEqual({})
  })

  it('reports nothing-to-remove and writes nothing on dry-run', () => {
    const f = files()
    expect(removeAllServers(f, 'user').verdicts[0]!.message).toContain('nothing to remove')
    addServer(f, 'user', 'a', { transport: 'stdio', command: 'npx', args: [] }, ORIGIN)
    const dry = removeAllServers(f, 'user', true)
    expect(dry.verdicts.some(item => item.message.includes('dry run'))).toBe(true)
    expect(listServers(f).servers.a).toBeDefined()
    // The audit log holds the earlier add but nothing from the dry run.
    const log = readFileSync(join(home, 'logs', 'install.jsonl'), 'utf8')
    expect(log).toContain('mcp add a')
    expect(log).not.toContain('remove --all')
  })
})

describe('removeAllSkills', () => {
  it('removes only manifest-tracked skills of the scope and leaves manual files alone', () => {
    const skillFiles = resolveSkillFiles(home)
    addSkill(skillFiles, 'user', bundleFixture('tracked-a'), { origin: 'test' })
    addSkill(skillFiles, 'user', bundleFixture('tracked-b'), { origin: 'test' })
    // A manual skill the plugin did not install.
    mkdirSync(join(home, 'skills', 'manual-skill'), { recursive: true })
    writeFileSync(join(home, 'skills', 'manual-skill', 'SKILL.md'), '---\nname: manual-skill\n---\n\n# M\n', 'utf8')

    const report = removeAllSkills(skillFiles, 'user')
    expect(report.summary).toMatchObject({ imported: 2, failed: 0 })
    expect(existsSync(join(home, 'skills', 'tracked-a'))).toBe(false)
    expect(existsSync(join(home, 'skills', 'tracked-b'))).toBe(false)
    expect(existsSync(join(home, 'skills', 'manual-skill', 'SKILL.md'))).toBe(true)
    expect(readManifest(join(home, 'skills-manifest.json')).skills).toEqual({})
  })

  it('honors dry-run', () => {
    const skillFiles = resolveSkillFiles(home)
    addSkill(skillFiles, 'user', bundleFixture('dry-skill'), { origin: 'test' })
    const dry = removeAllSkills(skillFiles, 'user', true)
    expect(dry.verdicts.some(item => item.message.includes('dry run'))).toBe(true)
    expect(existsSync(join(home, 'skills', 'dry-skill', 'SKILL.md'))).toBe(true)
  })
})

describe('uninstallAll', () => {
  function seed(): void {
    addMarketplace('mkt', join(tmp(), 'catalog.json'))
    const skillFiles = resolveSkillFiles(home)
    addSkill(skillFiles, 'user', bundleFixture('un-skill'), { origin: 'test' })
    addServer(files(), 'user', 'srv', { transport: 'stdio', command: 'npx', args: [] }, ORIGIN)
    // Leftover archive content.
    mkdirSync(join(home, 'install', 'leftover', 'some-plugin'), { recursive: true })
    writeFileSync(join(home, 'install', 'leftover', 'some-plugin', 'plugin.json'), '{}', 'utf8')
    // A stale clone work directory (as an interrupted run would leave).
    mkdirSync(join(home, 'install', 'work', 'git-stale'), { recursive: true })
    writeFileSync(join(home, 'install', 'work', 'git-stale', 'file.txt'), 'x', 'utf8')
  }

  it('removes everything the plugin manages and keeps the audit log', () => {
    seed()
    const report = uninstallAll(files(), resolveSkillFiles(home))
    expect(report.summary.failed).toBe(0)
    const reminder = report.verdicts.find(item => item.message.includes('profile dependency'))
    expect(reminder?.detail).toContain('dsh plugin --profile')

    expect(readMarketRegistry(join(home, 'marketplaces.json')).marketplaces).toEqual({})
    expect(readManifest(join(home, 'skills-manifest.json')).skills).toEqual({})
    expect(existsSync(join(home, 'skills', 'un-skill'))).toBe(false)
    expect(existsSync(join(home, 'mcp.json'))).toBe(false)
    expect(existsSync(join(home, 'install', 'leftover'))).toBe(false)
    expect(existsSync(join(home, 'install', 'work'))).toBe(false)
    // Audit history survives by default, including this uninstall.
    const log = readFileSync(join(home, 'logs', 'install.jsonl'), 'utf8')
    expect(log).toContain('uninstall')
  })

  it('purges the audit log only on explicit request', () => {
    seed()
    const report = uninstallAll(files(), resolveSkillFiles(home), { purgeLog: true })
    expect(report.summary.failed).toBe(0)
    expect(existsSync(join(home, 'logs', 'install.jsonl'))).toBe(false)
  })

  it('writes nothing on dry-run', () => {
    seed()
    const report = uninstallAll(files(), resolveSkillFiles(home), { dryRun: true })
    expect(report.verdicts.some(item => item.message.includes('dry run'))).toBe(true)
    expect(existsSync(join(home, 'mcp.json'))).toBe(true)
    expect(existsSync(join(home, 'skills', 'un-skill'))).toBe(true)
    expect(readMarketRegistry(join(home, 'marketplaces.json')).marketplaces.mkt).toBeDefined()
    // Seeding audited adds, but the dry-run uninstall must not be in the log.
    const log = readFileSync(join(home, 'logs', 'install.jsonl'), 'utf8')
    expect(log).toContain('"action":"mcp add srv"')
    expect(log).not.toContain('"action":"uninstall')
  })

  it('is idempotent: a second uninstall reports nothing left', () => {
    seed()
    uninstallAll(files(), resolveSkillFiles(home))
    const again = uninstallAll(files(), resolveSkillFiles(home))
    expect(again.summary.failed).toBe(0)
    expect(again.summary.imported).toBeLessThanOrEqual(1)
  })
})
