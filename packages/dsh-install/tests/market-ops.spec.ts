/**
 * Market + import ops tests: catalog parsing (both shapes), marketplace
 * registry CRUD with local-file sources, bulk server import, and
 * claude-plugin content extraction with leftover archiving.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseCatalog } from '../src/market/model.ts'
import { addMarketplace, listMarketplaces, removeMarketplace, syncMarketplace } from '../src/ops/market.ts'
import { importServers, normalizePluginSource, extractClaudePlugin } from '../src/ops/import.ts'
import { resolveRegistryFiles, type RegistryFiles } from '../src/ops/mcp.ts'
import { resolveSkillFiles } from '../src/ops/skills.ts'
import { readManifest } from '../src/skills/manifest.ts'
import { installWorkPath } from '../src/registry/paths.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-market-${process.pid}-${Math.random().toString(36).slice(2)}`)
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

const ORIGIN = { source: 'test', addedAt: '2026-08-20T00:00:00.000Z' }

describe('parseCatalog', () => {
  it('parses the DSH-native shape', () => {
    const catalog = parseCatalog(JSON.stringify({
      name: 'native',
      servers: [{ name: 's1', description: 'd', source: 'npx:s1' }],
      skills: [{ name: 'k1', description: 'd', source: 'owner/repo#k1' }],
    }), 'fallback')
    expect(catalog.name).toBe('native')
    expect(catalog.servers).toHaveLength(1)
    expect(catalog.skills[0]).toMatchObject({ name: 'k1' })
  })

  it('parses the claude marketplace shape', () => {
    const catalog = parseCatalog(JSON.stringify({
      name: 'claude-mkt',
      owner: { name: 'acme' },
      plugins: [{ name: 'p1', description: 'd', source: { sourceType: 'github', githubUrl: 'https://github.com/acme/p1' } }],
      mcpServers: [{ name: 'srv', description: 'd', url: 'npx:@scope/srv' }],
    }), 'fallback')
    expect(catalog.name).toBe('claude-mkt')
    expect(catalog.plugins[0]).toMatchObject({ name: 'p1', claudeSource: 'https://github.com/acme/p1' })
    expect(catalog.servers[0]).toMatchObject({ name: 'srv', source: 'npx:@scope/srv' })
  })

  it('rejects documents with no known arrays', () => {
    expect(() => parseCatalog('{"name":"x"}', 'fallback')).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY' }))
  })
})

describe('marketplace ops', () => {
  it('registers, lists, syncs (local file), and removes', async () => {
    const catalogFile = join(tmp(), 'catalog.json')
    writeFileSync(catalogFile, JSON.stringify({ name: 'local-mkt', servers: [{ name: 'srv', description: 'd', source: 'npx:x' }] }), 'utf8')

    expect(addMarketplace('local-mkt', catalogFile).summary).toMatchObject({ imported: 1 })
    expect(addMarketplace('local-mkt', catalogFile).verdicts[0]).toMatchObject({ code: 'DUPLICATE_SERVER' })
    expect(addMarketplace('bad name!', catalogFile).verdicts[0]).toMatchObject({ code: 'INVALID_NAME' })

    const listed = listMarketplaces()
    expect(listed.marketplaces['local-mkt']).toMatchObject({ source: catalogFile })

    const synced = await syncMarketplace('local-mkt')
    expect(synced.verdicts[0]).toMatchObject({ kind: 'imported' })
    expect(listMarketplaces().marketplaces['local-mkt']!.lastSync).toBeDefined()

    expect(removeMarketplace('local-mkt').summary.imported).toBe(1)
    expect(listMarketplaces().marketplaces['local-mkt']).toBeUndefined()
    expect((await syncMarketplace('local-mkt')).verdicts[0]).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports sync failures per marketplace without dropping others', async () => {
    const good = join(tmp(), 'good.json')
    writeFileSync(good, JSON.stringify({ servers: [] }), 'utf8')
    addMarketplace('good', good)
    addMarketplace('bad', join(tmp(), 'missing.json'))
    const report = await syncMarketplace()
    expect(report.verdicts).toHaveLength(2)
    expect(report.verdicts[0]).toMatchObject({ kind: 'imported' })
    expect(report.verdicts[1]).toMatchObject({ kind: 'failed', code: 'SOURCE_UNREACHABLE' })
  })
})

describe('import ops', () => {
  function files(): RegistryFiles {
    return resolveRegistryFiles(home)
  }

  it('bulk-imports with per-server verdicts (mixed ok/dup/invalid)', () => {
    const report = importServers(files(), 'user', [
      { name: 'ok-a', input: { transport: 'stdio', command: 'npx', args: [] } },
      { name: 'ok-a', input: { transport: 'stdio', command: 'other', args: [] } },
      { name: 'bad name!', input: { transport: 'stdio', command: 'x', args: [] } },
    ], ORIGIN)
    expect(report.summary).toMatchObject({ imported: 1, failed: 2 })
    expect(report.verdicts.some(item => item.code === 'DUPLICATE_SERVER')).toBe(true)
    expect(report.verdicts.some(item => item.code === 'INVALID_NAME')).toBe(true)
  })

  it('extracts a claude-plugin package: skills + mcpServers install, code payloads archive', () => {
    const pluginDir = join(tmp(), 'superpowers')
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
    mkdirSync(join(pluginDir, 'skills', 'brainstorming'), { recursive: true })
    mkdirSync(join(pluginDir, 'skills', 'undocumented-skill'), { recursive: true })
    mkdirSync(join(pluginDir, 'commands'), { recursive: true })
    writeFileSync(join(pluginDir, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: x\n---\n\n# B\n', 'utf8')
    // Directory-convention skill: NOT declared in the manifest (the real
    // obra/superpowers shape) — still discovered and installed.
    writeFileSync(join(pluginDir, 'skills', 'undocumented-skill', 'SKILL.md'), '---\nname: undocumented-skill\ndescription: x\n---\n\n# U\n', 'utf8')
    writeFileSync(join(pluginDir, 'commands', 'review.md'), '# review\n', 'utf8')
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'superpowers',
      skills: ['brainstorming'],
      mcpServers: { gh: { command: 'npx', args: ['-y', 'server-github'] } },
      commands: ['./commands/review.md'],
      agents: ['./agents/qa.md'],
      hooks: [],
    }), 'utf8')

    const extraction = extractClaudePlugin(files(), resolveSkillFiles(home), 'user', pluginDir, ORIGIN)
    expect(extraction.installedSkills.sort()).toEqual(['brainstorming', 'undocumented-skill'])
    expect(extraction.installedServers).toEqual(['gh'])
    expect(extraction.incompatible.some(item => item.code === 'INCOMPATIBLE_COMMANDS')).toBe(true)
    expect(extraction.incompatible.some(item => item.code === 'INCOMPATIBLE_AGENTS')).toBe(true)

    // Effects on disk: skill manifest, registry entry, leftover archive.
    const manifest = readManifest(join(home, 'skills-manifest.json'))
    expect(manifest.skills['brainstorming']).toBeDefined()
    expect(manifest.skills['undocumented-skill']).toBeDefined()
    const registry = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))
    expect(registry.servers.gh).toBeDefined()
    expect(existsSync(join(extraction.leftoverDir, 'plugin.json'))).toBe(true)
    expect(existsSync(join(extraction.leftoverDir, 'commands', 'review.md'))).toBe(true)
  })

  it('rejects non-plugin directories', () => {
    const notPlugin = tmp()
    expect(() => extractClaudePlugin(files(), resolveSkillFiles(home), 'user', notPlugin, ORIGIN)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENTRY' }),
    )
  })

  it('normalizes plugin sources: URLs become git specs, local paths pass through', () => {
    expect(normalizePluginSource('https://github.com/acme/plugin')).toBe('git+https://github.com/acme/plugin')
    expect(normalizePluginSource('github:acme/plugin#sub@v1')).toBe('github:acme/plugin#sub@v1')
    expect(normalizePluginSource('C:/local/plugin')).toBe('C:/local/plugin')
    expect(() => normalizePluginSource('   ')).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY' }))
  })

  it('local extractions never touch the ephemeral clone work directory', () => {
    const pluginDir = join(tmp(), 'local-plugin')
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'local-plugin', skills: [] }), 'utf8')
    extractClaudePlugin(files(), resolveSkillFiles(home), 'user', pluginDir, ORIGIN)
    expect(existsSync(installWorkPath())).toBe(false)
    expect(existsSync(join(home, 'install', 'leftover', 'local-plugin', 'plugin.json'))).toBe(true)
  })
})
