/**
 * Phase 2 runbook — Open superuser psql.
 *
 * Spawns an interactive psql session as supabase_admin against the
 * Supabase Postgres container. The recurring pain we hit during
 * Phase D config setup yesterday (KONVO-ADMIN-CLI.md §4b friction
 * patterns):
 *
 *   - `postgres` user is restricted in the Supabase docker image;
 *     ALTER DATABASE on custom GUCs requires `supabase_admin`.
 *   - The container ships without `less`, so default psql output
 *     can hang waiting for a pager that doesn't exist.
 *   - The container name is Coolify-suffixed and changes when
 *     projects are recreated.
 *
 * This runbook handles all three: connects as supabase_admin,
 * passes -P pager=off, and resolves the live container name via
 * `docker ps | grep -E ^supabase-db-` first.
 *
 * Read-only by classification — what the operator does INSIDE the
 * shell is on them. The runbook itself just opens the connection.
 */

import { exec, streamExec } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'open-superuser-psql',
  title:       'Open superuser psql',
  description: 'Interactive psql session as supabase_admin (the actual superuser, not the demoted postgres user). pager=off baked in.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // Resolve container name.
    const sp = prompt.spinner();
    sp.start('Resolving supabase-db container…');
    const psRes = await exec(
      ctx.config,
      `docker ps --format '{{.Names}}' | grep -E '^supabase-db-' | head -n 1`
    );
    const containerName = psRes.stdout.trim();
    if (psRes.exitCode !== 0 || !containerName) {
      sp.stop('No supabase-db container.');
      return {
        success: false,
        summary: 'No running container matched /^supabase-db-/.'
      };
    }
    sp.stop(`Container: ${containerName}`);

    prompt.note(
      [
        c.bold('Opening interactive psql.'),
        '',
        `Database: ${c.brand('postgres')}`,
        `Role:     ${c.brand('supabase_admin')}`,
        `Pager:    ${c.dim('off')}`,
        '',
        c.dim('\\q to exit and return to the runbook menu.')
      ].join('\n'),
      'Connecting'
    );

    // Drop into interactive psql via SSH with -t (allocate TTY).
    // streamExec already passes -t; psql will get a real terminal.
    const remoteCmd = `docker exec -it ${containerName} psql -U supabase_admin -d postgres -P pager=off`;
    const proc = streamExec(ctx.config, remoteCmd);

    // Forward Ctrl+C once so the operator's signal cleanly tears down
    // the psql session instead of crashing the CLI.
    const onSigint = (): void => { proc.kill('SIGINT'); };
    process.once('SIGINT', onSigint);

    const exitCode = await proc.exited;
    process.removeListener('SIGINT', onSigint);

    return {
      success: exitCode === 0 || exitCode === 130 || exitCode === null,
      summary: `psql session ended (exit ${exitCode ?? 'null'}).`,
      details: { containerName }
    };
  }
};

export default runbook;
