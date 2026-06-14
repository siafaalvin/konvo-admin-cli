/**
 * Runbook — sites-and-dashboards.
 *
 * Read-only reference output. Prints the full categorized list of
 * dashboards, web UIs, and API endpoints associated with running the
 * Konvo PWA, with login instructions inline. SSH tunnel commands are
 * surfaced ready-to-copy for services that need them (Coolify).
 *
 * Differs from the existing `open-dashboard` runbook (#10):
 *   - open-dashboard is a one-shot picker that opens the URL.
 *   - sites-and-dashboards is the reference / training view: full
 *     auth instructions, credential locations, tunnel commands.
 *     Optionally lets the operator open one in the browser at the end.
 *
 * No secrets in output — credential locations are pointers (file paths
 * on the VPS, "operator vault", etc.), never values. Operator fetches
 * actual credentials out-of-band (SSH + cat, password manager, etc.).
 *
 * Risk: read-only. Pure print + optional browser open.
 */

import {
  DASHBOARDS,
  dashboardsByCategory,
  findDashboard,
  openInBrowser,
  type AuthInfo,
  type Dashboard
} from '../lib/dashboards.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const CATEGORY_LABEL: Record<Dashboard['category'], string> = {
  app:       'Production app surfaces',
  infra:     'Infrastructure dashboards',
  service:   'External services',
  reference: 'Reference / occasional use'
};

/** Prefix every line of an indented block uniformly. */
function indent(text: string, prefix: string = '    '): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : prefix + line))
    .join('\n');
}

/** Compact one-line label for AuthInfo.method. */
function methodLabel(method: AuthInfo['method']): string {
  switch (method) {
    case 'public':         return c.green('public');
    case 'username/pass':  return c.yellow('username/pass');
    case 'sso':            return c.yellow('SSO');
    case 'api-token':      return c.yellow('API token');
    case 'mfa-portal':     return c.red('MFA-required portal');
  }
}

/** Render a single dashboard entry as multi-line output. */
function renderEntry(d: Dashboard): string {
  const lines: string[] = [];
  lines.push(`${c.brand('●')} ${c.bold(c.white(d.name))}`);
  lines.push(`    ${c.dim('URL')}        ${d.url}`);

  if (d.notes) {
    lines.push(`    ${c.dim('What')}       ${c.body(d.notes)}`);
  }

  if (d.needsTunnel && d.tunnelCommand) {
    lines.push('');
    lines.push(`    ${c.red('SSH tunnel required:')}`);
    lines.push(`      ${c.brand(d.tunnelCommand)}`);
    lines.push(`    ${c.dim('Then visit:')} ${d.url}`);
  }

  if (d.auth) {
    lines.push('');
    lines.push(`    ${c.dim('Auth')}       ${methodLabel(d.auth.method)}`);
    lines.push(`    ${c.dim('How')}        ${c.body(d.auth.description)}`);
    if (d.auth.credentialsLocation) {
      lines.push(`    ${c.dim('Creds at')}   ${c.body(d.auth.credentialsLocation)}`);
    }
  } else {
    lines.push(`    ${c.dim('Auth')}       ${c.dim('(not documented — check with team)')}`);
  }

  return lines.join('\n');
}

const runbook: Runbook = {
  id:          'sites-and-dashboards',
  title:       'Sites & dashboards (reference)',
  description: 'Show every Konvo dashboard / web UI / API endpoint with login instructions + tunnel commands.',
  risk:        'read-only',
  requires:    [],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;
    const grouped = dashboardsByCategory();

    // ── 1. Print the reference table ────────────────────────────
    const sections: string[] = [];
    for (const cat of ['app', 'infra', 'service', 'reference'] as const) {
      const entries = grouped[cat];
      if (entries.length === 0) continue;

      const header = c.bold(c.white(`── ${CATEGORY_LABEL[cat]} ──`));
      const body = entries.map(renderEntry).join('\n\n');
      sections.push(`${header}\n\n${body}`);
    }

    prompt.note(
      sections.join('\n\n\n'),
      'Konvo sites & dashboards — login reference'
    );

    // ── 2. Print the secrets-on-VPS quick reference ──────────────
    prompt.note(
      [
        c.dim('All values mode 600, owned by root. SSH first:'),
        `  ${c.brand('ssh -i ~/.ssh/id_ed25519 root@5.78.237.171')}`,
        '',
        c.dim('Then any of:'),
        `  ${c.body('cat /root/.konvo-prod/<file>.txt')}`,
        '',
        c.dim('Common files:'),
        '    jwt-secret.txt              GoTrue JWT signer',
        '    resend-api-key.txt          Transactional email',
        '    maptiler-key.txt            Worker-side geocoding',
        '    google-ava-key.txt          Address validation',
        '    dispatch-shared-secret.txt  Worker push trigger auth',
        '    stripe-secret-key.txt       Live Stripe ops',
        '    stripe-webhook-secret.txt   Webhook signature verify',
        '    vapid-public-key.txt        Web Push (also in PWA env)',
        '    vapid-private-key.txt       Web Push (worker only)'
      ].join('\n'),
      'Secrets quick reference (VPS paths)'
    );

    // ── 3. Print the SSH tunnel + container quick reference ──────
    prompt.note(
      [
        c.bold(c.white('Coolify dashboard (only tunnel-required service):')),
        `  ${c.brand('ssh -L 8000:localhost:8000 -i ~/.ssh/id_ed25519 root@5.78.237.171')}`,
        `  ${c.dim('# then open')} ${c.body('http://localhost:8000')}`,
        '',
        c.bold(c.white('Direct Postgres (read-only diagnostics):')),
        `  ${c.brand('ssh -i ~/.ssh/id_ed25519 root@5.78.237.171 \\')}`,
        `  ${c.brand('  "docker exec -it $(docker ps --format \'{{.Names}}\' | grep ^supabase-db-) \\')}`,
        `  ${c.brand('   psql -U postgres -d postgres"')}`,
        '',
        c.bold(c.white('Worker logs (real-time tail):')),
        `  ${c.brand('ssh -i ~/.ssh/id_ed25519 root@5.78.237.171 \\')}`,
        `  ${c.brand('  "docker logs -f --tail 50 konvo-worker-prod"')}`,
        '',
        c.dim('For a guided psql session use the open-superuser-psql runbook.'),
        c.dim('For a guided worker tail use the tail-worker-logs runbook.')
      ].join('\n'),
      'Common SSH access patterns'
    );

    // ── 4. Optional follow-up: open one in browser ───────────────
    const followup = await prompt.confirm({
      message: 'Open one of these in your browser now?',
      initialValue: false
    });

    if (prompt.isCancel(followup) || followup === false) {
      return {
        success: true,
        summary: `Printed reference for ${DASHBOARDS.length} dashboards / endpoints.`,
        details: { count: DASHBOARDS.length, opened: null }
      };
    }

    const choice = await prompt.select({
      message: 'Which one?',
      options: DASHBOARDS.map((d) => ({
        value: d.id,
        label: d.name,
        hint:  d.needsTunnel ? '(tunnel required)' : (d.notes ?? '')
      }))
    });

    if (prompt.isCancel(choice)) {
      prompt.cancel('Cancelled.');
      return {
        success: true,
        summary: `Printed reference for ${DASHBOARDS.length} dashboards / endpoints.`,
        details: { count: DASHBOARDS.length, opened: null }
      };
    }

    const target = findDashboard(choice as string);
    if (!target) {
      return {
        success: false,
        summary: `Unknown dashboard id: ${choice}`
      };
    }

    if (target.needsTunnel && target.tunnelCommand) {
      prompt.note(
        [
          `${target.name} requires an SSH tunnel.`,
          '',
          'Run this in a separate terminal:',
          `  ${c.brand(target.tunnelCommand)}`,
          '',
          `Then open: ${target.url}`,
          target.notes ? `\n${target.notes}` : ''
        ].join('\n').trim(),
        target.name
      );
      return {
        success: true,
        summary: `Printed tunnel instructions for ${target.name}.`,
        details: { dashboard: target.id, url: target.url, opened: false }
      };
    }

    const opened = await openInBrowser(target.url);
    if (!opened) {
      prompt.note(`Couldn't auto-open. URL: ${target.url}`, target.name);
    }

    return {
      success: true,
      summary: opened
        ? `Opened ${target.name} in browser.`
        : `Failed to auto-open ${target.name}; URL printed.`,
      details: { dashboard: target.id, url: target.url, opened }
    };
  }
};

// Re-export indent so unit tests (future) can verify formatting.
export { indent };

export default runbook;
