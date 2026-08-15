/**
 * Marketplace operations: add/list/remove/sync over the marketplace
 * registry, and catalog lookup across builtin + registered sources.
 * @module dsh-install/ops/market
 */

import { readFileSync } from 'node:fs'
import { RegistryError } from '../util/errors.ts'
import { installLogPath, marketplacesPath } from '../registry/paths.ts'
import { parseCatalog, readMarketRegistry, writeMarketRegistry, type Catalog, type MarketplaceRegistry } from '../market/model.ts'
import { appendAuditLog, CODES, createReport, verdict, type Report } from './report.ts'
import { searchBuiltin } from '../catalog/builtin.ts'
import type { CatalogEntry } from '../catalog/model.ts'

/** Fetch a catalog document source (URL via fetch, or a local path). */
export async function fetchCatalogDocument(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      throw new RegistryError('SOURCE_UNREACHABLE', `catalog ${source} responded ${response.status}`)
    }
    return await response.text()
  }
  try {
    return readFileSync(source, 'utf8')
  } catch (error) {
    throw new RegistryError('SOURCE_UNREACHABLE', `cannot read catalog ${source}: ${String(error)}`)
  }
}

function audit(action: string, target: string, verdicts: Report['verdicts']): Report {
  const report = createReport(action, target, verdicts)
  try {
    appendAuditLog(installLogPath(), report)
  } catch (error) {
    report.verdicts.push(verdict.failed(CODES.AUDIT_LOG_FAILED, 'audit log append failed', String(error)))
  }
  return report
}

/** Register a marketplace. */
export function addMarketplace(name: string, source: string): Report {
  const action = `marketplace add ${name}`
  try {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      return audit(action, source, [verdict.failed(CODES.INVALID_NAME, `marketplace name ${JSON.stringify(name)} is invalid`)])
    }
    const registry = readMarketRegistry(marketplacesPath())
    if (registry.marketplaces[name] !== undefined) {
      return audit(action, source, [verdict.failed(CODES.DUPLICATE_SERVER, `marketplace ${JSON.stringify(name)} is already registered — remove it first`)])
    }
    registry.marketplaces[name] = { source, addedAt: new Date().toISOString() }
    writeMarketRegistry(marketplacesPath(), registry)
    return audit(action, source, [verdict.imported(CODES.IMPORTED, `registered marketplace ${JSON.stringify(name)}`, `source: ${source}`)])
  } catch (error) {
    return audit(action, source, [verdict.failed(CODES.OPERATION_FAILED, String(error))])
  }
}

/** List registered marketplaces. */
export function listMarketplaces(): { marketplaces: MarketplaceRegistry['marketplaces']; report: Report } {
  try {
    const registry = readMarketRegistry(marketplacesPath())
    const sorted = Object.fromEntries(Object.entries(registry.marketplaces).sort(([a], [b]) => a.localeCompare(b)))
    return {
      marketplaces: sorted,
      report: createReport('marketplace list', 'registry', Object.entries(sorted).map(([name, record]) =>
        verdict.imported(CODES.IMPORTED, `${name}`, record.source))),
    }
  } catch (error) {
    return { marketplaces: {}, report: createReport('marketplace list', 'registry', [verdict.failed(CODES.OPERATION_FAILED, String(error))]) }
  }
}

/** Remove a registered marketplace. */
export function removeMarketplace(name: string): Report {
  const action = `marketplace remove ${name}`
  try {
    const registry = readMarketRegistry(marketplacesPath())
    if (registry.marketplaces[name] === undefined) {
      return audit(action, 'registry', [verdict.failed(CODES.NOT_FOUND, `no marketplace named ${JSON.stringify(name)}`)])
    }
    delete registry.marketplaces[name]
    writeMarketRegistry(marketplacesPath(), registry)
    return audit(action, 'registry', [verdict.imported(CODES.IMPORTED, `removed marketplace ${JSON.stringify(name)}`)])
  } catch (error) {
    return audit(action, 'registry', [verdict.failed(CODES.OPERATION_FAILED, String(error))])
  }
}

/** Sync one (or all) marketplaces: fetch + parse + stamp lastSync. */
export async function syncMarketplace(name?: string): Promise<Report> {
  const action = `marketplace sync${name === undefined ? '' : ` ${name}`}`
  try {
    const registry = readMarketRegistry(marketplacesPath())
    const targets = name === undefined ? Object.keys(registry.marketplaces) : [name]
    if (targets.length === 0 || (name !== undefined && registry.marketplaces[name] === undefined)) {
      return audit(action, 'registry', [verdict.failed(CODES.NOT_FOUND, name === undefined ? 'no marketplaces registered' : `no marketplace named ${JSON.stringify(name)}`)])
    }
    const verdicts: Report['verdicts'] = []
    for (const target of targets) {
      const record = registry.marketplaces[target]!
      try {
        const content = await fetchCatalogDocument(record.source)
        const catalog = parseCatalog(content, target)
        registry.marketplaces[target] = { ...record, lastSync: new Date().toISOString() }
        verdicts.push(verdict.imported(CODES.IMPORTED, `${target}: ${catalog.servers.length} servers, ${catalog.skills.length} skills, ${catalog.plugins.length} plugins`))
      } catch (error) {
        const code = error instanceof RegistryError ? error.code : CODES.SOURCE_UNREACHABLE
        verdicts.push(verdict.failed(code, `${target}: ${String(error)}`))
      }
    }
    writeMarketRegistry(marketplacesPath(), registry)
    return audit(action, 'registry', verdicts)
  } catch (error) {
    return audit(action, 'registry', [verdict.failed(CODES.OPERATION_FAILED, String(error))])
  }
}

/** Load every registered marketplace catalog (builtin is separate). */
export async function loadMarketplaceCatalogs(): Promise<Record<string, Catalog>> {
  const registry = readMarketRegistry(marketplacesPath())
  const catalogs: Record<string, Catalog> = {}
  for (const [name, record] of Object.entries(registry.marketplaces)) {
    const content = await fetchCatalogDocument(record.source)
    catalogs[name] = parseCatalog(content, name)
  }
  return catalogs
}

/** Search builtin + marketplace catalogs for a query. */
export async function searchCatalogs(query: string): Promise<{ builtin: CatalogEntry[]; marketplaces: Record<string, Catalog> }> {
  const marketplaces = await loadMarketplaceCatalogs()
  return { builtin: searchBuiltin(query), marketplaces }
}
