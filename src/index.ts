#!/usr/bin/env bun
/**
 * konvo-admin-cli entry point.
 *
 * Boot:
 *   1. Load .env via Bun's automatic loader (no dotenv needed).
 *   2. Print branded wordmark (lib/theme.ts).
 *   3. Compose RunbookContext from config + @clack/prompts + dryRun flag.
 *   4. Show the runbook picker.
 *   5. Dispatch to the chosen runbook's run(ctx).
 *   6. Render summary + exit code.
 *
 * --dry-run flag: appended to argv when set; mutating runbooks branch
 * on ctx.dryRun and skip the actual change.
 */

import * as p from '@clack/prompts';
import { loadConfig } from './lib/config.ts';
import { wordmark, tagline, riskBadge, c } from './lib/theme.ts';
import type { Runbook, RunbookContext } from './runbooks/_interface.ts';

// ─── Runbook registry ───────────────────────────────────────────────────────
// New runbooks: `import` them here, push into the array. Order is the
// presentation order in the picker.
import openDashboard from './runbooks/open-dashboard.ts';
import setPostgresGuc from './runbooks/set-postgres-guc.ts';
import inspectUser from './runbooks/inspect-user.ts';

const RUNBOOKS: Runbook[] = [
  inspectUser,
  setPostgresGuc,
  openDashboard
];

async function main(): Promise<number> {
  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');

  // Branded boot — gradient ASCII wordmark + tagline.
  console.log('\n' + wordmark());
  console.log(tagline() + '\n');

  if (dryRun) {
    p.note(c.yellow('Dry-run mode — mutating runbooks will skip actual changes.'), 'Mode');
  }
  p.note(
    [
      `Operator: ${c.brand(config.operator)}`,
      `Prod host: ${c.body(config.prodHost)}`,
      `SSH key:   ${c.body(config.sshKey)}`
    ].join('\n'),
    'Config'
  );

  // ─── Pick a runbook ───────────────────────────────────────────────────
  const choice = await p.select({
    message: 'Choose a runbook',
    options: RUNBOOKS.map((r) => ({
      value: r.id,
      label: `${riskBadge(r.risk)}  ${c.white(r.title)}`,
      hint:  c.dim(r.description)
    }))
  });

  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return 0;
  }

  const runbook = RUNBOOKS.find((r) => r.id === choice);
  if (!runbook) {
    p.outro(c.red(`Unknown runbook id: ${choice}`));
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
    p.outro(c.green(`✓ ${summary}`));
    return 0;
  }
  p.outro(c.red(`✗ ${summary}`));
  return 1;
}

const exitCode = await main();
process.exit(exitCode);
