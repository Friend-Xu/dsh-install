/**
 * Slash-command adapter: registers `/mcp` and `/skills` on the host
 * `ctx.commands` registry (web/TUI consume the same registry). Both commands
 * reuse the exact CLI grammar via `runManagement` — one parser, one ops
 * core, two surfaces — with output captured into a `CommandResult` instead
 * of process exit.
 * @module dsh-install/slash
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { runManagement } from './management.ts'

/** Slash adapter wiring. */
export interface SlashOptions {
  /** Working directory used for project-scope resolution. */
  cwd: string
  /** Origin label stamped onto installed entries (`slash:web`, `slash:tui`). */
  origin: string
}

/** Registration disposer. */
export type SlashRegistration = () => void

/**
 * Split one slash-command line into argv tokens, honoring single/double
 * quotes. The `--` separator needs no special handling: tokens after it are
 * passed through verbatim.
 * @param input - the raw input following the command name.
 * @returns the argv tokens.
 */
export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]!)
  }
  return tokens
}

/**
 * Run one management verb through the shared CLI pipeline, capturing output
 * as a direct `CommandResult` (a slash command never exits the process).
 * @param verb - the management verb (`mcp` or `skills`).
 * @param rawInput - text following the command name.
 * @param options - wiring.
 * @returns the UI result.
 */
export async function runSlashVerb(verb: 'mcp' | 'skills', rawInput: string, options: SlashOptions): Promise<CommandResult> {
  const tokens = tokenizeCommandLine(rawInput.trim())
  // A bare `/mcp` or `/skills` behaves like `list`.
  const args = tokens.length === 0 ? [verb, 'list'] : [verb, ...tokens]
  let out = ''
  let err = ''
  let code = 0
  await runManagement(args, {
    cwd: options.cwd,
    stdout: { write: chunk => { out += chunk } },
    stderr: { write: chunk => { err += chunk } },
    exit: exitCode => { code = exitCode },
    origin: options.origin,
  })
  if (code === 0) {
    const text = out.trim()
    return text === '' ? { kind: 'success' } : { kind: 'success', text }
  }
  return { kind: 'error', text: (err || out).trim() || `/${verb} failed with exit ${code}` }
}

/** The `/mcp` command definition. */
export function mcpCommandDefinition(options: SlashOptions): CommandDefinition {
  return {
    name: 'mcp',
    description: 'list, add, remove, enable, or disable installed MCP servers',
    input: { hint: '[list | add <name> -- <cmd> | add <name> --transport http --url <url> | remove <name> | on <name> | off <name>]' },
    handler: ({ rawInput }) => runSlashVerb('mcp', rawInput, options),
  }
}

/** The `/skills` command definition. */
export function skillsCommandDefinition(options: SlashOptions): CommandDefinition {
  return {
    name: 'skills',
    description: 'install, list, remove, or update skills',
    input: { hint: '[list | add <path-or-git-url> | remove <name> | update <name> <source>]' },
    handler: ({ rawInput }) => runSlashVerb('skills', rawInput, options),
  }
}

/**
 * Register both slash commands on `ctx.commands`.
 * @param ctx - plugin context carrying the command registry.
 * @param options - wiring.
 * @returns the precise Cordis disposer.
 */
export function registerSlashCommands(ctx: Context, options: SlashOptions): SlashRegistration {
  const disposers = [
    ctx.commands.register(mcpCommandDefinition(options)),
    ctx.commands.register(skillsCommandDefinition(options)),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
