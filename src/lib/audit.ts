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
 * Schema reference:
 *   admin_cli_audit_log (id bigint pk default nextval('admin_audit_log_id_seq'),
 *                        operator, runbook_id, action, target,
 *                        metadata jsonb, dry_run, created_at)
 *
 * NOTE: this is deliberately NOT public.admin_audit_log. History:
 * migration 0033 created admin_audit_log for the CLI log; migration 0080
 * later created its own admin_audit_log (CREATE TABLE IF NOT EXISTS) for
 * the immutable PII-access audit — a different, incompatible schema. In
 * prod the collision was resolved by renaming 0033's table to
 * admin_cli_audit_log (it kept its original sequence, admin_audit_log_id_seq),
 * leaving admin_audit_log to 0080. So the CLI log's table already exists in
 * prod with the correct shape; this writer just needs to target the right
 * name. (A migration to create admin_cli_audit_log was attempted as 0108 but
 * removed — prod already had the table, so no migration was needed.)
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
