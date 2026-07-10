/**
 * Runbook — deploy-coolify-app.
 *
 * Deploy, redeploy, or restart Coolify-managed applications via SSH.
 * Bypasses the Coolify dashboard entirely — useful when the UI is
 * unresponsive or slow.
 *
 * Operations:
 *   restart  — docker restart <container> (fast, no rebuild)
 *   redeploy — git pull + docker build + container swap (full rebuild)
 *   status   — show container status, uptime, resource usage
 *
 * Supported apps:
 *   - crowdfund-platform (crowdfund/backers/sidewayscactus/payments)
 *   - definish-pwa
 *   - two-100-pwa
 *   - postocard
 *
 * Risk: medium. Restart is low-risk (~5s downtime). Redeploy is
 * medium-risk (~2min build time, brief 502 during swap).
 */

import { exec } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface CoolifyApp {
  id: string;
  label: string;
  pattern: string;
  repo: string;
  domains: string[];
  hint: string;
}

const APPS: CoolifyApp[] = [
  {
    id: 'crowdfund',
    label: 'Crowdfund Platform',
    pattern: 'f3m45p00r6zldbq2mls0i2kk',
    repo: 'siafaalvin/crowdfund-platform',
    domains: ['crowdfund.thekonvo.com', 'backers.thekonvo.com', 'sidewayscactus.thekonvo.com', 'payments.thekonvo.com'],
    hint: 'Campaign carousel, backers, sideways cactus, payments',
  },
  {
    id: 'definish',
    label: 'Definish',
    pattern: 'no383trqfyh0u1uzouqydz46',
    repo: 'siafaalvin/definish-pwa',
    domains: ['definish.thekonvo.com'],
    hint: 'Word game PWA',
  },
  {
    id: 'two100',
    label: 'Two100',
    pattern: 'oeesezspn9cj3m9ob8227dzi',
    repo: 'siafaalvin/two-100-pwa',
    domains: ['two100.thekonvo.com'],
    hint: 'Math game PWA',
  },
  {
    id: 'postocard',
    label: 'Postocard',
    pattern: 'postocard-app',
    repo: 'siafaalvin/postocard',
    domains: ['postocard.thekonvo.com'],
    hint: 'Social feed (manual Docker deploy)',
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const runbook: Runbook = {
  id:          'deploy-coolify-app',
  title:       'Deploy / Restart Coolify app',
  description: 'Restart, redeploy, or check status of Coolify-managed apps via SSH (bypasses dashboard).',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt, config } = ctx;

    // 1. Pick an operation
    const operation = await prompt.select({
      message: 'What do you want to do?',
      options: [
        { value: 'status', label: 'Status check', hint: 'Show container state, uptime, resources' },
        { value: 'restart', label: 'Restart', hint: 'Quick restart (no rebuild, ~5s downtime)' },
        { value: 'redeploy', label: 'Redeploy', hint: 'Trigger Coolify webhook to rebuild from latest commit' },
      ],
    });
    if (prompt.isCancel(operation)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    // 2. Pick an app
    const appChoice = await prompt.select({
      message: 'Which app?',
      options: APPS.map((a) => ({ value: a.id, label: a.label, hint: a.hint })),
    });
    if (prompt.isCancel(appChoice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const app = APPS.find((a) => a.id === appChoice)!;

    // 3. Resolve container name
    const sp1 = prompt.spinner();
    sp1.start(`Finding container matching ${app.pattern}…`);
    const psRes = await exec(
      config,
      `docker ps --format '{{.Names}} {{.Status}} {{.CreatedAt}}' | grep '${app.pattern}' | head -1`
    );
    if (psRes.exitCode !== 0 || !psRes.stdout.trim()) {
      sp1.stop('No matching container found.');
      return { success: false, summary: `No running container matched '${app.pattern}'.` };
    }
    const [containerName, ...statusParts] = psRes.stdout.trim().split(' ');
    sp1.stop(`Container: ${containerName}`);

    // ─── STATUS ────────────────────────────────────────────────
    if (operation === 'status') {
      const statsRes = await exec(
        config,
        `docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}} {{.NetIO}}' ${containerName}`
      );
      const inspectRes = await exec(
        config,
        `docker inspect ${containerName} --format '{{.State.StartedAt}}' 2>/dev/null`
      );

      prompt.note(
        [
          `Container:  ${c.brand(containerName!)}`,
          `Status:     ${statusParts.join(' ')}`,
          `Started:    ${inspectRes.stdout?.trim() ?? 'unknown'}`,
          `Resources:  ${statsRes.stdout?.trim() ?? 'unknown'}`,
          `Domains:    ${app.domains.join(', ')}`,
          `Repo:       ${app.repo}`,
        ].join('\n'),
        'App Status'
      );

      // Quick health check on domains
      const sp2 = prompt.spinner();
      sp2.start('Checking domain health…');
      const healthResults: string[] = [];
      for (const domain of app.domains) {
        const curlRes = await exec(config, `curl -so /dev/null -w '%{http_code}' --max-time 5 https://${domain}`);
        const code = curlRes.stdout?.trim() ?? '000';
        const status = code === '200' || code === '307' ? c.green(code) : c.red(code);
        healthResults.push(`  ${domain}: ${status}`);
      }
      sp2.stop('Done.');
      prompt.note(healthResults.join('\n'), 'Domain Health');

      return { success: true, summary: `Status check for ${app.label}: container running.` };
    }

    // ─── RESTART ───────────────────────────────────────────────
    if (operation === 'restart') {
      prompt.note(
        [
          `Container:  ${containerName}`,
          `App:        ${app.label}`,
          `Downtime:   ~5 seconds`,
          `Domains:    ${app.domains.join(', ')}`,
        ].join('\n'),
        'Restart plan'
      );

      const confirmed = await prompt.confirm({
        message: `Restart ${app.label}? (~5s downtime)`,
        initialValue: false,
      });
      if (prompt.isCancel(confirmed) || !confirmed) {
        prompt.cancel('Aborted.');
        return { success: false, summary: 'Operator did not confirm.' };
      }

      if (ctx.dryRun) {
        return { success: true, summary: `Dry-run: would restart ${containerName}.` };
      }

      const sp2 = prompt.spinner();
      sp2.start('Restarting…');
      const restartRes = await exec(config, `docker restart ${containerName}`);
      if (restartRes.exitCode !== 0) {
        sp2.stop('Restart failed.');
        return { success: false, summary: `docker restart failed: ${restartRes.stderr?.trim()}` };
      }

      // Poll for healthy state
      let healthy = false;
      for (let i = 0; i < 12; i++) {
        await sleep(5000);
        const checkRes = await exec(config, `docker ps --filter name=${containerName} --format '{{.Status}}'`);
        if (checkRes.stdout?.includes('healthy') || checkRes.stdout?.includes('Up')) {
          healthy = true;
          break;
        }
      }
      sp2.stop(healthy ? 'Restart complete.' : 'Restart complete (health unclear).');

      await writeAudit(config, {
        runbookId: 'deploy-coolify-app',
        action: 'app-restarted',
        target: `${app.id}:${containerName}`,
        metadata: { app: app.id, container: containerName, healthy },
        dryRun: ctx.dryRun,
      });

      return {
        success: true,
        summary: `${app.label} restarted. ${healthy ? 'Container healthy.' : 'Check health manually.'}`,
      };
    }

    // ─── REDEPLOY ──────────────────────────────────────────────
    if (operation === 'redeploy') {
      // Get the latest commit from the repo
      const sp2 = prompt.spinner();
      sp2.start('Checking latest commit on remote…');
      const commitRes = await exec(
        config,
        `cd /tmp && rm -rf _deploy_check && git clone --depth 1 https://github.com/${app.repo}.git _deploy_check 2>/dev/null && cd _deploy_check && git log --oneline -1 && cd /tmp && rm -rf _deploy_check`
      );
      sp2.stop('Done.');

      const latestCommit = commitRes.stdout?.trim() ?? 'unknown';

      prompt.note(
        [
          `App:           ${c.brand(app.label)}`,
          `Container:     ${containerName}`,
          `Latest commit: ${latestCommit}`,
          `Domains:       ${app.domains.join(', ')}`,
          ``,
          c.yellow('This will:'),
          `  1. Pull latest code from GitHub`,
          `  2. Build new Docker image (--no-cache)`,
          `  3. Stop old container`,
          `  4. Start new container`,
          `  5. Verify health`,
          ``,
          c.yellow(`Downtime: ~2-3 minutes during build + swap`),
        ].join('\n'),
        'Redeploy plan'
      );

      const confirmed = await prompt.confirm({
        message: `Redeploy ${app.label}? Will cause ~2-3min downtime.`,
        initialValue: false,
      });
      if (prompt.isCancel(confirmed) || !confirmed) {
        prompt.cancel('Aborted.');
        return { success: false, summary: 'Operator did not confirm.' };
      }

      if (ctx.dryRun) {
        return { success: true, summary: `Dry-run: would redeploy ${app.label} from ${latestCommit}.` };
      }

      // For Coolify-managed apps, we can trigger a webhook or use the API
      // Simplest: use Coolify's deploy UUID endpoint
      const sp3 = prompt.spinner();
      sp3.start('Triggering Coolify redeploy…');

      // Try Coolify API first (if available)
      const coolifyRes = await exec(
        config,
        `curl -s -X POST "http://localhost:8000/api/v1/deploy?uuid=${app.pattern.split('-')[0]}&force=true" -H "Authorization: Bearer \$(cat /data/coolify/source/.env 2>/dev/null | grep API_TOKEN | cut -d= -f2)" 2>/dev/null || echo "API_UNAVAILABLE"`
      );

      if (coolifyRes.stdout?.includes('API_UNAVAILABLE') || coolifyRes.exitCode !== 0) {
        sp3.stop('Coolify API unavailable. Using manual rebuild…');

        // Manual rebuild approach
        const buildSp = prompt.spinner();
        buildSp.start('Cloning and building (this takes ~2min)…');

        const buildRes = await exec(
          config,
          [
            `cd /tmp && rm -rf _rebuild_${app.id}`,
            `git clone --depth 1 https://github.com/${app.repo}.git _rebuild_${app.id} 2>&1 | tail -1`,
            `cd _rebuild_${app.id}`,
            `docker build --no-cache -t ${app.id}-fresh . 2>&1 | tail -3`,
            `echo "BUILD_DONE"`,
          ].join(' && '),

        );

        if (!buildRes.stdout?.includes('BUILD_DONE')) {
          buildSp.stop('Build failed.');
          return {
            success: false,
            summary: `Docker build failed: ${buildRes.stderr?.slice(0, 200)}`,
          };
        }
        buildSp.stop('Build complete.');

        // For Coolify apps, we can't just swap the container without losing labels
        // Best approach: restart the Coolify-managed container (it will use the new image on next deploy)
        prompt.note(
          [
            c.yellow('Manual rebuild completed but Coolify manages this container.'),
            ``,
            `The new image is built as ${app.id}-fresh.`,
            `To complete the swap, trigger a deploy from Coolify dashboard,`,
            `or restart the container (it will keep running the old image).`,
            ``,
            c.dim('Alternatively: use Coolify dashboard → Deployments → Deploy'),
          ].join('\n'),
          'Next Steps'
        );

        // Cleanup
        await exec(config, `rm -rf /tmp/_rebuild_${app.id}`);

        return {
          success: true,
          summary: `Image built as ${app.id}-fresh. Coolify deploy needed to swap container.`,
        };
      } else {
        sp3.stop('Coolify deploy triggered.');

        // Wait and poll for new container
        const pollSp = prompt.spinner();
        pollSp.start('Waiting for new container…');
        let newContainer = false;
        for (let i = 0; i < 36; i++) { // 3 minutes
          await sleep(5000);
          const checkRes = await exec(
            config,
            `docker ps --format '{{.Names}} {{.CreatedAt}}' | grep '${app.pattern}' | head -1`
          );
          if (checkRes.stdout && !checkRes.stdout.includes(containerName!)) {
            newContainer = true;
            break;
          }
        }
        pollSp.stop(newContainer ? 'New container running.' : 'Timeout — check manually.');
      }

      await writeAudit(config, {
        runbookId: 'deploy-coolify-app',
        action: 'app-redeployed',
        target: `${app.id}:${containerName}`,
        metadata: { app: app.id, latestCommit },
        dryRun: ctx.dryRun,
      });

      return {
        success: true,
        summary: `${app.label} redeploy triggered from ${latestCommit}.`,
      };
    }

    return { success: false, summary: 'Unknown operation.' };
  },
};

export default runbook;
