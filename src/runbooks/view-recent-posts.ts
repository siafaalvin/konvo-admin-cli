/**
 * Runbook — View recent posts.
 *
 * Read-only. Shows the most recent posts on the platform with
 * author info. Useful for moderation spot-checks and seeing
 * what's being posted.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'view-recent-posts',
  title:       'View recent posts',
  description: 'See the most recent posts on the platform with author info.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Ask how many to show
    const countIn = await prompt.text({
      message: 'How many recent posts would you like to see?',
      placeholder: '10',
      initialValue: '10',
      validate: (v) => {
        const n = parseInt((v ?? '').trim(), 10);
        if (isNaN(n) || n < 1) return 'Enter a number (1 or more).';
        if (n > 50) return 'Maximum is 50 at a time.';
        return undefined;
      }
    });
    if (prompt.isCancel(countIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }
    const count = parseInt((countIn as string).trim(), 10);

    // 2. Fetch posts
    const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on
\\pset fieldsep '|||'
SELECT
  to_char(p.created_at, 'MM/DD HH24:MI') as posted,
  coalesce(u.username, 'unknown') as author,
  coalesce(prof.platform_id, 'unknown') as platform_id,
  left(p.content, 120) as content
FROM posts p
LEFT JOIN user_usernames u ON u.id = p.posted_as_username_id
LEFT JOIN profiles prof ON prof.id = p.author_id
WHERE p.deleted_at IS NULL
ORDER BY p.created_at DESC
LIMIT ${count};
`;

    const sp = prompt.spinner();
    sp.start(`Fetching ${count} most recent posts…`);
    const res = await psqlPiped(ctx.config, sql);
    sp.stop('Done.');

    if (res.exitCode !== 0) {
      return { success: false, summary: `Database error: ${res.stderr.trim().slice(0, 150)}` };
    }

    const rows = res.stdout.trim().split('\n').filter(Boolean);

    if (rows.length === 0) {
      prompt.note('No posts found on the platform yet.', 'Empty');
      return { success: true, summary: 'No posts found.' };
    }

    // 3. Format and display
    const formatted = rows.map((row, i) => {
      const [posted, author, platformId, content] = row.split('|||');
      return [
        `${c.dim(`#${i + 1}`)} ${c.brand(`@${author}`)} ${c.dim(`(${platformId})`)}`,
        `   ${c.dim(posted ?? '')}`,
        `   ${(content ?? '').trim()}`,
        ''
      ].join('\n');
    }).join('\n');

    prompt.note(formatted, `${rows.length} Recent Posts`);

    return {
      success: true,
      summary: `Showing ${rows.length} recent post(s).`,
      details: { count: rows.length }
    };
  }
};

export default runbook;
