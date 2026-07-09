/**
 * Runbook — bulk-add-user-grants.
 *
 * Loads a CSV of user grants and bulk-inserts them into
 * public.admin_grants. When these emails sign up on Konvo,
 * handle_new_user auto-promotes them based on the grant settings.
 *
 * CSV format:
 *   email,tier,pricing_band,seed_geofence_passes,notes
 *
 * - email: required, valid email
 * - tier: resident | resident_plus | standard (default: resident)
 * - pricing_band: campaign | standard (default: campaign)
 * - seed_geofence_passes: 0-3 (default: 0)
 * - notes: optional freetext
 *
 * Example:
 *   email,tier,pricing_band,seed_geofence_passes,notes
 *   alice@example.com,resident_plus,campaign,3,VIP early backer
 *   bob@example.com,resident,campaign,0,game registration
 *   carol@example.com,,,, (uses all defaults)
 *
 * Risk: low. Idempotent (ON CONFLICT email DO UPDATE). Each grant
 * only takes effect when the user actually signs up. Audit-logged.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const MAX_ROWS = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TIERS = new Set(['standard', 'resident', 'resident_plus']);
const VALID_BANDS = new Set(['campaign', 'standard']);

interface GrantRow {
  email: string;
  name: string;
  tier: string;
  pricing_band: string;
  seed_geofence_passes: number;
  notes: string;
}

interface ParseResult {
  total: number;
  invalid: { line: number; reason: string; raw: string }[];
  grants: GrantRow[];
  sample: GrantRow[];
}

async function parseCsv(filePath: string): Promise<ParseResult> {
  const file = Bun.file(filePath);
  const text = await file.text();
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Detect header
  const first = rawLines[0] ?? '';
  const hasHeader = first.toLowerCase().includes('email') && !first.includes('@');
  const dataLines = hasHeader ? rawLines.slice(1) : rawLines;

  const seen = new Set<string>();
  const grants: GrantRow[] = [];
  const invalid: { line: number; reason: string; raw: string }[] = [];

  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i]!;
    const cols = line.split(',').map((c) => c.trim());
    const lineNum = hasHeader ? i + 2 : i + 1;

    const email = (cols[0] ?? '').toLowerCase();
    if (!email) { invalid.push({ line: lineNum, reason: 'empty email', raw: line }); continue; }
    if (!EMAIL_RE.test(email)) { invalid.push({ line: lineNum, reason: 'invalid email format', raw: line }); continue; }
    if (seen.has(email)) continue; // dedup silently
    seen.add(email);

    const name = (cols[1] ?? '').trim();

    const tier = (cols[2] ?? '').toLowerCase() || 'resident';
    if (!VALID_TIERS.has(tier)) {
      invalid.push({ line: lineNum, reason: `invalid tier '${tier}' (use: standard, resident, resident_plus)`, raw: line });
      continue;
    }

    const band = (cols[3] ?? '').toLowerCase() || 'campaign';
    if (!VALID_BANDS.has(band)) {
      invalid.push({ line: lineNum, reason: `invalid pricing_band '${band}' (use: campaign, standard)`, raw: line });
      continue;
    }

    const seedStr = cols[4] ?? '0';
    const seed = parseInt(seedStr, 10);
    if (isNaN(seed) || seed < 0 || seed > 3) {
      invalid.push({ line: lineNum, reason: `invalid seed_geofence_passes '${seedStr}' (use 0-3)`, raw: line });
      continue;
    }

    const notes = cols[5] ?? '';

    grants.push({ email, name, tier, pricing_band: band, seed_geofence_passes: seed, notes });
  }

  return {
    total: dataLines.length,
    invalid,
    grants,
    sample: grants.slice(0, 5),
  };
}

function buildInsertSql(grants: GrantRow[], grantedBy: string): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const values = grants
    .map(
      (g) =>
        `('${esc(g.email)}', ${g.name ? `'${esc(g.name)}'` : 'NULL'}, '${esc(g.tier)}', '${esc(g.pricing_band)}', ${g.seed_geofence_passes}, '${esc(grantedBy)}', ${g.notes ? `'${esc(g.notes)}'` : 'NULL'})`
    )
    .join(',\n  ');

  return [
    `\\set QUIET on`,
    `\\pset format unaligned`,
    `\\pset tuples_only on`,
    ``,
    `with ins as (`,
    `  insert into public.admin_grants (email, name, tier_grant, pricing_band_grant, seed_geofence_passes, granted_by, notes)`,
    `  values`,
    `  ${values}`,
    `  on conflict (lower(email)) do update set`,
    `    name                 = COALESCE(excluded.name, admin_grants.name),
    tier_grant           = excluded.tier_grant,`,
    `    pricing_band_grant   = excluded.pricing_band_grant,`,
    `    seed_geofence_passes = excluded.seed_geofence_passes,`,
    `    granted_by           = excluded.granted_by,`,
    `    notes                = excluded.notes`,
    `  where admin_grants.redeemed_at is null`,
    `  returning email`,
    `)`,
    `select 'UPSERTED=' || count(*)::text from ins;`,
    ``
  ].join('\n');
}

const runbook: Runbook = {
  id:          'bulk-add-user-grants',
  title:       'Bulk add user grants (CSV)',
  description: 'Load a CSV of email+tier grants into public.admin_grants. Matching signups auto-get the specified tier.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. CSV path
    const pathIn = await prompt.text({
      message: 'Path to CSV file',
      placeholder: '~/Downloads/user-grants.csv',
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

    // 2. Parse
    const sp1 = prompt.spinner();
    sp1.start('Parsing CSV…');
    let parsed: ParseResult;
    try {
      parsed = await parseCsv(csvPath);
    } catch (err) {
      sp1.stop('Parse failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp1.stop(`Parsed: ${parsed.grants.length} valid grants, ${parsed.invalid.length} invalid.`);

    if (parsed.grants.length === 0) {
      return { success: false, summary: 'No valid grants in CSV.', details: { invalid: parsed.invalid.slice(0, 5) } };
    }
    if (parsed.grants.length > MAX_ROWS) {
      return { success: false, summary: `Too many rows (${parsed.grants.length}). Max: ${MAX_ROWS}.` };
    }

    // 3. Granted-by label
    const grantedByIn = await prompt.text({
      message: 'Granted by (operator label)',
      placeholder: 'admin-cli:bulk',
      initialValue: 'admin-cli:bulk',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        if (s.length > 100) return 'Max 100 chars.';
        return undefined;
      }
    });
    if (prompt.isCancel(grantedByIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const grantedBy = (grantedByIn as string).trim();

    // 4. Preview
    const tierCounts = { standard: 0, resident: 0, resident_plus: 0 };
    for (const g of parsed.grants) {
      tierCounts[g.tier as keyof typeof tierCounts]++;
    }

    prompt.note(
      [
        `File:      ${c.brand(basename(csvPath))}`,
        `Total in file: ${parsed.total}`,
        `Valid:     ${c.green(String(parsed.grants.length))}`,
        `Invalid:   ${parsed.invalid.length === 0 ? c.dim('0') : c.yellow(String(parsed.invalid.length))}`,
        ``,
        c.dim('Tier breakdown:'),
        `  resident:       ${tierCounts.resident}`,
        `  resident_plus:  ${tierCounts.resident_plus}`,
        `  standard:       ${tierCounts.standard}`,
        ``,
        c.dim('Sample (first 5):'),
        ...parsed.sample.map((g) => c.dim(`  · ${g.email}${g.name ? ` (${g.name})` : ''} → ${g.tier} (${g.pricing_band}, seed=${g.seed_geofence_passes})${g.notes ? ` [${g.notes}]` : ''}`)),
        parsed.invalid.length > 0
          ? '\n' + c.yellow('Invalid lines (first 3):') + '\n' + parsed.invalid.slice(0, 3).map((e) => `  L${e.line}: ${e.reason} → "${e.raw}"`).join('\n')
          : '',
        ctx.dryRun ? '\n' + c.yellow('(dry-run — no rows will be inserted)') : ''
      ].filter(Boolean).join('\n'),
      'Preview'
    );

    const confirmed = await prompt.confirm({
      message: `Upsert ${parsed.grants.length} grants as '${grantedBy}'?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have upserted ${parsed.grants.length} grants.`,
        details: { csvPath, count: parsed.grants.length, dryRun: true }
      };
    }

    // 5. Apply
    const sql = buildInsertSql(parsed.grants, grantedBy);
    const sp2 = prompt.spinner();
    sp2.start('Upserting grants…');
    const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
    if (res.exitCode !== 0) {
      sp2.stop('Upsert failed.');
      return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
    }
    sp2.stop('Upsert complete.');

    const m = res.stdout.match(/UPSERTED=(\d+)/);
    const upsertedCount = m ? parseInt(m[1]!, 10) : -1;

    const audit = await writeAudit(ctx.config, {
      runbookId: 'bulk-add-user-grants',
      action: 'admin-grants-bulk-upserted',
      target: `${grantedBy}:${basename(csvPath)}`,
      metadata: {
        grantedBy,
        csvPath,
        parsed: parsed.grants.length,
        invalid: parsed.invalid.length,
        upserted: upsertedCount,
        tierCounts,
      },
      dryRun: ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
    }

    return {
      success: true,
      summary: upsertedCount >= 0
        ? `Upserted ${upsertedCount} grants (${parsed.grants.length - upsertedCount} already redeemed/unchanged).`
        : `Upsert succeeded for ${parsed.grants.length} grants.`,
      details: { csvPath, grantedBy, parsed: parsed.grants.length, upserted: upsertedCount, tierCounts }
    };
  }
};

export default runbook;
