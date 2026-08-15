/**
 * CLI surface tests: `runManagement` end to end with fake IO and a temp
 * \$DSH_HOME\ - grammar, exit codes, output formats, and on-disk effects.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runManagement, type ManagementRuntime } from '../src/management.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-cli-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  // Reset the suite-wide home state: every test starts from an empty registry
  // and no installed skills.
  for (const file of ['mcp.json', 'skills-manifest.json']) rmSync(join(home, file), { force: true })
  rmSync(join(home, 'skills'), { recursive: true, force: true })
  rmSync(join(home, 'logs'), { recursive: true, force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let home: string

beforeAll(() => {
  home = tmp()
  // Keep the home fixture out of the per-test cleanup rotation; it lives for
  // the whole suite (each test starts from a fresh DSH_HOME on disk).
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

function registryOnDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8'))
}

describe('mcp CLI', () => {
  it('adds a stdio server from `--` passthrough with -e env flags', async () => {
    const result = await run(['mcp', 'add', 'github', '-e', 'GITHUB_TOKEN', '--', 'npx', '-y', '@modelcontextprotocol/server-github'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('已导入')
    const registry = registryOnDisk()
    expect(registry.servers).toHaveProperty('github')
    const server = (registry.servers as Record<string, { command: string; args: string[]; env: Record<string, string>; enabled: boolean }>).github!
    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
    expect(server.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' })
    expect(server.enabled).toBe(true)
  })

  it('adds a streamable-http server with headers and timeout', async () => {
    const result = await run(['mcp', 'add', 'myapi', '--transport', 'http', '--url', 'https://api.example.com/mcp',
      '--header', 'Authorization: Bearer ${T}', '--timeout', '30000'])
    expect(result.code).toBe(0)
    const server = (registryOnDisk().servers as Record<string, { transport: string; url: string; headers: Record<string, string>; toolCallTimeoutMs: number }>).myapi!
    expect(server.transport).toBe('streamable-http')
    expect(server.url).toBe('https://api.example.com/mcp')
    expect(server.headers).toEqual({ Authorization: 'Bearer ${T}' })
    expect(server.toolCallTimeoutMs).toBe(30_000)
  })

  it('rejects a stdio add without a command', async () => {
    const result = await run(['mcp', 'add', 'x'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('unknown shorthand')
  })

  it('rejects http adds without a URL', async () => {
    const result = await run(['mcp', 'add', 'x', '--transport', 'http'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('--url')
  })

  it('lists servers with flags and json format', async () => {
    await run(['mcp', 'add', 'github', '--', 'npx', '-y', 'server-github'])
    await run(['mcp', 'off', 'github'])
    const text = await run(['mcp', 'list'])
    expect(text.out).toContain('github')
    expect(text.out).toContain('disabled')
    const json = await run(['mcp', 'list', '--format', 'json'])
    const lines = JSON.parse(json.out) as string[]
    expect(lines.some(line => line.startsWith('github'))).toBe(true)
  })

  it('gets one server as JSON and fails for missing names', async () => {
    await run(['mcp', 'add', 'github', '--', 'npx', 'server'])
    const got = await run(['mcp', 'get', 'github'])
    expect(got.code).toBe(0)
    expect(JSON.parse(got.out).command).toBe('npx')
    const missing = await run(['mcp', 'get', 'nope'])
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('NOT_FOUND')
  })

  it('rejects duplicate adds without overwriting', async () => {
    await run(['mcp', 'add', 'github', '--', 'npx', 'one'])
    const again = await run(['mcp', 'add', 'github', '--', 'npx', 'two'])
    expect(again.code).toBe(1)
    expect(again.out).toContain('DUPLICATE_SERVER')
    expect((registryOnDisk().servers as Record<string, { args: string[] }>).github!.args).toEqual(['one'])
  })

  it('turns servers on and off', async () => {
    await run(['mcp', 'add', 'github', '--', 'npx', 'server'])
    expect((await run(['mcp', 'off', 'github'])).code).toBe(0)
    expect((registryOnDisk().servers as Record<string, { enabled: boolean }>).github!.enabled).toBe(false)
    expect((await run(['mcp', 'on', 'github'])).code).toBe(0)
    expect((registryOnDisk().servers as Record<string, { enabled: boolean }>).github!.enabled).toBe(true)
  })

  it('removes servers', async () => {
    await run(['mcp', 'add', 'github', '--', 'npx', 'server'])
    expect((await run(['mcp', 'remove', 'github'])).code).toBe(0)
    expect(registryOnDisk().servers).toEqual({})
    expect((await run(['mcp', 'remove', 'github'])).code).toBe(1)
  })

  it('updates an existing server configuration', async () => {
    await run(['mcp', 'add', 'web', '--', 'npx', 'server'])
    const result = await run(['mcp', 'update', 'web', '--transport', 'http', '--url', 'http://localhost:3000/mcp'])
    expect(result.code).toBe(0)
    expect((registryOnDisk().servers as Record<string, { transport: string }>).web!.transport).toBe('streamable-http')
  })

  it('supports --dry-run without writing', async () => {
    const result = await run(['mcp', 'add', 'github', '--dry-run', '--', 'npx', 'server'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('would add github')
    expect(existsSync(join(home, 'mcp.json'))).toBe(false)
  })

  it('scopes to the project registry from inside a git project', async () => {
    const project = tmp()
    mkdirSync(join(project, '.git'))
    const result = await run(['mcp', 'add', 'proj', '--scope', 'project', '--', 'npx', 'server'], project)
    expect(result.code).toBe(0)
    const projectRegistry = JSON.parse(readFileSync(join(project, '.dsh', 'mcp.json'), 'utf8'))
    expect(projectRegistry.servers).toHaveProperty('proj')
  })

  it('prints help with exit 0 and errors on unknown verbs', async () => {
    const help = await run(['mcp', '--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage')
    const unknown = await run(['frobnicate'])
    expect(unknown.code).toBe(1)
  })
})

function makeSkillFixture(name: string, bodyName?: string): string {
  const dir = tmp()
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${bodyName ?? name}\ndescription: fixture skill\n---\n\n# ${bodyName ?? name}\n`, 'utf8')
  return dir
}

describe('skills CLI', () => {
  it('installs a local bundle directory, lists it, and removes it', async () => {
    const source = makeSkillFixture('my-skill')
    const added = await run(['skills', 'add', join(source, 'my-skill')])
    expect(added.code).toBe(0)
    expect(added.out).toContain('installed skill')
    expect(existsSync(join(home, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)

    const listed = await run(['skills', 'list'])
    expect(listed.out).toContain('my-skill')

    const removed = await run(['skills', 'remove', 'my-skill'])
    expect(removed.code).toBe(0)
    expect(existsSync(join(home, 'skills', 'my-skill'))).toBe(false)
    expect((await run(['skills', 'remove', 'my-skill'])).code).toBe(1)
  })

  it('installs a flat markdown file and honors --link symlinks', async () => {
    const dir = tmp()
    const flat = join(dir, 'flat-skill.md')
    writeFileSync(flat, '---\nname: flat-skill\ndescription: flat\n---\n\n# Flat\n', 'utf8')
    expect((await run(['skills', 'add', flat])).code).toBe(0)
    expect(existsSync(join(home, 'skills', 'flat-skill.md'))).toBe(true)
    await run(['skills', 'remove', 'flat-skill'])

    const source = makeSkillFixture('linked-skill')
    expect((await run(['skills', 'add', join(source, 'linked-skill'), '--link'])).code).toBe(0)
    expect(lstatSync(join(home, 'skills', 'linked-skill')).isSymbolicLink()).toBe(true)
  })

  it('rejects invalid sources and duplicate installs', async () => {
    const dir = tmp()
    expect((await run(['skills', 'add', join(dir, 'no-such-skill')])).code).toBe(1)
    const source = makeSkillFixture('dup-skill')
    expect((await run(['skills', 'add', join(source, 'dup-skill')])).code).toBe(0)
    expect((await run(['skills', 'add', join(source, 'dup-skill')])).code).toBe(1)
  })

  it('updates an installed skill from a new source', async () => {
    const first = makeSkillFixture('up-skill')
    writeFileSync(join(first, 'up-skill', 'SKILL.md'), '---\nname: up-skill\ndescription: v1\n---\n\n# v1\n', 'utf8')
    expect((await run(['skills', 'add', join(first, 'up-skill')])).code).toBe(0)
    const second = makeSkillFixture('up-skill-v2')
    expect((await run(['skills', 'update', 'up-skill', join(second, 'up-skill-v2')])).code).toBe(0)
    expect(readFileSync(join(home, 'skills', 'up-skill', 'SKILL.md'), 'utf8')).toContain('up-skill-v2')
  })

  it('installs into the project skills root when scoped inside a project', async () => {
    const project = tmp()
    mkdirSync(join(project, '.git'))
    const source = makeSkillFixture('proj-skill')
    const result = await run(['skills', 'add', join(source, 'proj-skill'), '--scope', 'project'], project)
    expect(result.code).toBe(0)
    expect(existsSync(join(project, '.dsh', 'skills', 'proj-skill', 'SKILL.md'))).toBe(true)
  })
})
