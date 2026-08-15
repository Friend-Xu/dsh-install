/**
 * `mcp-registry` row — the aggregator plugin. Reads the user+project MCP
 * registries, mounts one `@deepseek-ai/dsh-mcp-client` child instance per
 * enabled server, and watches both files so registry edits remount live
 * without a restart.
 *
 * The row ships disabled (see cordis.patch.yml): mounting it must be an
 * explicit per-profile decision, because it starts spawning child processes
 * (or opening outbound HTTP connections) for every installed server.
 * @module dsh-install
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRegistryFiles } from './ops/mcp.ts'
import { startAggregator } from './aggregator.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-registry'

/** Services required by this plugin. */
export const inject = ['tools']

/** Aggregator configuration. */
export interface Config {
  /**
   * Working directory used to discover the project registry
   * (`<nearest .git ancestor>/.dsh/mcp.json`). @default `process.cwd()`
   */
  cwd?: string
  /** Watch the registry files and remount on change. @default true */
  watch?: boolean
  /** `fs.watchFile` poll interval in milliseconds. @default 500 */
  watchIntervalMs?: number
}

export const Config: z<Config> = z.object({
  cwd: z.string().default(''),
  watch: z.boolean().default(true),
  watchIntervalMs: z.number().min(50).max(60_000).default(500),
})

/**
 * Mount enabled registry servers as mcp-client children and keep the mounted
 * set in sync with the registry files. Activation waits for the initial
 * sync, so consumers observe the tools immediately after the row activates.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - resolved aggregator configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const files = resolveRegistryFiles(config.cwd ?? process.cwd())
  const handle = startAggregator({
    ctx,
    files,
    ...config.watch === undefined ? {} : { watch: config.watch },
    ...config.watchIntervalMs === undefined ? {} : { watchIntervalMs: config.watchIntervalMs },
    log: (level, message) => { ctx.logger?.[level]?.(message) },
  })
  ctx.effect(() => () => { void handle.dispose() }, 'mcp-registry.aggregator')
  await handle.sync()
}
