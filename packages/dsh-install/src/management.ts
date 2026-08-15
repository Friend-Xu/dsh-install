/**
 * The management engine: a cordis-free command-line surface over the
 * registry/ops core. Both adapters — the `install-cli` row (`cli.ts`) and
 * the slash commands (`slash.ts`) — consume this one module, so the
 * grammar, exit routing, and async-action draining exist exactly once.
 *
 * Commander does not await promise-returning actions: async work registers
 * on a pending queue that {@link runManagement} drains after parse.
 * @module dsh-install/management
 */

import { Command, CommanderError, InvalidArgumentError } from 'commander'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  addServer,
  getServer,
  listServers,
  removeAllServers,
  removeServer,
  resolveRegistryFiles,
  setServerEnabled,
  updateServer,
  type RegistryFiles,
} from './ops/mcp.ts'
import { addSkill, listSkills, removeAllSkills, removeSkill, resolveSkillFiles, updateSkill } from './ops/skills.ts'
import { importFromFile, importServers, extractClaudePlugin } from './ops/import.ts'
import { addMarketplace, listMarketplaces, loadMarketplaceCatalogs, removeMarketplace, searchCatalogs, syncMarketplace } from './ops/market.ts'
import { doctorServer, renderDoctor } from './ops/doctor.ts'
import { uninstallAll } from './ops/uninstall.ts'
import { resolveShorthand, findOnPath } from './catalog/resolve.ts'
import { renderReport, createReport, verdict, type Report } from './ops/report.ts'

/** Management verbs the `install-cli` row owns. */
export const MANAGEMENT_VERBS = ['mcp', 'skills', 'search', 'marketplace', 'plugin', 'uninstall'] as const

/** IO + lifecycle wiring for {@link runManagement}. */
export interface ManagementRuntime {
  cwd: string
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request bounded process exit with the given code. */
  exit(code: number): void
  /** Origin label stamped onto installed entries (`cli`). */
  origin: string
}

type Scope = 'user' | 'project'

function assertScope(value: string): Scope {
  if (value !== 'user' && value !== 'project') {
    throw new InvalidArgumentError(`--scope must be user or project, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Print a report in the requested format. */
function emit(runtime: ManagementRuntime, report: Report, format: string): void {
  if (format === 'json') {
    runtime.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  runtime.stdout.write(`${renderReport(report)}\n`)
}

/** Print a simple line list in the requested format. */
function emitList(runtime: ManagementRuntime, lines: string[], format: string): void {
  if (format === 'json') {
    runtime.stdout.write(`${JSON.stringify(lines, null, 2)}\n`)
    return
  }
  runtime.stdout.write(lines.length === 0 ? '(empty)\n' : `${lines.join('\n')}\n`)
}

/** Subcommand factory: every command gets exitOverride so help/grammar errors throw. */
function sub(parent: Command, spec: string, description: string): Command {
  const command = parent.command(spec).description(description).exitOverride()
  return command
}

/** Shared flags of `mcp add` / `mcp update`; command args arrive as a variadic positional after `--`. */
function addFlags(command: Command): Command {
  return command
    .argument('<name>', 'server name')
    .argument('[commandArgs...]', 'command and arguments after `--` (stdio transport)')
    .allowExcessArguments(true)
    .option('--transport <transport>', 'transport kind (stdio or http)', 'stdio')
    .option('--url <url>', 'Streamable HTTP endpoint URL (http transport)')
    .option('--header <header...>', 'extra HTTP headers as "Key: Value" (repeatable)')
    .option('-e, --env <env...>', 'extra env vars as KEY=VAR or KEY=literal (repeatable)')
    .option('--cwd <dir>', 'working directory for the stdio child process')
    .option('--timeout <ms>', 'per-tool-call timeout in milliseconds', value => Number(value))
    .option('--scope <scope>', 'which registry file to target', assertScope, 'user')
    .option('--yes', 'skip the confirmation prompt (reserved)')
    .option('--dry-run', 'print the resolved config without writing anything')
}

/**
 * Build the management commander program: `mcp ...` and `skills ...`
 * subcommands with claude/codex-aligned grammars.
 * @param runtime - IO and lifecycle wiring.
 * @param files - resolved registry files.
 * @returns the configured program and its pending async-action queue.
 */
export function managementProgram(runtime: ManagementRuntime, files: RegistryFiles): { program: Command; pending: Promise<void>[] } {
  const program = new Command()
    .name('dsh --profile install')
    .description('Install and manage MCP servers and skills for the DeepSeek Harness.')
    .helpOption('-h, --help', 'show this help')
    .exitOverride()
    .enablePositionalOptions()
    .showSuggestionAfterError(true)
    // Configure output BEFORE subcommands exist: commander inherits the
    // output configuration at child-creation time.
    .configureOutput({
      writeOut: text => runtime.stdout.write(text),
      writeErr: text => runtime.stderr.write(text),
    })

  // Explicit parent commands: commander 15 cannot derive one parent from two
  // space-separated subcommand specs (`command('mcp list')` + `command('mcp get')`
  // collides re-registering the implicit 'mcp' parent).
  // Async actions: commander does not await promise-returning actions, so
  // async work registers on a pending queue that runManagement drains after
  // parse. Every action still routes its own exit.
  const pending: Promise<void>[] = []
  const runAsync = (fn: () => Promise<void>): void => { pending.push(fn()) }
  const mcp = sub(program, 'mcp', 'manage installed MCP servers')
    .enablePositionalOptions()
    .addHelpText('after', `Examples:
  mcp add github -- npx -y @modelcontextprotocol/server-github -e GITHUB_TOKEN
  mcp add myapi --transport http --url https://api.example.com/mcp --header "Authorization: Bearer \${T}"
  mcp list | mcp get <name> | mcp remove <name> | mcp on <name> | mcp off <name> | mcp update <name>
`)
  const skills = sub(program, 'skills', 'manage installed skills')
    .addHelpText('after', `
Examples:
  skills add ./my-skill | skills add github:owner/repo#subdir@ref
  skills add <source> --link   (symlink a local skill for development)
  skills list | skills remove <name> | skills update <name> <source>
`)

  sub(mcp, 'list', 'list installed servers (merged user+project view)')
    .option('--format <format>', 'output format (text or json)', 'text')
    .action((options: { format: string }) => {
      const { servers, report } = listServers(files)
      const lines = Object.entries(servers).map(([serverName, server]) => {
        const flags = [
          server.entry.transport,
          server.scope,
          server.shadowed ? 'shadowed' : '',
          server.entry.enabled ? '' : 'disabled',
        ].filter(Boolean).join(', ')
        return `${serverName}\t${flags}\t${server.entry.origin.source}`
      })
      emitList(runtime, lines, options.format)
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  sub(mcp, 'get', 'show one installed server')
    .argument('<name>', 'server name')
    .action((serverName: string) => {
      const { server, report } = getServer(files, serverName)
      if (server !== undefined) runtime.stdout.write(`${JSON.stringify(server.entry, null, 2)}\n`)
      else emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  addFlags(sub(mcp, 'add', 'add a server: `mcp add <name> -- <command> [args...]`, or `--transport http --url <url>`'))
    .action((serverName: string, commandArgs: string[], options: Record<string, unknown>) => {
      const { exit } = runAddServer(runtime, files, serverName, options, commandArgs, false)
      runtime.exit(exit)
    })

  addFlags(sub(mcp, 'update', 'replace one server\'s configuration'))
    .action((serverName: string, commandArgs: string[], options: Record<string, unknown>) => {
      const { exit } = runAddServer(runtime, files, serverName, options, commandArgs, true)
      runtime.exit(exit)
    })

  sub(mcp, 'remove', 'remove a server from one scope (or every server with --all)')
    .argument('[name]', 'server name (required unless --all)')
    .option('--scope <scope>', 'which registry file to target', assertScope, 'user')
    .option('--all', 'remove every server in the scope')
    .option('--dry-run', 'report what would be removed without writing anything')
    .action((serverName: string | undefined, options: { scope: string; all?: boolean; dryRun?: boolean }) => {
      const scope = assertScope(options.scope)
      const report = options.all === true
        ? removeAllServers(files, scope, options.dryRun === true)
        : serverName === undefined
          ? createReport('mcp remove', scope, [verdict.failed('INVALID_ENTRY', 'mcp remove needs a name or --all')])
          : removeServer(files, scope, serverName)
      emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  for (const [verb, enabled] of [['on', true], ['off', false]] as const) {
    sub(mcp, verb, `${enabled ? 'enable' : 'disable'} a server (disabled servers are not mounted)`)
      .argument('<name>', 'server name')
      .option('--scope <scope>', 'which registry file to target', assertScope, 'user')
      .action((serverName: string, options: { scope: string }) => {
        const report = setServerEnabled(files, assertScope(options.scope), serverName, enabled)
        emit(runtime, report, 'text')
        runtime.exit(report.summary.failed === 0 ? 0 : 1)
      })
  }

  sub(mcp, 'doctor', 'diagnose one installed server (runtime, env vars, endpoint)')
    .argument('<name>', 'server name')
    .action((serverName: string) => {
      runAsync(async () => {
        try {
          const report = await doctorServer(files, serverName)
          runtime.stdout.write(`${renderDoctor(report)}\n`)
          runtime.exit(report.summary.failed === 0 ? 0 : 1)
        } catch (error) {
          runtime.stderr.write(`error: ${String(error)}\n`)
          runtime.exit(1)
        }
      })
    })

  sub(mcp, 'import', 'import servers from another agent\'s config')
    .option('--from <kind>', 'claude | codex | mcp-json | claude-plugin | auto', 'auto')
    .option('--path <path>', 'config file — or for claude-plugin: a directory, git spec, or https URL')
    .option('--scope <scope>', 'which registry file to target', assertScope, 'user')
    .option('--yes', 'skip the confirmation prompt (reserved)')
    .action((options: { from: string; path?: string; scope: string; yes?: boolean }) => {
      const scope = assertScope(options.scope)
      const kind = options.from
      if (kind === 'claude-plugin') {
        const path = options.path ?? '.'
        try {
          const extraction = extractClaudePlugin(
            files,
            resolveSkillFiles(runtime.cwd),
            scope,
            path,
            { source: `import:claude-plugin:${path}`, addedAt: new Date().toISOString() },
          )
          const verdicts: Report['verdicts'] = [
            ...extraction.installedSkills.map(skill => verdict.imported('IMPORTED', `skill ${JSON.stringify(skill)} installed`)),
            ...extraction.installedServers.map(server => verdict.imported('IMPORTED', `mcp server ${JSON.stringify(server)} added`)),
            ...extraction.incompatible,
          ]
          const report = createReport(`mcp import --from claude-plugin ${path}`, scope, verdicts)
          emit(runtime, report, 'text')
          runtime.exit(report.summary.failed === 0 ? 0 : 1)
          return
        } catch (error) {
          runtime.stderr.write(`error: ${String(error)}\n`)
          runtime.exit(1)
          return
        }
      }
      if (kind !== 'claude' && kind !== 'codex' && kind !== 'mcp-json' && kind !== 'auto') {
        runtime.stderr.write('error: --from must be claude, codex, mcp-json, claude-plugin, or auto\n')
        runtime.exit(1)
        return
      }
      const defaultPath = kind === 'claude' ? join(homedir(), '.claude.json')
        : kind === 'codex' ? join(homedir(), '.codex', 'config.toml')
          : '.mcp.json'
      const path = options.path ?? defaultPath
      const fileKind = kind === 'claude' ? 'claude-json' : kind === 'codex' ? 'codex-toml' : kind
      try {
        const servers = importFromFile(fileKind, path, `import:${kind}:${path}`)
        if (servers.length === 0) {
          runtime.stdout.write('(no servers found to import)\n')
          runtime.exit(0)
          return
        }
        const origin = { source: `import:${kind}:${path}`, addedAt: new Date().toISOString() }
        const report = importServers(files, scope, servers, origin)
        emit(runtime, report, 'text')
        runtime.exit(report.summary.failed === 0 ? 0 : 1)
      } catch (error) {
        runtime.stderr.write(`error: ${String(error)}\n`)
        runtime.exit(1)
      }
    })

  sub(skills, 'add', 'install a skill from a local path or git URL')
    .argument('<source>', 'path or git spec (git+URL, github:owner/repo, owner/repo#subdir@ref)')
    .option('--name <name>', 'override the skill name (kebab-case)')
    .option('--scope <scope>', 'which skills root to install into', assertScope, 'user')
    .option('--link', 'symlink the source instead of copying (local paths only)')
    .action((source: string, options: { name?: string; scope: string; link?: boolean }) => {
      const report = addSkill(resolveSkillFiles(runtime.cwd), assertScope(options.scope), source, {
        ...options.name === undefined ? {} : { name: options.name },
        link: options.link === true,
        origin: runtime.origin,
      })
      emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  sub(skills, 'list', 'list manifest-tracked skills')
    .option('--format <format>', 'output format (text or json)', 'text')
    .action((options: { format: string }) => {
      const { skills } = listSkills(resolveSkillFiles(runtime.cwd))
      const lines = Object.entries(skills).map(([skillName, record]) => `${skillName}\t${record.scope}\t${record.source}`)
      emitList(runtime, lines, options.format)
      runtime.exit(0)
    })

  sub(skills, 'remove', 'remove a manifest-tracked skill (or every tracked skill with --all)')
    .argument('[name]', 'skill name (required unless --all)')
    .option('--scope <scope>', 'which skills root to target', assertScope, 'user')
    .option('--all', 'remove every manifest-tracked skill in the scope')
    .option('--dry-run', 'report what would be removed without writing anything')
    .action((skillName: string | undefined, options: { scope: string; all?: boolean; dryRun?: boolean }) => {
      const scope = assertScope(options.scope)
      const report = options.all === true
        ? removeAllSkills(resolveSkillFiles(runtime.cwd), scope, options.dryRun === true)
        : skillName === undefined
          ? createReport('skills remove', scope, [verdict.failed('INVALID_ENTRY', 'skills remove needs a name or --all')])
          : removeSkill(resolveSkillFiles(runtime.cwd), skillName)
      emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  sub(skills, 'update', 'reinstall a manifest-tracked skill from a new source')
    .argument('<name>', 'skill name')
    .argument('<source>', 'new source (path or git spec)')
    .option('--link', 'symlink the source instead of copying (local paths only)')
    .action((skillName: string, source: string, options: { link?: boolean }) => {
      const report = updateSkill(resolveSkillFiles(runtime.cwd), skillName, source, {
        link: options.link === true,
        origin: runtime.origin,
      })
      emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  sub(program, 'search', 'search the builtin and marketplace catalogs')
    .argument('[query]', 'substring over server names and descriptions')
    .action((query?: string) => {
      runAsync(async () => {
        try {
          const { builtin, marketplaces } = await searchCatalogs(query ?? '')
          const lines = builtin.map(entry => `builtin\t${entry.name}\t${entry.description}`)
          for (const [marketName, catalog] of Object.entries(marketplaces)) {
            for (const server of catalog.servers) lines.push(`${marketName}\t${server.name}\t${server.description}`)
          }
          emitList(runtime, lines, 'text')
          runtime.exit(0)
        } catch (error) {
          runtime.stderr.write(`error: ${String(error)}\n`)
          runtime.exit(1)
        }
      })
    })

  const market = sub(program, 'marketplace', 'register, list, sync, or remove marketplaces')

  sub(market, 'add', 'register a marketplace (URL or local catalog path)')
    .argument('<name>', 'marketplace name')
    .argument('<source>', 'catalog document URL or local path')
    .action((marketName: string, source: string) => {
      const report = addMarketplace(marketName, source)
      emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  sub(market, 'list', 'list registered marketplaces')
    .action(() => {
      const { marketplaces } = listMarketplaces()
      emitList(runtime, Object.entries(marketplaces).map(([marketName, record]) => `${marketName}\t${record.source}${record.lastSync === undefined ? '' : `\tsynced ${record.lastSync}`}`), 'text')
      runtime.exit(0)
    })

  sub(market, 'remove', 'unregister a marketplace')
    .argument('<name>', 'marketplace name')
    .action((marketName: string) => {
      const report = removeMarketplace(marketName)
      emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  sub(market, 'sync', 'fetch and validate every (or one) marketplace catalog')
    .argument('[name]', 'marketplace name (all when omitted)')
    .action((marketName?: string) => {
      runAsync(async () => {
        const report = await syncMarketplace(marketName)
        emit(runtime, report, 'text')
        runtime.exit(report.summary.failed === 0 ? 0 : 1)
      })
    })

  const plugin = sub(program, 'plugin', 'install plugins from marketplaces')

  sub(plugin, 'install', 'install a plugin from a marketplace')
    .argument('<name@marketplace>', 'plugin qualified by its marketplace (or a bare name with --from)')
    .option('--from <marketplace>', 'marketplace to resolve a bare plugin name against')
    .option('--extract-content', 'extract skills/mcpServers from a claude-plugin package (content layer only)')
    .option('--scope <scope>', 'scope for extracted content', assertScope, 'user')
    .option('--profile <name>', 'profile a dsh.bundle plugin would install into')
    .action((qualified: string, options: { from?: string; extractContent?: boolean; scope: string; profile?: string }) => {
      runAsync(async () => {
        try {
          const at = qualified.indexOf('@')
          const pluginName = at === -1 ? qualified : qualified.slice(0, at)
          const marketName = at === -1 ? options.from : qualified.slice(at + 1)
          if (marketName === undefined) {
            runtime.stderr.write('error: no marketplace given — use <name>@<marketplace> or --from <marketplace>\n')
            runtime.exit(1)
            return
          }
          const catalogs = await loadMarketplaceCatalogs()
          const catalog = catalogs[marketName]
          if (catalog === undefined) {
            runtime.stderr.write(`error: no marketplace named ${JSON.stringify(marketName)}\n`)
            runtime.exit(1)
            return
          }
          const plugin = catalog.plugins.find(entry => entry.name === pluginName)
          if (plugin === undefined) {
            runtime.stderr.write(`error: no plugin named ${JSON.stringify(pluginName)} in marketplace ${JSON.stringify(marketName)}\n`)
            runtime.exit(1)
            return
          }
          if (plugin.claudeSource !== undefined && options.extractContent === true) {
            const extraction = extractClaudePlugin(
              files,
              resolveSkillFiles(runtime.cwd),
              assertScope(options.scope),
              plugin.claudeSource,
              { source: `marketplace:${marketName}:${pluginName}`, addedAt: new Date().toISOString() },
            )
            const report = createReport(`plugin install ${pluginName}@${marketName}`, 'content-extract', [
              ...extraction.installedSkills.map(skill => verdict.imported('IMPORTED', `skill ${JSON.stringify(skill)} installed`)),
              ...extraction.installedServers.map(server => verdict.imported('IMPORTED', `mcp server ${JSON.stringify(server)} added`)),
              ...extraction.incompatible,
            ])
            emit(runtime, report, 'text')
            runtime.exit(0)
            return
          }
          if (plugin.claudeSource !== undefined) {
            const report = createReport(`plugin install ${pluginName}@${marketName}`, 'plan', [
              verdict.skipped('INCOMPATIBLE_PLUGIN', `${pluginName} is a claude-plugin package, not a dsh bundle`, 're-run with --extract-content to install its skills/mcpServers content layer'),
            ])
            emit(runtime, report, 'text')
            runtime.exit(0)
            return
          }
          if (plugin.dshSource !== undefined) {
            const profile = options.profile ?? 'web'
            runtime.stdout.write(`dsh bundle ${pluginName} installs as a profile plugin — run:\n  dsh plugin --profile ${profile} add ${plugin.dshSource}\n`)
            runtime.exit(0)
            return
          }
          runtime.stderr.write(`error: plugin ${JSON.stringify(pluginName)} has no installable source\n`)
          runtime.exit(1)
        } catch (error) {
          runtime.stderr.write(`error: ${String(error)}\n`)
          runtime.exit(1)
        }
      })
    })

  sub(program, 'uninstall', 'remove every marketplace, skill, and server this plugin manages')
    .option('--scope <scope>', 'which scope\'s registry and skills to remove', assertScope, 'user')
    .option('--dry-run', 'report what would be removed without writing anything')
    .option('--purge-log', 'also delete the audit log (default: keep it)')
    .action((options: { scope: string; dryRun?: boolean; purgeLog?: boolean }) => {
      const report = uninstallAll(files, resolveSkillFiles(runtime.cwd), {
        scope: assertScope(options.scope),
        dryRun: options.dryRun === true,
        purgeLog: options.purgeLog === true,
      })
      emit(runtime, report, 'text')
      runtime.exit(report.summary.failed === 0 ? 0 : 1)
    })

  return { program, pending }
}

/** Build one server input from parsed CLI options and `--` passthrough args. */
function serverInputFromOptions(
  options: Record<string, unknown>,
  passthrough: string[],
): Parameters<typeof addServer>[3] {
  const transport = options.transport === 'http' ? 'streamable-http' : 'stdio'
  const env: Record<string, string> = {}
  for (const item of (options.env as string[] | undefined) ?? []) {
    const eq = item.indexOf('=')
    if (eq === -1) {
      // Bare name: pass the same-named environment variable through, e.g.
      // `-e GITHUB_TOKEN` stores `GITHUB_TOKEN: ${GITHUB_TOKEN}`.
      env[item] = `\${${item}}`
    } else {
      // KEY=VALUE: the value is stored literally (a full-string `${VAR}`
      // value is still recognized as an env reference by the registry).
      env[item.slice(0, eq)] = item.slice(eq + 1)
    }
  }
  const headers: Record<string, string> = {}
  for (const item of (options.header as string[] | undefined) ?? []) {
    const colon = item.indexOf(':')
    if (colon === -1) throw new InvalidArgumentError(`--header value ${JSON.stringify(item)} must be "Key: Value"`)
    headers[item.slice(0, colon).trim()] = item.slice(colon + 1).trim()
  }
  const timeout = typeof options.timeout === 'number' ? options.timeout : undefined
  if (transport === 'streamable-http') {
    if (typeof options.url !== 'string' || options.url === '') {
      throw new InvalidArgumentError('http transport requires --url <url>')
    }
    return {
      transport: 'streamable-http',
      url: options.url,
      headers,
      ...timeout === undefined ? {} : { toolCallTimeoutMs: timeout },
    }
  }
  if (passthrough.length === 0) {
    throw new InvalidArgumentError('stdio transport needs a command — use `-- <command> [args...]` (catalog shorthand arrives in M4)')
  }
  return {
    transport: 'stdio',
    command: passthrough[0]!,
    args: passthrough.slice(1),
    env,
    ...typeof options.cwd === 'string' && options.cwd !== '' ? { cwd: options.cwd } : {},
    ...timeout === undefined ? {} : { toolCallTimeoutMs: timeout },
  }
}

/** Derive a valid registry name from a URI shorthand spec. */
function deriveInstallName(spec: string): string {
  const stripped = spec.replace(/^(npx|uvx|docker):/, '')
  const name = stripped.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  if (name === '') throw new InvalidArgumentError(`shorthand ${JSON.stringify(spec)} derives an empty name`)
  return name
}

/** Shared implementation for `mcp add` / `mcp update`. */
function runAddServer(
  runtime: ManagementRuntime,
  files: RegistryFiles,
  serverName: string,
  options: Record<string, unknown>,
  passthrough: string[],
  update: boolean,
): { exit: number } {
  let input: Parameters<typeof addServer>[3]
  let installName = serverName
  try {
    if (options.transport !== 'http' && passthrough.length === 0) {
      // Shorthand: catalog name or npx:/uvx:/docker: URI form. URI forms
      // install under a derived valid name.
      const shorthand = resolveShorthand(serverName)
      if (shorthand === undefined) {
        throw new InvalidArgumentError(
          `unknown shorthand ${JSON.stringify(serverName)} — use \`-- <command> [args...]\`, a catalog name (try \`search ${serverName}\`), or npx:/uvx:/docker: forms`,
        )
      }
      if (/^(npx|uvx|docker):/.test(serverName)) installName = deriveInstallName(serverName)
      input = shorthand
      const found = findOnPath(shorthand.command!, process.env)
      if (found === undefined) {
        runtime.stderr.write(`warning: runtime ${JSON.stringify(shorthand.command)} not found on PATH — the server will be registered but may fail to start\n`)
      }
    } else {
      input = serverInputFromOptions(options, passthrough)
    }
  } catch (error) {
    runtime.stderr.write(`error: ${String(error instanceof Error ? error.message : error)}\n`)
    return { exit: 1 }
  }
  const scope = assertScope(String(options.scope ?? 'user'))
  if (options.dryRun === true) {
    runtime.stdout.write(`would ${update ? 'update' : 'add'} ${installName} (${scope}): ${JSON.stringify(input, null, 2)}\n`)
    return { exit: 0 }
  }
  const origin = { source: runtime.origin, addedAt: new Date().toISOString() }
  const report = update
    ? updateServer(files, scope, installName, input)
    : addServer(files, scope, installName, input, origin)
  emit(runtime, report, 'text')
  return { exit: report.summary.failed === 0 ? 0 : 1 }
}

/**
 * Run one management invocation: parse args, execute the action, drain async
 * actions, and route exits. Commander errors (help, grammar, action
 * rejections) exit through `runtime.exit` with commander's code.
 * @param args - inner arguments, verbatim (the verb first).
 * @param runtime - IO and lifecycle wiring.
 */
export async function runManagement(args: readonly string[], runtime: ManagementRuntime): Promise<void> {
  const files = resolveRegistryFiles(runtime.cwd)
  const { program, pending } = managementProgram(runtime, files)
  try {
    program.parse([...args], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      runtime.exit(error.exitCode)
      return
    }
    runtime.stderr.write(`error: ${String(error)}\n`)
    runtime.exit(1)
    return
  }
  await Promise.all(pending)
}
