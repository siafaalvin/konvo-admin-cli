/**
 * Runbook — manage-banned-terms.
 *
 * CRUD operations on public.banned_terms (introduced in houvox-pwa
 * migration 0057, v0.6 §7.1 phase A). Each row defines a forbidden
 * term in plate_messages.body_extra with a category + severity +
 * match_style.
 *
 * Operations:
 *   list           — recent active + retired terms grouped by category
 *   add            — single term with category + severity + match_style picker
 *   bulk-import    — paste CSV blob (term,category,severity,match_style)
 *                    for seeding from EFF / ADL / operator-curated lists
 *   inspect-hits   — for a given term-id, show plate_messages with body_extra
 *                    matching this term (last 30 days). NOT reversible to
 *                    the message author since match-time isn't audited
 *                    server-side; this is a best-effort lookup.
 *   retire         — soft-delete a term with reason
 *
 * Risk: medium. Adding a term immediately starts gating ALL subsequent
 * plate_send_message calls. Mistakes have cascading effects (a poorly-
 * tuned term blocks legitimate messages → sender contacts support →
 * ops backlog). bulk-import is the highest blast-radius action; we
 * gate it behind a type-to-confirm "import N rows from CSV".
 *
 * Each action audit-logged. retire is reversible (un-retire by
 * resetting retired_at to null via a second add or via manual SQL —
 * we don't expose un-retire from the UI to keep the audit trail
 * cleaner).
 *
 * The plate_send_message RPC reads banned_terms via match_banned_terms
 * SECURITY DEFINER helper (also mig 0057). Mutations here take effect
 * IMMEDIATELY for the next plate_send_message call — no cache, no
 * worker restart needed.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const CATEGORY_OPTIONS = [
  { value: 'slur',          label: 'Slur',                hint: 'Hate-speech directed at protected attributes' },
  { value: 'threat',        label: 'Threat',              hint: 'Direct threat of violence / harm' },
  { value: 'harassment',    label: 'Harassment',          hint: 'Targeted abuse without explicit threat' },
  { value: 'csam_signal',   label: 'CSAM signal',         hint: 'Coded language used by predators' },
  { value: 'spam',          label: 'Spam',                hint: 'Mass-distribution / commercial abuse' },
  { value: 'other',         label: 'Other',               hint: 'Operator specifies in notes' }
] as const;

const SEVERITY_OPTIONS = [
  { value: 'warn',     label: 'Warn',     hint: 'Message goes through, flagged for ops review' },
  { value: 'block',    label: 'Block',    hint: 'Reject with reason=content_blocked. Default per Q-1.' },
  { value: 'escalate', label: 'Escalate', hint: 'Reject + auto-issue $25 fine via issue_fine' }
] as const;

const MATCH_STYLE_OPTIONS = [
  { value: 'word',      label: 'Word',      hint: 'Whole-word case-insensitive (default). Safest.' },
  { value: 'substring', label: 'Substring', hint: 'Plain indexOf — risks false positives' },
  { value: 'regex',     label: 'Regex',     hint: 'POSIX regex — operator must validate carefully' }
] as const;

type Action = 'list' | 'add' | 'bulk-import' | 'inspect-hits' | 'retire';

const runbook: Runbook = {
  id:          'manage-banned-terms',
  title:       'Manage banned terms',
  description: 'CRUD on public.banned_terms — list / add / bulk-import / inspect-hits / retire. Mutations take effect immediately for the next plate_send_message.',
  risk:        'high',
  requires:    ['ssh', 'db'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = (await prompt.select({
      message: 'What do you want to do?',
      options: [
        { value: 'list',         label: 'List recent terms',                  hint: 'Active + retired, grouped by category' },
        { value: 'add',          label: 'Add a single term',                  hint: 'category + severity + match_style picker' },
        { value: 'bulk-import',  label: 'Bulk-import from CSV blob',          hint: 'Seed from EFF / ADL public lists' },
        { value: 'inspect-hits', label: 'Inspect recent hits for a term',     hint: 'plate_messages from last 30 days that hit this term' },
        { value: 'retire',       label: 'Retire (soft-delete) a term',        hint: 'Stops gating; preserves audit trail' }
      ]
    })) as Action | symbol;
    if (prompt.isCancel(action)) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    switch (action) {
      case 'list':         return await runList(ctx);
      case 'add':          return await runAdd(ctx);
      case 'bulk-import':  return await runBulkImport(ctx);
      case 'inspect-hits': return await runInspectHits(ctx);
      case 'retire':       return await runRetire(ctx);
    }
    return { success: false, summary: `Unknown action: ${String(action)}` };
  }
};

// ─── list ────────────────────────────────────────────────────────────────

async function runList(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config } = ctx;
  const sp = prompt.spinner();
  sp.start('Loading banned_terms…');

  const sql = `
    select id, term, category, severity, match_style,
           added_at::timestamptz(0)::text as added,
           coalesce(retired_at::timestamptz(0)::text, '-') as retired,
           coalesce(notes, '-') as notes
      from public.banned_terms
      order by retired_at is not null asc, category asc, term asc
      limit 200;
  `;
  const r = await psqlPiped(config, sql);
  sp.stop('Done.');

  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'psql failed');
    return { success: false, summary: 'Query failed.' };
  }

  prompt.note(r.stdout || '(no rows)', 'banned_terms (active first, then retired; max 200)');
  return { success: true, summary: 'Listed banned_terms.' };
}

// ─── add ────────────────────────────────────────────────────────────────

async function runAdd(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config, dryRun } = ctx;

  const term = await prompt.text({
    message: 'Term to ban (1–200 chars, case-insensitive). For regex match-style, this is the full pattern:',
    validate: (v) => {
      const s = (v ?? '').trim();
      if (s.length < 1)   return 'Required.';
      if (s.length > 200) return 'Max 200 chars.';
      return undefined;
    }
  });
  if (prompt.isCancel(term)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  const category = await prompt.select({ message: 'Category:', options: CATEGORY_OPTIONS as unknown as Array<{value: string; label: string; hint: string}> });
  if (prompt.isCancel(category)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  const severity = await prompt.select({ message: 'Severity:', options: SEVERITY_OPTIONS as unknown as Array<{value: string; label: string; hint: string}> });
  if (prompt.isCancel(severity)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  const matchStyle = await prompt.select({ message: 'Match style:', options: MATCH_STYLE_OPTIONS as unknown as Array<{value: string; label: string; hint: string}> });
  if (prompt.isCancel(matchStyle)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  const notes = await prompt.text({
    message: 'Notes (optional, free-form, e.g. "EFF list 2025-Q3 row 142"):',
    placeholder: '',
    defaultValue: ''
  });
  const notesValue = (typeof notes === 'string' && notes.trim() !== '') ? notes.trim() : null;

  const summary = [
    `term:        ${c.bold(term as string)}`,
    `category:    ${category}`,
    `severity:    ${severity}`,
    `match_style: ${matchStyle}`,
    `notes:       ${notesValue ?? '(none)'}`
  ].join('\n');
  prompt.note(summary, 'About to insert');

  const confirmed = await prompt.confirm({ message: 'Insert this term?', initialValue: false });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (dryRun) {
    return { success: true, summary: 'Dry-run: would have inserted.', details: { term, category, severity, matchStyle, notes: notesValue } };
  }

  const sql = `
    insert into public.banned_terms (term, category, severity, match_style, notes)
    values ($\$${escapeSql(term as string)}$\$, '${category}', '${severity}', '${matchStyle}', ${notesValue ? `$\$${escapeSql(notesValue)}$\$` : 'null'})
    returning id, term, category, severity, match_style;
  `;
  const r = await psqlPiped(config, sql);
  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'Insert failed');
    return { success: false, summary: 'Insert failed.', details: { stderr: r.stderr } };
  }

  prompt.note(r.stdout, c.green('✓ Inserted'));
  await writeAudit(config, {
    runbookId: 'manage-banned-terms',
    action:    'term-added',
    metadata:  { term, category, severity, matchStyle, notes: notesValue },
    dryRun:    false
  });
  return { success: true, summary: `Added ${category}/${severity}/${matchStyle} term.` };
}

// SQL string escape — uses dollar-quoting for safety. Used inside $\$...$\$.
function escapeSql(s: string): string {
  // Reject any string that contains $$ — extremely rare in real banned-term
  // input; protects against breaking out of the dollar-quote. Operator
  // can re-encode by varying the dollar-quote tag if needed.
  if (s.includes('$$')) {
    throw new Error('Term contains $$, which conflicts with dollar-quoting. Edit the term.');
  }
  return s;
}


// ─── bulk-import ────────────────────────────────────────────────────────

async function runBulkImport(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config, dryRun } = ctx;

  prompt.note(
    [
      'Paste a CSV blob (header row required). Columns:',
      '  term,category,severity,match_style[,notes]',
      '',
      'Example (3 rows):',
      '  term,category,severity,match_style',
      '  example1,slur,block,word',
      '  example2,threat,escalate,word',
      '  example3,spam,warn,substring',
      '',
      'Allowed values:',
      '  category    : slur | threat | harassment | csam_signal | spam | other',
      '  severity    : warn | block | escalate',
      '  match_style : word | substring | regex',
      '',
      'Each row goes through the same validation as add. Bad rows abort the whole import.'
    ].join('\n'),
    'Bulk-import format'
  );

  const blob = await prompt.text({
    message: 'Paste CSV (terminate with empty line, then Enter):',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Required.' : undefined)
  });
  if (prompt.isCancel(blob)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  // Parse + validate
  const lines = (blob as string).split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) {
    return { success: false, summary: 'Need at least header + 1 data row.' };
  }
  const header = lines[0]!.toLowerCase().split(',').map((s) => s.trim());
  const required = ['term', 'category', 'severity', 'match_style'];
  for (const col of required) {
    if (!header.includes(col)) {
      return { success: false, summary: `Header missing required column: ${col}` };
    }
  }
  const idxTerm        = header.indexOf('term');
  const idxCategory    = header.indexOf('category');
  const idxSeverity    = header.indexOf('severity');
  const idxMatchStyle  = header.indexOf('match_style');
  const idxNotes       = header.indexOf('notes');

  const rows: Array<{
    term: string; category: string; severity: string; match_style: string; notes: string | null;
  }> = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!.split(',').map((s) => s.trim());
    const term         = fields[idxTerm];
    const category     = fields[idxCategory];
    const severity     = fields[idxSeverity];
    const match_style  = fields[idxMatchStyle];
    const notes        = idxNotes >= 0 ? fields[idxNotes] : null;
    if (!term || !category || !severity || !match_style) {
      return { success: false, summary: `Row ${i + 1} missing required field.` };
    }
    if (!CATEGORY_OPTIONS.some((o) => o.value === category)) {
      return { success: false, summary: `Row ${i + 1} bad category: ${category}` };
    }
    if (!SEVERITY_OPTIONS.some((o) => o.value === severity)) {
      return { success: false, summary: `Row ${i + 1} bad severity: ${severity}` };
    }
    if (!MATCH_STYLE_OPTIONS.some((o) => o.value === match_style)) {
      return { success: false, summary: `Row ${i + 1} bad match_style: ${match_style}` };
    }
    rows.push({ term, category, severity, match_style, notes: notes && notes.length > 0 ? notes : null });
  }

  prompt.note(
    [
      `Parsed ${c.bold(String(rows.length))} rows.`,
      ``,
      `Severity breakdown:`,
      `  warn:     ${rows.filter((r) => r.severity === 'warn').length}`,
      `  block:    ${rows.filter((r) => r.severity === 'block').length}`,
      `  escalate: ${rows.filter((r) => r.severity === 'escalate').length}`,
      ``,
      c.yellow('Type-to-confirm: this is the highest-blast-radius action in this runbook.')
    ].join('\n'),
    'Ready to import'
  );

  const phrase = `import ${rows.length}`;
  const typed = await prompt.text({
    message: `Type "${c.bold(phrase)}" (without quotes) to proceed:`,
    validate: (v) => ((v ?? '').trim() === phrase ? undefined : `Must match: ${phrase}`)
  });
  if (prompt.isCancel(typed)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  if (dryRun) {
    return { success: true, summary: `Dry-run: would import ${rows.length} rows.`, details: { rowCount: rows.length } };
  }

  // Build a single multi-row INSERT for atomicity
  const values = rows
    .map((r) => `($\$${escapeSql(r.term)}$\$, '${r.category}', '${r.severity}', '${r.match_style}', ${r.notes ? `$\$${escapeSql(r.notes)}$\$` : 'null'})`)
    .join(',\n  ');
  const sql = `
    insert into public.banned_terms (term, category, severity, match_style, notes)
    values
      ${values};
    select count(*) as inserted from public.banned_terms where notes is not null and added_at >= now() - interval '5 seconds';
  `;
  const r = await psqlPiped(config, sql);
  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'Bulk import failed');
    return { success: false, summary: 'Import failed.' };
  }

  prompt.note(r.stdout, c.green('✓ Imported'));
  await writeAudit(config, {
    runbookId: 'manage-banned-terms',
    action:    'bulk-import',
    metadata:  { rowCount: rows.length },
    dryRun:    false
  });
  return { success: true, summary: `Imported ${rows.length} terms.`, details: { rowCount: rows.length } };
}

// ─── inspect-hits ───────────────────────────────────────────────────────

async function runInspectHits(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config } = ctx;

  const termId = await prompt.text({
    message: 'banned_terms.id (UUID):',
    validate: (v) => (/^[0-9a-f-]{36}$/i.test((v ?? '').trim()) ? undefined : 'Expected UUID format.')
  });
  if (prompt.isCancel(termId)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  const sp = prompt.spinner();
  sp.start('Looking up term + checking recent plate_messages…');

  // Note: there's no per-message hit log — we approximate by querying
  // plate_messages from the last 30 days where body_extra contains the
  // term using the SAME match logic. Best-effort.
  const sql = `
    with t as (
      select * from public.banned_terms where id = '${termId}'::uuid
    )
    select
      (select term from t)        as term,
      (select category from t)    as category,
      (select severity from t)    as severity,
      (select match_style from t) as match_style,
      (select retired_at from t)  as retired_at,
      (
        select count(*)
          from public.plate_messages pm, t
         where pm.sent_at >= now() - interval '30 days'
           and pm.body_extra is not null
           and case t.match_style
                 when 'substring' then position(lower(t.term) in lower(pm.body_extra)) > 0
                 when 'word'      then lower(pm.body_extra) ~ ('\\m' || regexp_replace(lower(t.term), '([\\\\.\\^$*+?()[\\]{}|])', '\\\\\\\\\\\\1', 'g') || '\\M')
                 when 'regex'     then lower(pm.body_extra) ~ lower(t.term)
               end
      ) as approx_hits_30d;

    select pm.id, pm.sent_at::timestamptz(0)::text as sent_at,
           pm.from_user_id::text as from_user,
           pm.flagged_for_review,
           left(pm.body_extra, 100) as body_preview
      from public.plate_messages pm, public.banned_terms t
      where t.id = '${termId}'::uuid
        and pm.sent_at >= now() - interval '30 days'
        and pm.body_extra is not null
        and case t.match_style
              when 'substring' then position(lower(t.term) in lower(pm.body_extra)) > 0
              when 'word'      then lower(pm.body_extra) ~ ('\\m' || regexp_replace(lower(t.term), '([\\\\.\\^$*+?()[\\]{}|])', '\\\\\\\\\\\\1', 'g') || '\\M')
              when 'regex'     then lower(pm.body_extra) ~ lower(t.term)
            end
      order by pm.sent_at desc
      limit 50;
  `;
  const r = await psqlPiped(config, sql);
  sp.stop('Done.');

  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'Lookup failed');
    return { success: false, summary: 'Lookup failed.' };
  }

  prompt.note(r.stdout || '(no rows)', `Hits for term ${termId}`);
  return { success: true, summary: 'Inspected hits.' };
}

// ─── retire ─────────────────────────────────────────────────────────────

async function runRetire(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config, dryRun } = ctx;

  const termId = await prompt.text({
    message: 'banned_terms.id (UUID) to retire:',
    validate: (v) => (/^[0-9a-f-]{36}$/i.test((v ?? '').trim()) ? undefined : 'Expected UUID format.')
  });
  if (prompt.isCancel(termId)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  const reason = await prompt.text({
    message: 'Retire reason (free-form, audit log):',
    validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'Required.')
  });
  if (prompt.isCancel(reason)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  // Show current state before retiring
  const beforeSql = `select id, term, category, severity, match_style, retired_at from public.banned_terms where id = '${termId}'::uuid;`;
  const before = await psqlPiped(config, beforeSql);
  if (before.exitCode !== 0 || !before.stdout.includes(termId as string)) {
    prompt.note(c.red(`Term ${termId} not found.`), 'Lookup failed');
    return { success: false, summary: 'Term not found.' };
  }
  prompt.note(before.stdout, 'About to retire');

  const confirmed = await prompt.confirm({
    message: c.yellow('Retire this term? Future plate_send_message calls will no longer gate on it.'),
    initialValue: false
  });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (dryRun) {
    return { success: true, summary: 'Dry-run: would have retired.', details: { termId, reason } };
  }

  const sql = `
    update public.banned_terms
       set retired_at = now(),
           retired_reason = $\$${escapeSql(reason as string)}$\$
     where id = '${termId}'::uuid
       and retired_at is null
    returning id, term, retired_at;
  `;
  const r = await psqlPiped(config, sql);
  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'Retire failed');
    return { success: false, summary: 'Retire failed.' };
  }

  prompt.note(r.stdout, c.green('✓ Retired'));
  await writeAudit(config, {
    runbookId: 'manage-banned-terms',
    action:    'term-retired',
    target:    termId as string,
    metadata:  { reason },
    dryRun:    false
  });
  return { success: true, summary: `Retired term ${termId}.` };
}

export default runbook;
