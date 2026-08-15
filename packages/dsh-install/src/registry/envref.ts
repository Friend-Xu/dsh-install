/**
 * Environment reference handling: registry entries may carry `${VAR}`
 * references instead of literal secrets — either as the whole value
 * (`"${GITHUB_TOKEN}"`) or embedded in longer text (`"Bearer ${TOKEN}"`).
 * References are distinguishable at parse time and expanded only at mount
 * time (aggregator), so the file on disk never holds a resolved secret.
 * @module dsh-install/registry/envref
 */

/** A `${VAR}` reference; names follow shell variable rules. */
export const ENV_TEMPLATE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** One template segment: literal text or a variable reference. */
export type EnvSegment = string | { variable: string }

/** A parsed env value. */
export type EnvValue =
  | { kind: 'literal'; value: string }
  | { kind: 'env'; variable: string }
  | { kind: 'template'; segments: EnvSegment[] }

/**
 * Parse one env/header value.
 * - `${VAR}` as the whole value → a single reference.
 * - Embedded `${VAR}` occurrences → a template with segments.
 * - No `${` at all → a literal.
 * - Any `${...}`-shaped text whose inner name is invalid → loud error
 *   (`ENV_TEMPLATE_INVALID`): it is almost certainly a typo, and passing it
 *   through silently would leak `${...}` text into server environments.
 * @param value - the raw stored value.
 * @returns the parsed value.
 * @throws {@link Error} with code `ENV_TEMPLATE_INVALID` for malformed templates.
 */
export function parseEnvValue(value: string): EnvValue {
  const matches = [...value.matchAll(ENV_TEMPLATE_PATTERN)]
  if (matches.length === 0) {
    if (value.includes('${')) {
      throw Object.assign(
        new Error(`env value ${JSON.stringify(value)} contains a malformed ${'${...}'} template`),
        { code: 'ENV_TEMPLATE_INVALID' },
      )
    }
    return { kind: 'literal', value }
  }
  if (matches.length === 1 && matches[0]![0] === value) {
    return { kind: 'env', variable: matches[0]![1]! }
  }
  const segments: EnvSegment[] = []
  let cursor = 0
  for (const match of matches) {
    const index = match.index
    if (index > cursor) segments.push(value.slice(cursor, index))
    segments.push({ variable: match[1]! })
    cursor = index + match[0].length
  }
  if (cursor < value.length) segments.push(value.slice(cursor))
  return { kind: 'template', segments }
}

/** Result of expanding one stored value against an environment. */
export type ExpandedValue =
  | { resolved: true; value: string }
  | { resolved: false; missing: string[] }

/**
 * Expand a stored value against an environment snapshot.
 * @param value - the raw stored value.
 * @param env - the environment to resolve references from.
 * @returns the resolved literal, or the missing variable names.
 */
export function expandEnvValue(value: string, env: Readonly<Record<string, string | undefined>>): ExpandedValue {
  const parsed = parseEnvValue(value)
  if (parsed.kind === 'literal') return { resolved: true, value: parsed.value }
  if (parsed.kind === 'env') {
    const resolved = env[parsed.variable]
    if (resolved === undefined) return { resolved: false, missing: [parsed.variable] }
    return { resolved: true, value: resolved }
  }
  const missing: string[] = []
  let output = ''
  for (const segment of parsed.segments) {
    if (typeof segment === 'string') {
      output += segment
      continue
    }
    const resolved = env[segment.variable]
    if (resolved === undefined) missing.push(segment.variable)
    else output += resolved
  }
  if (missing.length > 0) return { resolved: false, missing }
  return { resolved: true, value: output }
}

/**
 * Expand a stored record (env vars or headers), omitting keys whose
 * reference cannot be fully resolved from the environment.
 * @param record - the stored record.
 * @param env - the environment to resolve references from.
 * @returns expanded record plus the names of missing variables.
 */
export function expandRecord(
  record: Record<string, string>,
  env: Readonly<Record<string, string | undefined>>,
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const [key, stored] of Object.entries(record)) {
    const expanded = expandEnvValue(stored, env)
    if (expanded.resolved) {
      values[key] = expanded.value
    } else {
      missing.push(...expanded.missing)
    }
  }
  return { values, missing }
}
