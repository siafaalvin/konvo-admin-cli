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
import tailWorkerLogs from './runbooks/tail-worker-logs.ts';
import smokeTest from './runbooks/smoke-test.ts';
import restartService from './runbooks/restart-service.ts';
import confirmStuckUser from './runbooks/confirm-stuck-user.ts';
import bulkInsertCrowdfund from './runbooks/bulk-insert-crowdfund.ts';
import applyPhaseDConfig from './runbooks/apply-phase-d-config.ts';
import refundRevoke from './runbooks/refund-revoke.ts';
import rotateStripeKeys from './runbooks/rotate-stripe-keys.ts';
import openSuperuserPsql from './runbooks/open-superuser-psql.ts';
import inspectDatabaseGucs from './runbooks/inspect-database-gucs.ts';
import verifyWorkerEnv from './runbooks/verify-worker-env.ts';
import diagnoseRolePermissions from './runbooks/diagnose-role-permissions.ts';
import applyMigration from './runbooks/apply-migration.ts';
import applySearchOptimization from './runbooks/apply-search-optimization.ts';
import testWorkerDispatch from './runbooks/test-worker-dispatch.ts';
import syncStripeCatalog from './runbooks/sync-stripe-catalog.ts';
import manageAdminGrants from './runbooks/manage-admin-grants.ts';
import runSignupLoadTest from './runbooks/run-signup-load-test.ts';
import toggleWaitlist from './runbooks/toggle-waitlist.ts';
import issuePunitiveAction from './runbooks/issue-punitive-action.ts';
import manageBuildingHolds from './runbooks/manage-building-holds.ts';
import manageBannedTerms from './runbooks/manage-banned-terms.ts';
import reviewFlaggedPlateMessages from './runbooks/review-flagged-plate-messages.ts';
import setStripePriceId from './runbooks/set-stripe-price-id.ts';
import redeployWorker from './runbooks/redeploy-worker.ts';
import sitesAndDashboards from './runbooks/sites-and-dashboards.ts';
import resetUserPassword from './runbooks/reset-user-password.ts';
import snapshotSupabaseBackup from './runbooks/snapshot-supabase-backup.ts';
import deployCoolifyApp from './runbooks/deploy-coolify-app.ts';
import bulkAddUserGrants from './runbooks/bulk-add-user-grants.ts';
import bulkSendReceipts from './runbooks/bulk-send-receipts.ts';
import devServers from './runbooks/dev-servers.ts';
import changeUserTier from './runbooks/change-user-tier.ts';
import suspendUser from './runbooks/suspend-user.ts';
import deletePost from './runbooks/delete-post.ts';
import createSystemPost from './runbooks/create-system-post.ts';
import verifyAddressManually from './runbooks/verify-address-manually.ts';
import checkSystemHealth from './runbooks/check-system-health.ts';
import markUserPaid from './runbooks/mark-user-paid.ts';
import viewRecentPosts from './runbooks/view-recent-posts.ts';
import resetVerificationZone from './runbooks/reset-verification-zone.ts';
import viewAlerts from './runbooks/view-alerts.ts';
import triage from './runbooks/triage.ts';
import sendEmailTemplate from './runbooks/send-email-template.ts';
import reviewBotReplies from './runbooks/review-bot-replies.ts';
import manageIndexLists from './runbooks/manage-index-lists.ts';
import manageWorkReleaseContent from './runbooks/manage-work-release-content.ts';
import reviewNextFlag from './runbooks/review-next-flag.ts';
import approveAppeal from './runbooks/approve-appeal.ts';

const RUNBOOKS: Runbook[] = [
  triage,
  reviewNextFlag,
  approveAppeal,
  checkSystemHealth,
  viewAlerts,
  reviewBotReplies,
  manageIndexLists,
  manageWorkReleaseContent,
  sendEmailTemplate,
  smokeTest,
  viewRecentPosts,
  inspectUser,
  changeUserTier,
  suspendUser,
  markUserPaid,
  verifyAddressManually,
  resetVerificationZone,
  deletePost,
  createSystemPost,
  applySearchOptimization,
  confirmStuckUser,
  manageAdminGrants,
  bulkAddUserGrants,
  bulkSendReceipts,
  resetUserPassword,
  manageBuildingHolds,
  manageBannedTerms,
  reviewFlaggedPlateMessages,
  toggleWaitlist,
  issuePunitiveAction,
  setStripePriceId,
  redeployWorker,
  deployCoolifyApp,
  snapshotSupabaseBackup,
  tailWorkerLogs,
  restartService,
  bulkInsertCrowdfund,
  applyPhaseDConfig,
  refundRevoke,
  rotateStripeKeys,
  syncStripeCatalog,
  runSignupLoadTest,
  setPostgresGuc,
  inspectDatabaseGucs,
  verifyWorkerEnv,
  testWorkerDispatch,
  diagnoseRolePermissions,
  applyMigration,
  openSuperuserPsql,
  openDashboard,
  sitesAndDashboards,
  devServers
];

async function main(): Promise<number> {
  const config = loadConfig();
  const dryRun = process.argv.includes('--dry-run');

  // Branded boot — gradient ASCII wordmark + tagline. Printed once,
  // not on every loop iteration.
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

  const ctx: RunbookContext = { config, prompt: p, dryRun };
  let lastExitCode = 0;

  // ─── Menu loop ────────────────────────────────────────────────────────
  // Stays inside the picker until the operator chooses "Exit" or
  // cancels at the menu level (Ctrl+C / Esc on the picker itself).
  // Cancelling INSIDE a runbook just returns to this menu.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const choice = await p.select({
      message: 'Choose a runbook',
      options: [
        ...RUNBOOKS.map((r) => ({
          value: r.id,
          label: `${riskBadge(r.risk)}  ${c.white(r.title)}`,
          hint:  c.dim(r.description)
        })),
        {
          value: '__exit',
          label: c.dim('Exit'),
          hint:  c.dim('Quit konvo-admin-cli')
        }
      ]
    });

    if (p.isCancel(choice) || choice === '__exit') {
      p.outro(c.dim('Bye.'));
      return lastExitCode;
    }

    const runbook = RUNBOOKS.find((r) => r.id === choice);
    if (!runbook) {
      p.note(c.red(`Unknown runbook id: ${choice}`), 'Error');
      lastExitCode = 1;
      continue;
    }

    // ─── Dispatch ────────────────────────────────────────────────────
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

    // Inline summary so we stay in the loop. Don't call p.outro here —
    // outro closes the prompt session and we want to keep going.
    if (success) {
      p.note(c.green(`✓ ${summary}`), 'Result');
    } else {
      p.note(c.red(`✗ ${summary}`), 'Result');
      lastExitCode = 1;
    }
  }
}

const exitCode = await main();
process.exit(exitCode);
