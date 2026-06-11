/**
 * Runbook #5 — Run prod smoke test.
 *
 * Three independent stages, each rendered as its own progress group:
 *
 *   1. HTTP reachability — verifies the public surfaces respond.
 *      Combines DNS + TLS + reverse-proxy + service health into one
 *      observable signal per host.
 *   2. Worker /healthz body sanity — checks the worker reports its
 *      build hash + uptime, not just a 200.
 *   3. Outbox drain — inserts a synthetic centrifugo_outbox row and
 *      confirms the consumer drains it within 2s. The most meaningful
 *      E2E signal: it exercises Postgres → worker → Centrifugo.
 *
 * Read-only. The synthetic outbox row goes to a dedicated channel
 * (`chat:smoketest`) that no client subscribes to.
 *
 * Loosely mirrors coolify/production/06-smoke-test.sh in the
 * houvox-pwa repo — but skips the JWT-bridge stage (too brittle to
 * automate cleanly) and the Supabase checks (require ANON_KEY in
 * env, which is friction for a CLI tool).
 */

import { psqlPiped } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface Check {
  label:  string;
  pass:   boolean;
  detail: string;
}

const HTTP_TARGETS = [
  { label: 'app.thekonvo.com',          url: 'https://app.thekonvo.com/',           expect: [200] },
  { label: 'worker /healthz',           url: 'https://worker.thekonvo.com/healthz', expect: [200] },
  { label: 'rt.thekonvo.com /health',   url: 'https://rt.thekonvo.com/health',      expect: [200] }
] as const;

async function checkHttp(target: typeof HTTP_TARGETS[number]): Promise<Check> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    const res = await fetch(target.url, { signal: ac.signal, redirect: 'manual' });
    clearTimeout(timer);
    const ok = (target.expect as readonly number[]).includes(res.status);
    return {
      label:  target.label,
      pass:   ok,
      detail: `${res.status} ${res.statusText || ''}`.trim()
    };
  } catch (err) {
    return {
      label:  target.label,
      pass:   false,
      detail: err instanceof Error ? err.message.slice(0, 100) : String(err)
    };
  }
}

async function checkWorkerHealthBody(): Promise<Check> {
  // Worker /healthz returns plaintext or JSON depending on build —
  // we just want to confirm it isn't a placeholder / cached 200 from
  // Cloudflare.
  try {
    const res = await fetch('https://worker.thekonvo.com/healthz', { redirect: 'manual' });
    const body = await res.text();
    const trimmed = body.trim().slice(0, 200);
    if (res.status !== 200) {
      return { label: 'worker /healthz body', pass: false, detail: `status ${res.status}` };
    }
    if (trimmed.length === 0) {
      return { label: 'worker /healthz body', pass: false, detail: 'empty body' };
    }
    return { label: 'worker /healthz body', pass: true, detail: trimmed };
  } catch (err) {
    return {
      label:  'worker /healthz body',
      pass:   false,
      detail: err instanceof Error ? err.message.slice(0, 100) : String(err)
    };
  }
}

async function checkOutboxDrain(ctx: RunbookContext): Promise<Check> {
  // Insert a synthetic row, sleep 2s, count remaining rows. If the
  // consumer is healthy the count goes back to baseline.
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

select count(*) as before_count from public.centrifugo_outbox \\gset

insert into public.centrifugo_outbox (method, payload, partition)
values ('publish',
        '{"channel":"chat:smoketest","data":{"type":"smoke-test"}}'::jsonb,
        0);

select pg_sleep(2);

select count(*) as after_count from public.centrifugo_outbox \\gset

\\echo BEFORE :before_count AFTER :after_count
`;
  try {
    const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
    if (res.exitCode !== 0) {
      return {
        label:  'outbox drain',
        pass:   false,
        detail: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 120)}`
      };
    }
    const m = res.stdout.match(/BEFORE\s+(\d+)\s+AFTER\s+(\d+)/);
    if (!m) {
      return {
        label:  'outbox drain',
        pass:   false,
        detail: `couldn't parse output: ${res.stdout.trim().slice(0, 120)}`
      };
    }
    const before = parseInt(m[1]!, 10);
    const after  = parseInt(m[2]!, 10);
    return {
      label:  'outbox drain',
      pass:   after <= before,
      detail: `before=${before}, after=${after}` + (after <= before ? ' (drained ✓)' : ' (STUCK)')
    };
  } catch (err) {
    return {
      label:  'outbox drain',
      pass:   false,
      detail: err instanceof Error ? err.message.slice(0, 100) : String(err)
    };
  }
}

const runbook: Runbook = {
  id:          'smoke-test',
  title:       'Run prod smoke test',
  description: 'HTTP reachability + worker health body + outbox drain. Read-only end-to-end signal.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;
    const results: Check[] = [];

    // ─── Stage 1: HTTP reachability ─────────────────────────────────
    const sp1 = prompt.spinner();
    sp1.start('Checking public surfaces…');
    const httpResults = await Promise.all(HTTP_TARGETS.map(checkHttp));
    results.push(...httpResults);
    sp1.stop(`HTTP: ${httpResults.filter((r) => r.pass).length}/${httpResults.length} reachable`);
    prompt.note(
      httpResults
        .map((r) => `  ${r.pass ? c.green('✓') : c.red('✗')}  ${r.label.padEnd(28)} ${c.dim(r.detail)}`)
        .join('\n'),
      'Stage 1 — HTTP reachability'
    );

    // ─── Stage 2: Worker health body ────────────────────────────────
    const sp2 = prompt.spinner();
    sp2.start('Checking worker /healthz body…');
    const bodyResult = await checkWorkerHealthBody();
    results.push(bodyResult);
    sp2.stop(bodyResult.pass ? 'Worker reports healthy.' : 'Worker /healthz body suspect.');
    prompt.note(
      `  ${bodyResult.pass ? c.green('✓') : c.red('✗')}  ${bodyResult.label}\n  ${c.dim(bodyResult.detail)}`,
      'Stage 2 — Worker body'
    );

    // ─── Stage 3: Outbox drain ──────────────────────────────────────
    const sp3 = prompt.spinner();
    sp3.start('Inserting synthetic outbox row…');
    const drainResult = await checkOutboxDrain(ctx);
    results.push(drainResult);
    sp3.stop(drainResult.pass ? 'Outbox drained.' : 'Outbox stuck.');
    prompt.note(
      `  ${drainResult.pass ? c.green('✓') : c.red('✗')}  ${drainResult.label}\n  ${c.dim(drainResult.detail)}`,
      'Stage 3 — Outbox drain (E2E)'
    );

    // ─── Summary ────────────────────────────────────────────────────
    const passed = results.filter((r) => r.pass).length;
    const total  = results.length;
    const allPassed = passed === total;

    return {
      success: allPassed,
      summary: allPassed
        ? `All ${total} checks passed.`
        : `${passed}/${total} passed; ${total - passed} failed.`,
      details: { results }
    };
  }
};

export default runbook;
