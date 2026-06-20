/**
 * Runbook — snapshot-supabase-backup.
 *
 * Triggers an ad-hoc run of the daily backup script on the prod VPS,
 * outside of the regular 02:30 UTC cron schedule. Useful before risky
 * operations (schema migrations, manual data fixes, etc.) so you have
 * a known-good restore point.
 *
 * The actual script lives at /root/backups/run-supabase-backup.sh and
 * is documented in planning/SUPABASE-BACKUPS.md. This runbook just
 * invokes it via SSH and prints the resulting log + artifact list.
 *
 * Risk: low. Read-only on the running databases (pg_dumpall takes a
 * snapshot via MVCC; doesn't lock writers). Disk usage grows by ~10MB
 * per snapshot at current data volume. Aborting mid-run leaves a
 * partial date-dir which the next run will not interfere with — clean
 * up manually if it bothers you.
 */

import { exec } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const SCRIPT_PATH = '/root/backups/run-supabase-backup.sh';

const runbook: Runbook = {
  id:          'snapshot-supabase-backup',
  title:       'Snapshot Supabase backups',
  description: 'Trigger an ad-hoc backup of both Konvo + Crowdfund Supabase DBs (pg_dumpall + storage tarball). Daily cron also runs at 02:30 UTC.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    prompt.note(
      [
        c.brand('Snapshot Supabase backups'),
        '',
        `This runs ${c.dim(SCRIPT_PATH)} on the prod VPS, which:`,
        '',
        '  1. pg_dumpall both Supabase databases (Konvo + Crowdfund)',
        '  2. tar+gzip both storage volumes (MinIO files)',
        '  3. write into /root/backups/supabase/<YYYY-MM-DD>/',
        '  4. uploads off-host if configured (currently local-only)',
        '',
        c.dim('Expected duration: ~10-30 seconds depending on data volume.'),
        c.dim('Disk impact: ~10MB at current scale, grows with table size.')
      ].join('\n'),
      'About'
    );

    const confirmed = await prompt.confirm({
      message: 'Run snapshot now?',
      initialValue: true,
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: 'Dry-run: would have triggered snapshot.',
        details: { script: SCRIPT_PATH, dryRun: true },
      };
    }

    const sp = prompt.spinner();
    sp.start('Running snapshot script...');

    let res: Awaited<ReturnType<typeof exec>>;
    try {
      res = await exec(ctx.config, SCRIPT_PATH);
    } catch (err) {
      sp.stop('Snapshot failed.');
      return {
        success: false,
        summary: err instanceof Error ? err.message.slice(0, 200) : String(err),
      };
    }

    if (res.exitCode !== 0) {
      sp.stop('Snapshot failed.');
      prompt.note(
        [
          c.red(`Exit code: ${res.exitCode}`),
          '',
          c.dim('Stderr (truncated):'),
          res.stderr.slice(0, 600),
          '',
          c.dim('Stdout (truncated):'),
          res.stdout.slice(0, 600),
        ].join('\n'),
        'Failure'
      );
      return {
        success: false,
        summary: `Script exited ${res.exitCode}: ${(res.stderr || res.stdout).split('\n').filter(Boolean).slice(-1)[0] ?? '(no message)'}`,
      };
    }
    sp.stop('Snapshot complete.');

    // Pull the latest log + artifact list.
    const sp2 = prompt.spinner();
    sp2.start('Reading log + artifact list...');
    const logRes = await exec(
      ctx.config,
      `latest=$(ls -t /root/backups/logs/*.log 2>/dev/null | head -1) && \
       cat "$latest" 2>/dev/null && \
       echo --- && \
       ls -lah /root/backups/supabase/$(date -u +%Y-%m-%d) 2>/dev/null`
    );
    sp2.stop('Done.');

    const [logPart, artifactPart] = logRes.stdout.split('---');

    prompt.note(
      [
        c.dim('Log (most recent run):'),
        '',
        (logPart ?? '').trim().split('\n').slice(-12).join('\n'),
      ].join('\n'),
      'Run output'
    );

    prompt.note(
      (artifactPart ?? '').trim() || c.yellow('(no artifacts found — script may have failed silently)'),
      'Artifacts'
    );

    const audit = await writeAudit(ctx.config, {
      runbookId: 'snapshot-supabase-backup',
      action:    'snapshot-triggered',
      target:    `supabase/${new Date().toISOString().slice(0, 10)}`,
      metadata:  {
        scriptPath: SCRIPT_PATH,
        exitCode:   res.exitCode,
      },
      dryRun:    ctx.dryRun,
    });
    if (!audit.ok) {
      prompt.note(
        c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`),
        'Warning'
      );
    }

    return {
      success: true,
      summary: 'Snapshot complete. See log + artifact list above.',
      details: {
        scriptPath: SCRIPT_PATH,
        date:       new Date().toISOString().slice(0, 10),
      },
    };
  },
};

export default runbook;
