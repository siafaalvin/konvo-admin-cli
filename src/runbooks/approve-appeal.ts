/**
 * Runbook — Approve Appeal (one-command workflow for operators).
 *
 * Shows the next pending appeal with context, simple approve/deny.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'approve-appeal',
  title:       '⚖️ Review Next Appeal',
  description: 'Pull and review the oldest pending appeal — approve or deny.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt, config, dryRun } = ctx;

    const sp = prompt.spinner();
    sp.start('Fetching next pending appeal…');
    const result = await psqlPiped(config, `
      SELECT
        a.id as appeal_id,
        a.reason as appeal_reason,
        a.created_at,
        a.original_action,
        p.platform_id as username,
        f.category as flag_category,
        f.reason as flag_reason
      FROM appeals a
      LEFT JOIN profiles p ON p.id = a.user_id
      LEFT JOIN content_flags f ON f.id = a.flag_id
      WHERE a.status = 'pending'
      ORDER BY a.created_at ASC
      LIMIT 1;
    `, 'supabase_admin');
    sp.stop('Done.');

    if (!result.stdout.trim() || result.stdout.includes('(0 rows)')) {
      prompt.note('✅ No pending appeals! Queue is clear.', '🎉 All clear');
      return { success: true, summary: 'No pending appeals.' };
    }

    const lines = result.stdout.trim().split('\n').filter(l => l.includes('|'));
    if (lines.length === 0) {
      prompt.note('✅ No pending appeals!', '🎉 All clear');
      return { success: true, summary: 'No pending appeals.' };
    }

    const values = lines[0].split('|').map(v => v.trim());
    const [appealId, appealReason, createdAt, originalAction, username, flagCategory, flagReason] = values;

    prompt.note([
      `📋 Appeal ID: ${appealId}`,
      `👤 User: @${username}`,
      `🕐 Filed: ${createdAt}`,
      ``,
      `━━━ Original Action ━━━`,
      `Action: ${originalAction}`,
      `Flag category: ${flagCategory}`,
      `Flag reason: ${flagReason || '(none)'}`,
      ``,
      `━━━ Appeal Reason ━━━`,
      appealReason || '(no reason provided)',
    ].join('\n'), '⚖️ Appeal Details');

    const action = await prompt.select({
      message: 'Decision:',
      options: [
        { value: 'approve', label: '✅ Approve — restore the user/content' },
        { value: 'deny', label: '❌ Deny — uphold the original action' },
        { value: 'skip', label: '⏭️ Skip — come back later' },
      ]
    });

    if (prompt.isCancel(action) || action === 'skip') {
      return { success: true, summary: 'Skipped appeal review.' };
    }

    if (dryRun) {
      prompt.note(`[DRY RUN] Would ${action} appeal ${appealId}`, '🏷️ Training Mode');
      return { success: true, summary: `[DRY RUN] Decision: ${action}` };
    }

    sp.start(`Applying decision: ${action}…`);

    if (action === 'approve') {
      await psqlPiped(config, `
        UPDATE appeals SET status = 'approved', reviewed_at = now() WHERE id = '${appealId}';
        -- Restore tier if suspended
        UPDATE profiles SET tier = 'resident' WHERE platform_id = '${username}' AND tier = 'viewer';
      `, 'supabase_admin');
    } else {
      await psqlPiped(config, `
        UPDATE appeals SET status = 'denied', reviewed_at = now() WHERE id = '${appealId}';
      `, 'supabase_admin');
    }

    sp.stop(`✅ Appeal ${action === 'approve' ? 'approved' : 'denied'}.`);
    return { success: true, summary: `Appeal ${appealId}: ${action}` };
  }
};

export default runbook;
