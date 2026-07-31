/**
 * Runbook — Review Next Flag (one-command workflow for operators).
 *
 * Pulls the oldest unreviewed flag, shows context, and presents
 * simple yes/no actions. Designed for college student operators
 * who need clear, unambiguous prompts.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'review-next-flag',
  title:       '🚩 Review Next Flag',
  description: 'Pull and review the oldest pending flag — simple yes/no actions.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt, config, dryRun } = ctx;

    // Fetch oldest pending flag with context
    const sp = prompt.spinner();
    sp.start('Fetching next pending flag…');
    const result = await psqlPiped(config, `
      SELECT
        f.id as flag_id,
        f.category,
        f.reason,
        f.created_at,
        flagged_post.content as post_content,
        flagged_post.id as post_id,
        target_profile.platform_id as target_username,
        reporter_profile.platform_id as reporter_username
      FROM content_flags f
      LEFT JOIN posts flagged_post ON flagged_post.id = f.post_id
      LEFT JOIN profiles target_profile ON target_profile.id = f.target_user_id
      LEFT JOIN profiles reporter_profile ON reporter_profile.id = f.reporter_id
      WHERE f.status = 'pending'
      ORDER BY f.created_at ASC
      LIMIT 1;
    `, 'supabase_admin');
    sp.stop('Done.');

    if (!result.stdout.trim() || result.stdout.includes('(0 rows)')) {
      prompt.note('✅ No pending flags! Queue is clear.', '🎉 All clear');
      return { ok: true, summary: 'No pending flags.' };
    }

    // Parse and display
    const lines = result.stdout.trim().split('\n').filter(l => l.includes('|'));
    if (lines.length === 0) {
      prompt.note('✅ No pending flags!', '🎉 All clear');
      return { ok: true, summary: 'No pending flags.' };
    }

    const values = lines[0].split('|').map(v => v.trim());
    const [flagId, category, reason, createdAt, postContent, postId, targetUser, reporterUser] = values;

    prompt.note([
      `📋 Flag ID: ${flagId}`,
      `📁 Category: ${category}`,
      `📝 Reason: ${reason || '(none provided)'}`,
      `🕐 Filed: ${createdAt}`,
      ``,
      `👤 Target: @${targetUser}`,
      `👁️ Reporter: @${reporterUser}`,
      ``,
      `━━━ Post Content ━━━`,
      postContent ? postContent.slice(0, 300) : '(no post attached)',
      postContent && postContent.length > 300 ? '...(truncated)' : ''
    ].join('\n'), '🚩 Flag Details');

    // Simple action menu
    const action = await prompt.select({
      message: 'What action should be taken?',
      options: [
        { value: 'dismiss', label: '✅ Dismiss — flag is invalid or content is fine' },
        { value: 'warn', label: '⚠️ Warn — content borderline, warn the user' },
        { value: 'remove', label: '🗑️ Remove — delete the flagged post' },
        { value: 'suspend', label: '🔴 Suspend — remove post + suspend user' },
        { value: 'skip', label: '⏭️ Skip — come back to this one later' },
      ]
    });

    if (prompt.isCancel(action) || action === 'skip') {
      return { ok: true, summary: 'Skipped flag review.' };
    }

    if (dryRun) {
      prompt.note(`[DRY RUN] Would apply action: ${action} to flag ${flagId}`, '🏷️ Training Mode');
      return { ok: true, summary: `[DRY RUN] Action: ${action}` };
    }

    // Execute action
    sp.start(`Applying action: ${action}…`);

    if (action === 'dismiss') {
      await psqlPiped(config, `
        UPDATE content_flags SET status = 'dismissed', reviewed_at = now() WHERE id = '${flagId}';
      `, 'supabase_admin');
    } else if (action === 'warn') {
      await psqlPiped(config, `
        UPDATE content_flags SET status = 'actioned', reviewed_at = now(), action_taken = 'warning' WHERE id = '${flagId}';
      `, 'supabase_admin');
    } else if (action === 'remove') {
      await psqlPiped(config, `
        UPDATE posts SET deleted_at = now() WHERE id = '${postId}';
        UPDATE content_flags SET status = 'actioned', reviewed_at = now(), action_taken = 'post_removed' WHERE id = '${flagId}';
      `, 'supabase_admin');
    } else if (action === 'suspend') {
      await psqlPiped(config, `
        UPDATE posts SET deleted_at = now() WHERE id = '${postId}';
        UPDATE profiles SET tier = 'viewer', subscription_tier = 'free' WHERE platform_id = '${targetUser}';
        UPDATE content_flags SET status = 'actioned', reviewed_at = now(), action_taken = 'suspended' WHERE id = '${flagId}';
      `, 'supabase_admin');
    }

    sp.stop(`✅ Action applied: ${action}`);
    return { ok: true, summary: `Applied ${action} to flag ${flagId}` };
  }
};

export default runbook;
