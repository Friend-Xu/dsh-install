import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandEnvValue, expandRecord, parseEnvValue } from '../src/registry/envref.ts'
import { normalizeServer, parseRegistry, type RawServerInput } from '../src/registry/model.ts'
import { RegistryError } from '../src/util/errors.ts'

describe('envref', () => {
  it('parses a full-string template as an env reference', () => {
    expect(parseEnvValue('${GITHUB_TOKEN}')).toEqual({ kind: 'env', variable: 'GITHUB_TOKEN' })
  })

  it('keeps literals literal and parses embedded templates into segments', () => {
    expect(parseEnvValue('Bearer abc')).toEqual({ kind: 'literal', value: 'Bearer abc' })
    expect(parseEnvValue('prefix-${TOKEN}-suffix')).toEqual({
      kind: 'template',
      segments: ['prefix-', { variable: 'TOKEN' }, '-suffix'],
    })
  })

  it('expands embedded templates and reports missing parts', () => {
    expect(expandEnvValue('Bearer ${TOKEN}', { TOKEN: 'secret' })).toEqual({ resolved: true, value: 'Bearer secret' })
    expect(expandEnvValue('${A}-${B}', { A: 'x' })).toEqual({ resolved: false, missing: ['B'] })
  })

  it('rejects malformed ${...} shapes with ENV_TEMPLATE_INVALID', () => {
    for (const bad of ['${}', '${1BAD}', '${TOKEN']) {
      expect(() => parseEnvValue(bad)).toThrowError(
        expect.objectContaining({ code: 'ENV_TEMPLATE_INVALID' }),
      )
    }
  })

  it('expands references and reports missing variables', () => {
    expect(expandEnvValue('${TOKEN}', { TOKEN: 'secret' })).toEqual({ resolved: true, value: 'secret' })
    expect(expandEnvValue('${MISSING}', {})).toEqual({ resolved: false, missing: ['MISSING'] })
  })

  it('expandRecord omits missing keys and lists their variable names', () => {
    const result = expandRecord({ A: '${OK}', B: 'literal', C: '${GONE}' }, { OK: 'yes' })
    expect(result.values).toEqual({ A: 'yes', B: 'literal' })
    expect(result.missing).toEqual(['GONE'])
  })
})

describe('model.normalizeServer', () => {
  const origin = { source: 'test', addedAt: '2026-08-20T00:00:00.000Z' }

  it('normalizes a minimal stdio entry with defaults', () => {
    const entry = normalizeServer({ transport: 'stdio', command: 'npx' }, origin)
    expect(entry).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      enabled: true,
      origin,
    })
  })

  it('normalizes a full stdio entry', () => {
    const entry = normalizeServer({
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      cwd: '/tmp',
      toolCallTimeoutMs: 30_000,
      enabled: false,
    }, origin)
    expect(entry.transport).toBe('stdio')
    expect(entry.enabled).toBe(false)
    expect(entry.toolCallTimeoutMs).toBe(30_000)
  })

  it('normalizes a streamable-http entry', () => {
    const entry = normalizeServer({
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    }, origin)
    expect(entry).toMatchObject({ transport: 'streamable-http', url: 'https://example.com/mcp' })
  })

  it('rejects invalid entries with stable codes', () => {
    expect(() => normalizeServer({ transport: 'stdio' }, origin)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENTRY' }),
    )
    expect(() => normalizeServer({ transport: 'stdio', command: '  ' }, origin)).toThrowError(/non-empty command/)
    expect(() => normalizeServer({ transport: 'streamable-http' }, origin)).toThrowError(/non-empty url/)
    expect(() => normalizeServer({ transport: 'streamable-http', url: 'ftp://x' }, origin)).toThrowError(/http/)
    expect(() => normalizeServer({ transport: 'stdio', command: 'x', args: [1] }, origin)).toThrowError(/array of strings/)
    expect(() => normalizeServer({ transport: 'stdio', command: 'x', env: { A: '${}' } }, origin)).toThrowError(
      expect.objectContaining({ code: 'ENV_TEMPLATE_INVALID' }),
    )
    expect(() => normalizeServer({ transport: 'stdio', command: 'x', toolCallTimeoutMs: -1 }, origin)).toThrowError(/positive integer/)
    expect(() => normalizeServer({ transport: 'carrier-pigeon' }, origin)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENTRY' }),
    )
  })
})

describe('model.parseRegistry', () => {
  it('parses a valid document', () => {
    const registry = parseRegistry(JSON.stringify({ version: 1, servers: { a: { transport: 'stdio', command: 'x' } } }))
    expect(Object.keys(registry.servers)).toEqual(['a'])
  })

  it('rejects wrong versions, bad JSON, and non-objects', () => {
    for (const content of ['not json', '"a string"', '[]', '{"version": 2, "servers": {}}', '{"version": 1, "servers": []}']) {
      expect(() => parseRegistry(content)).toThrowError(
        expect.objectContaining({ code: 'INVALID_REGISTRY_FILE' }),
      )
    }
  })

  it('rejects invalid server names and unknown transports inside the document', () => {
    expect(() => parseRegistry('{"version":1,"servers":{"bad name!":{"transport":"stdio"}}}')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REGISTRY_FILE' }),
    )
    expect(() => parseRegistry('{"version":1,"servers":{"a":{"transport":"pigeon"}}}')).toThrowError(/unknown transport/)
  })
})
