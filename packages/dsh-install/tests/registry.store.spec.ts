import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyRegistry, normalizeServer, type McpRegistry, type ServerEntry } from '../src/registry/model.ts'
import { mergeRegistries, readRegistry, writeRegistry } from '../src/registry/store.ts'

const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-install-store-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const origin = { source: 'test', addedAt: '2026-08-20T00:00:00.000Z' }
const server = (command: string): ServerEntry => normalizeServer({ transport: 'stdio', command }, origin)
const registryWith = (entries: Record<string, ServerEntry>): McpRegistry => ({ version: 1, servers: entries })

describe('store.readRegistry', () => {
  it('reads a missing file as an empty registry', () => {
    expect(readRegistry(join(tmp(), 'absent.json'))).toEqual(emptyRegistry())
  })

  it('round-trips a written document', () => {
    const file = join(tmp(), 'mcp.json')
    const registry = registryWith({
      github: normalizeServer({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      }, origin),
    })
    writeRegistry(file, registry)
    expect(readRegistry(file)).toEqual(registry)
  })

  it('creates parent directories on write', () => {
    const file = join(tmp(), 'deep', 'nested', 'mcp.json')
    writeRegistry(file, emptyRegistry())
    expect(readFileSync(file, 'utf8')).toContain('"version": 1')
  })

  it('fails loud on a corrupt present file', () => {
    const file = join(tmp(), 'mcp.json')
    writeFileSync(file, '{ not json', 'utf8')
    expect(() => readRegistry(file)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REGISTRY_FILE' }),
    )
  })
})

describe('store.mergeRegistries', () => {
  it('merges disjoint scopes', () => {
    const merged = mergeRegistries(registryWith({ a: server('a') }), registryWith({ b: server('b') }))
    expect(Object.keys(merged)).toEqual(['a', 'b'])
    expect(merged.a).toMatchObject({ scope: 'user', shadowed: false })
    expect(merged.b).toMatchObject({ scope: 'project', shadowed: false })
  })

  it('project shadows user by name and marks shadowing', () => {
    const merged = mergeRegistries(registryWith({ a: server('user-a') }), registryWith({ a: server('project-a') }))
    expect(merged.a).toMatchObject({ scope: 'project', shadowed: true })
  })

  it('sorts names', () => {
    const merged = mergeRegistries(registryWith({ z: server('z'), a: server('a') }), emptyRegistry())
    expect(Object.keys(merged)).toEqual(['a', 'z'])
  })
})
