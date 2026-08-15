/**
 * Marketplace registry (`$DSH_HOME/marketplaces.json`) and catalog parsing.
 * Two catalog shapes are accepted:
 *
 * - DSH-native: `{ "servers": [...], "skills": [...] }` with
 *   `{ name, description, source }` entries (`source` is a path/git spec/URL).
 * - Claude Code marketplace: `.claude-plugin/marketplace.json` —
 *   `{ name, owner, metadata?, plugins: [{ name, source: { sourceType, githubUrl|url|npm }, description }],
 *     mcpServers?: { name, source, description }[], skills?: ... }`.
 *
 * Entries map to install paths by kind: `servers`/`mcpServers` → the MCP
 * registry, `skills` → file installs, `plugins` → dsh bundles (dshPlugins)
 * or content-only extraction for claude-plugin packages.
 * @module dsh-install/market/model
 */

import { readFileSync } from 'node:fs'
import { RegistryError } from '../util/errors.ts'
import { writeFileAtomic } from '../util/atomic-file.ts'

/** Marketplace registry document version. */
export const MARKET_REGISTRY_VERSION = 1 as const

/** One registered marketplace. */
export interface MarketplaceRecord {
  /** Source: URL or local path of the catalog document (or marketplace repo). */
  source: string
  /** Pinned ref for git-style sources. */
  ref?: string
  /** ISO timestamp of registration. */
  addedAt: string
  /** ISO timestamp of the last successful sync. */
  lastSync?: string
}

/** The marketplace registry document. */
export interface MarketplaceRegistry {
  version: typeof MARKET_REGISTRY_VERSION
  marketplaces: Record<string, MarketplaceRecord>
}

/** One server entry in either catalog shape. */
export interface CatalogServerEntry {
  name: string
  description: string
  /** Install source: path, git spec, or URL; empty means "shorthand-only". */
  source: string
}

/** One skill entry in a catalog. */
export interface CatalogSkillEntry {
  name: string
  description: string
  /** Install source: path, git spec, or tarball URL. */
  source: string
}

/** One plugin entry (claude marketplace shape). */
export interface CatalogPluginEntry {
  name: string
  description: string
  /** Resolved source for a dsh bundle install. */
  dshSource?: string
  /** Raw claude plugin source (github url / npm), for content extraction. */
  claudeSource?: string
}

/** A parsed catalog document, either shape normalized into one model. */
export interface Catalog {
  name: string
  servers: CatalogServerEntry[]
  skills: CatalogSkillEntry[]
  plugins: CatalogPluginEntry[]
}

/** An empty marketplace registry. */
export function emptyMarketRegistry(): MarketplaceRegistry {
  return { version: MARKET_REGISTRY_VERSION, marketplaces: {} }
}

/** Read the marketplace registry; a missing file is empty, corrupt fails loud. */
export function readMarketRegistry(file: string): MarketplaceRegistry {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyMarketRegistry()
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new RegistryError('INVALID_REGISTRY_FILE', `marketplaces registry is not valid JSON: ${String(error)}`)
  }
  const doc = raw as Record<string, unknown>
  if (doc.version !== MARKET_REGISTRY_VERSION || typeof doc.marketplaces !== 'object' || doc.marketplaces === null) {
    throw new RegistryError('INVALID_REGISTRY_FILE', `marketplaces registry must be { version: ${MARKET_REGISTRY_VERSION}, marketplaces: {...} }`)
  }
  return { version: MARKET_REGISTRY_VERSION, marketplaces: doc.marketplaces as MarketplaceRegistry['marketplaces'] }
}

/** Persist the marketplace registry atomically. */
export function writeMarketRegistry(file: string, registry: MarketplaceRegistry): void {
  writeFileAtomic(file, `${JSON.stringify(registry, null, 2)}\n`, 'marketplaces')
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RegistryError('INVALID_ENTRY', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string, label: string, fallback = ''): string {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new RegistryError('INVALID_ENTRY', `${label}.${key} must be a string`)
  return value
}

function entryList(value: unknown, label: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new RegistryError('INVALID_ENTRY', `${label} must be an array`)
  return value
}

function parseServerEntries(items: unknown[], label: string): CatalogServerEntry[] {
  return items.map((item, index) => {
    const record = asRecord(item, `${label}[${index}]`)
    const name = stringField(record, 'name', `${label}[${index}]`)
    if (name === '') throw new RegistryError('INVALID_ENTRY', `${label}[${index}].name is required`)
    return {
      name,
      description: stringField(record, 'description', `${label}[${index}]`),
      // `source` (DSH shape) or `url` (claude marketplace mcpServers shape).
      source: record.source !== undefined
        ? stringField(record, 'source', `${label}[${index}]`)
        : stringField(record, 'url', `${label}[${index}]`),
    }
  })
}

function parseSkillEntries(items: unknown[], label: string): CatalogSkillEntry[] {
  return items.map((item, index) => {
    const record = asRecord(item, `${label}[${index}]`)
    const name = stringField(record, 'name', `${label}[${index}]`)
    if (name === '') throw new RegistryError('INVALID_ENTRY', `${label}[${index}].name is required`)
    return {
      name,
      description: stringField(record, 'description', `${label}[${index}]`),
      source: record.source !== undefined
        ? stringField(record, 'source', `${label}[${index}]`)
        : stringField(record, 'url', `${label}[${index}]`),
    }
  })
}

function parsePluginEntries(items: unknown[], label: string): CatalogPluginEntry[] {
  return items.map((item, index) => {
    const record = asRecord(item, `${label}[${index}]`)
    const name = stringField(record, 'name', `${label}[${index}]`)
    if (name === '') throw new RegistryError('INVALID_ENTRY', `${label}[${index}].name is required`)
    const description = stringField(record, 'description', `${label}[${index}]`)
    const dshSource = record.dshSource === undefined ? undefined : stringField(record, 'dshSource', `${label}[${index}]`)
    const source = record.source
    let claudeSource: string | undefined
    if (source !== undefined) {
      const sourceRecord = asRecord(source, `${label}[${index}].source`)
      const sourceType = stringField(sourceRecord, 'sourceType', `${label}[${index}].source`)
      claudeSource = sourceType === 'github'
        ? stringField(sourceRecord, 'githubUrl', `${label}[${index}].source`)
        : stringField(sourceRecord, 'url', `${label}[${index}].source`)
    }
    return {
      name,
      description,
      ...dshSource === undefined ? {} : { dshSource },
      ...claudeSource === undefined ? {} : { claudeSource },
    }
  })
}

/**
 * Parse one catalog document in either shape.
 * @param content - raw JSON text of the catalog document.
 * @param fallbackName - name to use when the document declares none.
 * @returns the normalized catalog.
 */
export function parseCatalog(content: string, fallbackName: string): Catalog {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new RegistryError('INVALID_ENTRY', `catalog is not valid JSON: ${String(error)}`)
  }
  const doc = asRecord(raw, 'catalog')
  const name = stringField(doc, 'name', 'catalog', fallbackName)
  // DSH-native shape: top-level servers/skills arrays.
  if (doc.servers !== undefined || doc.skills !== undefined) {
    return {
      name,
      servers: parseServerEntries(entryList(doc.servers, 'servers'), 'servers'),
      skills: parseSkillEntries(entryList(doc.skills, 'skills'), 'skills'),
      plugins: parsePluginEntries(entryList(doc.plugins, 'plugins'), 'plugins'),
    }
  }
  // Claude Code marketplace shape: plugins + mcpServers arrays.
  if (doc.plugins !== undefined || doc.mcpServers !== undefined) {
    return {
      name,
      servers: parseServerEntries(entryList(doc.mcpServers, 'mcpServers'), 'mcpServers'),
      skills: parseSkillEntries(entryList(doc.skills, 'skills'), 'skills'),
      plugins: parsePluginEntries(entryList(doc.plugins, 'plugins'), 'plugins'),
    }
  }
  throw new RegistryError('INVALID_ENTRY', `catalog ${JSON.stringify(name)} has no servers/skills/plugins/mcpServers arrays`)
}
