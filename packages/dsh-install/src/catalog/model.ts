/**
 * Server catalog: a snapshot of well-known MCP servers with their runtime
 * matrix (npx/uvx/docker) and env requirements. `mcp add <name>` resolves
 * shorthand names against the builtin catalog; `search` lists it; external
 * catalogs from marketplaces extend it (see ../market).
 * @module dsh-install/catalog/model
 */

/** How a catalog entry's server process is started. */
export type CatalogRuntime = 'npx' | 'uvx' | 'docker' | 'node'

/** One declared environment requirement. */
export interface CatalogEnvRequirement {
  /** Variable name passed to the server. */
  name: string
  /** Human description of what it is for. */
  description: string
  /** Whether the server is unusable without it. */
  required: boolean
}

/** One catalog entry. */
export interface CatalogEntry {
  /** Stable shorthand name (`mcp add <name>`). */
  name: string
  /** Human-readable summary. */
  description: string
  /** Runtime family that starts the server. */
  runtime: CatalogRuntime
  /** Command prefix the runtime implies; listed for display only. */
  command: string
  /** Arguments for the server. */
  args: string[]
  /** Environment requirements (user supplies values via `-e NAME`). */
  env: CatalogEnvRequirement[]
  /** Set when the entry needs user-specific arguments (e.g. filesystem dirs). */
  requiresArgs?: boolean
  /** Homepage or registry URL. */
  source: string
}
