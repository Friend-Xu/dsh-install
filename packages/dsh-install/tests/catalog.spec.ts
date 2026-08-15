/**
 * Catalog tests: URI shorthands, builtin resolution, runtime probing.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_CATALOG, searchBuiltin } from '../src/catalog/builtin.ts'
import { findOnPath, parseUriShorthand, resolveShorthand, runtimeStatus } from '../src/catalog/resolve.ts'

const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-catalog-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseUriShorthand', () => {
  it('maps npx/uvx/docker forms', () => {
    expect(parseUriShorthand('npx:@scope/pkg')).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', '@scope/pkg'] })
    expect(parseUriShorthand('uvx:mcp-server-git')).toEqual({ transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] })
    expect(parseUriShorthand('docker:mcp/git')).toEqual({ transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'mcp/git'] })
    expect(parseUriShorthand('plain-name')).toBeUndefined()
    expect(parseUriShorthand('npx:')).toBeUndefined()
  })
})

describe('resolveShorthand', () => {
  it('resolves builtin entries', () => {
    const input = resolveShorthand('github')
    expect(input).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] })
    expect(input!.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' })
  })

  it('refuses entries that need explicit arguments', () => {
    expect(() => resolveShorthand('filesystem')).toThrowError(expect.objectContaining({ code: 'INVALID_ENTRY' }))
  })

  it('returns undefined for unknown names', () => {
    expect(resolveShorthand('no-such-server')).toBeUndefined()
  })

  it('resolves URI forms directly', () => {
    expect(resolveShorthand('uvx:mcp-server-git')).toMatchObject({ command: 'uvx' })
  })
})

describe('findOnPath', () => {
  it('finds executables in PATH directories', () => {
    const bin = tmp()
    writeFileSync(join(bin, 'npx'), '#!x', 'utf8')
    const env = { PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}/nowhere` }
    expect(findOnPath('npx', env)).toBe(join(bin, 'npx'))
    expect(findOnPath('uvx', env)).toBeUndefined()
  })

  it('honors PATHEXT on Windows and finds uppercase names case-insensitively', () => {
    if (process.platform !== 'win32') return
    const bin = tmp()
    writeFileSync(join(bin, 'NODE.EXE'), 'x', 'utf8')
    const env = { PATH: bin, PATHEXT: '.EXE' }
    expect(findOnPath('node', env)).toMatch(/NODE\.EXE$/i)
  })
})

describe('runtimeStatus', () => {
  it('reports availability from PATH', () => {
    const bin = tmp()
    writeFileSync(join(bin, 'npx'), 'x', 'utf8')
    const env = { PATH: bin }
    const entry = BUILTIN_CATALOG.find(candidate => candidate.name === 'github')!
    expect(runtimeStatus(entry, env)).toMatchObject({ runtime: 'npx', available: true })
    expect(runtimeStatus(entry, { PATH: '' })).toMatchObject({ runtime: 'npx', available: false })
  })
})

describe('searchBuiltin', () => {
  it('matches name and description substrings case-insensitively', () => {
    expect(searchBuiltin('git').map(entry => entry.name)).toContain('github')
    expect(searchBuiltin('PYTHON').map(entry => entry.name)).toContain('git')
    expect(searchBuiltin('')).toHaveLength(BUILTIN_CATALOG.length)
    expect(searchBuiltin('zzzz-no-match')).toEqual([])
  })
})
