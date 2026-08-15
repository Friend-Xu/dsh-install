/**
 * Install reporting: per-item verdicts with stable reason codes, an audit
 * log (JSONL) holding every operation, and a human-readable renderer. The
 * report is a first-class product surface — CLI, slash commands, and the
 * durable audit trail all consume this one model.
 * @module dsh-install/ops/report
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Stable reason-code matrix (see DESIGN.md section 6). */
export const CODES = {
  /** The item was imported as-is. */
  IMPORTED: 'IMPORTED',
  /** Secrets were rewritten to ${VAR} references; nothing plaintext on disk. */
  SECRET_CONVERTED: 'SECRET_CONVERTED',
  /** The target name already exists elsewhere; the winner is recorded. */
  CONFLICT_EXISTING: 'CONFLICT_EXISTING',
  /** The name is invalid for its target namespace. */
  INVALID_NAME: 'INVALID_NAME',
  /** The entry shape is invalid. */
  INVALID_ENTRY: 'INVALID_ENTRY',
  /** The referenced item does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** A name already exists in the same scope. */
  DUPLICATE_SERVER: 'DUPLICATE_SERVER',
  /** The registry file on disk is corrupt or unsupported. */
  INVALID_REGISTRY_FILE: 'INVALID_REGISTRY_FILE',
  /** The source has commands DSH has no runtime for. */
  INCOMPATIBLE_COMMANDS: 'INCOMPATIBLE_COMMANDS',
  /** The source has agents DSH cannot mount without preset adaptation. */
  INCOMPATIBLE_AGENTS: 'INCOMPATIBLE_AGENTS',
  /** The source has hooks whose event shape DSH does not match. */
  INCOMPATIBLE_HOOKS: 'INCOMPATIBLE_HOOKS',
  /** A frontmatter/config field DSH does not recognize; kept in metadata. */
  SKIP_UNSUPPORTED_FIELD: 'SKIP_UNSUPPORTED_FIELD',
  /** A ${VAR} reference was not resolvable at operation time. */
  ENV_UNRESOLVED: 'ENV_UNRESOLVED',
  /** A required runtime (uvx/docker/npx) is not installed. */
  RUNTIME_MISSING: 'RUNTIME_MISSING',
  /** The audit log itself could not be appended. */
  AUDIT_LOG_FAILED: 'AUDIT_LOG_FAILED',
  /** The import source could not be read/fetched. */
  SOURCE_UNREACHABLE: 'SOURCE_UNREACHABLE',
  /** The operation itself failed. */
  OPERATION_FAILED: 'OPERATION_FAILED',
} as const

/** Verdict outcome kinds. */
export type VerdictKind = 'imported' | 'partial' | 'skipped' | 'failed'

/** One per-item adjudication. */
export interface Verdict {
  kind: VerdictKind
  /** Stable reason code from {@link CODES}. */
  code: string
  /** Human-readable one-liner. */
  message: string
  /** Optional detail: source→target mapping, next step, or raw error. */
  detail?: string
}

/** Rolled-up counts per verdict kind. */
export interface ReportSummary {
  imported: number
  partial: number
  skipped: number
  failed: number
}

/** One operation's complete report. */
export interface Report {
  /** Unique id (timestamp + random suffix); the audit log key. */
  id: string
  /** ISO timestamp. */
  timestamp: string
  /** Operation label, e.g. `mcp add github`. */
  action: string
  /** Operation target, e.g. a source or scope. */
  target: string
  verdicts: Verdict[]
  summary: ReportSummary
}

function summarize(verdicts: readonly Verdict[]): ReportSummary {
  const summary: ReportSummary = { imported: 0, partial: 0, skipped: 0, failed: 0 }
  for (const verdict of verdicts) summary[verdict.kind] += 1
  return summary
}

let counter = 0

/**
 * Build a report from an operation's verdicts.
 * @param action - operation label.
 * @param target - operation target.
 * @param verdicts - per-item adjudications.
 * @param now - timestamp provider (testable).
 * @returns the report.
 */
export function createReport(
  action: string,
  target: string,
  verdicts: readonly Verdict[],
  now: () => Date = () => new Date(),
): Report {
  const timestamp = now().toISOString()
  counter = (counter + 1) % 0xFFFFFF
  const id = `${timestamp.replace(/[-:.]/g, '')}-${counter.toString(16).padStart(6, '0')}`
  return { id, timestamp, action, target, verdicts: [...verdicts], summary: summarize(verdicts) }
}

/** Convenience: one-item report helpers. */
export const verdict = {
  imported: (code: string, message: string, detail?: string): Verdict =>
    detail === undefined ? { kind: 'imported', code, message } : { kind: 'imported', code, message, detail },
  partial: (code: string, message: string, detail?: string): Verdict =>
    detail === undefined ? { kind: 'partial', code, message } : { kind: 'partial', code, message, detail },
  skipped: (code: string, message: string, detail?: string): Verdict =>
    detail === undefined ? { kind: 'skipped', code, message } : { kind: 'skipped', code, message, detail },
  failed: (code: string, message: string, detail?: string): Verdict =>
    detail === undefined ? { kind: 'failed', code, message } : { kind: 'failed', code, message, detail },
}

/**
 * Append a report to the JSONL audit log. Parent directories are created;
 * failures throw so callers surface the audit gap honestly.
 * @param logPath - absolute audit log path.
 * @param report - the report to persist.
 */
export function appendAuditLog(logPath: string, report: Report): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${JSON.stringify(report)}\n`, 'utf8')
  } catch (error) {
    throw Object.assign(
      new Error(`cannot append to audit log ${logPath}: ${String(error)}`),
      { code: CODES.AUDIT_LOG_FAILED },
    )
  }
}

const KIND_LABEL: Record<VerdictKind, string> = {
  imported: '✅ 已导入',
  partial: '⚠️ 部分',
  skipped: '❌ 未迁移',
  failed: '🚫 失败',
}

/**
 * Render a report for humans (CLI default and slash-command output).
 * @param report - the report to render.
 * @returns multi-line text.
 */
export function renderReport(report: Report): string {
  const lines: string[] = [`安装报告 · ${report.action} · ${report.id}`]
  for (const kind of ['imported', 'partial', 'skipped', 'failed'] as const) {
    const group = report.verdicts.filter(item => item.kind === kind)
    if (group.length === 0) continue
    lines.push(`${KIND_LABEL[kind]} (${group.length})`)
    for (const item of group) {
      lines.push(`   ${item.message}${item.code === CODES.IMPORTED ? '' : ` — ${item.code}`}`)
      if (item.detail !== undefined) lines.push(`     ${item.detail}`)
    }
  }
  const { imported, partial, skipped, failed } = report.summary
  lines.push(`摘要: ${imported} 导入 · ${partial} 部分 · ${skipped} 未迁移 · ${failed} 失败`)
  return lines.join('\n')
}
