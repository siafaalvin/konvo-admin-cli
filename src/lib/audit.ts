/**
 * Audit log writer. Each high-risk runbook should call writeAudit()
 * after a successful mutation so we have a record of who did what,
 * when, and against which target.
 *
 * Writes go to public.admin_cli_audit_log on prod via the same SSH+psql
 * channel runbooks already use — no separate Postgres connection
 * required, and the runbook's `requires: ['ssh']` already covers
 * audit-write capability.
 *
 * Writes are best-effort: a failed audit write does NOT fail the
 * runbook. If we can't write the audit row, we surface a yellow
 * note and move on. Losing the operation completely because we
 * couldn't log it would be worse than losing the audit trail for
 * one row.
 *
 * Schema reference (houvox-pwa migration 0108_admin_cli_audit_log):
 *   admin_cli_audit_log (id bigserial pk, operator, runbook_id, action,
 *                        target, metadata jsonb, dry_run, created_at)
 *
 * NOTE: this is deliberately NOT public.admin_audit_log — that name is
 * owned by migration 0080 (the immutable PII-access audit, a different
 * schema). Migration 0033 originally tried to claim admin_audit_log for
 * the CLI log but lost the name collision to 0080 in prod, so every CLI
 * audit write silently failed until 0108 gave this log its own table.
 */

import { psqlPiped } from './ssh.ts';
import type { Config } from './config.ts';

export interface AuditEntry {
  runbookId: string;
  action:    string;
  target?:   string;
  metadata?: Record<string, unknown>;
  dryRun:    boolean;
}

/**
 * Write an audit row. Returns { ok, error } so callers can surface
 * a soft warning on failure without exception handling. Never
 * throws.
 */
export async function writeAudit(
  cfg: Config,
  entry: AuditEntry
): Promise<{ ok: boolean; error?: string }> {
  // SQL-escape: single-quote all string values, double internal
  // single quotes. JSONB values are also single-quoted with the
  // ::jsonb cast.
  const q = (s: string): string => `'${s.replace(/'/g, `''`)}'`;
  const operator = cfg.operator;
  const target   = entry.target ? q(entry.target) : 'null';
  const metadata = entry.metadata
    ? `${q(JSON.stringify(entry.metadata))}::jsonb`
    : 'null::jsonb';

  const sql = `
insert into public.admin_cli_audit_log
  (operator, runbook_id, action, target, metadata, dry_run)
values
  (${q(operator)}, ${q(entry.runbookId)}, ${q(entry.action)}, ${target}, ${metadata}, ${entry.dryRun ? 'true' : 'false'});
`;

  try {
    const res = await psqlPiped(cfg, sql, 'supabase_admin');
    if (res.exitCode !== 0) {
      return {
        ok:    false,
        error: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 160)}`
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message.slice(0, 160) : String(err)
    };
  }
}
