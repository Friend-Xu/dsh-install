/**
 * The registry aggregator: one source of truth for "which MCP servers are
 * installed and enabled", projected onto live mcp-client child instances.
 *
 * - Reads the user+project registries, merges them (project shadows user),
 *   and mounts one child plugin per enabled server.
 * - Watches both registry files; on any change it resyncs and diffs by
 *   server name + config identity: unchanged mounts stay up (no reconnect),
 *   changed ones are disposed and remounted, removed ones are disposed.
 * - Failures are isolated per child: a server that cannot mount (bad config,
 *   duplicate serverName with a cordis.yml row, dead endpoint) is logged and
 *   skipped without disturbing the others; the next registry change retries.
 * - A corrupt registry never silently unmounts: the previous generation is
 *   kept, the error is logged, and the next successful read resyncs.
 *
 * The child plugin is injectable so orchestration behavior is testable
 * without spawning real MCP servers; production passes the real
 * `@deepseek-ai/dsh-mcp-client`.
 * @module dsh-install/aggregator
 */

import type { Context } from '@deepseek-ai/cordis'
import { unwatchFile, watchFile } from 'node:fs'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import { emptyRegistry, type ServerEntry } from './registry/model.ts'
import { mergeRegistries, readRegistry } from './registry/store.ts'
import { expandRecord } from './registry/envref.ts'
import type { RegistryFiles } from './ops/mcp.ts'

/** A plugin with the mcp-client child shape (real or fake, for tests). */
export interface ChildPlugin {
  name: string
  inject: string[]
  apply(ctx: Context, config: McpClientConfig): unknown
}

/** What an aggregator keeps per live mount. */
export interface MountRecord {
  /** Server name (the stable registry key). */
  name: string
  /** Which scope's file supplied the mounted entry. */
  source: 'user' | 'project'
  /** Identity of the mounted configuration (stable string). */
  configId: string
  /** The mounted child fiber. */
  fiber: { dispose(): Promise<unknown> }
  /** Env variable names that were missing at mount time (keys omitted). */
  missingEnv: string[]
}

/** One desired mount, derived from a registry entry. */
export interface DesiredMount {
  name: string
  source: 'user' | 'project'
  configId: string
  config: McpClientConfig
  missingEnv: string[]
}

/** Aggregator control surface. */
export interface AggregatorHandle {
  /** Stop watching, unmount every child, and await full cleanup. */
  dispose(): Promise<void>
  /** Force a resync now (also used by tests). */
  sync(): Promise<void>
  /** The live mounts by server name. */
  mounts(): ReadonlyMap<string, MountRecord>
  /** The last sync failure (kept for diagnostics and tests). */
  lastError(): unknown
}

/** Aggregator configuration. */
export interface AggregatorOptions {
  /** Parent context children mount under. */
  ctx: Context
  /** Registry files to aggregate (resolved by the plugin row from its cwd). */
  files: RegistryFiles
  /** Child plugin factory shape; the real mcp-client by default. */
  childPlugin?: ChildPlugin
  /** Environment used to expand `${VAR}` references; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
  /** Watch the registry files and resync on change. @default true */
  watch?: boolean
  /** `fs.watchFile` poll interval in milliseconds. @default 500 */
  watchIntervalMs?: number
  /** Log sink; defaults to `ctx.logger` when available. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** Result of projecting one registry entry onto the child plugin's config. */
export interface ProjectedConfig {
  /** The exact child config (only mcp-client fields; registry extras stripped). */
  config: McpClientConfig
  /** Stable identity: the STORED config, not the env-expanded values. */
  id: string
  /** Env variable names missing from the environment at projection time. */
  missingEnv: string[]
}

/**
 * Project a registry entry onto the child plugin's configuration.
 * `${VAR}` references are expanded against the environment; keys whose
 * variables are missing are omitted (the entry stays registered, flagged
 * by `missingEnv`). The identity uses the stored (unexpanded) shape plus
 * scope so editing the registry file remounts, while ambient env value
 * changes alone do not.
 * @param name - server name.
 * @param source - scope the entry came from.
 * @param entry - the registry entry.
 * @param env - expansion environment.
 * @returns the projected config.
 */
export function projectConfig(
  name: string,
  source: 'user' | 'project',
  entry: ServerEntry,
  env: Readonly<Record<string, string | undefined>>,
): ProjectedConfig {
  const { origin: _origin, enabled: _enabled, ...stored } = entry
  const id = JSON.stringify([source, stored])
  if (entry.transport === 'stdio') {
    const { values, missing } = expandRecord(entry.env, env)
    return {
      id,
      missingEnv: missing,
      config: {
        transport: 'stdio',
        serverName: name,
        command: entry.command,
        args: entry.args,
        env: values,
        cwd: entry.cwd,
        toolCallTimeoutMs: entry.toolCallTimeoutMs,
        failOnStartupError: false,
      },
    }
  }
  const { values, missing } = expandRecord(entry.headers, env)
  return {
    id,
    missingEnv: missing,
    config: {
      transport: 'streamable-http',
      serverName: name,
      url: entry.url,
      headers: values,
      toolCallTimeoutMs: entry.toolCallTimeoutMs,
      failOnStartupError: false,
    },
  }
}

/**
 * Diff the previous mount generation against the desired one.
 * @param previous - mounts by server name.
 * @param desired - desired mounts by server name.
 * @returns names to unmount and desired mounts to (re)mount.
 */
export function diffMounts(
  previous: ReadonlyMap<string, MountRecord>,
  desired: ReadonlyMap<string, DesiredMount>,
): { unmount: string[]; mount: DesiredMount[] } {
  const unmount: string[] = []
  const mount: DesiredMount[] = []
  for (const name of previous.keys()) {
    const target = desired.get(name)
    if (target === undefined || target.configId !== previous.get(name)!.configId) unmount.push(name)
  }
  for (const [name, target] of desired) {
    const current = previous.get(name)
    if (current === undefined || current.configId !== target.configId) mount.push(target)
  }
  return { unmount, mount }
}

/**
 * Start an aggregator: initial sync, optional file watching, and lifecycle.
 * @param options - aggregation configuration.
 * @returns the control handle.
 */
export function startAggregator(options: AggregatorOptions): AggregatorHandle {
  const child = options.childPlugin ?? (McpClient as unknown as ChildPlugin)
  const env = options.env ?? process.env
  const mounts = new Map<string, MountRecord>()
  let disposed = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let syncError: unknown

  const log = options.log ?? ((level: 'info' | 'warn' | 'error', message: string) => {
    options.ctx.logger?.[level]?.(message)
  })

  /** Read both registries and project the desired generation. */
  function desiredGeneration(): Map<string, DesiredMount> {
    const user = readRegistry(options.files.user)
    const project = options.files.project === undefined ? emptyRegistry() : readRegistry(options.files.project)
    const merged = mergeRegistries(user, project)
    const desired = new Map<string, DesiredMount>()
    for (const [name, { entry, scope }] of Object.entries(merged)) {
      if (!entry.enabled) continue
      const projected = projectConfig(name, scope, entry, env)
      desired.set(name, { name, source: scope, configId: projected.id, config: projected.config, missingEnv: projected.missingEnv })
    }
    return desired
  }

  async function doSync(): Promise<void> {
    if (disposed) return
    try {
      const desired = desiredGeneration()
      const { unmount, mount } = diffMounts(mounts, desired)
      for (const name of unmount) {
        const record = mounts.get(name)!
        mounts.delete(name)
        try {
          await record.fiber.dispose()
          log('info', `mcp-registry: unmounted ${name} (${record.source})`)
        } catch (error) {
          log('error', `mcp-registry: dispose of ${name} failed: ${String(error)}`)
        }
      }
      for (const target of mount) {
        if (target.missingEnv.length > 0) {
          log('warn', `mcp-registry: ${target.name}: ${target.missingEnv.join(', ')} not set — mounting without those keys`)
        }
        try {
          const fork = options.ctx.plugin(child, target.config)
          try {
            await fork
          } catch (error) {
            await fork.dispose().catch(() => undefined)
            throw error
          }
          mounts.set(target.name, {
            name: target.name,
            source: target.source,
            configId: target.configId,
            fiber: fork,
            missingEnv: target.missingEnv,
          })
          log('info', `mcp-registry: mounted ${target.name} (${target.config.transport}, ${target.source})`)
        } catch (error) {
          log('error', `mcp-registry: failed to mount ${target.name} (${target.config.transport}, ${target.source}): ${String(error)}`)
        }
      }
      syncError = undefined
    } catch (error) {
      // Registry read/projection failure: keep the current generation.
      syncError = error
      log('error', `mcp-registry: sync failed, keeping ${mounts.size} current mount(s): ${String(error)}`)
    }
  }

  // Syncs are serialized on one chain: the initial sync, watch-driven
  // resyncs, and explicit sync() calls must never run concurrently — two
  // concurrent generations would double-mount (each sees an empty mount map
  // and both spawn children).
  let chain: Promise<void> = Promise.resolve()
  function sync(): Promise<void> {
    const run = chain.then(() => doSync())
    chain = run
    return run
  }

  if (options.watch !== false) {
    const interval = options.watchIntervalMs ?? 500
    const schedule = (): void => {
      if (disposed) return
      clearTimeout(debounce)
      debounce = setTimeout(() => { void sync() }, 25)
    }
    watchFile(options.files.user, { interval, persistent: false }, schedule)
    if (options.files.project !== undefined) {
      watchFile(options.files.project, { interval, persistent: false }, schedule)
    }
  }

  void sync()

  return {
    async dispose(): Promise<void> {
      disposed = true
      clearTimeout(debounce)
      unwatchFile(options.files.user)
      if (options.files.project !== undefined) unwatchFile(options.files.project)
      for (const [name, record] of [...mounts]) {
        mounts.delete(name)
        try {
          await record.fiber.dispose()
        } catch (error) {
          log('error', `mcp-registry: dispose of ${name} failed: ${String(error)}`)
        }
      }
    },
    sync,
    mounts: () => mounts,
    lastError: () => syncError,
  }
}
