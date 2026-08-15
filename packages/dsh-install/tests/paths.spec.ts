import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installLogPath,
  leftoverRootPath,
  marketplacesPath,
  projectMcpRegistryPath,
  projectRootOf,
  projectSkillsRootPath,
  userMcpRegistryPath,
  userSkillsManifestPath,
  userSkillsRootPath,
} from '../src/registry/paths.ts'

const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-install-paths-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

describe('paths.user registry', () => {
  it('resolves $DSH_HOME/mcp.json when DSH_HOME is set', () => {
    const home = tmp()
    process.env.DSH_HOME = home
    expect(userMcpRegistryPath()).toBe(join(home, 'mcp.json'))
    expect(userSkillsRootPath()).toBe(join(home, 'skills'))
    expect(userSkillsManifestPath()).toBe(join(home, 'skills-manifest.json'))
    expect(marketplacesPath()).toBe(join(home, 'marketplaces.json'))
    expect(installLogPath()).toBe(join(home, 'logs', 'install.jsonl'))
    expect(leftoverRootPath()).toBe(join(home, 'install', 'leftover'))
  })
})

describe('paths.project root discovery', () => {
  it('finds the nearest .git ancestor from a nested cwd', () => {
    const project = tmp()
    mkdirSync(join(project, '.git'))
    const nested = join(project, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    expect(projectRootOf(nested)).toBe(project)
    expect(projectMcpRegistryPath(nested)).toBe(join(project, '.dsh', 'mcp.json'))
    expect(projectSkillsRootPath(nested)).toBe(join(project, '.dsh', 'skills'))
  })

  it('returns undefined outside any project', () => {
    const dir = tmp()
    expect(projectRootOf(dir)).toBeUndefined()
    expect(projectMcpRegistryPath(dir)).toBeUndefined()
    expect(projectSkillsRootPath(dir)).toBeUndefined()
  })

  it('treats a .git file (worktree marker) as no project marker for scope purposes', () => {
    // projectRootOf requires a .git DIRECTORY; a gitfile-typed worktree is a
    // real project in practice, but v1 keeps the rule identical to the skill
    // provider (directory marker). Pin the current behavior.
    const dir = tmp()
    writeFileSync(join(dir, '.git'), 'gitdir: elsewhere')
    expect(projectRootOf(dir)).toBeUndefined()
  })
})
