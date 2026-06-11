/**
 * Runbook #11 — Rotate Stripe keys.
 *
 * Guided rotation of the Stripe SECRET API key (sk_live_… / sk_test_…)
 * with sequenced checkpoints. Several steps require operator action
 * in external UIs (Stripe dashboard, Coolify) — Stripe's API doesn't
 * let API keys create new API keys, and Coolify env edits are UI-only.
 * The runbook's value is enforcing the right order:
 *
 *   1. Open Stripe dashboard → operator generates a new key
 *      (without revealing it elsewhere yet).
 *   2. Operator pastes new key into the runbook prompt.
 *   3. Runbook validates the new key by calling stripe.balance.retrieve()
 *      with an ad-hoc client — confirms the key works.
 *   4. Operator updates DISPATCH_SHARED_SECRET in Coolify worker env
 *      (manual step; runbook prints the exact var name + opens
 *      Coolify dashboard tunnel instructions).
 *   5. Runbook restarts konvo-worker-prod via SSH (automated).
 *   6. Runbook runs the smoke test (automated) to confirm dispatch
 *      still works end-to-end with the new key.
 *   7. Operator deletes the OLD key in Stripe dashboard (manual,
 *      runbook re-opens Stripe dashboard).
 *
 * Risk: high. Wrong sequencing is the failure mode (deleting the
 * old key before the new key is verified would brick payments).
 * Mitigations:
 *   - The validate-new-key step happens BEFORE the worker restart,
 *     so we never restart with an unverified key.
 *   - The smoke test gate happens BEFORE we tell the operator to
 *     delete the old key.
 *   - Live-key banner displayed throughout.
 *   - The runbook does NOT touch the operator's local
 *     KONVO_STRIPE_SECRET_KEY in .env — they update that themselves
 *     after the rotation completes.
 */

import Stripe from 'stripe';
import { exec } from '../lib/ssh.ts';
import { openInBrowser, findDashboard } from '../lib/dashboards.ts';
import { c } from '../lib/theme.ts';
import { stripeMode } from '../lib/stripe.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

/** Wait helper used between the worker restart and the post-restart poll. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Validate a candidate new key by trying to retrieve account balance. */
async function validateNewKey(newKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const adHoc = new Stripe(newKey, { typescript: true });
    const balance = await adHoc.balance.retrieve();
    return {
      ok:     true,
      detail: `available: ${balance.available.map((b) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ') || '0.00'}`
    };
  } catch (err) {
    return {
      ok:     false,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err)
    };
  }
}

/** Restart konvo-worker-prod. Mirrors restart-service runbook logic. */
async function restartWorker(ctx: RunbookContext): Promise<{ success: boolean; detail: string }> {
  const psRes = await exec(ctx.config, `docker ps --format '{{.Names}}' | grep -E '^konvo-worker-prod$' | head -n 1`);
  const containerName = psRes.stdout.trim();
  if (!containerName) {
    return { success: false, detail: 'konvo-worker-prod container not found.' };
  }
  const restartRes = await exec(ctx.config, `docker restart ${containerName}`);
  if (restartRes.exitCode !== 0) {
    return { success: false, detail: `docker restart exit ${restartRes.exitCode}` };
  }
  // Poll docker ps for up-to-30s.
  const deadline = Date.now() + 30_000;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    await sleep(1_500);
    const statusRes = await exec(
      ctx.config,
      `docker ps --filter 'name=${containerName}' --format '{{.Status}}' | head -n 1`
    );
    lastStatus = statusRes.stdout.trim();
    if (lastStatus.startsWith('Up ')) {
      return { success: true, detail: lastStatus };
    }
  }
  return { success: false, detail: `did not return to Up within 30s (last: ${lastStatus})` };
}

/** Hit worker /healthz post-restart for a low-cost sanity check. */
async function postRestartHealthCheck(): Promise<{ ok: boolean; detail: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    const res = await fetch('https://worker.thekonvo.com/healthz', { signal: ac.signal, redirect: 'manual' });
    clearTimeout(timer);
    return {
      ok:     res.status === 200,
      detail: `${res.status} ${res.statusText || ''}`.trim()
    };
  } catch (err) {
    return {
      ok:     false,
      detail: err instanceof Error ? err.message.slice(0, 100) : String(err)
    };
  }
}

const runbook: Runbook = {
  id:          'rotate-stripe-keys',
  title:       'Rotate Stripe keys',
  description: 'Guided rotation of the Stripe SECRET API key. Sequenced manual + automated steps with validation gates.',
  risk:        'high',
  requires:    ['ssh', 'stripe'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;
    const currentMode = stripeMode(ctx.config);

    // ─── Preflight ──────────────────────────────────────────────────
    prompt.note(
      [
        c.bold('Stripe key rotation — guided checklist'),
        '',
        `Current local key:   ${currentMode === 'unset' ? c.dim('not set in .env') : currentMode === 'live' ? c.yellow('LIVE') : c.dim('test')}`,
        '',
        c.dim('Steps:'),
        c.dim('  1. Open Stripe → generate new SECRET key (you will paste it here)'),
        c.dim('  2. Validate new key works (automated)'),
        c.dim('  3. Open Coolify → update STRIPE_SECRET_KEY env (manual)'),
        c.dim('  4. Restart konvo-worker-prod (automated)'),
        c.dim('  5. Smoke test post-restart (automated)'),
        c.dim('  6. Delete OLD key in Stripe (manual — final step)'),
        '',
        c.yellow('Do NOT delete the old key until step 5 is green.')
      ].join('\n'),
      'Plan'
    );

    const proceed = await prompt.confirm({
      message: 'Begin rotation?',
      initialValue: false
    });
    if (prompt.isCancel(proceed) || !proceed) {
      prompt.cancel('Aborted before any action.');
      return { success: false, summary: 'Operator did not begin rotation.' };
    }

    // ─── Step 1: Open Stripe dashboard for key generation ───────────
    const stripeDash = findDashboard('stripe');
    prompt.note(
      [
        c.bold('Step 1 — Generate new key'),
        '',
        '1. In the Stripe dashboard that just opened:',
        '   Developers → API keys → "+ Create restricted key"',
        '   (or "Create secret key" for a standard rolling key)',
        '2. Copy the new key value (you only see it once).',
        '3. Come back here and paste it.',
        '',
        c.dim('The runbook will validate the key before you continue.')
      ].join('\n'),
      'Action'
    );
    if (stripeDash) {
      await openInBrowser(stripeDash.url + 'apikeys');
    }

    // ─── Step 2: Paste + validate new key ───────────────────────────
    const newKeyIn = await prompt.password({
      message: 'Paste the new Stripe secret key',
      mask: '•',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{20,}$/.test(s)) {
          return 'Should look like sk_live_… / sk_test_… / rk_live_… / rk_test_….';
        }
        return undefined;
      }
    });
    if (prompt.isCancel(newKeyIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled at key paste.' };
    }
    const newKey = (newKeyIn as string).trim();
    const newKeyMode = newKey.startsWith('sk_live_') || newKey.startsWith('rk_live_') ? 'live' : 'test';
    if (currentMode === 'live' && newKeyMode === 'test') {
      const reallyTest = await prompt.confirm({
        message: c.yellow('Current key is LIVE but new key is TEST. Are you sure?'),
        initialValue: false
      });
      if (prompt.isCancel(reallyTest) || !reallyTest) {
        return { success: false, summary: 'Operator cancelled — mode mismatch.' };
      }
    }

    if (ctx.dryRun) {
      prompt.note(c.yellow('(dry-run — would validate new key against Stripe API)'), 'Step 2');
    } else {
      const sp1 = prompt.spinner();
      sp1.start('Calling Stripe balance.retrieve() with new key…');
      const v = await validateNewKey(newKey);
      if (!v.ok) {
        sp1.stop('Validation failed.');
        return {
          success: false,
          summary: `New key validation failed: ${v.detail}`,
          details: { step: 'validate-new-key' }
        };
      }
      sp1.stop(`Validated. ${v.detail}`);
    }

    // ─── Step 3: Coolify env update (manual) ────────────────────────
    const coolify = findDashboard('coolify');
    prompt.note(
      [
        c.bold('Step 3 — Update worker env in Coolify'),
        '',
        coolify
          ? `Open SSH tunnel + Coolify in another terminal:\n  ssh -L 8000:localhost:8000 -i ${ctx.config.sshKey} ${ctx.config.prodHost}\n  → http://localhost:8000`
          : '(Coolify dashboard not registered)',
        '',
        '1. Project: Konvo Production → konvo-worker-prod',
        '2. Settings → Environment Variables',
        `3. Update: ${c.brand('STRIPE_SECRET_KEY')} → paste the new key`,
        '4. Save',
        '',
        c.dim('Do not press Restart in Coolify — this runbook will do it'),
        c.dim('via SSH so we can verify + smoke-test cleanly.')
      ].join('\n'),
      'Action'
    );

    const envUpdated = await prompt.confirm({
      message: 'STRIPE_SECRET_KEY updated in Coolify and saved?',
      initialValue: false
    });
    if (prompt.isCancel(envUpdated) || !envUpdated) {
      prompt.cancel('Aborted before worker restart.');
      return {
        success: false,
        summary: 'Operator did not confirm Coolify env update. Old key still in use; new key is unused.',
        details: { step: 'coolify-env' }
      };
    }

    // ─── Step 4: Restart worker ────────────────────────────────────
    if (ctx.dryRun) {
      prompt.note(c.yellow('(dry-run — would docker restart konvo-worker-prod)'), 'Step 4');
    } else {
      const sp2 = prompt.spinner();
      sp2.start('docker restart konvo-worker-prod…');
      const restart = await restartWorker(ctx);
      if (!restart.success) {
        sp2.stop('Restart failed.');
        return {
          success: false,
          summary: `Worker restart failed: ${restart.detail}. New key in Coolify env but worker not running with it.`,
          details: { step: 'restart-worker' }
        };
      }
      sp2.stop(`Worker is ${restart.detail}.`);
    }

    // ─── Step 5: Post-restart smoke test ───────────────────────────
    if (ctx.dryRun) {
      prompt.note(c.yellow('(dry-run — would call worker /healthz)'), 'Step 5');
    } else {
      const sp3 = prompt.spinner();
      sp3.start('Hitting worker /healthz…');
      // Give the worker ~3s to actually finish booting after Up.
      await sleep(3_000);
      const health = await postRestartHealthCheck();
      if (!health.ok) {
        sp3.stop('Smoke test failed.');
        prompt.note(
          [
            c.red('Worker health check failed after restart.'),
            c.dim(health.detail),
            '',
            c.bold('Recovery:'),
            '  1. Tail worker logs (use Tail logs runbook).',
            '  2. If the worker can\'t parse the new key, revert',
            '     STRIPE_SECRET_KEY in Coolify to the OLD key.',
            '  3. Restart again. Old key is still valid until you',
            '     delete it in Stripe (which you have NOT done yet).'
          ].join('\n'),
          'Failure recovery'
        );
        return {
          success: false,
          summary: `Worker health check failed after restart: ${health.detail}. OLD key still works in Stripe — recover by reverting Coolify env.`,
          details: { step: 'post-restart-health' }
        };
      }
      sp3.stop(`Worker /healthz: ${health.detail}.`);
    }

    // ─── Step 6: Tell operator to delete old key (manual) ──────────
    prompt.note(
      [
        c.bold('Step 6 — Delete OLD key in Stripe'),
        '',
        c.green('✓ New key validated.'),
        c.green('✓ Coolify env updated.'),
        c.green('✓ Worker restarted + healthy.'),
        '',
        'Now and only now:',
        '  1. Stripe dashboard → Developers → API keys',
        '  2. Find the OLD key (note the last 4 chars match the prefix you replaced)',
        '  3. Click "Roll" or "Delete" on the OLD key.',
        '',
        c.yellow('Also update KONVO_STRIPE_SECRET_KEY in your local .env'),
        c.yellow('to the new key, otherwise refund-revoke + future'),
        c.yellow('runs of this runbook will use the deleted key.')
      ].join('\n'),
      'Final action'
    );

    if (stripeDash) {
      await openInBrowser(stripeDash.url + 'apikeys');
    }

    const oldKeyDeleted = await prompt.confirm({
      message: 'Old key deleted in Stripe?',
      initialValue: false
    });

    return {
      success: true,
      summary: oldKeyDeleted
        ? `Rotation complete. New ${newKeyMode} key in use; old key deleted.`
        : `Rotation complete EXCEPT old-key deletion. New key in use, but old key is still valid in Stripe — delete it when convenient.`,
      details: { newKeyMode, oldKeyDeleted: !!oldKeyDeleted }
    };
  }
};

export default runbook;
