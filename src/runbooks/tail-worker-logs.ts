/**
 * Runbook #6 — Tail worker logs.
 *
 * Streams `docker logs` (with optional -f follow) from a chosen
 * production container, in real-time. The most common debug step
 * after a user reports something flaky.
 *
 * Read-only — log inspection only, no mutations.
 *
 * Implementation notes:
 *   - Uses streamExec() so output flows live without buffering.
 *   - We pre-resolve the actual container name via a one-shot
 *     `docker ps` over SSH because Coolify suffixes container names
 *     (e.g. `supabase-db-hoc46cx1c1qd643gkaqxhezq`) and they change
 *     when projects are recreated.
 *   - SIGINT (Ctrl+C) is intercepted so we can kill the SSH child
 *     cleanly + return a normal RunbookResult instead of crashing.
 */

import { exec, streamExec } from '../lib/ssh.ts';
import { SERVICES } from '../lib/services.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'tail-worker-logs',
  title:       'Tail logs',
  description: 'Stream docker logs from a chosen production container. Optional follow. Ctrl+C to exit.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Pick a service.
    const choice = await prompt.select({
      message: 'Which service?',
      options: SERVICES.map((s) => ({ value: s.id, label: s.label, hint: s.hint }))
    });
    if (prompt.isCancel(choice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const service = SERVICES.find((s) => s.id === choice)!;

    // 2. History size.
    const tailIn = await prompt.text({
      message: 'How many recent lines?',
      placeholder: '200',
      initialValue: '200',
      validate: (v) => {
        const n = parseInt((v ?? '').trim(), 10);
        if (!Number.isFinite(n) || n < 1 || n > 10_000) {
          return 'Enter 1–10000.';
        }
        return undefined;
      }
    });
    if (prompt.isCancel(tailIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const tailLines = parseInt((tailIn as string).trim(), 10);

    // 3. Follow new logs?
    const follow = await prompt.confirm({
      message: 'Follow new log lines (-f)?',
      initialValue: true
    });
    if (prompt.isCancel(follow)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    // 4. Resolve actual container name (Coolify suffixes can change).
    const sp = prompt.spinner();
    sp.start(`Resolving container matching /${service.pattern}/…`);
    const psRes = await exec(
      ctx.config,
      `docker ps --format '{{.Names}}' | grep -E '${service.pattern}' | head -n 1`
    );
    if (psRes.exitCode !== 0 || psRes.stdout.trim() === '') {
      sp.stop('No matching container.');
      return {
        success: false,
        summary: `No running container matched /${service.pattern}/.`,
        details: { service: service.id }
      };
    }
    const containerName = psRes.stdout.trim();
    sp.stop(`Container: ${containerName}`);

    // 5. Stream logs. We hand control to streamExec; output flows
    //    direct to inherited stdio. We listen for SIGINT once so the
    //    operator can Ctrl+C without crashing the CLI.
    const followFlag = follow ? '-f' : '';
    const remoteCmd = `docker logs ${followFlag} --tail ${tailLines} ${containerName}`;

    prompt.note(
      [
        `Streaming from ${containerName}`,
        ``,
        follow
          ? 'Press Ctrl+C to stop following.'
          : 'Showing last ' + tailLines + ' lines, then exiting.'
      ].join('\n'),
      'Live'
    );

    const proc = streamExec(ctx.config, remoteCmd);

    // Forward Ctrl+C exactly once, then restore default behaviour.
    const onSigint = (): void => {
      proc.kill('SIGINT');
    };
    process.once('SIGINT', onSigint);

    const exitCode = await proc.exited;
    process.removeListener('SIGINT', onSigint);

    // SSH returning 130 = killed by SIGINT, treat as normal exit.
    if (exitCode === 0 || exitCode === 130 || exitCode === null) {
      return {
        success: true,
        summary: `Tail finished for ${containerName}.`,
        details: { containerName, follow, tailLines }
      };
    }
    return {
      success: false,
      summary: `Tail exited with code ${exitCode}.`,
      details: { containerName, exitCode }
    };
  }
};

export default runbook;
