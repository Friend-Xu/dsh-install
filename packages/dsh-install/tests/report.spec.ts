import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendAuditLog, CODES, createReport, renderReport, verdict } from '../src/ops/report.ts'

const dirs: string[] = []

function tmp(): string {
  const dir = join(tmpdir(), `dsh-install-report-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = new Date('2026-08-20T12:00:00.000Z')

describe('report', () => {
  it('summarizes verdict kinds', () => {
    const report = createReport('mcp add github', 'user', [
      verdict.imported(CODES.IMPORTED, 'added'),
      verdict.partial(CODES.CONFLICT_EXISTING, 'shadowed'),
      verdict.skipped(CODES.INCOMPATIBLE_COMMANDS, 'no runtime'),
      verdict.failed(CODES.NOT_FOUND, 'missing'),
    ], () => NOW)
    expect(report.summary).toEqual({ imported: 1, partial: 1, skipped: 1, failed: 1 })
    expect(report.id).toContain('20260820T120000000Z')
  })

  it('renders grouped human text with codes on non-imported lines', () => {
    const report = createReport('mcp add github', 'user', [
      verdict.imported(CODES.IMPORTED, 'added github'),
      verdict.skipped(CODES.INCOMPATIBLE_COMMANDS, 'commands skipped', 'convert to a skill'),
    ], () => NOW)
    const text = renderReport(report)
    expect(text).toContain('✅ 已导入 (1)')
    expect(text).toContain('❌ 未迁移 (1)')
    expect(text).toContain('INCOMPATIBLE_COMMANDS')
    expect(text).toContain('convert to a skill')
    expect(text).toContain('摘要: 1 导入 · 0 部分 · 1 未迁移 · 0 失败')
  })

  it('appends JSONL audit records and creates parent directories', () => {
    const log = join(tmp(), 'nested', 'logs', 'install.jsonl')
    const report = createReport('mcp add github', 'user', [verdict.imported(CODES.IMPORTED, 'added')], () => NOW)
    appendAuditLog(log, report)
    appendAuditLog(log, report)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: 'mcp add github', target: 'user' })
  })

  it('reports audit log failures with AUDIT_LOG_FAILED', () => {
    const parent = join(tmp(), 'blocked')
    mkdirSync(parent)
    // A FILE where a directory is required makes the parent mkdir fail.
    writeFileSync(join(parent, 'file-as-dir'), 'x', 'utf8')
    const log = join(parent, 'file-as-dir', 'install.jsonl')
    const report = createReport('mcp add x', 'user', [verdict.imported(CODES.IMPORTED, 'ok')], () => NOW)
    expect(() => appendAuditLog(log, report)).toThrowError(
      expect.objectContaining({ code: CODES.AUDIT_LOG_FAILED }),
    )
  })
})
