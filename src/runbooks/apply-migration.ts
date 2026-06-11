/**
 * Phase 2 runbook — Apply migration.
 *
 * Reads a local SQL file and applies it to prod via SSH+psql as
 * supabase_admin. Designed for the houvox-pwa supabase/migrations/
 * pattern but works for any standalone SQL file the operator points
 * it at.
 *
 * Pre-checks:
 *   - File exists + is readable + isn't empty.
 *   - Operator confirms after seeing a stat'd preview (path, size,
 *     first/last 5 SQL lines).
 *
 * Apply path:
 *   - Pipes the entire file through stdin to psql with
 *     ON_ERROR_STOP=1 so a single failed statement aborts the
 *     whole migration cleanly (no partial state).
 *   - Reports any output from psql verbatim — operators frequently
 *     want to see the CREATE INDEX / NOTICE / etc. lines.
 *
 * Risk: high. Migrations are inherently mutations. The runbook does
 * NOT track which migrations have been applied (no migrations table
 * lookup); the operator is responsible for not double-applying.
 *
 * Idempotent migrations (CREATE TABLE IF NOT EXISTS, etc.) are safe
 * to re-apply; non-idempotent ones (ALTER TABLE ADD COLUMN) will
 * fail loudly on second run, which is the desired behavior.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'apply-migration',
  title:       'Apply migration',
  description: 'Read a local SQL file and apply it to prod via psql with ON_ERROR_STOP=1. High-risk, no double-apply check.',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Path.
    const pathIn = await prompt.text({
      message: 'Path to SQL file',
      placeholder: '~/Projects/houvox-pwa/supabase/migrations/0033_admin_audit_log.sql',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        const expanded = s.replace(/^~(?=$|\/)/, process.env['HOME'] ?? '~');
        const r = resolve(expanded);
        if (!existsSync(r)) return `File not found: ${r}`;
        if (!statSync(r).isFile()) return `Not a regular file: ${r}`;
        if (statSync(r).size === 0) return 'File is empty.';
        return undefined;
      }
    });
    if (prompt.isCancel(pathIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const sqlPath = resolve(
      (pathIn as string).trim().replace(/^~(?=$|\/)/, process.env['HOME'] ?? '~')
    );

    // 2. Stat + read.
    const file = Bun.file(sqlPath);
    const sql = await file.text();
    const lines = sql.split('\n');
    const sizeKb = (statSync(sqlPath).size / 1024).toFixed(1);

    // Filter to non-empty / non-comment-only lines for the preview
    // window — pure comment headers shouldn't crowd out the actual SQL.
    const nonComment = lines.filter((l) => {
      const trimmed = l.trim();
      return trimmed.length > 0 && !trimmed.startsWith('--');
    });
    const headPreview = nonComment.slice(0, 5);
    const tailPreview = nonComment.slice(-5);

    prompt.note(
      [
        `File:  ${c.brand(sqlPath)}`,
        `Size:  ${sizeKb} KB, ${lines.length} lines (${nonComment.length} non-comment).`,
        '',
        c.dim('First 5 non-comment lines:'),
        ...headPreview.map((l) => `  ${c.dim('│')} ${l.slice(0, 80)}`),
        c.dim('  …'),
        c.dim('Last 5 non-comment lines:'),
        ...tailPreview.map((l) => `  ${c.dim('│')} ${l.slice(0, 80)}`),
        '',
        c.yellow('ON_ERROR_STOP=1 — first failed statement aborts the migration.'),
        ctx.dryRun ? c.yellow('(dry-run — psql will not be invoked)') : ''
      ].filter(Boolean).join('\n'),
      'Migration preview'
    );

    // 3. Confirm.
    const confirmed = await prompt.confirm({
      message: 'Apply this migration to prod?',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have applied ${sqlPath}.`,
        details: { sqlPath, sizeKb, dryRun: true }
      };
    }

    // 4. Apply.
    const sp = prompt.spinner();
    sp.start('Piping SQL to psql…');
    const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
    if (res.exitCode !== 0) {
      sp.stop('Migration failed.');
      // Show stderr verbatim — operator needs the actual psql error
      // to figure out which statement failed.
      prompt.note(
        [
          c.red(`psql exit ${res.exitCode}`),
          '',
          c.dim('stderr:'),
          res.stderr.trim() || '(empty)',
          '',
          c.dim('stdout (last 20 lines):'),
          res.stdout.split('\n').slice(-20).join('\n')
        ].join('\n'),
        'psql output'
      );
      return {
        success: false,
        summary: `psql exit ${res.exitCode}. Migration may be partially applied — review the output above.`,
        details: { sqlPath, exitCode: res.exitCode }
      };
    }
    sp.stop('Migration applied.');

    // Show the psql output (CREATE TABLE, CREATE INDEX, etc.) so
    // the operator can confirm the expected statements ran.
    if (res.stdout.trim()) {
      prompt.note(res.stdout.trim().slice(0, 4000), 'psql output');
    }

    // Audit log — best effort, soft failure.
    const audit = await writeAudit(ctx.config, {
      runbookId: 'apply-migration',
      action:    'migration-applied',
      target:    basename(sqlPath),
      metadata:  { sqlPath, sizeKb: parseFloat(sizeKb), nonCommentLines: nonComment.length },
      dryRun:    ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`), 'Warning');
    }

    return {
      success: true,
      summary: `Applied ${sqlPath} (${sizeKb} KB).`,
      details: { sqlPath, sizeKb }
    };
  }
};

export default runbook;
