# Optional: launcher aliases for `dsh mcp` / `dsh skills`

The bundle is fully self-sufficient through the dedicated management profile
(`dsh --profile install mcp ...`). For the exact `claude mcp add`-style
ergonomics, the harness launcher can alias two verbs to that profile — the
same pattern as the built-in `dsh web` alias for `--profile web`.

This is an optional, tiny change to the harness repository
(`apps/cli/src/args.ts`); **the bundle works without it**.

## Suggested change (apps/cli/src/args.ts)

Add, beside the `web` alias block (after line ~156 of the current file):

```typescript
// `mcp` and `skills` are aliases for the management profile that hosts the
// install-cli surface (see the dsh-install bundle). Boot-free launcher verbs
// would need a second binary; the alias keeps every grammar decision inside
// the plugin, exactly like the `web` alias.
for (const verb of ['mcp', 'skills'] as const) {
  const alias = program.command(verb).description(`alias of --profile install (${verb} ...); install the dsh-install bundle into the install profile first`)
  alias
    .helpOption(false)
    .allowUnknownOption()
    .passThroughOptions()
    .enablePositionalOptions()
    .argument('[args...]', 'arguments for the install profile')
    .option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
    .action((args: string[], options: BootOptions) => {
      rejectParentOptions(verb)
      resolved = resolveBoot(alias, 'install', options, args)
    })
}
```

## Alternative without a launcher change

A shell alias achieves the same ergonomics per machine:

```console
# PowerShell profile
function dshmcp { dsh --profile install mcp @args }
function dshskills { dsh --profile install skills @args }

# POSIX shell
alias dshmcp='dsh --profile install mcp'
alias dshskills='dsh --profile install skills'
```

## Why the launcher change is tiny

- `parseDshArgs` already owns aliasing (`web` → `--profile web`); the verbs
  add two entries to the same table with the same passthrough semantics.
- All grammar, validation, storage, and reporting stay inside the bundle —
  the launcher learns nothing about MCP or skills.
- Profiles, bundle reconciliation, and hot reload are untouched.
