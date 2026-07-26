/**
 * Runbook — Review bot reply queue.
 *
 * Shows pending @siafaayye auto-generated replies that are waiting
 * for approval. You can approve them as-is, edit before posting,
 * or reject them entirely.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'review-bot-replies',
  title:       'Review bot replies',
  description: 'Approve, edit, or reject auto-generated @siafaayye replies before they get posted.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // Fetch pending replies
    const sp = prompt.spinner();
    sp.start('Loading pending replies…');
    const res = await psqlPiped(ctx.config, `
      SELECT id, comment_author, left(comment_content, 100) as comment,
             left(generated_reply, 150) as draft_reply, created_at::date
      FROM pending_bot_replies
      WHERE status = 'pending'
      ORDER BY created_at ASC;
    `, 'supabase_admin');
    sp.stop('Done.');

    if (!res.stdout?.trim() || res.stdout.includes('(0 rows)')) {
      prompt.note('🎉 No pending replies — the queue is empty!', 'All clear');
      return { success: true, summary: 'No pending replies to review.' };
    }

    prompt.note(res.stdout.trim(), 'Pending Bot Replies');

    // Get individual replies for review
    const listRes = await psqlPiped(ctx.config, `
      SELECT id::text FROM pending_bot_replies WHERE status = 'pending' ORDER BY created_at ASC;
    `, 'supabase_admin');

    const ids = listRes.stdout.trim().split('\n')
      .map(l => l.trim())
      .filter(l => /^[0-9a-f-]{36}$/.test(l));

    if (ids.length === 0) {
      return { success: true, summary: 'No pending replies.' };
    }

    let approved = 0;
    let rejected = 0;

    for (const pendingId of ids) {
      // Show the full reply detail
      const detail = await psqlPiped(ctx.config, `
        SELECT comment_author, comment_content, generated_reply
        FROM pending_bot_replies WHERE id = '${pendingId}';
      `, 'supabase_admin');

      prompt.note(detail.stdout.trim(), `Reply ${pendingId.substring(0, 8)}`);

      const action = await prompt.select({
        message: 'What do you want to do with this reply?',
        options: [
          { value: 'approve', label: '✅ Approve — post as-is' },
          { value: 'edit',    label: '✏️  Edit — change the text before posting' },
          { value: 'reject',  label: '❌ Reject — don\'t post this reply' },
          { value: 'skip',    label: '⏭️  Skip — decide later' },
        ],
      });

      if (prompt.isCancel(action) || action === 'skip') continue;

      if (action === 'approve') {
        await psqlPiped(ctx.config,
          `SELECT approve_bot_reply('${pendingId}'::uuid, 'admin');`,
          'supabase_admin');
        approved++;
        prompt.note('Posted!', '✅');
      } else if (action === 'edit') {
        const edited = await prompt.text({
          message: 'Enter the edited reply text:',
          placeholder: 'Type the reply you want to post…',
          validate: (v) => (v ?? '').trim().length < 2 ? 'Reply too short.' : undefined
        });
        if (prompt.isCancel(edited)) continue;
        const escapedEdit = (edited as string).replace(/'/g, "''");
        await psqlPiped(ctx.config,
          `SELECT approve_bot_reply('${pendingId}'::uuid, 'admin', '${escapedEdit}');`,
          'supabase_admin');
        approved++;
        prompt.note('Posted (edited)!', '✅');
      } else if (action === 'reject') {
        await psqlPiped(ctx.config,
          `SELECT reject_bot_reply('${pendingId}'::uuid, 'admin');`,
          'supabase_admin');
        rejected++;
        prompt.note('Rejected.', '❌');
      }
    }

    return {
      success: true,
      summary: `Review complete: ${approved} approved, ${rejected} rejected, ${ids.length - approved - rejected} skipped.`,
    };
  },
};

export default runbook;
