/**
 * Runbook — Post as @siafaayye (system/official account).
 *
 * Creates a new post from the official Konvo account. Appears in all
 * users' feeds. Used for announcements, system messages, etc.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'create-system-post',
  title:       'Post as @siafaayye',
  description: 'Create a new post from the official Konvo account. Appears in all users\' feeds.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // First, look up the system account IDs
    const lookupSql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on
SELECT au.id::text || '|||' || u.id::text
FROM auth.users au
JOIN user_usernames u ON u.user_id = au.id AND u.username = 'siafaayye'
WHERE lower(au.email) = 'siafaalvin@gmail.com';
`;

    const sp = prompt.spinner();
    sp.start('Looking up system account…');
    const lookupRes = await psqlPiped(ctx.config, lookupSql);
    sp.stop('Done.');

    if (lookupRes.exitCode !== 0) {
      return { success: false, summary: `Database error: ${lookupRes.stderr.trim().slice(0, 150)}` };
    }

    const ids = lookupRes.stdout.trim();
    if (!ids) {
      return { success: false, summary: 'Could not find the @siafaayye system account in the database.' };
    }

    const [authorId, usernameId] = ids.split('|||');

    // 1. Ask for the post content
    const contentIn = await prompt.text({
      message: 'What should the post say? (Write your message below.)',
      placeholder: 'e.g. Welcome to Konvo! We\'re live.',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'The post can\'t be empty.';
        if (s.length > 2000) return 'Too long — keep it under 2000 characters.';
        return undefined;
      }
    });
    if (prompt.isCancel(contentIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }
    const content = (contentIn as string).trim();

    // 2. Show preview
    prompt.note(
      [
        `From:    @siafaayye (official Konvo account)`,
        `Visible: All users' feeds`,
        '',
        `Message:`,
        `  "${content}"`,
        '',
        ctx.dryRun ? c.yellow('🔸 Dry-run mode — post will NOT actually be created.') : ''
      ].filter(Boolean).join('\n'),
      'Post Preview'
    );

    // 3. Confirm
    const confirmed = await prompt.confirm({
      message: 'Publish this post? Everyone on Konvo will see it.',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Cancelled — nothing was posted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would publish a post as @siafaayye ("${content.slice(0, 60)}…").`,
        details: { content: content.slice(0, 200), dryRun: true }
      };
    }

    // 4. Insert the post
    const contentEsc = content.replace(/'/g, `''`);
    const insertSql = `
INSERT INTO posts (author_id, posted_as_username_id, content, created_at, updated_at)
VALUES ('${authorId}', '${usernameId}', '${contentEsc}', now(), now())
RETURNING id::text;
`;

    const sp2 = prompt.spinner();
    sp2.start('Publishing post…');
    const insertRes = await psqlPiped(ctx.config, insertSql);
    sp2.stop('Done.');

    if (insertRes.exitCode !== 0) {
      return { success: false, summary: `Failed to publish: ${insertRes.stderr.trim().slice(0, 150)}` };
    }

    // Parse the returned post ID
    const newPostId = insertRes.stdout.trim().split('\n').filter(l => l.trim() && !l.startsWith('-') && !l.startsWith('(')).pop()?.trim() ?? 'unknown';

    await writeAudit(ctx.config, {
      runbookId: 'create-system-post',
      action:    'post-created',
      target:    newPostId,
      metadata:  { contentSnippet: content.slice(0, 100) },
      dryRun:    ctx.dryRun
    });

    // 5. Success
    prompt.note(`Post ID: ${c.dim(newPostId)}`, 'Published!');

    return {
      success: true,
      summary: `Post published as @siafaayye (ID: ${newPostId}).`,
      details: { postId: newPostId, content: content.slice(0, 200) }
    };
  }
};

export default runbook;
