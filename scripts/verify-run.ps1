# Real-machine pre-publish verification. Requires an environment that allows
# spawning piped child processes. All artifacts stay in the project root.
# Usage: & .local/verify-run.ps1 [-HarnessBin <path to bin.js>]
param([string]$HarnessBin = 'D:\Agents\DeepSeek-Harness\apps\cli\lib\bin.js')

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$env:DSH_HOME = Join-Path $root '.local\verify-home'
$dist = Join-Path $root '.local\dist'
$pkg = Join-Path $root 'packages\dsh-install'

Remove-Item $env:DSH_HOME -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $dist | Out-Null

Write-Output "=== build + pack ==="
pnpm --dir $pkg run build
pnpm --dir $pkg pack --pack-destination $dist
$tarball = (Get-ChildItem $dist -Filter '*.tgz' | Select-Object -First 1).FullName
Write-Output "tarball: $tarball"

# The project root contains '&', which the harness shell forwarding truncates
# in argv paths (documented in README). Install via pnpm directly + reconcile
# the bundles list manually; `dsh plugin add <tarball>` itself was already
# verified in earlier rounds.
Write-Output "=== install bundle into profile (pnpm + manual reconcile) ==="
node $HarnessBin plugin --profile install add is-even
$profileDir = Join-Path $env:DSH_HOME 'profiles\install'
# Keep the profile's own pnpm configuration: the project-root .npmrc
# (relative store-dir, isolated linker) must not leak into profile-dir pnpm.
Set-Content -Path (Join-Path $profileDir '.npmrc') -Value "node-linker=hoisted" -Encoding ascii
Copy-Item $tarball $profileDir
pnpm --dir $profileDir add ".\$(Split-Path $tarball -Leaf)"
$manifestPath = Join-Path $profileDir 'package.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath)
$json = $manifest | ConvertFrom-Json
$bundles = @($json.dsh.profile.bundles)
if ('@dsh-tools/dsh-install' -notin $bundles) { $bundles += '@dsh-tools/dsh-install' }
$json.dsh.profile.bundles = $bundles
[System.IO.File]::WriteAllText($manifestPath, ($json | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
Write-Output "bundles: $($json.dsh.profile.bundles -join ', ')"

Write-Output "=== A: skills add from git ==="
node $HarnessBin --profile install skills add 'github:anthropics/skills#skills/docx'

Write-Output "=== B: mcp add everything + doctor ==="
node $HarnessBin --profile install mcp add everything
node $HarnessBin --profile install mcp doctor everything

Write-Output "=== C: marketplace https URL + sync ==="
node $HarnessBin --profile install marketplace add net-test 'https://jsonplaceholder.typicode.com/todos'
node $HarnessBin --profile install marketplace sync net-test

Write-Output "=== D: claude-plugin import from github URL ==="
node $HarnessBin --profile install mcp import --from claude-plugin --path 'https://github.com/obra/superpowers'

Write-Output "=== E: spawn e2e suite ==="
pnpm --dir $pkg exec vitest run --config vitest.e2e.config.mjs

Write-Output "=== post state ==="
Write-Output '--- mcp.json ---'
Get-Content (Join-Path $env:DSH_HOME 'mcp.json') -ErrorAction SilentlyContinue
Write-Output '--- install/work (must be absent/empty) ---'
Get-ChildItem (Join-Path $env:DSH_HOME 'install\work') -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
Write-Output '--- install/leftover ---'
Get-ChildItem (Join-Path $env:DSH_HOME 'install\leftover') -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
Write-Output '--- audit log tail ---'
Get-Content (Join-Path $env:DSH_HOME 'logs\install.jsonl') -Tail 5 -ErrorAction SilentlyContinue
