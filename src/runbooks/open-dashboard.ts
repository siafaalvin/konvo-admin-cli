/**
 * Runbook #10 — Open dashboard.
 *
 * Multi-select menu over OPS-URLS dashboards, opens whichever the
 * operator picks in the default browser (or prints SSH-tunnel
 * instructions if the dashboard requires one — Coolify is the only
 * such case today).
 *
 * Pure read-only / no mutations / no SSH needed. The simplest runbook
 * in the catalog; serves as the reference shape for future ones.
 */

import { DASHBOARDS, dashboardsByCategory, openInBrowser } from '../lib/dashboards.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'open-dashboard',
  title:       'Open dashboard',
  description: 'Pick a Konvo dashboard (Cloudflare, Coolify, Stripe, Resend, …) and open it in your browser.',
  risk:        'read-only',
  requires:    [],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;
    const grouped = dashboardsByCategory();

    // Build a single flat list with category dividers as disabled
    // hints. @clack/prompts.select doesn't natively support groups but
    // we can fake it with hint labels per option.
    const options: Array<{ value: string; label: string; hint?: string }> = [];
    for (const cat of ['app', 'infra', 'service', 'reference'] as const) {
      const entries = grouped[cat];
      if (entries.length === 0) continue;
      for (const d of entries) {
        options.push({
          value: d.id,
          label: d.name,
          hint:  d.notes ?? undefined
        });
      }
    }

    const choice = await prompt.select({
      message: 'Which dashboard?',
      options
    });

    if (prompt.isCancel(choice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    const target = DASHBOARDS.find((d) => d.id === choice);
    if (!target) {
      // Defensive: shouldn't happen since options came from DASHBOARDS.
      return { success: false, summary: `Unknown dashboard id: ${choice}` };
    }

    if (target.needsTunnel) {
      // Coolify currently — surface the tunnel command instead of opening.
      prompt.note(
        [
          `${target.name} requires an SSH tunnel.`,
          ``,
          `Run this in a separate terminal:`,
          `  ssh -L 8000:localhost:8000 -i ${ctx.config.sshKey} ${ctx.config.prodHost}`,
          ``,
          `Then open:`,
          `  ${target.url}`,
          target.notes ? `\n${target.notes}` : ''
        ].join('\n').trim(),
        target.name
      );
      return {
        success: true,
        summary: `Printed tunnel instructions for ${target.name}.`,
        details: { dashboard: target.id, url: target.url }
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

export default runbook;
