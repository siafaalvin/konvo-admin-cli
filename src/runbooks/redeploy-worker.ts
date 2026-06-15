/**
 * Runbook — redeploy-worker.
 *
 * Runs the verification-worker deploy script
 * (`coolify/production/05-deploy-worker.sh`) from the operator's local
 * houvox-pwa clone, targeting the production VPS. The script itself
 * handles rsync of source, docker build on the VPS, container swap,
 * and post-deploy smoke tests.
 *
 * Operator-facing wrapper for what was previously:
 *
 *   cd ~/Projects/houvox-pwa
 *   ./coolify/production/05-deploy-worker.sh root@5.78.237.171
 *
 * Adds: git status pre-flight, env summary, deploy spawn with
 * inherited stdio (so the script's progress bars / colors survive),
 * and audit-logging of the resulting commit hash.
 *
 * Risk: high. Production worker swap. ~30s of dropped traffic during
 * container restart (rare 502s on /v1/* endpoints). The script itself
 * is idempotent — on failure the prior container stays running.
 *
 * Use this after:
 *   - Merging a worker-touching PR (route changes, new endpoints)
 *   - Running set-stripe-price-id (so the new env var lands in the
 *     running container)
 *   - Stripe key rotation, GUC changes that worker reads on boot,
 *     etc.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const DEPLOY_SCRIPT_RELATIVE = 'coolify/production/05-deploy-worker.sh';

const runbook: Runbook = {
  id:          'redeploy-worker',
  title:       'Redeploy verification-worker',
  description: 'Run coolify/production/05-deploy-worker.sh from local houvox-pwa clone, targeting prod VPS. Audit-logged.',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt, config } = ctx;

    // ── 1. Locate the deploy script ──────────────────────────────
    if (!config.pwaRepoPath) {
      prompt.note(
        [
          c.red('houvox-pwa repo path is not configured.'),
          ``,
          c.dim('Set KONVO_PWA_REPO_PATH in your .env or shell, e.g.:'),
          c.dim('  export KONVO_PWA_REPO_PATH=/Users/you/Projects/houvox-pwa'),
          ``,
          c.dim('The runbook expects a sibling folder by default (../houvox-pwa),'),
          c.dim('but that wasn\'t found from the current working directory.')
        ].join('\n'),
        'Configuration missing'
      );
      return { success: false, summary: 'KONVO_PWA_REPO_PATH not set and no sibling houvox-pwa folder found.' };
    }

    const scriptPath = join(config.pwaRepoPath, DEPLOY_SCRIPT_RELATIVE);
    if (!existsSync(scriptPath)) {
      return {
        success: false,
        summary: `Deploy script not found at ${scriptPath}.`,
        details: { pwaRepoPath: config.pwaRepoPath, scriptPath }
      };
    }

    // ── 2. Pre-flight git status ────────────────────────────────
    const sp1 = prompt.spinner();
    sp1.start('Checking local git state…');
    const [statusRes, branchRes, hashRes, behindRes] = await Promise.all([
      runLocal(['git', 'status', '--porcelain'], config.pwaRepoPath),
      runLocal(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], config.pwaRepoPath),
      runLocal(['git', 'rev-parse', '--short', 'HEAD'], config.pwaRepoPath),
      runLocal(['git', 'rev-list', '--count', 'HEAD..origin/main'], config.pwaRepoPath)
    ]);
    sp1.stop('Done.');

    const dirty       = (statusRes.stdout?.trim() ?? '') !== '';
    const branch      = branchRes.stdout?.trim() ?? '?';
    const hash        = hashRes.stdout?.trim() ?? '?';
    const behindMain  = parseInt(behindRes.stdout?.trim() ?? '0', 10);

    // Pre-flight hygiene gates. Production deploys MUST come from a
    // clean main checkout — dirty trees + non-main branches caused
    // the 2026-06-15 incident where a chore-branch redeploy clobbered
    // the freshly-merged §3.3 phase-A worker route. Previously these
    // were warnings; now they're hard aborts. behindMain stays as a
    // soft warning since deploying an older HEAD is sometimes a
    // valid rollback.
    const hardBlockers: string[] = [];
    if (branch !== 'main') {
      hardBlockers.push(
        `${c.red('Branch is')} ${c.yellow(branch)}${c.red(', not main.')}`
      );
    }
    if (dirty) {
      hardBlockers.push(
        `${c.red('Working tree is')} ${c.yellow('dirty')}${c.red(' — uncommitted changes would be deployed.')}`
      );
    }

    const softWarnings: string[] = [];
    if (behindMain > 0) {
      softWarnings.push(
        `Local is ${c.yellow(`${behindMain} commit(s) behind`)} origin/main — pull first if you want HEAD.`
      );
    }

    prompt.note(
      [
        `Repo:        ${config.pwaRepoPath}`,
        `Branch:      ${branch}`,
        `HEAD:        ${hash}${dirty ? c.yellow(' (dirty)') : ''}`,
        `Target host: ${config.prodHost}`,
        `Script:      ${DEPLOY_SCRIPT_RELATIVE}`
      ].join('\n'),
      'Deploy plan'
    );

    if (hardBlockers.length > 0) {
      prompt.note(
        [
          ...hardBlockers,
          '',
          c.dim('Production deploys must run from a clean main checkout.'),
          c.dim('Fix locally and re-run:'),
          c.dim('  cd ' + config.pwaRepoPath),
          c.dim('  git stash               # if you have WIP changes'),
          c.dim('  git checkout main'),
          c.dim('  git pull --ff-only'),
          c.dim('  # then re-run this runbook')
        ].join('\n'),
        c.red('✘ Pre-flight failed — refusing to deploy')
      );
      return {
        success: false,
        summary: 'Pre-flight failed: ' + (
          branch !== 'main' && dirty ? 'on non-main branch + dirty tree'
          : branch !== 'main'        ? 'on non-main branch'
          :                            'dirty working tree'
        ),
        details: { branch, dirty, hash, hardBlockers: hardBlockers.length }
      };
    }

    if (softWarnings.length > 0) {
      prompt.note(softWarnings.join('\n'), c.yellow('⚠ Pre-flight warnings'));
    }

    // ── 3. Confirm ──────────────────────────────────────────────
    const confirmed = await prompt.confirm({
      message: `Redeploy verification-worker to ${config.prodHost}? Brief 502s expected during container swap.`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have spawned ${scriptPath} ${config.prodHost}.`,
        details: {
          script:    scriptPath,
          target:    config.prodHost,
          branch,
          hash,
          dirty,
          dryRun:    true
        }
      };
    }

    // ── 4. Spawn the deploy script with inherited stdio ─────────
    // The script prints colored progress (rsync %, docker build steps,
    // smoke-test results). Inheriting stdio keeps that intact.
    prompt.note(c.dim('Spawning deploy script. Output streams below.'), 'Deploying');

    const proc = Bun.spawn({
      cmd:   [scriptPath, config.prodHost],
      cwd:   config.pwaRepoPath,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      env:   { ...process.env, SSH_KEY: config.sshKey }
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const audit = await writeAudit(config, {
        runbookId: 'redeploy-worker',
        action:    'deploy-failed',
        target:    config.prodHost,
        metadata:  { branch, hash, dirty, exit_code: exitCode },
        dryRun:    ctx.dryRun
      });
      if (!audit.ok) {
        prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
      }
      return {
        success: false,
        summary: `Deploy script exited ${exitCode}. Worker may or may not have swapped — check 'restart-service' or smoke-test runbook.`,
        details: { exit_code: exitCode, branch, hash }
      };
    }

    // ── 5. Audit log + final status ─────────────────────────────
    const audit = await writeAudit(config, {
      runbookId: 'redeploy-worker',
      action:    'worker-redeployed',
      target:    config.prodHost,
      metadata:  { branch, hash, dirty },
      dryRun:    ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
    }

    prompt.note(
      [
        c.green('✓ Worker redeployed'),
        ``,
        `Branch ${branch} @ ${hash}`,
        `Target: ${config.prodHost}`,
        ``,
        c.dim('Verify endpoints:'),
        c.dim('  curl -fsS https://worker.thekonvo.com/healthz'),
        c.dim('  Or run smoke-test runbook for the full check.')
      ].join('\n'),
      'Deploy complete'
    );

    return {
      success: true,
      summary: `Worker redeployed (${branch} @ ${hash}) to ${config.prodHost}.`,
      details: { branch, hash, dirty, target: config.prodHost }
    };
  }
};

// ─── helpers ────────────────────────────────────────────────────────────

async function runLocal(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd, cwd,
    stdin:  'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export default runbook;
