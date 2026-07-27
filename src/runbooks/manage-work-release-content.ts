/**
 * Runbook — Manage Work-Release Content.
 *
 * View, add, deactivate, and audit work-release articles,
 * transcription passages, and quiz questions.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'manage-work-release-content',
  title:       'Manage work-release content',
  description: 'View, add, or deactivate articles, passages, and quiz questions used in Work-Release tasks.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = await prompt.select({
      message: 'What do you want to do?',
      options: [
        { value: 'stats',      label: '📊 View content stats (counts by type + category)' },
        { value: 'list',       label: '📋 List articles by category' },
        { value: 'add',        label: '➕ Add a new article' },
        { value: 'add_quiz',   label: '❓ Add a quiz question to an article' },
        { value: 'add_passage', label: '📝 Add a transcription passage' },
        { value: 'deactivate', label: '🚫 Deactivate content (hide from assignments)' },
        { value: 'preview',    label: '👁️  Preview an article' },
      ],
    });
    if (typeof action !== 'string') return { success: false, summary: 'Cancelled.' };

    const sp = prompt.spinner();

    if (action === 'stats') {
      sp.start('Loading stats…');
      const res = await psqlPiped(ctx.config, `
        SELECT content_type, category, count(*) as items, count(*) FILTER (WHERE is_active) as active
        FROM work_release_content
        GROUP BY content_type, category
        ORDER BY content_type, category;
      `, 'supabase_admin');
      sp.stop('Done.');
      prompt.note(res.stdout.trim() || '(empty)', 'Work-Release Content Stats');
      return { success: true, summary: 'Stats displayed.' };
    }

    if (action === 'list') {
      const category = await prompt.select({
        message: 'Which category?',
        options: [
          { value: 'harassment', label: 'Harassment & Bullying' },
          { value: 'hate_speech', label: 'Hate Speech' },
          { value: 'threats', label: 'Threats & Violence' },
          { value: 'privacy', label: 'Privacy Violation' },
          { value: 'manipulation', label: 'Spam & Manipulation' },
        ],
      });
      if (typeof category !== 'string') return { success: false, summary: 'Cancelled.' };
      sp.start('Loading…');
      const res = await psqlPiped(ctx.config, `
        SELECT left(id::text, 8) as id, title, estimated_minutes as mins, difficulty, is_active
        FROM work_release_content
        WHERE content_type = 'article' AND category = '${category}'
        ORDER BY created_at;
      `, 'supabase_admin');
      sp.stop('Done.');
      prompt.note(res.stdout.trim() || '(none)', `Articles: ${category}`);
      return { success: true, summary: 'Listed.' };
    }

    if (action === 'add') {
      const category = await prompt.select({
        message: 'Category:',
        options: [
          { value: 'harassment', label: 'Harassment' },
          { value: 'hate_speech', label: 'Hate Speech' },
          { value: 'threats', label: 'Threats' },
          { value: 'privacy', label: 'Privacy' },
          { value: 'manipulation', label: 'Manipulation' },
        ],
      });
      const title = await prompt.text({ message: 'Article title:', validate: v => (v ?? '').trim() ? undefined : 'Required' });
      const body = await prompt.text({ message: 'Article body (paste full text):', validate: v => (v ?? '').length > 50 ? undefined : 'Too short (need 50+ chars)' });
      const mins = await prompt.text({ message: 'Estimated reading minutes:', placeholder: '5' });
      const diff = await prompt.select({ message: 'Difficulty:', options: [{ value: '1', label: '1 Easy' }, { value: '2', label: '2 Medium' }, { value: '3', label: '3 Hard' }] });

      if (typeof title !== 'string' || typeof body !== 'string') return { success: false, summary: 'Cancelled.' };

      if (ctx.dryRun) return { success: true, summary: `Dry-run: would add "${title}" to ${category}` };

      sp.start('Adding article…');
      const escaped = (body as string).replace(/'/g, "''");
      const res = await psqlPiped(ctx.config, `
        INSERT INTO work_release_content (content_type, category, title, body, estimated_minutes, difficulty)
        VALUES ('article', '${category}', '${(title as string).replace(/'/g, "''")}', '${escaped}', ${mins || 5}, ${diff});
      `, 'supabase_admin');
      sp.stop('Done.');
      return { success: res.exitCode === 0, summary: res.exitCode === 0 ? `Added "${title}"` : `Error: ${res.stderr.slice(0, 100)}` };
    }

    if (action === 'add_quiz') {
      const articleId = await prompt.text({ message: 'Article ID (first 8 chars or full UUID):', validate: v => (v ?? '').trim() ? undefined : 'Required' });
      const question = await prompt.text({ message: 'Question text:' });
      const optA = await prompt.text({ message: 'Option A:' });
      const optB = await prompt.text({ message: 'Option B:' });
      const optC = await prompt.text({ message: 'Option C:' });
      const optD = await prompt.text({ message: 'Option D:' });
      const correct = await prompt.select({ message: 'Correct answer:', options: [{ value: '0', label: 'A' }, { value: '1', label: 'B' }, { value: '2', label: 'C' }, { value: '3', label: 'D' }] });

      if (typeof question !== 'string') return { success: false, summary: 'Cancelled.' };
      const quizJson = JSON.stringify({ options: [optA, optB, optC, optD], correct: parseInt(correct as string) });

      sp.start('Adding question…');
      const res = await psqlPiped(ctx.config, `
        INSERT INTO work_release_content (content_type, category, title, body, parent_content_id, quiz_options, difficulty)
        SELECT 'quiz_question', wc.category, 'Q', '${(question as string).replace(/'/g, "''")}', wc.id, '${quizJson}'::jsonb, 2
        FROM work_release_content wc WHERE wc.id::text LIKE '${articleId}%' AND wc.content_type = 'article' LIMIT 1;
      `, 'supabase_admin');
      sp.stop('Done.');
      return { success: true, summary: 'Quiz question added.' };
    }

    if (action === 'add_passage') {
      const category = await prompt.select({
        message: 'Offense category this passage addresses:',
        options: [
          { value: 'harassment', label: 'Harassment' },
          { value: 'hate_speech', label: 'Hate Speech' },
          { value: 'threats', label: 'Threats' },
          { value: 'privacy', label: 'Privacy' },
          { value: 'manipulation', label: 'Manipulation' },
        ],
      });
      const title = await prompt.text({ message: 'Passage title/source:' });
      const body = await prompt.text({ message: 'Passage text (200-500 words):' });

      if (typeof title !== 'string' || typeof body !== 'string') return { success: false, summary: 'Cancelled.' };

      sp.start('Adding passage…');
      const res = await psqlPiped(ctx.config, `
        INSERT INTO work_release_content (content_type, category, title, body, estimated_minutes, difficulty)
        VALUES ('transcription_passage', '${category}', '${(title as string).replace(/'/g, "''")}', '${(body as string).replace(/'/g, "''")}', 2, 2);
      `, 'supabase_admin');
      sp.stop('Done.');
      return { success: true, summary: `Passage added: "${title}"` };
    }

    if (action === 'deactivate') {
      const contentId = await prompt.text({ message: 'Content ID to deactivate (first 8 chars or full UUID):' });
      if (typeof contentId !== 'string') return { success: false, summary: 'Cancelled.' };

      sp.start('Deactivating…');
      const res = await psqlPiped(ctx.config, `
        UPDATE work_release_content SET is_active = false WHERE id::text LIKE '${contentId}%';
      `, 'supabase_admin');
      sp.stop('Done.');
      return { success: true, summary: 'Content deactivated.' };
    }

    if (action === 'preview') {
      const contentId = await prompt.text({ message: 'Article ID to preview (first 8 chars):' });
      if (typeof contentId !== 'string') return { success: false, summary: 'Cancelled.' };

      sp.start('Loading…');
      const res = await psqlPiped(ctx.config, `
        SELECT title, category, left(body, 500) as preview, estimated_minutes
        FROM work_release_content WHERE id::text LIKE '${contentId}%' LIMIT 1;
      `, 'supabase_admin');
      sp.stop('Done.');
      prompt.note(res.stdout.trim() || '(not found)', 'Preview');
      return { success: true, summary: 'Previewed.' };
    }

    return { success: true, summary: 'Done.' };
  },
};

export default runbook;
