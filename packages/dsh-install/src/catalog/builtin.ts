/**
 * The builtin catalog snapshot: well-known, broadly used MCP servers that
 * ship with the plugin so `mcp add <name>` works offline. Env requirements
 * are declared (never values); entries whose arguments must be user-supplied
 * refuse the shorthand and point at the `--` form instead.
 * @module dsh-install/catalog/builtin
 */

import type { CatalogEntry } from './model.ts'

/** The builtin snapshot, in a stable order. */
export const BUILTIN_CATALOG: readonly CatalogEntry[] = [
  {
    name: 'github',
    description: 'Official GitHub server: issues, PRs, and repository search',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{ name: 'GITHUB_TOKEN', description: 'GitHub personal access token', required: true }],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'filesystem',
    description: 'Official filesystem server: read/write files under allowed directories',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: [],
    requiresArgs: true,
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'everything',
    description: 'Official integration-test server: echoes, sums, and probes',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    env: [],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'memory',
    description: 'Official knowledge-graph memory server (local persistence)',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: [],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'sequential-thinking',
    description: 'Official server for step-by-step reasoning',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    env: [],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'fetch',
    description: 'Fetch web pages and convert to markdown (Python)',
    runtime: 'uvx',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    env: [],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'git',
    description: 'Git repository operations (Python)',
    runtime: 'uvx',
    command: 'uvx',
    args: ['mcp-server-git'],
    env: [],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'sqlite',
    description: 'SQLite database queries (Python)',
    runtime: 'uvx',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    env: [],
    requiresArgs: true,
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'time',
    description: 'Time and timezone conversions (Python)',
    runtime: 'uvx',
    command: 'uvx',
    args: ['mcp-server-time'],
    env: [],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'sentry',
    description: 'Sentry error monitoring (needs --auth-token: use the `--` form)',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server-sentry'],
    env: [],
    requiresArgs: true,
    source: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    name: 'context7',
    description: 'Up-to-date library documentation lookup',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: [],
    source: 'https://github.com/upstash/context7',
  },
  {
    name: 'playwright',
    description: 'Browser automation for testing and scraping',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    env: [],
    source: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    name: 'brave-search',
    description: 'Brave web search API',
    runtime: 'npx',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: [{ name: 'BRAVE_API_KEY', description: 'Brave Search API key', required: true }],
    source: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    name: 'docker-git',
    description: 'Git repository operations (Docker image)',
    runtime: 'docker',
    command: 'docker',
    args: ['run', '-i', '--rm', 'mcp/git'],
    env: [],
    source: 'https://hub.docker.com/r/mcp/git',
  },
  {
    name: 'docker-fetch',
    description: 'Fetch web pages (Docker image)',
    runtime: 'docker',
    command: 'docker',
    args: ['run', '-i', '--rm', 'mcp/fetch'],
    env: [],
    source: 'https://hub.docker.com/r/mcp/fetch',
  },
]

/** Look up a builtin entry by shorthand name. */
export function builtinEntry(name: string): CatalogEntry | undefined {
  return BUILTIN_CATALOG.find(entry => entry.name === name)
}

/** Names matching a query (case-insensitive substring over name+description). */
export function searchBuiltin(query: string): CatalogEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...BUILTIN_CATALOG]
  return BUILTIN_CATALOG.filter(entry =>
    entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle))
}
