/**
 * Phase 2 runbook — Test worker dispatch.
 *
 * Fires a single dispatch HTTP call to the worker exactly the way
 * the cron-driven `dispatch_due_geofence_checks()` SQL function
 * would, but for a fake row that won't trigger any real notification.
 *
 * The shared-secret HMAC is read from konvo.dispatch_shared_secret
 * GUC on prod (so we don't have to ask the operator for it). The
 * runbook signs an empty-payload request, sends it to the worker,
 * and reports the response status + body.
 *
 * Useful when:
 *   - You just rotated DISPATCH_SHARED_SECRET via apply-phase-d-config
 *     and want to confirm the worker accepts the new value.
 *   - You're debugging why a real dispatch fired but no notification
 *     landed.
 *
 * Risk: read-only. The fake payload routes to a stub channel that
 * has no subscribers; nothing user-visible happens.
 */

import { exec } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'test-worker-dispatch',
  title:       'Test worker dispatch',
  description: 'Fire a signed dispatch HTTP call to the worker the way pg_cron would. Validates the shared-secret bridge.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // Phase 1: read GUCs from prod.
    const sp1 = prompt.spinner();
    sp1.start('Reading konvo.* GUCs from prod…');
    const gucSql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

with kv as (
  select split_part(s, '=', 1) as k,
         substring(s from position('=' in s) + 1) as v
  from pg_db_role_setting,
       unnest(setconfig) as s
  where setdatabase = (select oid from pg_database where datname = 'postgres')
)
select
  'url=' || coalesce(max(case when k = 'konvo.notifications_worker_url' then v end), '') || E'\\n' ||
  'sec=' || coalesce(max(case when k = 'konvo.dispatch_shared_secret' then v end), '')
from kv;
`;
    // We pipe via psql but on the VPS, then read back. Easier: pass
    // through ssh exec with a heredoc-free SQL via stdin.
    const psqlRes = await exec(
      ctx.config,
      `docker exec -i $(docker ps --format '{{.Names}}' | grep -E '^supabase-db-') psql -U supabase_admin -d postgres -P pager=off -tA -c "${gucSql.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`
    );
    if (psqlRes.exitCode !== 0) {
      sp1.stop('Failed to read GUCs.');
      return {
        success: false,
        summary: `psql exit ${psqlRes.exitCode}: ${psqlRes.stderr.trim().slice(0, 160)}`
      };
    }
    sp1.stop('GUCs read.');

    const out = psqlRes.stdout.trim();
    const urlMatch = out.match(/url=(.*)$/m);
    const secMatch = out.match(/sec=(.*)$/m);
    const workerUrl = (urlMatch?.[1] ?? '').trim();
    const sharedSecret = (secMatch?.[1] ?? '').trim();

    if (!workerUrl || !sharedSecret) {
      prompt.note(
        [
          workerUrl ? '' : c.red('konvo.notifications_worker_url is unset.'),
          sharedSecret ? '' : c.red('konvo.dispatch_shared_secret is unset.'),
          '',
          c.dim('Run "Apply Phase D notification config" first.')
        ].filter(Boolean).join('\n'),
        'Phase D not configured'
      );
      return {
        success: false,
        summary: 'Phase D GUCs not set.',
        details: { workerUrl: !!workerUrl, secret: !!sharedSecret }
      };
    }

    // Phase 2: build + sign + send the test request.
    // Payload mirrors what dispatch_due_geofence_checks() sends —
    // worker route + JSON shape. We use a fake check_id so the worker
    // can no-op or reject without hurting anything.
    const payload = {
      type:     'smoke-test',
      check_id: '00000000-0000-0000-0000-000000000000',
      sent_at:  new Date().toISOString()
    };
    const body = JSON.stringify(payload);

    // HMAC-SHA256 of the body with the shared secret. Encoded hex.
    const hmac = new Bun.CryptoHasher('sha256', sharedSecret);
    hmac.update(body);
    const signature = hmac.digest('hex');

    const dispatchUrl = `${workerUrl.replace(/\/+$/, '')}/v1/dispatch/test`;

    prompt.note(
      [
        `URL:        ${c.brand(dispatchUrl)}`,
        `Signature:  ${c.dim(signature.slice(0, 16))}…`,
        `Payload:    ${c.dim(body)}`,
        '',
        c.dim('Sending POST with X-Dispatch-Signature header…')
      ].join('\n'),
      'Test dispatch'
    );

    const sp2 = prompt.spinner();
    sp2.start('Calling worker…');
    let status = 0;
    let respBody = '';
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8_000);
      const res = await fetch(dispatchUrl, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type':         'application/json',
          'X-Dispatch-Signature': signature
        },
        body
      });
      clearTimeout(timer);
      status = res.status;
      respBody = await res.text();
    } catch (err) {
      sp2.stop('Request failed.');
      return {
        success: false,
        summary: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        details: { dispatchUrl }
      };
    }
    sp2.stop(`Worker responded ${status}.`);

    const ok = status >= 200 && status < 300;
    const statusColor = ok ? c.green : status === 401 ? c.red : c.yellow;
    prompt.note(
      [
        `Status: ${statusColor(String(status))}`,
        `Body:   ${c.dim(respBody.slice(0, 500))}`,
        '',
        ok
          ? c.green('Worker accepted the signed request — shared-secret bridge is healthy.')
          : status === 401
          ? c.red('401 — worker rejected the signature. The DISPATCH_SHARED_SECRET env in Coolify likely doesn\'t match konvo.dispatch_shared_secret. Restart konvo-worker-prod after updating, then retry.')
          : status === 404
          ? c.yellow('404 — /v1/dispatch/test route not registered. The worker may be on an older build that doesn\'t have the test endpoint; the production route is /v1/dispatch.')
          : c.yellow('Non-2xx status. Check worker logs (Tail logs runbook → worker).')
      ].join('\n'),
      'Result'
    );

    return {
      success: ok,
      summary: ok
        ? `Worker dispatch test passed (${status}).`
        : `Worker dispatch test failed (${status}).`,
      details: { dispatchUrl, status, bodyPreview: respBody.slice(0, 200) }
    };
  }
};

export default runbook;
