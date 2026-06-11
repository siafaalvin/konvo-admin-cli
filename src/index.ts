#!/usr/bin/env bun
/**
 * konvo-admin-cli entry point.
 *
 * Boot:
 *   1. Load .env via Bun's automatic loader (no dotenv needed).
 *   2. Compose RunbookContext from config + @clack/prompts + dryRun flag.
 *   3. Show the runbook picker.
 *   4. Dispatch to the chosen runbook's run(ctx).
 *   5. Render summary + exit code.
 *
 * --dry-run flag: appended to argv when set; mutating runbooks branch
 * on ctx.dryRun and skip the actual change.
 */

import * as p from '@clack/prompts';
import { loadConfig } from './lib/config.ts';
import type { Runbook, RunbookContext } from './runbooks/_interface.ts';

// ─── Runbook registry ───────────────────────────────────────────────────────
// New runbooks: `import` them here, push into the array. Order is the
// presentation order in the picker.
import openDashboard from './runbooks/open-dashboard.ts';
import setPostgresGuc from './runbooks/set-postgres-guc.ts';

const RUNBOOKS: Runbook[] = [
  openDashboard,
  setPostgresGuc
];

const RISK_BADGE: Record<Runbook['risk'], string> = {
  'read-only': '·',
  'low':       '!',
  'high':      '!!'
};

async function main(): Promise<number> {
  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');

  p.intro('konvo-admin-cli v0.1.0');

  if (dryRun) {
    p.note('Dry-run mode — mutating runbooks will skip actual changes.', 'Mode');
  }
  p.note(
    [
      `Operator: ${config.operator}`,
      `Prod host: ${config.prodHost}`,
      `SSH key:   ${config.sshKey}`
    ].join('\n'),
    'Config'
  );

  // ─── Pick a runbook ───────────────────────────────────────────────────
  const choice = await p.select({
    message: 'Choose a runbook',
    options: RUNBOOKS.map((r) => ({
      value: r.id,
      label: `${RISK_BADGE[r.risk]}  ${r.title}`,
      hint:  r.description
    }))
  });

  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return 0;
  }

  const runbook = RUNBOOKS.find((r) => r.id === choice);
  if (!runbook) {
    p.outro(`Unknown runbook id: ${choice}`);
    return 1;
  }

  // ─── Dispatch ────────────────────────────────────────────────────────
  const ctx: RunbookContext = { config, prompt: p, dryRun };
  let success = false;
  let summary = 'unknown failure';
  try {
    const res = await runbook.run(ctx);
    success = res.success;
    summary = res.summary;
  } catch (err) {
    success = false;
    summary = err instanceof Error ? err.message : String(err);
  }

  if (success) {
    p.outro(`✓ ${summary}`);
    return 0;
  }
  p.outro(`✗ ${summary}`);
  return 1;
}

const exitCode = await main();
process.exit(exitCode);
