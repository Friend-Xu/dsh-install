/**
 * `install-cli` row — the management surface adapter. Two consumers share
 * the management engine (`./management.ts`):
 *
 * - cmdline: when the first inner argument is a known management verb, run
 *   it with the process streams and request exit. Any other argument list —
 *   including a bare boot — is left untouched, so this row can be mounted
 *   in any profile without disturbing its app.
 * - slash: registers `/mcp` and `/skills` on `ctx.commands` (see
 *   `./slash.ts`, which consumes the same engine).
 * @module dsh-install/cli
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: declaration-merges `ctx.cmdlineArgs` / `ctx.appExit`.
import type {} from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'
import { MANAGEMENT_VERBS, runManagement } from './management.ts'
import { registerSlashCommands } from './slash.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'install-cli'

/** Services required by this plugin. */
export const inject = ['cmdlineArgs', 'commands']

/** Management-surface configuration. */
export interface Config {
  /** Whether to register the slash commands on `ctx.commands`. @default true */
  slashCommands?: boolean
  /** Working directory used to resolve project scope. @default `process.cwd()` */
  cwd?: string
}

export const Config: z<Config> = z.object({
  slashCommands: z.boolean().default(true),
  cwd: z.string().default(''),
})

/**
 * Parse management verbs from the command line and register slash commands.
 * @param ctx - plugin context carrying the command line and command registry.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const cwd = config.cwd ?? process.cwd()
  if (config.slashCommands !== false) {
    ctx.effect(() => registerSlashCommands(ctx, { cwd, origin: 'slash' }), 'install-cli.slash')
  }
  const args = ctx.cmdlineArgs?.get() ?? []
  if (!(MANAGEMENT_VERBS as readonly string[]).includes(args[0] ?? '')) return
  const exit = ctx.get('appExit')
  void runManagement(args, {
    cwd,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: code => { exit?.(code) },
    origin: 'cli',
  })
}
