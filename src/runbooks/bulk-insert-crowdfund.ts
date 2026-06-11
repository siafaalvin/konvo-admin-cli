/**
 * Runbook #1 — Bulk insert crowdfund emails.
 *
 * Loads a local CSV, dedups + validates emails, generates a single
 * multi-row INSERT ... ON CONFLICT DO NOTHING, and pipes it through
 * SSH+psql as supabase_admin. The crowdfund_emails table itself
 * grants no automatic access — handle_new_user (the auth.users
 * trigger from migration 0021) reads this table on signup and
 * grants `access_method = 'crowdfund'` if the new user's email
 * matches.
 *
 * CSV format expected:
 *   - One email per line (headerless), OR
 *   - First column = email, other columns ignored, with optional
 *     header row containing 'email' (case-insensitive)
 *
 * Risk: low. The mutation itself is idempotent (ON CONFLICT DO
 * NOTHING). The danger is importing the WRONG file and mass-granting
 * access. Mitigations:
 *   - Show parsed counts (total / valid / dedup'd / sample first 5)
 *     before confirming.
 *   - Hard cap at 10000 rows in one run (more than that, batch it).
 *   - Operator must confirm with explicit y/N.
 *   - Audit-log entry on completion (TODO when admin_audit_log
 *     migration ships).
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { psqlPiped } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const MAX_ROWS = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ParseResult {
  total:    number;       // raw lines after header skip
  invalid:  string[];     // lines that didn't look like emails
  emails:   string[];     // unique, lowercased, validated
  sample:   string[];     // first five for preview
}

async function parseCsv(filePath: string): Promise<ParseResult> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Auto-detect header — if line 1 contains 'email' (case-insensitive)
  // and no '@', treat it as a header.
  const first = rawLines[0] ?? '';
  const hasHeader =
    first.toLowerCase().includes('email') && !first.includes('@');
  const dataLines = hasHeader ? rawLines.slice(1) : rawLines;

  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const line of dataLines) {
    // Take the first comma-separated field, in case the CSV has
    // additional columns we don't care about.
    const candidate = (line.split(',')[0] ?? '').trim().toLowerCase();
    if (!candidate) continue;
    if (!EMAIL_RE.test(candidate)) {
      invalid.push(candidate);
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    emails.push(candidate);
  }

  return {
    total:   dataLines.length,
    invalid,
    emails,
    sample:  emails.slice(0, 5)
  };
}

/**
 * Build a single SQL INSERT with multi-row VALUES. SQL-escape every
 * email by doubling embedded single quotes (none should be there
 * after EMAIL_RE validation, but cheap insurance).
 */
function buildInsertSql(emails: string[], campaign: string): string {
  const campaignEsc = campaign.replace(/'/g, `''`);
  const values = emails
    .map((e) => `('${e.replace(/'/g, `''`)}', '${campaignEsc}')`)
    .join(',\n  ');
  return [
    `\\set QUIET on`,
    `\\pset format unaligned`,
    `\\pset tuples_only on`,
    ``,
    `with ins as (`,
    `  insert into public.crowdfund_emails (email, campaign)`,
    `  values`,
    `  ${values}`,
    `  on conflict (email) do nothing`,
    `  returning email`,
    `)`,
    `select 'INSERTED=' || count(*)::text from ins;`,
    ``
  ].join('\n');
}

const runbook: Runbook = {
  id:          'bulk-insert-crowdfund',
  title:       'Bulk insert crowdfund emails',
  description: 'Load a CSV of emails into public.crowdfund_emails. New signups matching these emails auto-get crowdfund access.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Path to CSV.
    const pathIn = await prompt.text({
      message: 'Path to CSV file',
      placeholder: '~/Downloads/crowdfund-supporters.csv',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        const expanded = s.replace(/^~(?=$|\/)/, process.env['HOME'] ?? '~');
        const resolved = resolve(expanded);
        if (!existsSync(resolved)) return `File not found: ${resolved}`;
        if (!statSync(resolved).isFile()) return `Not a regular file: ${resolved}`;
        return undefined;
      }
    });
    if (prompt.isCancel(pathIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const csvPath = resolve((pathIn as string).trim().replace(/^~(?=$|\/)/, process.env['HOME'] ?? '~'));

    // 2. Parse + validate.
    const sp1 = prompt.spinner();
    sp1.start('Parsing CSV…');
    let parsed: ParseResult;
    try {
      parsed = await parseCsv(csvPath);
    } catch (err) {
      sp1.stop('Parse failed.');
      return {
        success: false,
        summary: err instanceof Error ? err.message : String(err)
      };
    }
    sp1.stop(`Parsed: ${parsed.emails.length} valid, ${parsed.invalid.length} invalid.`);

    if (parsed.emails.length === 0) {
      return {
        success: false,
        summary: 'No valid emails in CSV.',
        details: { csvPath, invalid: parsed.invalid.length }
      };
    }
    if (parsed.emails.length > MAX_ROWS) {
      return {
        success: false,
        summary: `Too many rows (${parsed.emails.length}). Max per run: ${MAX_ROWS}. Split the file and rerun.`,
        details: { csvPath, count: parsed.emails.length }
      };
    }

    // 3. Campaign name.
    const campaignIn = await prompt.text({
      message: 'Campaign name',
      placeholder: 'launch',
      initialValue: 'launch',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        if (!/^[a-z0-9_-]{1,40}$/.test(s)) {
          return 'Use a-z 0-9 _ - (max 40 chars).';
        }
        return undefined;
      }
    });
    if (prompt.isCancel(campaignIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const campaign = (campaignIn as string).trim();

    // 4. Preview + confirm.
    prompt.note(
      [
        `File:      ${c.brand(csvPath)}`,
        `Campaign:  ${c.brand(campaign)}`,
        `Total in file: ${parsed.total}`,
        `Valid:     ${c.green(String(parsed.emails.length))}`,
        `Invalid:   ${parsed.invalid.length === 0 ? c.dim('0') : c.yellow(String(parsed.invalid.length))}`,
        ``,
        c.dim('Sample (first 5):'),
        ...parsed.sample.map((e) => c.dim(`  · ${e}`)),
        parsed.invalid.length > 0
          ? '\n' + c.yellow('Invalid lines (first 3): ') + parsed.invalid.slice(0, 3).map((e) => `'${e}'`).join(', ')
          : '',
        ctx.dryRun ? '\n' + c.yellow('(dry-run — no rows will be inserted)') : ''
      ].filter(Boolean).join('\n'),
      'Preview'
    );

    const confirmed = await prompt.confirm({
      message: `Insert ${parsed.emails.length} emails as campaign '${campaign}'?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have inserted ${parsed.emails.length} emails.`,
        details: { csvPath, campaign, count: parsed.emails.length, dryRun: true }
      };
    }

    // 5. Apply.
    const sql = buildInsertSql(parsed.emails, campaign);
    const sp2 = prompt.spinner();
    sp2.start('Inserting…');
    const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
    if (res.exitCode !== 0) {
      sp2.stop('Insert failed.');
      return {
        success: false,
        summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`,
        details: { csvPath, campaign, exitCode: res.exitCode }
      };
    }
    sp2.stop('Insert complete.');

    // Parse "INSERTED=<n>" from output to report new vs duplicate.
    const m = res.stdout.match(/INSERTED=(\d+)/);
    const newCount   = m ? parseInt(m[1]!, 10) : -1;
    const dupCount   = newCount >= 0 ? parsed.emails.length - newCount : -1;

    return {
      success: true,
      summary: newCount >= 0
        ? `Inserted ${newCount} new (${dupCount} already present, campaign '${campaign}').`
        : `Insert succeeded for ${parsed.emails.length} emails (count parse failed).`,
      details: { csvPath, campaign, parsed: parsed.emails.length, newCount, dupCount }
    };
  }
};

export default runbook;
