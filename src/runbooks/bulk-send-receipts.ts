/**
 * Runbook — bulk-send-receipts.
 *
 * Sends payment receipt emails to backers who already paid but didn't
 * receive a receipt (because RESEND_API_KEY wasn't configured in prod
 * at the time, or because the email sending feature wasn't yet wired).
 *
 * Two modes:
 *
 *   1. From crowdfund DB — queries the crowdfund-platform's `contributions`
 *      table via SSH tunnel / psql on the Konvo VPS and sends receipts to
 *      all backers (or a filtered subset by project/date).
 *
 *   2. From CSV — loads a CSV of (email, amount, tier, date) and sends
 *      receipts for each row. Useful when you have a Stripe export or
 *      a manual list of backers who need receipts.
 *
 * Sends via Resend API (raw fetch). Rate-limited to 2 emails/sec to
 * stay well within Resend's 10/sec burst limit.
 *
 * Risk: low. Sends emails only — no DB mutations. Each recipient
 * receives at most one email per run (deduped by email address).
 * Operator sees a preview + confirmation before any emails fire.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const RESEND_API = 'https://api.resend.com/emails';
const RATE_LIMIT_MS = 500; // 2 emails/sec
const FROM_ADDRESS = 'Konvo <hello@thekonvo.com>';

interface ReceiptRow {
  email:    string;
  amount:   number;    // dollars
  tier:     string;
  date:     string;    // ISO or YYYY-MM-DD
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildReceiptHtml(row: ReceiptRow): string {
  return `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <div style="display: inline-block; width: 40px; height: 40px; background: #FF733E; border-radius: 10px; line-height: 40px; color: white; font-weight: bold; font-size: 18px;">K</div>
      </div>
      <h1 style="font-size: 20px; margin: 0 0 8px; text-align: center;">Payment Receipt</h1>
      <p style="color: #666; text-align: center; margin: 0 0 24px;">Thank you for supporting Konvo!</p>
      <div style="background: #f8f8f8; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 6px 0; color: #666; font-size: 14px;">Tier</td><td style="padding: 6px 0; text-align: right; font-weight: 600; font-size: 14px;">${row.tier}</td></tr>
          <tr><td style="padding: 6px 0; color: #666; font-size: 14px;">Amount</td><td style="padding: 6px 0; text-align: right; font-weight: 600; font-size: 14px;">$${row.amount.toFixed(2)}</td></tr>
          <tr><td style="padding: 6px 0; color: #666; font-size: 14px;">Date</td><td style="padding: 6px 0; text-align: right; font-size: 14px;">${row.date}</td></tr>
          <tr><td style="padding: 6px 0; color: #666; font-size: 14px;">Email</td><td style="padding: 6px 0; text-align: right; font-size: 14px;">${row.email}</td></tr>
        </table>
      </div>
      <p style="font-size: 14px; color: #666; text-align: center;">
        Your account is ready at<br/>
        <a href="https://app.thekonvo.com/login?tab=signup" style="color: #FF733E;">app.thekonvo.com</a>
      </p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
      <p style="font-size: 11px; color: #999; text-align: center;">Konvo — thekonvo.com</p>
    </div>
  `;
}

async function sendOneReceipt(apiKey: string, row: ReceiptRow): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(RESEND_API, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        from:    FROM_ADDRESS,
        to:      row.email,
        subject: `Payment receipt — ${row.tier} ($${row.amount.toFixed(2)})`,
        html:    buildReceiptHtml(row)
      })
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { ok: false, error: `${res.status}: ${errBody.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ─── CSV parsing ──────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function parseCsv(filePath: string): Promise<{ rows: ReceiptRow[]; errors: string[] }> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Detect header
  const first = lines[0] ?? '';
  const hasHeader = first.toLowerCase().includes('email') && !first.includes('@');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rows: ReceiptRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i]!;
    const cols = line.split(',').map((c) => c.trim());
    const lineNum = hasHeader ? i + 2 : i + 1;

    const email = (cols[0] ?? '').toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      errors.push(`L${lineNum}: invalid email "${cols[0]}"`);
      continue;
    }
    if (seen.has(email)) continue; // dedup
    seen.add(email);

    const amount = parseFloat(cols[1] ?? '0');
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`L${lineNum}: invalid amount "${cols[1]}"`);
      continue;
    }

    const tier = (cols[2] ?? 'Backer').trim() || 'Backer';
    const date = (cols[3] ?? new Date().toISOString().slice(0, 10)).trim();

    rows.push({ email, amount, tier, date });
  }

  return { rows, errors };
}

// ─── DB query mode ────────────────────────────────────────────────────────

async function fetchFromDb(ctx: RunbookContext): Promise<ReceiptRow[]> {
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on
\\pset fieldsep ','

select
  c.email,
  c.amount::text,
  coalesce(rt.title, 'Contribution'),
  to_char(c.created_at, 'YYYY-MM-DD')
from public.contributions c
left join public.reward_tiers rt on rt.id = c.reward_tier_id
where c.email is not null
  and c.email != ''
order by c.created_at;
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }

  const rows: ReceiptRow[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const cols = line.split(',');
    const email = (cols[0] ?? '').toLowerCase();
    if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    const amount = parseFloat(cols[1] ?? '0');
    if (!Number.isFinite(amount) || amount <= 0) continue;
    rows.push({
      email,
      amount,
      tier: (cols[2] ?? 'Contribution').trim(),
      date: (cols[3] ?? '').trim()
    });
  }
  return rows;
}

// ─── Runbook ──────────────────────────────────────────────────────────────

const runbook: Runbook = {
  id:          'bulk-send-receipts',
  title:       'Bulk send payment receipts',
  description: 'Send receipt emails to previous backers who missed their confirmation. From DB or CSV.',
  risk:        'low',
  requires:    [],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // Check for Resend API key
    const resendKey = (Bun.env ?? process.env)['KONVO_RESEND_API_KEY']?.trim();
    if (!resendKey && !ctx.dryRun) {
      prompt.note(
        c.red('KONVO_RESEND_API_KEY is not set in your .env. Cannot send emails.\nAdd it and re-run, or use --dry-run to preview.'),
        'Missing config'
      );
      return { success: false, summary: 'KONVO_RESEND_API_KEY not configured.' };
    }

    const source = await prompt.select({
      message: 'Receipt source',
      options: [
        { value: 'db',     label: 'From crowdfund DB',     hint: 'Query contributions table via SSH tunnel' },
        { value: 'csv',    label: 'From CSV file',         hint: 'Load email,amount,tier,date from a file' },
        { value: '__exit', label: c.dim('Cancel'),         hint: c.dim('Return to main menu') }
      ]
    });
    if (prompt.isCancel(source) || source === '__exit') {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    let rows: ReceiptRow[];

    if (source === 'csv') {
      const pathIn = await prompt.text({
        message: 'Path to CSV (email,amount,tier,date)',
        placeholder: '~/Downloads/backers.csv',
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return 'Required.';
          const expanded = s.replace(/^~(?=$|\/)/, process.env['HOME'] ?? '~');
          const resolved = resolve(expanded);
          if (!existsSync(resolved)) return `File not found: ${resolved}`;
          if (!statSync(resolved).isFile()) return `Not a regular file.`;
          return undefined;
        }
      });
      if (prompt.isCancel(pathIn)) {
        prompt.cancel('Cancelled.');
        return { success: false, summary: 'Operator cancelled.' };
      }
      const csvPath = resolve((pathIn as string).trim().replace(/^~(?=$|\/)/, process.env['HOME'] ?? '~'));
      const sp = prompt.spinner();
      sp.start('Parsing CSV…');
      const { rows: parsed, errors } = await parseCsv(csvPath);
      sp.stop(`Parsed ${parsed.length} valid rows.`);
      if (errors.length > 0) {
        prompt.note(
          c.yellow(`${errors.length} invalid lines:\n`) + errors.slice(0, 5).map((e) => `  ${e}`).join('\n'),
          'Parse warnings'
        );
      }
      rows = parsed;
    } else {
      const sp = prompt.spinner();
      sp.start('Querying contributions from prod DB…');
      try {
        rows = await fetchFromDb(ctx);
      } catch (err) {
        sp.stop('Failed.');
        return { success: false, summary: err instanceof Error ? err.message : String(err) };
      }
      sp.stop(`Found ${rows.length} backer(s) with email.`);
    }

    if (rows.length === 0) {
      return { success: false, summary: 'No recipients found.' };
    }

    // Preview
    const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
    prompt.note(
      [
        `Recipients:    ${c.brand(String(rows.length))}`,
        `Total amount:  ${c.brand('$' + totalAmount.toFixed(2))}`,
        ``,
        c.dim('Sample (first 5):'),
        ...rows.slice(0, 5).map((r) =>
          c.dim(`  · ${r.email} — $${r.amount.toFixed(2)} (${r.tier}, ${r.date})`)
        ),
        rows.length > 5 ? c.dim(`  … and ${rows.length - 5} more`) : '',
        '',
        ctx.dryRun ? c.yellow('(dry-run — no emails will be sent)') : ''
      ].filter(Boolean).join('\n'),
      'Preview'
    );

    const confirmed = await prompt.confirm({
      message: `Send ${rows.length} receipt email(s)?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have sent ${rows.length} receipt email(s).`,
        details: { count: rows.length, dryRun: true }
      };
    }

    // Send emails with rate limiting
    const sp2 = prompt.spinner();
    sp2.start(`Sending ${rows.length} emails…`);
    let sent = 0;
    let failed = 0;
    const failures: { email: string; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const result = await sendOneReceipt(resendKey!, row);
      if (result.ok) {
        sent++;
      } else {
        failed++;
        if (failures.length < 10) failures.push({ email: row.email, error: result.error ?? 'unknown' });
      }

      // Rate limit + progress update
      if (i < rows.length - 1) await sleep(RATE_LIMIT_MS);
      if ((i + 1) % 10 === 0) {
        sp2.message(`Sending… ${i + 1}/${rows.length} (${sent} ok, ${failed} failed)`);
      }
    }
    sp2.stop(`Done: ${sent} sent, ${failed} failed.`);

    if (failures.length > 0) {
      prompt.note(
        failures.map((f) => `  ${f.email}: ${f.error}`).join('\n'),
        `${failed} failure(s)`
      );
    }

    const audit = await writeAudit(ctx.config, {
      runbookId: 'bulk-send-receipts',
      action:    'receipts-sent',
      target:    `${sent}/${rows.length}`,
      metadata:  { sent, failed, total: rows.length, source },
      dryRun:    ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
    }

    return {
      success: failed === 0,
      summary: `Sent ${sent} receipt(s)${failed > 0 ? `, ${failed} failed` : ''}.`,
      details: { sent, failed, total: rows.length }
    };
  }
};

export default runbook;
