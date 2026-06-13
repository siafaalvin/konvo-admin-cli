/**
 * Runbook — manage-building-holds.
 *
 * CRUD operations for the public.building_holds blocklist (introduced
 * in houvox-pwa migration 0038). Each row blocks one address from being
 * registered as a residence by individuals.
 *
 * Operations:
 *   list     — show recent active + dissolved holds
 *   add      — insert a new operator-curated hold (source='blocklist',
 *              configurable confidence + category + notes)
 *   inspect  — full hold history for a specific address
 *   dissolve — flip an active hold to dissolved with operator reason
 *
 * Risk: low. Single-row mutations on a small table. Each action
 * audit-logged. Operator confirms each mutation explicitly. Reversible
 * (dissolution leaves the row in place; can re-block by inserting a new row).
 *
 * The PWA's signup gate (Task 33) calls /v1/buildings/check during
 * AddressClaimForm.submit; that endpoint reads building_holds via
 * is_address_blocked + building_hold_status. Mutations here take effect
 * immediately for the next signup attempt.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface BuildingHold {
  id:               string;
  address_id:       string;
  formatted:        string;
  source:           'blocklist' | 'osm' | 'heuristic';
  confidence:       'high' | 'medium' | 'low';
  category:         string | null;
  notes:            string | null;
  created_by:       string | null;
  created_at:       string;
  dissolved_at:     string | null;
  dissolved_by:     string | null;
  dissolved_reason: string | null;
}

const SOURCE_OPTIONS = [
  { value: 'blocklist', label: 'Blocklist',  hint: 'Operator-curated — highest confidence, wins over all' },
  { value: 'osm',       label: 'OSM',        hint: 'Picked up via OSM POI tags by the layered lookup' },
  { value: 'heuristic', label: 'Heuristic',  hint: 'Keyword / zoning match (lowest confidence)' }
] as const;

const CONFIDENCE_OPTIONS = [
  { value: 'high',   label: 'High',   hint: 'Auto-block — named civic building, clear amenity tag' },
  { value: 'medium', label: 'Medium', hint: 'Auto-block — OSM POI without strong tags' },
  { value: 'low',    label: 'Low',    hint: 'Flag-only — heuristic-only, user can confirm and proceed' }
] as const;

const CATEGORY_OPTIONS = [
  { value: 'school',        label: 'School',         hint: 'Educational institution' },
  { value: 'government',    label: 'Government',     hint: 'Townhall / courthouse / agency' },
  { value: 'hospital',      label: 'Hospital',       hint: 'Medical facility' },
  { value: 'park',          label: 'Park',           hint: 'Public park / recreation area' },
  { value: 'landmark',      label: 'Landmark',       hint: 'Tourist / historic site' },
  { value: 'commercial',    label: 'Commercial',     hint: 'Retail / office without residential use' },
  { value: 'public_safety', label: 'Public safety',  hint: 'Police / fire station' },
  { value: 'other',         label: 'Other',          hint: 'Operator specifies in notes' }
] as const;

const DISSOLVE_REASON_OPTIONS = [
  { value: 'verified',     label: 'Building verification passed',  hint: 'Owner provided proof of residential use' },
  { value: 'admin_review', label: 'Administrative review',         hint: 'Operator decision to allow' },
  { value: 'duplicate',    label: 'Duplicate hold',                hint: 'Another active hold supersedes' },
  { value: 'out_of_date',  label: 'Out-of-date data',              hint: 'OSM tag corrected; building is residential' }
] as const;

const ACTION_OPTIONS = [
  { value: 'list',     label: 'List recent holds',         hint: 'Show active + recent dissolved' },
  { value: 'add',      label: 'Add a hold',                hint: 'Block an address from registration' },
  { value: 'inspect',  label: 'Inspect address',           hint: 'Full hold history for one address' },
  { value: 'dissolve', label: 'Dissolve a hold',           hint: 'Lift a block (operator reason required)' },
  { value: '__exit',   label: c.dim('Cancel'),             hint: c.dim('Return to main menu') }
] as const;

const runbook: Runbook = {
  id:          'manage-building-holds',
  title:       'Manage building holds (blocklist)',
  description: 'CRUD for public.building_holds — the building registration blocklist consumed by /v1/buildings/check. Audit-logged.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = await prompt.select({
      message: 'What would you like to do?',
      options: [...ACTION_OPTIONS]
    });
    if (prompt.isCancel(action) || action === '__exit') {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    switch (action) {
      case 'list':     return listHolds(ctx);
      case 'add':      return addHold(ctx);
      case 'inspect':  return inspectAddress(ctx);
      case 'dissolve': return dissolveHold(ctx);
      default:         return { success: false, summary: `Unknown action: ${action as string}` };
    }
  }
};

// ─── shared helpers ──────────────────────────────────────────────────────

const sqlEsc = (s: string): string => s.replace(/'/g, `''`);

async function lookupAddressId(ctx: RunbookContext, formattedHint: string): Promise<{ id: string; formatted: string } | null> {
  const res = await psqlPiped(ctx.config, `
\\pset format unaligned
\\pset tuples_only on
select id || E'\\x1f' || formatted
  from public.addresses
  where lower(formatted) like lower('%${sqlEsc(formattedHint)}%')
  order by created_at desc
  limit 5;
`, 'supabase_admin');
  if (res.exitCode !== 0) return null;

  const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  // If just one match, take it. Otherwise, let the operator pick.
  if (lines.length === 1) {
    const parts = lines[0]?.split('\x1f') ?? [];
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { id: parts[0], formatted: parts[1] };
    }
    return null;
  }

  const choice = await ctx.prompt.select({
    message: 'Multiple matches — pick one',
    options: lines.map((l) => {
      const [id, formatted] = l.split('\x1f');
      return { value: id ?? '', label: formatted ?? '(unknown)', hint: id?.slice(0, 8) ?? '' };
    })
  });
  if (ctx.prompt.isCancel(choice)) return null;
  const matched = lines.find((l) => l.startsWith((choice as string) + '\x1f'));
  if (!matched) return null;
  const parts = matched.split('\x1f');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { id: parts[0], formatted: parts[1] };
}

// ─── list ────────────────────────────────────────────────────────────────

async function listHolds(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;
  const sql = `
\\pset format unaligned
\\pset tuples_only on
select
  h.id || E'\\x1f' ||
  a.formatted || E'\\x1f' ||
  h.source || E'\\x1f' ||
  h.confidence || E'\\x1f' ||
  coalesce(h.category, '') || E'\\x1f' ||
  coalesce(h.created_by, '') || E'\\x1f' ||
  to_char(h.created_at, 'YYYY-MM-DD HH24:MI') || E'\\x1f' ||
  case when h.dissolved_at is null then '' else to_char(h.dissolved_at, 'YYYY-MM-DD HH24:MI') end
from public.building_holds h
join public.addresses a on a.id = h.address_id
order by h.dissolved_at nulls first, h.created_at desc
limit 50;
`;
  const sp = prompt.spinner();
  sp.start('Reading building_holds…');
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  sp.stop('Done.');
  if (res.exitCode !== 0) {
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
  }

  const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    prompt.note(c.dim('No building holds on prod.'), 'Empty');
    return { success: true, summary: 'building_holds is empty.' };
  }

  const rendered = lines.map((line) => {
    const [, formatted, source, confidence, category, by, created, dissolved] = line.split('\x1f');
    const status = dissolved
      ? c.dim(`dissolved ${dissolved.slice(0, 10)}`)
      : c.green('active');
    const cat = category ? ` · ${category}` : '';
    const issuer = by ? ` by ${by}` : '';
    return `  ${status.padEnd(28)} ${(formatted ?? '').padEnd(50).slice(0, 50)} ${(source ?? '').padEnd(10)} ${(confidence ?? '').padEnd(8)}${cat}  ${c.dim(`${created}${issuer}`)}`;
  }).join('\n');

  prompt.note(rendered, `${lines.length} hold(s)`);
  return { success: true, summary: `Listed ${lines.length} building hold(s).` };
}

// ─── add ─────────────────────────────────────────────────────────────────

async function addHold(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;

  const formattedIn = await prompt.text({
    message: 'Address (partial match OK)',
    placeholder: '900 Wayne Ave, Silver Spring',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Required.' : undefined)
  });
  if (prompt.isCancel(formattedIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const matched = await lookupAddressId(ctx, (formattedIn as string).trim());
  if (!matched) {
    return { success: false, summary: 'No matching addresses found. Address must already be in public.addresses (claimed at least once).' };
  }

  const source = await prompt.select({
    message: 'Source',
    options: [...SOURCE_OPTIONS],
    initialValue: 'blocklist'
  });
  if (prompt.isCancel(source)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

  const confidence = await prompt.select({
    message: 'Confidence',
    options: [...CONFIDENCE_OPTIONS],
    initialValue: 'high'
  });
  if (prompt.isCancel(confidence)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

  const category = await prompt.select({
    message: 'Category',
    options: [...CATEGORY_OPTIONS]
  });
  if (prompt.isCancel(category)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

  const notesIn = await prompt.text({
    message: 'Notes (visible to user when blocked)',
    placeholder: 'e.g. Listed as Silver Spring Library on OSM, not residential',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Required.' : undefined)
  });
  if (prompt.isCancel(notesIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const notes = (notesIn as string).trim();

  prompt.note(
    [
      `Address:    ${matched.formatted}`,
      `Source:     ${source as string}`,
      `Confidence: ${confidence as string}`,
      `Category:   ${category as string}`,
      `Notes:      ${notes}`
    ].join('\n'),
    'Confirm hold'
  );

  const confirmed = await prompt.confirm({ message: 'Add this hold?', initialValue: false });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (ctx.dryRun) {
    return {
      success: true,
      summary: `Dry-run: would have added ${confidence as string}-confidence ${source as string} hold for ${matched.formatted}.`,
      details: { address_id: matched.id, formatted: matched.formatted, source, confidence, category, notes, dryRun: true }
    };
  }

  const sql = `
insert into public.building_holds
  (address_id, source, confidence, category, notes, created_by)
values
  ('${matched.id}'::uuid, '${sqlEsc(source as string)}', '${sqlEsc(confidence as string)}',
   '${sqlEsc(category as string)}', '${sqlEsc(notes)}', '${sqlEsc(ctx.config.operator)}')
on conflict do nothing
returning id;
`;
  const sp = prompt.spinner();
  sp.start('Inserting hold…');
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    sp.stop('Failed.');
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
  }
  sp.stop('Hold added.');

  // Detect 'on conflict do nothing' (an active hold already exists).
  const inserted = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean).length > 0;
  if (!inserted) {
    prompt.note(c.yellow(`No row inserted — an active hold already exists for ${matched.formatted}. Dissolve the existing one first if you need to update.`), 'Conflict');
  }

  const audit = await writeAudit(ctx.config, {
    runbookId: 'manage-building-holds',
    action:    'hold-added',
    target:    matched.id,
    metadata:  {
      address_id: matched.id,
      formatted:  matched.formatted,
      source, confidence, category, notes,
      conflict:   !inserted
    },
    dryRun: ctx.dryRun
  });
  if (!audit.ok) {
    prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
  }

  return {
    success: inserted,
    summary: inserted
      ? `Added ${confidence as string}-confidence ${source as string} hold on ${matched.formatted}.`
      : `Skipped — active hold already exists for ${matched.formatted}.`,
    details: { address_id: matched.id, formatted: matched.formatted, source, confidence, category, notes }
  };
}

// ─── inspect ─────────────────────────────────────────────────────────────

async function inspectAddress(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;
  const formattedIn = await prompt.text({
    message: 'Address (partial match)',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Required.' : undefined)
  });
  if (prompt.isCancel(formattedIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const matched = await lookupAddressId(ctx, (formattedIn as string).trim());
  if (!matched) {
    return { success: false, summary: 'No matching addresses found.' };
  }

  const sql = `
\\pset format unaligned
\\pset tuples_only on
select
  h.id || E'\\x1f' ||
  h.source || E'\\x1f' ||
  h.confidence || E'\\x1f' ||
  coalesce(h.category, '') || E'\\x1f' ||
  coalesce(h.notes, '') || E'\\x1f' ||
  coalesce(h.created_by, '') || E'\\x1f' ||
  to_char(h.created_at, 'YYYY-MM-DD HH24:MI') || E'\\x1f' ||
  case when h.dissolved_at is null then '' else
    to_char(h.dissolved_at, 'YYYY-MM-DD HH24:MI') || ' (' || coalesce(h.dissolved_reason,'?') || ' by ' || coalesce(h.dissolved_by,'?') || ')'
  end
from public.building_holds h
where h.address_id = '${matched.id}'::uuid
order by h.created_at desc
limit 20;
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
  }
  const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    prompt.note(c.dim(`No holds (active or dissolved) for ${matched.formatted}.`), 'Clean');
    return { success: true, summary: `${matched.formatted} has no holds.` };
  }

  const rendered = lines.map((line) => {
    const [id, source, confidence, category, notes, by, created, dissolved] = line.split('\x1f');
    const status = dissolved
      ? c.dim(`dissolved: ${dissolved}`)
      : c.green('active');
    const issuer = by ? ` by ${by}` : '';
    const cat = category ? ` · ${category}` : '';
    const note = notes ? `\n      ${c.dim(notes)}` : '';
    return `  ${status.padEnd(45)} ${(source ?? '').padEnd(10)} ${(confidence ?? '').padEnd(8)}${cat}  ${c.dim(`${created}${issuer}`)}${note}\n      ${c.dim(`id: ${id ?? '?'}`)}`;
  }).join('\n');

  prompt.note(rendered, `${matched.formatted} — ${lines.length} hold(s)`);
  return { success: true, summary: `Inspected ${matched.formatted}: ${lines.length} hold record(s).` };
}

// ─── dissolve ────────────────────────────────────────────────────────────

async function dissolveHold(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;

  const formattedIn = await prompt.text({
    message: 'Address whose hold should be dissolved',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Required.' : undefined)
  });
  if (prompt.isCancel(formattedIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const matched = await lookupAddressId(ctx, (formattedIn as string).trim());
  if (!matched) {
    return { success: false, summary: 'No matching addresses found.' };
  }

  // Find the active hold (uniqueness is enforced; can be at most 1).
  const findRes = await psqlPiped(ctx.config, `
\\pset format unaligned
\\pset tuples_only on
select id || E'\\x1f' || source || E'\\x1f' || confidence || E'\\x1f' || coalesce(category,'') || E'\\x1f' || coalesce(notes,'')
  from public.building_holds
  where address_id = '${matched.id}'::uuid
    and dissolved_at is null
  limit 1;
`, 'supabase_admin');

  const line = findRes.stdout.trim();
  if (!line) {
    return { success: false, summary: `No active hold for ${matched.formatted}.` };
  }
  const [holdId, source, confidence, category, notes] = line.split('\x1f');

  prompt.note(
    [
      `Address:    ${matched.formatted}`,
      `Hold ID:    ${holdId}`,
      `Source:     ${source}`,
      `Confidence: ${confidence}`,
      `Category:   ${category || '(none)'}`,
      `Notes:      ${notes || '(none)'}`
    ].join('\n'),
    'Active hold'
  );

  const reason = await prompt.select({
    message: 'Dissolution reason',
    options: [...DISSOLVE_REASON_OPTIONS]
  });
  if (prompt.isCancel(reason)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

  const confirmed = await prompt.confirm({
    message: `Dissolve this hold? Address will become claimable again.`,
    initialValue: false
  });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (ctx.dryRun) {
    return {
      success: true,
      summary: `Dry-run: would have dissolved hold for ${matched.formatted} (reason: ${reason as string}).`,
      details: { hold_id: holdId, address_id: matched.id, formatted: matched.formatted, reason, dryRun: true }
    };
  }

  const sql = `
update public.building_holds
   set dissolved_at = now(),
       dissolved_by = '${sqlEsc(ctx.config.operator)}',
       dissolved_reason = '${sqlEsc(reason as string)}'
 where id = '${holdId}'::uuid
   and dissolved_at is null
returning id;
`;
  const sp = prompt.spinner();
  sp.start('Dissolving hold…');
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    sp.stop('Failed.');
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
  }
  sp.stop('Hold dissolved.');

  const audit = await writeAudit(ctx.config, {
    runbookId: 'manage-building-holds',
    action:    'hold-dissolved',
    target:    holdId ?? matched.id,
    metadata:  {
      hold_id:    holdId,
      address_id: matched.id,
      formatted:  matched.formatted,
      reason,
      dissolved_by: ctx.config.operator
    },
    dryRun: ctx.dryRun
  });
  if (!audit.ok) {
    prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
  }

  return {
    success: true,
    summary: `Dissolved hold on ${matched.formatted} (reason: ${reason as string}).`,
    details: { hold_id: holdId, address_id: matched.id, formatted: matched.formatted, reason }
  };
}

export default runbook;
