/**
 * Slash adapter tests: line tokenization, direct CommandResult rendering,
 * and the command-definition shapes registered on `ctx.commands`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mcpCommandDefinition, runSlashVerb, skillsCommandDefinition, tokenizeCommandLine, type SlashOptions } from '../src/slash.ts'

const PREVIOUS_HOME = process.env.DSH_HOME
const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-slash-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let home: string
let options: SlashOptions

beforeAll(() => {
  home = tmp()
  dirs.pop()
  process.env.DSH_HOME = home
  options = { cwd: home, origin: 'slash:test' }
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (PREVIOUS_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = PREVIOUS_HOME
})

/** Wired lazily in beforeAll; every spec runs after it. */
function opts(): SlashOptions {
  return options
}

describe('tokenizeCommandLine', () => {
  it('splits on whitespace and honors quotes', async () => {
    expect(tokenizeCommandLine('list --format json')).toEqual(['list', '--format', 'json'])
    expect(tokenizeCommandLine('add myapi --header "Authorization: Bearer x"')).toEqual(
      ['add', 'myapi', '--header', 'Authorization: Bearer x'],
    )
    expect(tokenizeCommandLine("add x --env 'A=B C'")).toEqual(['add', 'x', '--env', 'A=B C'])
    expect(tokenizeCommandLine('   ')).toEqual([])
  })
})

describe('runSlashVerb', () => {
  it('renders mcp list as a direct success result', async () => {
    const result = await runSlashVerb('mcp', '', opts())
    expect(result.kind).toBe('success')
  })

  it('adds a server through the shared CLI pipeline', async () => {
    const result = await runSlashVerb('mcp', 'add github -- npx -y server-github', opts())
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' && result.text).toContain('已导入')
  })

  it('returns an error result for failed operations', async () => {
    const result = await runSlashVerb('mcp', 'remove never-installed', opts())
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toContain('NOT_FOUND')
  })

  it('installs skills via the shared pipeline', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'slash-skill'), { recursive: true })
    writeFileSync(join(dir, 'slash-skill', 'SKILL.md'), '---\nname: slash-skill\ndescription: x\n---\n\n# Slash\n', 'utf8')
    const result = await runSlashVerb('skills', `add "${join(dir, 'slash-skill')}"`, opts())
    expect(result.kind).toBe('success')
  })
})

describe('command definitions', () => {
  it('exposes registry-compatible shapes', async () => {
    const mcp = mcpCommandDefinition(opts())
    expect(mcp).toMatchObject({ name: 'mcp' })
    expect(typeof mcp.description).toBe('string')
    expect(mcp.input).toBeDefined()
    const skills = skillsCommandDefinition(opts())
    expect(skills).toMatchObject({ name: 'skills' })
    const result = await skills.handler({ commandId: undefined as never, agent: {} as never, rawInput: 'list', signal: new AbortController().signal })
    expect(result.kind).toBe('success')
  })
})
