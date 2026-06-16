/**
 * Runbook — review-flagged-plate-messages.
 *
 * Operator review queue for plate_message_flags (introduced in
 * houvox-pwa migration 0058, v0.6 §7.2 phase A). Each row represents
 * a recipient-flagged plate message OR a §7.1-auto-flagged rejection
 * awaiting (or post-) operator review.
 *
 * Operations:
 *   list-pending                  — pending + auto_upheld flags ordered by
 *                                   flagged_at, with body preview + reason
 *                                   + sender platform_id
 *   review                        — for a specific flag id, full body + flagger
 *                                   platform_id (operator-only), pick
 *                                   uphold / dismiss with required notes
 *   bulk-uphold-auto-upheld       — confirm all currently-auto_upheld flags
 *                                   in one pass (issues \$25 fines per flag)
 *   retire                        — soft-delete an upheld flag (compassionate
 *                                   release / false-positive cleanup)
 *
 * Risk: HIGH. Each upheld flag impacts a user's public profile reputation
 * AND issues a fine. Type-to-confirm gate on uphold + retire actions.
 *
 * Flagger anonymity invariant (PLATE-FLAG-AND-PUBLISH-DESIGN.md §5):
 *   - Operator does see flagger_user_id (necessary for retaliation-pattern
 *     detection — same flagger reporting same sender 30 times = suspicious)
 *   - But this runbook displays flagger only as platform_id (hvx_XXXXXXXX),
 *     never email or display_name
 *   - The flagger's identity NEVER propagates beyond ops review surfaces
 *
 * The plate_flag_uphold + plate_flag_dismiss + plate_flag_retire RPCs
 * are SECURITY DEFINER, service_role-only — this runbook authenticates
 * as service_role over SSH+psql.
 *
 * Mutations take effect IMMEDIATELY:
 *   uphold  → /u/{platform_id} renders the new "Reports" entry
 *   dismiss → public surface unchanged (auto_upheld flags lose surfaced_at)
 *   retire  → public surface clears (filter on retired_at IS NULL)
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

type Action = 'list-pending' | 'review' | 'bulk-uphold-auto-upheld' | 'retire';

const runbook: Runbook = {
  id:          'review-flagged-plate-messages',
  title:       'Review flagged plate messages',
  description: 'Triage pending + auto_upheld flags from plate_message_flags. Uphold issues a fine + surfaces on sender profile; dismiss clears it.',
  risk:        'high',
  requires:    ['ssh', 'db'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = (await prompt.select({
      message: 'What do you want to do?',
      options: [
        { value: 'list-pending',            label: 'List pending + auto_upheld flags',     hint: 'Triage queue' },
        { value: 'review',                  label: 'Review one flag (uphold or dismiss)',  hint: 'Per-flag decision with notes' },
        { value: 'bulk-uphold-auto-upheld', label: 'Bulk-uphold all auto_upheld',          hint: 'Re-confirms system-flagged decisions; $25 fine per' },
        { value: 'retire',                  label: 'Retire (soft-delete) an upheld flag',  hint: 'Compassionate release / false-positive cleanup' }
      ]
    })) as Action | symbol;

    if (prompt.isCancel(action)) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    switch (action) {
      case 'list-pending':            return await runListPending(ctx);
      case 'review':                  return await runReview(ctx);
      case 'bulk-uphold-auto-upheld': return await runBulkUpholdAuto(ctx);
      case 'retire':                  return await runRetire(ctx);
    }
    return { success: false, summary: `Unknown action: ${String(action)}` };
  }
};

// ─── list-pending ───────────────────────────────────────────────────────

async function runListPending(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config } = ctx;
  const sp = prompt.spinner();
  sp.start('Loading review queue…');

  // Show pending + auto_upheld together. auto_upheld rows are
  // already-public-surfaced but might warrant operator review (e.g.
  // bulk-confirm or override to dismiss).
  const sql = `
    select
      f.id::text                                          as flag_id,
      f.status,
      f.reason,
      f.flagged_at::timestamptz(0)::text                  as flagged_at,
      coalesce(sender.platform_id, '(deleted)')           as sender_pid,
      coalesce(flagger.platform_id, '(system / null)')    as flagger_pid,
      left(f.message_body_at_flag, 80)                    as body_preview
      from public.plate_message_flags f
      left join public.profiles sender   on sender.id   = f.sender_user_id
      left join public.profiles flagger  on flagger.id  = f.flagger_user_id
      where f.status in ('pending', 'auto_upheld')
        and f.retired_at is null
      order by f.flagged_at desc
      limit 50;
  `;
  const r = await psqlPiped(config, sql);
  sp.stop('Done.');

  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'psql failed');
    return { success: false, summary: 'Query failed.' };
  }

  prompt.note(r.stdout || '(no rows)', 'Pending + auto_upheld flags (newest first, max 50)');
  return { success: true, summary: 'Listed flag queue.' };
}


// ─── review (single flag) ───────────────────────────────────────────────

async function runReview(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config, dryRun } = ctx;

  const flagId = await prompt.text({
    message: 'Flag id (UUID):',
    validate: (v) => (/^[0-9a-f-]{36}$/i.test((v ?? '').trim()) ? undefined : 'Expected UUID format.')
  });
  if (prompt.isCancel(flagId)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  // Fetch full context for review
  const sp = prompt.spinner();
  sp.start('Loading flag details…');
  const fetchSql = `
    select
      f.id::text                                       as flag_id,
      f.status,
      f.reason,
      f.flagged_at::timestamptz(0)::text               as flagged_at,
      coalesce(sender.platform_id, '(deleted)')        as sender_pid,
      coalesce(flagger.platform_id, '(system / null)') as flagger_pid,
      f.message_body_at_flag                           as body,
      f.message_id::text                               as message_id,
      coalesce(f.review_notes, '-')                    as prior_notes
      from public.plate_message_flags f
      left join public.profiles sender   on sender.id   = f.sender_user_id
      left join public.profiles flagger  on flagger.id  = f.flagger_user_id
      where f.id = '${flagId}'::uuid;
  `;
  const fetched = await psqlPiped(config, fetchSql);
  sp.stop('Done.');

  if (fetched.exitCode !== 0 || !fetched.stdout.includes(flagId as string)) {
    prompt.note(c.red(`Flag ${flagId} not found.`), 'Lookup failed');
    return { success: false, summary: 'Flag not found.' };
  }

  prompt.note(fetched.stdout, 'Flag context');

  const decision = (await prompt.select({
    message: 'Decision:',
    options: [
      { value: 'uphold',  label: 'Uphold',  hint: 'Surface on sender profile + issue fine' },
      { value: 'dismiss', label: 'Dismiss', hint: 'No public surface, no fine' },
      { value: 'cancel',  label: 'Cancel',  hint: 'Defer decision' }
    ]
  })) as 'uphold' | 'dismiss' | 'cancel' | symbol;
  if (prompt.isCancel(decision) || decision === 'cancel') {
    prompt.cancel('Deferred.');
    return { success: false, summary: 'Operator deferred decision.' };
  }

  const notes = await prompt.text({
    message: 'Review notes (required, audit log):',
    validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'Required.')
  });
  if (prompt.isCancel(notes)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  // Type-to-confirm — both uphold and dismiss are high-blast-radius
  const phrase = `${decision} ${(flagId as string).slice(0, 8)}`;
  const typed = await prompt.text({
    message: `Type "${c.bold(phrase)}" (without quotes) to confirm:`,
    validate: (v) => ((v ?? '').trim() === phrase ? undefined : `Must match: ${phrase}`)
  });
  if (prompt.isCancel(typed)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  if (dryRun) {
    return { success: true, summary: `Dry-run: would ${decision}.`, details: { flagId, decision, notes } };
  }

  // Call the appropriate RPC. Reviewer UUID is null — operator
  // identity is captured in the audit log instead (config.operator
  // is a free-form string, not a Supabase auth.users.id).
  const reviewerSql = 'null';
  const rpcSql = decision === 'uphold'
    ? `select public.plate_flag_uphold('${flagId}'::uuid, $\$${(notes as string).replace(/\$\$/g, '$ $')}$\$, ${reviewerSql});`
    : `select public.plate_flag_dismiss('${flagId}'::uuid, $\$${(notes as string).replace(/\$\$/g, '$ $')}$\$, ${reviewerSql});`;

  const r = await psqlPiped(config, rpcSql);
  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), `${decision} failed`);
    return { success: false, summary: `${decision} failed.` };
  }

  prompt.note(r.stdout, c.green(`✓ ${decision === 'uphold' ? 'Upheld' : 'Dismissed'}`));
  await writeAudit(config, {
    runbookId: 'review-flagged-plate-messages',
    action:    `flag-${decision}`,
    target:    flagId as string,
    metadata:  { notes, decision },
    dryRun:    false
  });
  return { success: true, summary: `${decision === 'uphold' ? 'Upheld' : 'Dismissed'} flag ${flagId}.` };
}

// ─── bulk-uphold-auto-upheld ────────────────────────────────────────────

async function runBulkUpholdAuto(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config, dryRun } = ctx;

  // Show how many would be affected
  const sp = prompt.spinner();
  sp.start('Counting auto_upheld flags…');
  const countSql = `
    select count(*) as n,
           array_agg(distinct reason) as reasons
      from public.plate_message_flags
     where status = 'auto_upheld' and retired_at is null;
  `;
  const counted = await psqlPiped(config, countSql);
  sp.stop('Done.');

  if (counted.exitCode !== 0) {
    prompt.note(c.red(counted.stderr || counted.stdout), 'Count query failed');
    return { success: false, summary: 'Count failed.' };
  }
  prompt.note(counted.stdout, 'Auto_upheld flags currently in queue');

  // Parse N from output (best-effort — psql output formatting)
  const nMatch = counted.stdout.match(/^\s*(\d+)\s*\|/m);
  const n = nMatch ? parseInt(nMatch[1] ?? '0', 10) : 0;
  if (n === 0) {
    return { success: true, summary: 'No auto_upheld flags to bulk-uphold.' };
  }

  prompt.note(
    [
      c.yellow(`This will issue \$25 fines for each of ${n} flag(s) (${(n * 25).toFixed(0)} dollars total).`),
      '',
      c.dim('Each flag stays surfaced on the sender\'s public profile. Use this only when ops trusts the underlying banned-term match.'),
    ].join('\n'),
    'Confirm bulk uphold'
  );

  const phrase = `uphold all ${n}`;
  const typed = await prompt.text({
    message: `Type "${c.bold(phrase)}" (without quotes) to proceed:`,
    validate: (v) => ((v ?? '').trim() === phrase ? undefined : `Must match: ${phrase}`)
  });
  if (prompt.isCancel(typed)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  if (dryRun) {
    return { success: true, summary: `Dry-run: would uphold ${n} auto_upheld flags.`, details: { count: n } };
  }

  // Loop in SQL — call plate_flag_uphold per flag. Reviewer null;
  // audit log captures operator string.
  const reviewerSql = 'null';
  const bulkSql = `
    select public.plate_flag_uphold(f.id, 'bulk-uphold of auto_upheld batch', ${reviewerSql})
      from public.plate_message_flags f
     where f.status = 'auto_upheld' and f.retired_at is null;
  `;
  const r = await psqlPiped(config, bulkSql);
  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'Bulk uphold failed');
    return { success: false, summary: 'Bulk uphold failed.' };
  }

  prompt.note(r.stdout.split('\n').slice(-15).join('\n'), c.green(`✓ Upheld ${n} flag(s)`));
  await writeAudit(config, {
    runbookId: 'review-flagged-plate-messages',
    action:    'bulk-uphold-auto',
    metadata:  { count: n },
    dryRun:    false
  });
  return { success: true, summary: `Bulk-upheld ${n} auto_upheld flags.`, details: { count: n } };
}

// ─── retire ─────────────────────────────────────────────────────────────

async function runRetire(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt, config, dryRun } = ctx;

  const flagId = await prompt.text({
    message: 'Flag id (UUID) to retire:',
    validate: (v) => (/^[0-9a-f-]{36}$/i.test((v ?? '').trim()) ? undefined : 'Expected UUID format.')
  });
  if (prompt.isCancel(flagId)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  const reason = await prompt.text({
    message: 'Retire reason (required, audit log):',
    validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'Required.')
  });
  if (prompt.isCancel(reason)) { prompt.cancel('Aborted.'); return { success: false, summary: 'Cancelled.' }; }

  prompt.note(
    [
      c.dim('Retire clears the public-profile surface for this flag.'),
      c.dim('Audit trail preserved (row stays).'),
      c.dim('Does NOT refund the fine — separate ops action via refund-revoke runbook.')
    ].join('\n'),
    'About to retire'
  );

  const confirmed = await prompt.confirm({
    message: c.yellow('Retire this flag?'),
    initialValue: false
  });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (dryRun) {
    return { success: true, summary: 'Dry-run: would have retired.', details: { flagId, reason } };
  }

  const sql = `select public.plate_flag_retire('${flagId}'::uuid, $\$${(reason as string).replace(/\$\$/g, '$ $')}$\$);`;
  const r = await psqlPiped(config, sql);
  if (r.exitCode !== 0) {
    prompt.note(c.red(r.stderr || r.stdout), 'Retire failed');
    return { success: false, summary: 'Retire failed.' };
  }

  prompt.note(r.stdout, c.green('✓ Retired'));
  await writeAudit(config, {
    runbookId: 'review-flagged-plate-messages',
    action:    'flag-retired',
    target:    flagId as string,
    metadata:  { reason },
    dryRun:    false
  });
  return { success: true, summary: `Retired flag ${flagId}.` };
}

export default runbook;
