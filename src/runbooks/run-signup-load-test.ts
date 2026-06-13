/**
 * Runbook — run-signup-load-test.
 *
 * Level 1 capacity test from planning/houvox/v2-punchlist context:
 * synthetic-signup load test against the worker's
 * /v1/admin/loadtest/signup + /cleanup endpoints. Measures realistic
 * signup-rate ceiling — answers item 1.1 of the v2 punchlist
 * ('what's the max daily registrations the current VPS can handle?').
 *
 * Mechanics:
 *   - Operator picks a target RPS (e.g. 50 req/sec) and duration
 *     (e.g. 60 sec)
 *   - Runbook fires N requests at the target rate with bounded
 *     concurrency, measuring per-request latency
 *   - At the end, calls cleanup endpoint with the same run_id
 *   - Reports: sustained RPS achieved, success rate, p50/p95/p99
 *     latency, error breakdown
 *
 * Required env: LOADTEST_ADMIN_SECRET on operator's .env (matches
 * worker env, set on VPS at /root/.konvo-prod/loadtest-admin-secret.txt).
 *
 * Risk: high. Creates real auth.users rows + fires
 * handle_new_user trigger on prod. Cleanup runs at end but a
 * crashed test can leave orphans. Recommended pre-flight steps
 * (operator-confirmed): set konvo.waitlist_enabled=true to bounce
 * real signups during the test, run during low-traffic window.
 */

import { c } from '../lib/theme.ts';
import { writeAudit } from '../lib/audit.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface ReqResult {
  ok:          boolean;
  status:      number;
  elapsed_ms:  number;
  error?:      string;
}

const runbook: Runbook = {
  id:          'run-signup-load-test',
  title:       'Run signup load test',
  description: 'Level 1 capacity test — synthetic auth.users rows at configurable RPS. Measures realistic daily-registration ceiling.',
  risk:        'high',
  requires:    [],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // Read the loadtest admin secret from env.
    const env = (Bun.env ?? process.env) as Record<string, string | undefined>;
    const secret = env['KONVO_LOADTEST_ADMIN_SECRET']?.trim();
    if (!secret) {
      return {
        success: false,
        summary: 'KONVO_LOADTEST_ADMIN_SECRET is unset. Add it to .env (matches LOADTEST_ADMIN_SECRET on the worker).'
      };
    }

    const workerUrl = env['KONVO_WORKER_URL']?.trim() || 'https://worker.thekonvo.com';

    // ─── Pre-flight reminder ────────────────────────────────────────
    prompt.note(
      [
        c.bold('Pre-flight checklist:'),
        '',
        c.dim('  1. Worker is deployed with LOADTEST_ADMIN_SECRET set'),
        c.dim('  2. (Recommended) konvo.waitlist_enabled=true so real signups bounce'),
        c.dim('  3. Low-traffic window — currently always low at our scale'),
        c.dim('  4. You will see auth.users + profile rows created in real time'),
        c.dim('  5. Cleanup runs automatically at end (uses run_id scoping)'),
        '',
        c.brand(`Worker: ${workerUrl}`)
      ].join('\n'),
      'Pre-flight'
    );

    // ─── Configure the run ──────────────────────────────────────────
    const targetRpsIn = await prompt.text({
      message: 'Target RPS (requests per second)',
      placeholder: '50',
      initialValue: '50',
      validate: (v) => {
        const n = parseInt((v ?? '').trim(), 10);
        if (!Number.isFinite(n) || n < 1 || n > 500) return 'Must be 1-500.';
        return undefined;
      }
    });
    if (prompt.isCancel(targetRpsIn)) return { success: false, summary: 'Operator cancelled.' };
    const targetRps = parseInt((targetRpsIn as string).trim(), 10);

    const durationIn = await prompt.text({
      message: 'Duration (seconds)',
      placeholder: '30',
      initialValue: '30',
      validate: (v) => {
        const n = parseInt((v ?? '').trim(), 10);
        if (!Number.isFinite(n) || n < 5 || n > 300) return 'Must be 5-300 seconds.';
        return undefined;
      }
    });
    if (prompt.isCancel(durationIn)) return { success: false, summary: 'Operator cancelled.' };
    const duration = parseInt((durationIn as string).trim(), 10);

    const totalRequests = targetRps * duration;
    const runId = (Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);

    prompt.note(
      [
        `Target RPS:      ${c.brand(String(targetRps))}`,
        `Duration:        ${c.brand(String(duration))}s`,
        `Total requests:  ${c.brand(String(totalRequests))}`,
        `Run ID:          ${c.dim(runId)}`,
        `Cleanup pattern: ${c.dim(`loadtest+${runId}-%@thekonvo.com`)}`,
        '',
        ctx.dryRun ? c.yellow('(dry-run — no requests will be sent)') : ''
      ].filter(Boolean).join('\n'),
      'Run plan'
    );

    const confirmed = await prompt.confirm({
      message: `Begin load test (creates ${totalRequests} real auth.users rows + cleans up after)?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have fired ${totalRequests} synthetic signups at ${targetRps} RPS for ${duration}s.`,
        details: { runId, targetRps, duration, dryRun: true }
      };
    }

    // ─── Execute the load test ──────────────────────────────────────
    const sp = prompt.spinner();
    sp.start(`Firing ${totalRequests} requests at ${targetRps} RPS…`);

    const results: ReqResult[] = [];
    const intervalMs = 1000 / targetRps;
    const t0 = performance.now();

    // Naive scheduler: kick off requests at fixed intervals; each request
    // resolves whenever it finishes (no backpressure beyond the worker's
    // own queue). Realistic enough for Level 1.
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < totalRequests; i++) {
      const sleepUntil = t0 + i * intervalMs;
      const sleepFor = Math.max(0, sleepUntil - performance.now());
      if (sleepFor > 0) await new Promise((res) => setTimeout(res, sleepFor));

      const indexLocal = i;
      inflight.push((async () => {
        const start = performance.now();
        try {
          const res = await fetch(`${workerUrl}/v1/admin/loadtest/signup`, {
            method:  'POST',
            headers: {
              'Content-Type':            'application/json',
              'X-Loadtest-Admin-Secret': secret
            },
            body: JSON.stringify({ run_id: runId, index: indexLocal })
          });
          const elapsed = performance.now() - start;
          if (res.ok) {
            results.push({ ok: true, status: res.status, elapsed_ms: elapsed });
          } else {
            const body = await res.text().catch(() => '');
            results.push({
              ok:         false,
              status:     res.status,
              elapsed_ms: elapsed,
              error:      body.slice(0, 100)
            });
          }
        } catch (err) {
          results.push({
            ok:         false,
            status:     0,
            elapsed_ms: performance.now() - start,
            error:      err instanceof Error ? err.message.slice(0, 100) : String(err)
          });
        }
      })());
    }

    await Promise.all(inflight);
    const elapsed = (performance.now() - t0) / 1000;
    sp.stop(`Done in ${elapsed.toFixed(1)}s.`);

    // ─── Compute stats ─────────────────────────────────────────────
    const successes = results.filter((r) => r.ok);
    const failures  = results.filter((r) => !r.ok);
    const latencies = successes.map((r) => r.elapsed_ms).sort((a, b) => a - b);
    const pct       = (p: number): number =>
      latencies.length ? (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0) : 0;
    const sustainedRps = successes.length / elapsed;

    // Group failures by status code
    const failureByStatus = new Map<number, number>();
    for (const f of failures) {
      failureByStatus.set(f.status, (failureByStatus.get(f.status) ?? 0) + 1);
    }
    const failureBreakdown = [...failureByStatus.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `${code === 0 ? 'network' : code}: ${count}`)
      .join(', ');

    prompt.note(
      [
        c.bold('Run results'),
        '',
        `Total requests:    ${results.length}`,
        `Successes:         ${c.green(String(successes.length))}`,
        `Failures:          ${failures.length === 0 ? c.dim('0') : c.red(String(failures.length))}` +
          (failureBreakdown ? c.dim(`  (${failureBreakdown})`) : ''),
        `Wall time:         ${elapsed.toFixed(1)}s`,
        `Sustained RPS:     ${c.brand(sustainedRps.toFixed(1))}`,
        '',
        c.bold('Latency (success only):'),
        `  p50:  ${c.brand(pct(0.50).toFixed(0).padStart(5))}ms`,
        `  p95:  ${c.brand(pct(0.95).toFixed(0).padStart(5))}ms`,
        `  p99:  ${c.brand(pct(0.99).toFixed(0).padStart(5))}ms`,
        `  max:  ${c.dim(latencies.length ? (latencies[latencies.length - 1] ?? 0).toFixed(0).padStart(5) : '   0')}ms`
      ].join('\n'),
      'Results'
    );

    // ─── Cleanup ────────────────────────────────────────────────────
    const sp2 = prompt.spinner();
    sp2.start('Cleaning up synthetic users…');
    let cleanupResult: { deleted: number; failures: number } | null = null;
    try {
      const res = await fetch(`${workerUrl}/v1/admin/loadtest/cleanup`, {
        method:  'POST',
        headers: {
          'Content-Type':            'application/json',
          'X-Loadtest-Admin-Secret': secret
        },
        body: JSON.stringify({ run_id: runId })
      });
      if (res.ok) {
        cleanupResult = await res.json() as { deleted: number; failures: number };
      } else {
        sp2.stop(c.red(`Cleanup failed: HTTP ${res.status}`));
      }
    } catch (err) {
      sp2.stop(c.red(`Cleanup network error: ${err instanceof Error ? err.message : String(err)}`));
    }
    if (cleanupResult) {
      sp2.stop(`Deleted ${cleanupResult.deleted} synthetic users (${cleanupResult.failures} cleanup failures).`);
    }

    // ─── Audit log ──────────────────────────────────────────────────
    const audit = await writeAudit(ctx.config, {
      runbookId: 'run-signup-load-test',
      action:    'load-test-completed',
      target:    runId,
      metadata:  {
        runId,
        targetRps,
        duration,
        totalRequests:  results.length,
        successes:      successes.length,
        failures:       failures.length,
        sustainedRps:   Math.round(sustainedRps * 10) / 10,
        p50_ms:         Math.round(pct(0.50)),
        p95_ms:         Math.round(pct(0.95)),
        p99_ms:         Math.round(pct(0.99)),
        cleanupDeleted: cleanupResult?.deleted ?? null,
        cleanupFailed:  cleanupResult?.failures ?? null
      },
      dryRun: false
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit write failed: ${audit.error}`), 'Warning');
    }

    return {
      success: failures.length === 0,
      summary: failures.length === 0
        ? `${sustainedRps.toFixed(1)} RPS sustained, p99 ${pct(0.99).toFixed(0)}ms, all clean.`
        : `${failures.length}/${results.length} failures at ${targetRps} target RPS — likely past saturation.`,
      details: {
        runId, targetRps, duration,
        sustainedRps, successes: successes.length, failures: failures.length,
        latencyP50: pct(0.50), latencyP95: pct(0.95), latencyP99: pct(0.99),
        cleanupDeleted: cleanupResult?.deleted
      }
    };
  }
};

export default runbook;
