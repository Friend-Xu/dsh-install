/**
 * CLI end-to-end for the M4 surface: catalog shorthand adds, search,
 * marketplace verbs, config imports, doctor, and plugin content extraction.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runManagement, type ManagementRuntime } from '../src/management.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-cli-m4-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const file of ['mcp.json', 'skills-manifest.json', 'marketplaces.json']) rmSync(join(home, file), { force: true })
  rmSync(join(home, 'skills'), { recursive: true, force: true })
  rmSync(join(home, 'install'), { recursive: true, force: true })
  rmSync(join(home, 'logs'), { recursive: true, force: true })
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

interface RunResult {
  code: number
  out: string
  err: string
}

async function run(args: string[], cwd = home): Promise<RunResult> {
  let out = ''
  let err = ''
  let code = -1
  const runtime: ManagementRuntime = {
    cwd,
    stdout: { write: chunk => { out += String(chunk) } },
    stderr: { write: chunk => { err += String(chunk) } },
    exit: exitCode => { code = exitCode },
    origin: 'test',
  }
  await runManagement(args, runtime)
  return { code, out, err }
}

describe('catalog shorthand adds', () => {
  it('adds a builtin entry by name', async () => {
    const result = await run(['mcp', 'add', 'github'])
    expect(result.code).toBe(0)
    const registry = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))
    expect(registry.servers.github.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
    expect(registry.servers.github.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' })
  })

  it('adds URI shorthands under a derived valid name', async () => {
    const result = await run(['mcp', 'add', 'uvx:mcp-server-git'])
    expect(result.code).toBe(0)
    const registry = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))
    expect(registry.servers['mcp-server-git']).toMatchObject({ command: 'uvx', args: ['mcp-server-git'] })
  })

  it('refuses catalog entries that need explicit arguments', async () => {
    const result = await run(['mcp', 'add', 'filesystem'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('needs extra arguments')
  })

  it('rejects unknown shorthands with a search hint', async () => {
    const result = await run(['mcp', 'add', 'no-such-server'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('search no-such-server')
  })
})

describe('search', () => {
  it('lists matching builtin entries', async () => {
    const result = await run(['search', 'github'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('builtin\tgithub')
  })

  it('includes marketplace catalogs', async () => {
    const catalogFile = join(tmp(), 'catalog.json')
    writeFileSync(catalogFile, JSON.stringify({ name: 'mkt', servers: [{ name: 'special-srv', description: 'special', source: 'npx:x' }] }), 'utf8')
    expect((await run(['marketplace', 'add', 'mkt', catalogFile])).code).toBe(0)
    const result = await run(['search', 'special'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('mkt\tspecial-srv')
  })
})

describe('mcp import', () => {
  it('imports an .mcp.json file', async () => {
    const source = join(tmp(), '.mcp.json')
    writeFileSync(source, JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'server-github'] },
        web: { type: 'http', url: 'http://localhost:3000/mcp' },
      },
    }), 'utf8')
    const result = await run(['mcp', 'import', '--from', 'mcp-json', '--path', source])
    expect(result.code).toBe(0)
    expect(result.out).toContain('github')
    const registry = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))
    expect(registry.servers.github).toBeDefined()
    expect(registry.servers.web.transport).toBe('streamable-http')
  })

  it('reports missing files as errors', async () => {
    const result = await run(['mcp', 'import', '--path', join(tmp(), 'absent.json')])
    expect(result.code).toBe(1)
    expect(result.err).toContain('cannot read')
  })

  it('rejects unknown --from kinds', async () => {
    expect((await run(['mcp', 'import', '--from', 'nonsense'])).code).toBe(1)
  })
})

describe('mcp doctor', () => {
  it('reports runtime and env status without mounting', async () => {
    const bin = tmp()
    writeFileSync(join(bin, 'npx'), 'x', 'utf8')
    const oldPath = process.env.PATH
    process.env.PATH = bin
    try {
      await run(['mcp', 'add', 'github'])
      const result = await run(['mcp', 'doctor', 'github'])
      expect(result.code).toBe(0)
      expect(result.out).toContain('runtime "npx" found')
      expect(result.out).toContain('GITHUB_TOKEN is not set')
    } finally {
      process.env.PATH = oldPath
    }
  })

  it('fails for unknown servers', async () => {
    expect((await run(['mcp', 'doctor', 'nope'])).code).toBe(1)
  })
})

describe('plugin install', () => {
  it('plans a dsh bundle install as a forwarded dsh plugin add', async () => {
    const catalogFile = join(tmp(), 'catalog.json')
    writeFileSync(catalogFile, JSON.stringify({
      name: 'mkt',
      plugins: [{ name: 'bundle-plugin', description: 'd', dshSource: 'dsh-bundle-plugin' }],
    }), 'utf8')
    await run(['marketplace', 'add', 'mkt', catalogFile])
    const result = await run(['plugin', 'install', 'bundle-plugin@mkt'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('dsh plugin --profile web add dsh-bundle-plugin')
  })

  it('extracts content from a claude-plugin entry with --extract-content', async () => {
    const pluginDir = join(tmp(), 'acme-plugin')
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true })
    mkdirSync(join(pluginDir, 'skills', 'acme-skill'), { recursive: true })
    writeFileSync(join(pluginDir, 'skills', 'acme-skill', 'SKILL.md'), '---\nname: acme-skill\ndescription: x\n---\n\n# A\n', 'utf8')
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: 'acme-plugin',
      skills: ['acme-skill'],
      mcpServers: { gh: { command: 'npx', args: ['-y', 'x'] } },
    }), 'utf8')
    const catalogFile = join(tmp(), 'catalog.json')
    writeFileSync(catalogFile, JSON.stringify({
      name: 'mkt',
      plugins: [{ name: 'acme-plugin', description: 'd', source: { sourceType: 'github', githubUrl: pluginDir } }],
    }), 'utf8')
    await run(['marketplace', 'add', 'mkt', catalogFile])
    const result = await run(['plugin', 'install', 'acme-plugin@mkt', '--extract-content'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('acme-skill')
    expect(existsSync(join(home, 'skills', 'acme-skill', 'SKILL.md'))).toBe(true)
  })

  it('reports claude plugins without extraction as incompatible', async () => {
    const catalogFile = join(tmp(), 'catalog.json')
    writeFileSync(catalogFile, JSON.stringify({
      name: 'mkt',
      plugins: [{ name: 'claude-only', description: 'd', source: { sourceType: 'github', githubUrl: 'https://github.com/x/y' } }],
    }), 'utf8')
    await run(['marketplace', 'add', 'mkt', catalogFile])
    const result = await run(['plugin', 'install', 'claude-only@mkt'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('INCOMPATIBLE_PLUGIN')
    expect(result.out).toContain('--extract-content')
  })

  it('fails for unknown marketplaces and plugins', async () => {
    expect((await run(['plugin', 'install', 'x@no-mkt'])).code).toBe(1)
    const catalogFile = join(tmp(), 'catalog.json')
    writeFileSync(catalogFile, JSON.stringify({ name: 'mkt', plugins: [] }), 'utf8')
    await run(['marketplace', 'add', 'mkt', catalogFile])
    expect((await run(['plugin', 'install', 'nope@mkt'])).code).toBe(1)
  })
})
