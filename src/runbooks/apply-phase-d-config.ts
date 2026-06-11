/**
 * Runbook #8 — Apply Phase D notification config.
 *
 * Phase D is the push + email dispatch pipeline that geofence-v2's
 * cron-driven `dispatch_due_geofence_checks()` function depends on.
 * It needs two database-scoped GUCs set on the `postgres` database:
 *
 *   konvo.notifications_worker_url   — base URL of the worker that
 *                                      receives dispatch HTTP calls.
 *                                      Currently always
 *                                      https://worker.thekonvo.com.
 *
 *   konvo.dispatch_shared_secret     — HMAC secret. The worker's
 *                                      DISPATCH_SHARED_SECRET env
 *                                      var MUST match this value or
 *                                      every dispatch call will 401.
 *
 * If either GUC is unset the SQL function gracefully no-ops the HTTP
 * call but still flips notification_sent_at — the cadence holds, but
 * users get no actual notifications.
 *
 * Workflow:
 *   1. Read current values via pg_db_role_setting.
 *   2. Show the operator what's currently stored (URL plain, secret
 *      length only).
 *   3. Prompt for each value, defaulting to current.
 *   4. Confirm with diff preview.
 *   5. Apply via two ALTER DATABASE statements as supabase_admin.
 *   6. Verify both round-trip.
 *   7. Final reminder: the worker's DISPATCH_SHARED_SECRET env var
 *      must equal whatever was just stored. Coolify env update + a
 *      konvo-worker-prod restart are the operator's next two steps;
 *      the runbook surfaces them but doesn't perform them — the
 *      Coolify env edit is a UI-only action today.
 *
 * Risk: high. Misconfiguration silently breaks every push + email
 * notification (the function returns OK but no HTTP call lands).
 * Mitigations: always show a diff before apply, never echo the
 * stored secret.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const DEFAULT_URL = 'https://worker.thekonvo.com';

interface CurrentState {
  workerUrl:     string | null;
  secretLength:  number;
}

async function readCurrentState(ctx: RunbookContext): Promise<CurrentState> {
  // pg_db_role_setting.setconfig is text[] of "name=value" entries.
  // We unnest, split on '=', and report.
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

with kv as (
  select split_part(s, '=', 1) as k,
         substring(s from position('=' in s) + 1) as v
  from pg_db_role_setting,
       unnest(setconfig) as s
  where setdatabase = (select oid from pg_database where datname = 'postgres')
    and setrole     = 0
)
select 'workerUrl='      || coalesce(max(case when k = 'konvo.notifications_worker_url' then v end), '') || E'\\n' ||
       'secretLength='   || coalesce(max(case when k = 'konvo.dispatch_shared_secret'   then length(v)::text end), '0')
from kv;
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
  const out = res.stdout.trim();
  const get = (k: string): string => {
    const m = out.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1]!.trim() : '';
  };
  return {
    workerUrl:     get('workerUrl').length === 0 ? null : get('workerUrl'),
    secretLength:  parseInt(get('secretLength') || '0', 10) || 0
  };
}

const runbook: Runbook = {
  id:          'apply-phase-d-config',
  title:       'Apply Phase D notification config',
  description: 'Configure konvo.notifications_worker_url + konvo.dispatch_shared_secret. Reminds about matching worker env var + restart.',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Read current state.
    const sp1 = prompt.spinner();
    sp1.start('Reading current GUCs…');
    let current: CurrentState;
    try {
      current = await readCurrentState(ctx);
    } catch (err) {
      sp1.stop('Read failed.');
      return {
        success: false,
        summary: err instanceof Error ? err.message : String(err)
      };
    }
    sp1.stop('Current GUCs read.');

    prompt.note(
      [
        `konvo.notifications_worker_url = ${current.workerUrl ? c.brand(current.workerUrl) : c.dim('<unset>')}`,
        `konvo.dispatch_shared_secret   = ${current.secretLength > 0
          ? c.brand(`<${current.secretLength} chars set>`)
          : c.dim('<unset>')
        }`
      ].join('\n'),
      'Current state'
    );

    // 2. Prompt for new worker URL.
    const urlIn = await prompt.text({
      message: 'konvo.notifications_worker_url',
      placeholder: DEFAULT_URL,
      initialValue: current.workerUrl ?? DEFAULT_URL,
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        if (!/^https:\/\/[^\s]+$/.test(s)) return 'Must be an https://… URL.';
        return undefined;
      }
    });
    if (prompt.isCancel(urlIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const newUrl = (urlIn as string).trim();

    // 3. Prompt for new secret. Allow skipping if it's already set.
    const updateSecret = current.secretLength > 0
      ? await prompt.confirm({
          message: 'Update the shared secret?',
          initialValue: false
        })
      : true; // forced when unset
    if (prompt.isCancel(updateSecret)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    let newSecret: string | null = null;
    if (updateSecret) {
      const secretIn = await prompt.password({
        message: 'konvo.dispatch_shared_secret',
        mask: '•',
        validate: (v) => {
          const s = v ?? '';
          if (s.length < 32) return 'Must be ≥ 32 chars.';
          return undefined;
        }
      });
      if (prompt.isCancel(secretIn)) {
        prompt.cancel('Cancelled.');
        return { success: false, summary: 'Operator cancelled.' };
      }
      newSecret = secretIn as string;
    }

    // 4. Diff preview.
    const urlChanged = newUrl !== current.workerUrl;
    const secretChanged = newSecret !== null;

    if (!urlChanged && !secretChanged) {
      return {
        success: true,
        summary: 'No changes — both GUCs already at desired state.',
        details: { current }
      };
    }

    prompt.note(
      [
        urlChanged
          ? `konvo.notifications_worker_url:\n  ${c.dim(current.workerUrl ?? '<unset>')} → ${c.brand(newUrl)}`
          : c.dim('konvo.notifications_worker_url: unchanged'),
        '',
        secretChanged
          ? `konvo.dispatch_shared_secret:\n  ${c.dim(current.secretLength > 0 ? `<${current.secretLength} chars>` : '<unset>')} → ${c.brand(`<${newSecret!.length} chars hidden>`)}`
          : c.dim('konvo.dispatch_shared_secret: unchanged'),
        '',
        ctx.dryRun ? c.yellow('(dry-run — no changes will be applied)') : ''
      ].filter(Boolean).join('\n'),
      'Preview'
    );

    const confirmed = await prompt.confirm({
      message: 'Apply Phase D config to prod?',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      prompt.note(
        [
          c.yellow('After apply (in non-dry-run):'),
          c.dim('  1. Update worker env DISPATCH_SHARED_SECRET in Coolify'),
          c.dim('  2. Restart konvo-worker-prod (use Restart service runbook)'),
          c.dim('  3. Run Smoke test runbook to verify dispatch')
        ].join('\n'),
        'Reminder'
      );
      return {
        success: true,
        summary: `Dry-run: would have updated ${urlChanged ? 'URL' : ''}${urlChanged && secretChanged ? ' + ' : ''}${secretChanged ? 'secret' : ''}.`,
        details: { current, newUrl: urlChanged ? newUrl : null, secretChanged, dryRun: true }
      };
    }

    // 5. Apply. Each ALTER DATABASE is a separate statement so we
    //    surface granular errors. Single SQL block, supabase_admin.
    const stmts: string[] = [];
    if (urlChanged) {
      const escaped = newUrl.replace(/'/g, `''`);
      stmts.push(`alter database postgres set konvo.notifications_worker_url = '${escaped}';`);
    }
    if (secretChanged) {
      const escaped = newSecret!.replace(/'/g, `''`);
      stmts.push(`alter database postgres set konvo.dispatch_shared_secret = '${escaped}';`);
    }
    const applySql = stmts.join('\n') + '\n';

    const sp2 = prompt.spinner();
    sp2.start('Applying ALTER DATABASE…');
    const applyRes = await psqlPiped(ctx.config, applySql, 'supabase_admin');
    if (applyRes.exitCode !== 0) {
      sp2.stop('Apply failed.');
      return {
        success: false,
        summary: `psql exit ${applyRes.exitCode}: ${applyRes.stderr.trim().slice(0, 200)}`,
        details: { exitCode: applyRes.exitCode }
      };
    }
    sp2.stop('Applied.');

    // 6. Verify.
    const sp3 = prompt.spinner();
    sp3.start('Verifying…');
    let after: CurrentState;
    try {
      after = await readCurrentState(ctx);
    } catch (err) {
      sp3.stop('Verify failed.');
      return {
        success: false,
        summary: err instanceof Error ? err.message : String(err)
      };
    }
    sp3.stop('Verified.');

    const expectedSecretLen = secretChanged ? newSecret!.length : current.secretLength;
    const urlOk    = !urlChanged    || after.workerUrl === newUrl;
    const secretOk = !secretChanged || after.secretLength === expectedSecretLen;

    if (!urlOk || !secretOk) {
      return {
        success: false,
        summary: `Apply succeeded but verify mismatch (urlOk=${urlOk}, secretOk=${secretOk}).`,
        details: { current, after }
      };
    }

    // 7. Final reminder.
    prompt.note(
      [
        c.bold('Next steps for end-to-end Phase D:'),
        '',
        secretChanged
          ? c.yellow('  1. Update DISPATCH_SHARED_SECRET in Coolify worker env to match.')
          : c.dim('  1. Worker env DISPATCH_SHARED_SECRET unchanged — no Coolify edit needed.'),
        secretChanged
          ? c.yellow('  2. Restart konvo-worker-prod (use Restart service runbook).')
          : c.dim('  2. Worker restart not required.'),
        '  3. Run Smoke test runbook to confirm dispatch works end-to-end.',
        '',
        c.dim('New sessions pick up the GUC change immediately;'),
        c.dim('cron-driven dispatch_due_geofence_checks() reads them every'),
        c.dim('time it fires.')
      ].join('\n'),
      'Reminder'
    );

    return {
      success: true,
      summary: `Phase D config updated (${urlChanged ? 'URL' : ''}${urlChanged && secretChanged ? ' + ' : ''}${secretChanged ? 'secret' : ''}).`,
      details: { before: current, after }
    };
  }
};

export default runbook;
