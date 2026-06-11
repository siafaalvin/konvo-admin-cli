/**
 * Runbook #7 — Restart service.
 *
 * Picks a restartable service (filtered via `restartableServices()`,
 * which excludes Postgres), confirms with the operator, and runs
 * `docker restart <container>` over SSH. Then polls `docker ps` for
 * up-to-30s to verify the container comes back to `Up` state.
 *
 * Risk classification: low. Single-container restart, blast radius
 * usually <30s of dropped traffic to that one service. The operator
 * still has to confirm — restarts during peak traffic can cause user-
 * visible blips (notably centrifugo, where every websocket
 * reconnects).
 *
 * Excludes:
 *   - supabase-db (Postgres) — too much blast radius for a click.
 *     If you genuinely need to restart Postgres, do it through
 *     Coolify with a planned window, not via this runbook.
 */

import { exec } from '../lib/ssh.ts';
import { restartableServices } from '../lib/services.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

/** Sleep helper — used between docker ps polls. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const runbook: Runbook = {
  id:          'restart-service',
  title:       'Restart service',
  description: 'docker restart <container> with confirmation + post-restart health poll. Excludes Postgres.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Pick a restartable service.
    const services = restartableServices();
    const choice = await prompt.select({
      message: 'Which service to restart?',
      options: services.map((s) => ({ value: s.id, label: s.label, hint: s.hint }))
    });
    if (prompt.isCancel(choice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const service = services.find((s) => s.id === choice)!;

    // 2. Resolve actual container name (Coolify suffix-aware).
    const sp1 = prompt.spinner();
    sp1.start(`Resolving container matching /${service.pattern}/…`);
    const psRes = await exec(
      ctx.config,
      `docker ps --format '{{.Names}}' | grep -E '${service.pattern}' | head -n 1`
    );
    if (psRes.exitCode !== 0 || psRes.stdout.trim() === '') {
      sp1.stop('No matching container.');
      return {
        success: false,
        summary: `No running container matched /${service.pattern}/.`,
        details: { service: service.id }
      };
    }
    const containerName = psRes.stdout.trim();
    sp1.stop(`Container: ${containerName}`);

    // 3. Confirm — show what's about to happen + the blast radius
    //    note for the chatty services.
    const blastRadiusNote =
      service.id === 'centrifugo'    ? 'All active websockets will reconnect (≈1s blip per client).' :
      service.id === 'worker'        ? 'In-flight background jobs may be dropped; safe to retry.'    :
      service.id === 'supabase-rest' ? 'Brief 502s on /rest/v1 calls during the restart window.'     :
      service.id === 'supabase-auth' ? 'Sign-in / sign-up requests will get 502s for ~5s.'           :
      service.id === 'supabase-storage' ? 'Document uploads will fail during the restart window.'   :
                                       'Restart blast radius: brief 502 on the service surface.';

    prompt.note(
      [
        `Container: ${c.brand(containerName)}`,
        `Command:   docker restart ${containerName}`,
        ``,
        c.dim(blastRadiusNote),
        ctx.dryRun ? c.yellow('(dry-run — no restart will be issued)') : ''
      ].filter(Boolean).join('\n'),
      'Preview'
    );

    const confirmed = await prompt.confirm({
      message: 'Restart now?',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have restarted ${containerName}.`,
        details: { containerName, dryRun: true }
      };
    }

    // 4. Issue the restart.
    const sp2 = prompt.spinner();
    sp2.start('docker restart…');
    const restartRes = await exec(ctx.config, `docker restart ${containerName}`);
    if (restartRes.exitCode !== 0) {
      sp2.stop('docker restart failed.');
      return {
        success: false,
        summary: `docker restart exit ${restartRes.exitCode}: ${restartRes.stderr.trim().slice(0, 200)}`,
        details: { containerName, exitCode: restartRes.exitCode }
      };
    }
    sp2.stop('Restart issued.');

    // 5. Poll docker ps for up-to-30s to verify it's back to Up.
    const sp3 = prompt.spinner();
    sp3.start('Waiting for container to report Up…');
    const deadline = Date.now() + 30_000;
    let lastStatus = 'unknown';
    let upConfirmed = false;
    while (Date.now() < deadline) {
      await sleep(1_500);
      const statusRes = await exec(
        ctx.config,
        `docker ps --filter 'name=${containerName}' --format '{{.Status}}' | head -n 1`
      );
      lastStatus = statusRes.stdout.trim();
      // Docker reports e.g. 'Up 4 seconds' or 'Restarting (1) 2 seconds ago'.
      if (lastStatus.startsWith('Up ')) {
        upConfirmed = true;
        break;
      }
    }
    sp3.stop(upConfirmed ? `Container is ${lastStatus}.` : `Container did not return to Up within 30s.`);

    if (!upConfirmed) {
      return {
        success: false,
        summary: `Restarted ${containerName} but it did not report Up within 30s. Last status: ${lastStatus}`,
        details: { containerName, lastStatus }
      };
    }
    return {
      success: true,
      summary: `Restarted ${containerName} — ${lastStatus}.`,
      details: { containerName, status: lastStatus }
    };
  }
};

export default runbook;
