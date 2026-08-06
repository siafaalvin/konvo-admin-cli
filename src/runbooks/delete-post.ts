/**
 * Runbook — Delete a post (soft-delete).
 *
 * Sets deleted_at on a post so it disappears from feeds, but the
 * data stays in the database for auditing. Fully reversible.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'delete-post',
  title:       'Delete a post',
  description: 'Soft-delete a post by its ID. The post won\'t appear in feeds but data is preserved.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Ask for the post ID
    const postIdIn = await prompt.text({
      message: 'What is the post ID? (It looks like a long string of letters and dashes.)',
      placeholder: 'e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Please paste the post ID.';
        // Basic UUID shape check
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
          return 'That doesn\'t look like a valid post ID (should be a UUID like a1b2c3d4-e5f6-...).';
        }
        return undefined;
      }
    });
    if (prompt.isCancel(postIdIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }
    const postId = (postIdIn as string).trim().toLowerCase();

    // 2. Look up the post
    const lookupSql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

INSERT INTO admin_audit_log (accessor, action, target_user_id, reason)
SELECT 'konvo-admin-cli:delete-post', 'email_lookup', posts.author_id, 'delete post'
FROM posts WHERE posts.id = '${postId}';
SELECT
  p.content || '|||' ||
  coalesce(u.username, 'unknown') || '|||' ||
  coalesce(pr.platform_id, 'unknown') || '|||' ||
  to_char(p.created_at, 'YYYY-MM-DD HH24:MI') || '|||' ||
  coalesce(p.deleted_at::text, 'not_deleted')
FROM posts p
LEFT JOIN user_usernames u ON u.id = p.posted_as_username_id
LEFT JOIN profiles pr ON pr.id = p.author_id
WHERE p.id = '${postId}';
`;

    const sp = prompt.spinner();
    sp.start('Finding post…');
    const lookupRes = await psqlPiped(ctx.config, lookupSql);
    sp.stop('Done.');

    if (lookupRes.exitCode !== 0) {
      return { success: false, summary: `Database error: ${lookupRes.stderr.trim().slice(0, 150)}` };
    }

    const row = lookupRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    if (!row) {
      prompt.note('No post found with that ID.', 'Not found');
      return { success: false, summary: `Post ${postId} not found.` };
    }

    const [content, username, authorPlatformId, createdAt, deletedAt] = row.split('|||');

    if (deletedAt !== 'not_deleted') {
      prompt.note(`This post was already deleted on ${deletedAt}.`, 'Already deleted');
      return { success: true, summary: `Post ${postId} is already deleted.` };
    }

    // 3. Show the post and confirm
    const preview = [
      `Post ID:  ${c.dim(postId)}`,
      `Author:   @${username} (${authorPlatformId})`,
      `Posted:   ${createdAt}`,
      '',
      `Content:`,
      c.body(`  "${(content ?? '').slice(0, 300)}${(content ?? '').length > 300 ? '…' : ''}"`),
      '',
      ctx.dryRun ? c.yellow('🔸 Dry-run mode — post will NOT actually be deleted.') : ''
    ].filter(Boolean).join('\n');

    prompt.note(preview, 'Post to delete');

    const confirmed = await prompt.confirm({
      message: 'Delete this post? It will disappear from feeds (data is kept for records).',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Cancelled — post was NOT deleted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would soft-delete post ${postId} by @${username}.`,
        details: { postId, username, authorPlatformId, dryRun: true }
      };
    }

    // 4. Soft-delete
    const deleteSql = `UPDATE posts SET deleted_at = now() WHERE id = '${postId}';\n`;

    const sp2 = prompt.spinner();
    sp2.start('Deleting post…');
    const deleteRes = await psqlPiped(ctx.config, deleteSql);
    sp2.stop('Done.');

    if (deleteRes.exitCode !== 0) {
      return { success: false, summary: `Failed: ${deleteRes.stderr.trim().slice(0, 150)}` };
    }

    await writeAudit(ctx.config, {
      runbookId: 'delete-post',
      action:    'soft-delete',
      target:    postId,
      metadata:  { postId, username, authorPlatformId, contentSnippet: (content ?? '').slice(0, 100) },
      dryRun:    ctx.dryRun
    });

    return {
      success: true,
      summary: `Post by @${username} deleted. It's gone from feeds now.`,
      details: { postId, username, authorPlatformId }
    };
  }
};

export default runbook;
