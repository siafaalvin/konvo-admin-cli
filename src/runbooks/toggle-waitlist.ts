/**
 * Runbook — toggle-waitlist.
 *
 * Flips konvo.waitlist_enabled between true and false. Used to
 * manually route ALL non-VIP signups to the waitlist queue (when
 * true) — typically during prod incident response or capacity
 * planning windows.
 *
 * Effect: takes hold IMMEDIATELY for the next signup. handle_new_user
 * reads the GUC from pg_db_role_setting catalog (per migration 0041),
 * which reflects ALTER DATABASE writes on the spot. No worker restart
 * required.
 *
 * Doesn't bypass the daily cap — the cap also applies. To open
 * signups fully, both this AND the cap need to be set right.
 *
 * Risk: low. Single boolean flip. Easily reversible.
 *
 * Notes for operator:
 *   - VIPs (admin_grants + crowdfund_emails unredeemed) ALWAYS bypass
 *     this gate, even when on=true. So existing partner/friend signups
 *     keep working.
 *   - Users hitting the gate get bounced to /waitlist/<code> with a
 *     position + shareable URL (Task 10 PR #117).
 *   - Each successful waitlist entry counts toward the queue total
 *     surfaced on the landing page.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface WaitlistState {
  waitlist_enabled: boolean;
  daily_signup_cap: number | null;
  today_signups:    number;
  queue_pending:    number;
  queue_invited:    number;
}

async function readState(ctx: RunbookContext): Promise<WaitlistState> {
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

with kv as (
  select split_part(s, '=', 1) as k, substring(s from position('=' in s) + 1) as v
  from pg_db_role_setting, unnest(setconfig) as s
  where setdatabase = (select oid from pg_database where datname = current_database())
)
select
  'waitlist_enabled=' || coalesce((select v from kv where k = 'konvo.waitlist_enabled'), 'false') || E'\\n' ||
  'daily_signup_cap=' || coalesce((select v from kv where k = 'konvo.daily_signup_cap'), '') || E'\\n' ||
  'today_signups='    || (select count(*) from auth.users where created_at >= current_date)::text || E'\\n' ||
  'queue_pending='    || (select count(*) from public.waitlist_entries where invited_at is null)::text || E'\\n' ||
  'queue_invited='    || (select count(*) from public.waitlist_entries where invited_at is not null and signup_completed_at is null)::text;
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
  const out = res.stdout.trim();
  const get = (key: string): string => {
    const m = out.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1]!.trim() : '';
  };
  const capStr = get('daily_signup_cap');
  return {
    waitlist_enabled: get('waitlist_enabled') === 'true',
    daily_signup_cap: capStr ? parseInt(capStr, 10) : null,
    today_signups:    parseInt(get('today_signups')   || '0', 10),
    queue_pending:    parseInt(get('queue_pending')   || '0', 10),
    queue_invited:    parseInt(get('queue_invited')   || '0', 10)
  };
}

const runbook: Runbook = {
  id:          'toggle-waitlist',
  title:       'Toggle waitlist',
  description: 'Flip konvo.waitlist_enabled. Takes effect immediately for the next signup. Shows current cap + queue state before toggling.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // ─── Read current state ───────────────────────────────────────
    const sp = prompt.spinner();
    sp.start('Reading waitlist state…');
    let state: WaitlistState;
    try {
      state = await readState(ctx);
    } catch (err) {
      sp.stop('Read failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp.stop('State read.');

    const newValue = !state.waitlist_enabled;
    const action = newValue ? 'waitlist-toggled-on' : 'waitlist-toggled-off';

    // ─── Show context ────────────────────────────────────────────
    const capDisplay = state.daily_signup_cap === null
      ? c.dim('unset')
      : state.daily_signup_cap === 0
        ? c.red('0 (blocks all)')
        : c.brand(state.daily_signup_cap.toLocaleString());

    const todayDisplay = (state.daily_signup_cap !== null && state.daily_signup_cap > 0 &&
                          state.today_signups >= state.daily_signup_cap)
      ? c.red(state.today_signups.toString())
      : c.dim(state.today_signups.toString());

    prompt.note(
      [
        c.bold('Current state'),
        '',
        `waitlist_enabled:   ${state.waitlist_enabled ? c.yellow('true') : c.dim('false')}`,
        `daily_signup_cap:   ${capDisplay}`,
        `today's signups:    ${todayDisplay} of ${state.daily_signup_cap ?? '?'}`,
        `queue (pending):    ${state.queue_pending.toLocaleString()}`,
        `queue (invited):    ${state.queue_invited.toLocaleString()}`,
        '',
        c.bold('Will flip to'),
        '',
        `waitlist_enabled:   ${newValue ? c.yellow('true') : c.dim('false')}`,
        '',
        newValue
          ? c.yellow('All non-VIP signups will be routed to /waitlist/<code> until you flip this back. VIPs (admin_grants + crowdfund_emails unredeemed) bypass.')
          : c.green('Signups will resume normally, subject to the daily cap.'),
        ctx.dryRun ? '\n' + c.yellow('(dry-run — no GUC change will be applied)') : ''
      ].filter(Boolean).join('\n'),
      'Toggle preview'
    );

    // ─── Confirm ──────────────────────────────────────────────────
    const confirmed = await prompt.confirm({
      message: newValue
        ? 'Enable waitlist gate now?'
        : 'Disable waitlist gate (resume normal signups)?',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have flipped waitlist_enabled to ${newValue}.`,
        details: { from: state.waitlist_enabled, to: newValue, dryRun: true }
      };
    }

    // ─── Apply ────────────────────────────────────────────────────
    const valueStr = newValue ? 'true' : 'false';
    const sp2 = prompt.spinner();
    sp2.start('ALTER DATABASE…');
    const applyRes = await psqlPiped(
      ctx.config,
      `alter database postgres set konvo.waitlist_enabled = '${valueStr}';\n`,
      'supabase_admin'
    );
    if (applyRes.exitCode !== 0) {
      sp2.stop('ALTER DATABASE failed.');
      return {
        success: false,
        summary: `psql exit ${applyRes.exitCode}: ${applyRes.stderr.trim().slice(0, 200)}`,
        details: { from: state.waitlist_enabled, to: newValue }
      };
    }
    sp2.stop('Applied.');

    // ─── Verify ───────────────────────────────────────────────────
    const sp3 = prompt.spinner();
    sp3.start('Verifying…');
    let after: WaitlistState;
    try {
      after = await readState(ctx);
    } catch (err) {
      sp3.stop('Verify failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp3.stop('Verified.');

    if (after.waitlist_enabled !== newValue) {
      return {
        success: false,
        summary: `Apply succeeded but verify mismatch: expected ${newValue}, got ${after.waitlist_enabled}`,
        details: { expected: newValue, actual: after.waitlist_enabled }
      };
    }

    // ─── Audit ────────────────────────────────────────────────────
    const audit = await writeAudit(ctx.config, {
      runbookId: 'toggle-waitlist',
      action,
      target:    `enabled:${newValue}`,
      metadata:  {
        from:           state.waitlist_enabled,
        to:             newValue,
        cap:            state.daily_signup_cap,
        today_signups:  state.today_signups,
        queue_pending:  state.queue_pending,
        queue_invited:  state.queue_invited
      },
      dryRun: false
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`), 'Warning');
    }

    return {
      success: true,
      summary: newValue
        ? `Waitlist enabled. New non-VIP signups will route to /waitlist.`
        : `Waitlist disabled. Signups resume normally (cap still active).`,
      details: { from: state.waitlist_enabled, to: newValue }
    };
  }
};

export default runbook;
