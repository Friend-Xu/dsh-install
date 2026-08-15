# dsh-install

Install and manage **MCP servers** and **skills** for the DeepSeek Harness —
a registry-backed installer with live remounting, slash commands, ecosystem
importers, marketplaces, and auditable install reports.

```console
$ dsh --profile install mcp add github
$ dsh --profile install mcp add myapi --transport http --url https://api.example.com/mcp
$ dsh --profile install skills add github:obra/superpowers#brainstorming@v1.0
```

## Why this exists

The harness can already *consume* MCP servers (`@deepseek-ai/dsh-mcp-client`)
and skills (`dsh-skill-filesystem`), but installing them meant hand-editing
`cordis.yml` or copying files around. This bundle adds the management plane
Claude Code / Codex / CC Switch users expect, on top of the existing runtime:

| Surface | Command |
|---|---|
| CLI (management profile) | `dsh --profile install mcp|skills|search|marketplace|plugin ...` |
| Slash (web/TUI) | `/mcp`, `/skills` |
| Runtime | `mcp-registry` aggregator row (live remount, no restarts) |

## Install

One package, two rows. Install it into the profiles you use:

```console
# 1. A dedicated management profile (CLI surface)
dsh plugin --profile install add @dsh-tools/dsh-install

# 2. Every profile that should MOUNT the installed servers (e.g. web)
dsh plugin --profile web add @dsh-tools/dsh-install
```

Then enable the aggregator row in the consuming profile's
`cordis.patch.yml` (installing a plugin must never silently start spawning
child processes — the row ships disabled, like the harness's own
`skill-badge`):

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: mcp-registry
  disabled: false
```

That's the whole setup. Registry edits hot-reload: the aggregator watches
both files and remounts by server name, so `mcp add` in one terminal is
live in the running web host with zero restarts.

## Storage

```
$DSH_HOME/mcp.json                # user scope (default)
<project>/.dsh/mcp.json           # project scope (git-shareable; shadows user by name)
$DSH_HOME/skills-manifest.json    # skill provenance (source/ref/target)
$DSH_HOME/marketplaces.json       # registered marketplaces
$DSH_HOME/logs/install.jsonl      # audit trail (every operation, per-item verdicts)
$DSH_HOME/install/leftover/       # archived sources of un-migrated payloads
```

Secrets are never stored: env values are `${VAR}` references, expanded only
at mount time by the aggregator. Project roots follow the harness skill
provider's rule (nearest `.git` ancestor).

## Commands

### mcp

```console
dsh --profile install mcp add github                                  # builtin catalog
dsh --profile install mcp add uvx:mcp-server-git                       # URI shorthand
dsh --profile install mcp add myapi --transport http --url <url> --header "Authorization: Bearer ${T}"
dsh --profile install mcp add custom -- npx -y @scope/server -e API_KEY --timeout 30000
dsh --profile install mcp list [--format json] | mcp get <name> | mcp remove <name> [--all] [--dry-run]
dsh --profile install mcp on <name> | mcp off <name> | mcp update <name> ...
dsh --profile install mcp doctor <name>                               # runtime/env/endpoint checks
dsh --profile install mcp import --from claude|codex|mcp-json|claude-plugin|auto [--path <p>]
```

- `mcp add <name>` without `--` resolves the builtin catalog
  (`search <query>` lists it) or `npx:`/`uvx:`/`docker:` URI forms (URI
  forms install under a derived valid name).
- Catalog entries that need user-specific arguments (`filesystem`,
  `sqlite`, `sentry`) refuse the shorthand and point at the `--` form.
- Imports read `.mcp.json` (Cursor/VS Code/Smithery output),
  `~/.claude.json`, `~/.codex/config.toml`, or extract a claude-plugin
  package's content layer (skills + mcpServers). Un-migrated payloads
  (commands/agents/hooks) are reported with stable `INCOMPATIBLE_*` codes
  and archived, never destroyed.

### skills

```console
dsh --profile install skills add ./my-skill
dsh --profile install skills add github:owner/repo#subdir@v1.0
dsh --profile install skills add <path> --link            # symlink (dev mode)
dsh --profile install skills list | skills remove <name> [--all] [--dry-run] | skills update <name> <source>
```

Sources: local directories (bundle `SKILL.md` or flat `<name>.md`), git
specs (`git+URL`, `github:owner/repo`, `owner/repo#subdir@ref` — shallow
clone + ref pin). Installs land in `~/.dsh/skills` or `<project>/.dsh/skills`,
which the harness skill provider already watches — **installs hot-reload,
no restart**. `remove` only touches manifest-tracked installs.

### marketplace / plugin / search

```console
dsh --profile install marketplace add <name> <url-or-path>
dsh --profile install marketplace list | remove <name> | sync [<name>]
dsh --profile install search <query>
dsh --profile install plugin install <name>@<marketplace> [--extract-content] [--profile <p>]
```

Catalogs parse both the DSH-native shape (`{servers, skills, plugins}`) and
Claude Code marketplace documents (`.claude-plugin/marketplace.json`).
Plugin entries map by kind: dsh bundles forward to `dsh plugin add`;
claude-plugin packages — whether local directories, git specs, or GitHub
URLs — install their content layer with `--extract-content` or report
`INCOMPATIBLE_PLUGIN` honestly.

## Lifecycle of files the plugin writes

| Layer | Location | Lifetime |
|---|---|---|
| Clone work dir | `$DSH_HOME/install/work/` | Ephemeral: remote sources (skills, claude plugins) are shallow-cloned here, deleted again before the command returns; each clone resets the directory, so interrupted runs cannot accumulate |
| Leftover archive | `$DSH_HOME/install/leftover/` | Intentional: un-migrated payload sources (commands/agents/hooks) are archived as the "never destroyed" guarantee; `uninstall` clears it |
| Audit log | `$DSH_HOME/logs/install.jsonl` | Intentional, append-only history; `uninstall --purge-log` deletes it explicitly |

Out of scope by design: runtime caches of the tools MCP servers run on
(`~/.npm/_npx`, uv cache, docker images) are private caches owned by those
runtimes — the plugin detects runtimes but never installs, clears, or
manages their caches.

## Reports & audit

Every mutating operation prints per-item verdicts (`✅ imported` /
`⚠️ partial` / `❌ skipped` / `🚫 failed`) with stable reason codes
(`DUPLICATE_SERVER`, `SECRET_CONVERTED`, `INCOMPATIBLE_COMMANDS`,
`RUNTIME_MISSING`, ...) and appends the full report to
`$DSH_HOME/logs/install.jsonl`. Slash commands render the same reports
directly in the web UI — command input and output never reach the model.

## Uninstall

```console
dsh --profile install mcp remove --all [--scope user|project] [--dry-run]
dsh --profile install skills remove --all [--dry-run]      # manifest-tracked installs only
dsh --profile install uninstall [--dry-run] [--purge-log]  # everything this plugin manages
```

- `uninstall` removes every marketplace registration, every manifest-tracked
  skill, the scope's MCP registry file, and the leftover archive — one
  audited per-item report, idempotent, `--dry-run` writes nothing.
- Boundaries: manual skills and anything outside the plugin's own paths are
  **never touched**; the audit log survives by default (the uninstall is
  itself history) and `--purge-log` deletes it explicitly.
- The bundle package itself is a profile dependency: remove it with
  `dsh plugin --profile <name> remove dsh-install`, then drop the
  `mcp-registry` enable lines from each profile's `cordis.patch.yml`
  (the `uninstall` report prints both reminders).

## Slash commands

`/mcp [list|add ...|remove <n>|on <n>|off <n>]` and
`/skills [list|add ...|remove <n>|update <n> <src>]` are registered on the
host command registry, so both the web UI and TUI surfaces pick them up.
Both share the exact CLI grammar and ops core.

## Development

```console
pnpm install
pnpm --dir packages/dsh-install test        # 126 tests, sandbox-safe (no subprocess spawns)
pnpm --dir packages/dsh-install typecheck
pnpm --dir packages/dsh-install build       # tsdown → lib/
```

Local install during development (relative paths are anchored to your cwd):

```console
dsh plugin --profile install add ./packages/dsh-install
```

Published packages: `@dsh-tools/dsh-install` on npm (the tarball in
`.local/dist/` is the pre-publish verification artifact).

Dependency policy: harness-coupled packages (`cordis`, `dsh-cmdline`,
`dsh-commands`, `dsh-mcp-client`, `schemastery`) are **peerDependencies** —
profiles resolve them from the harness installation's own node_modules, so
there is exactly one copy and zero version drift. `dsh-home-paths` and
`commander` are ordinary dependencies.

## Known limitations (honest list)

- **stdio servers and git sources spawn subprocesses**; the test suite
  verifies the orchestration around them with fakes plus a real in-process
  Streamable-HTTP MCP e2e, but spawn paths need a non-sandboxed environment
  to exercise end to end (local-path installs cover the same code paths).
- **Shorthand adds are non-interactive**: the builtin catalog is a trusted
  snapshot and the resolved command is shown in the report; an interactive
  confirm prompt (with `--yes`) is reserved for a later release.
- **URI shorthands derive install names** (`uvx:mcp-server-git` →
  `mcp-server-git`); rename with `mcp update` if you want a different name.
- **Git-worktree projects** (`.git` is a file, not a directory) are not
  detected as project roots — identical to the harness skill provider rule.
- **Rich web popups** (CC-Switch-style forms) require client roster changes
  in the harness; this bundle contributes host-side slash commands only.
- Marketplace URL fetches, git cloning, and `dsh plugin` forwarding need
  network/CLI access; local file sources cover the same code paths in tests.

## Optional: launcher alias

For the exact `claude mcp add`-style ergonomics, the harness launcher can
alias two verbs to the management profile (same pattern as the built-in
`dsh web` alias). See `docs/launcher-alias.md` for the precise change to
`apps/cli/src/args.ts` — the bundle works fully without it.

## License

MIT
