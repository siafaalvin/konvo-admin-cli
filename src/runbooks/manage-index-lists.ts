/**
 * Runbook — Manage Index Lists.
 *
 * View, add, remove, and audit terms in the platform's Index Lists.
 * This is the primary tool for managing Tier 2 (context-dependent)
 * terms that are too sensitive for version control.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'manage-index-lists',
  title:       'Manage Index Lists',
  description: 'Add, remove, or view terms in platform Index Lists (content moderation).',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = await prompt.select({
      message: 'What do you want to do?',
      options: [
        { value: 'view',   label: '📋 View all lists and term counts' },
        { value: 'terms',  label: '🔍 View terms in a specific list' },
        { value: 'add',    label: '➕ Add a term to a list' },
        { value: 'remove', label: '➖ Remove a term' },
        { value: 'hits',   label: '📊 View recent hits (what was blocked/flagged)' },
      ],
    });
    if (typeof action !== 'string') return { success: false, summary: 'Cancelled.' };

    const sp = prompt.spinner();

    if (action === 'view') {
      sp.start('Loading lists…');
      const res = await psqlPiped(ctx.config, `
        SELECT l.name, l.type, count(t.id) as terms, l.is_active
        FROM index_lists l
        LEFT JOIN index_list_terms t ON t.list_id = l.id
        GROUP BY l.id ORDER BY l.type, l.name;
      `, 'supabase_admin');
      sp.stop('Done.');
      prompt.note(res.stdout.trim() || '(no lists)', 'Index Lists');
      return { success: true, summary: 'Lists displayed.' };
    }

    if (action === 'terms') {
      const listName = await prompt.text({ message: 'List name (or part of it):' });
      if (typeof listName !== 'string') return { success: false, summary: 'Cancelled.' };
      sp.start('Loading terms…');
      const res = await psqlPiped(ctx.config, `
        SELECT t.term, t.match_type, t.severity, t.context_exempt IS NOT NULL as has_context
        FROM index_list_terms t
        JOIN index_lists l ON l.id = t.list_id
        WHERE l.name ILIKE '%${(listName as string).replace(/'/g, "''")}%'
        ORDER BY t.severity DESC, t.term;
      `, 'supabase_admin');
      sp.stop('Done.');
      prompt.note(res.stdout.trim() || '(no terms)', 'Terms');
      return { success: true, summary: 'Terms displayed.' };
    }

    if (action === 'add') {
      const listType = await prompt.select({
        message: 'Which list?',
        options: [
          { value: 'platform_core', label: 'Platform Core (hard block)' },
          { value: 'platform_soft', label: 'Platform Soft (context-dependent flag)' },
        ],
      });
      if (typeof listType !== 'string') return { success: false, summary: 'Cancelled.' };

      const term = await prompt.text({ message: 'Term to add:', validate: v => (v ?? '').trim() ? undefined : 'Required' });
      if (typeof term !== 'string') return { success: false, summary: 'Cancelled.' };

      const matchType = await prompt.select({
        message: 'Match type:',
        options: [
          { value: 'contains', label: 'Contains (matches anywhere in text)' },
          { value: 'exact',    label: 'Exact (whole word match only)' },
          { value: 'regex',    label: 'Regex pattern' },
        ],
      });

      const severity = await prompt.select({
        message: 'Severity (1=low, 5=critical):',
        options: [
          { value: '1', label: '1 — Low (minor)' },
          { value: '2', label: '2 — Moderate' },
          { value: '3', label: '3 — Significant' },
          { value: '4', label: '4 — High' },
          { value: '5', label: '5 — Critical' },
        ],
      });

      const hasContext = await prompt.confirm({ message: 'Is this term context-dependent (can be dismissed in some situations)?', initialValue: listType === 'platform_soft' });

      let contextJson = 'NULL';
      if (hasContext) {
        const threatCheck = await prompt.confirm({ message: 'Enable threat context check (downgrade if responding to antagonism)?', initialValue: false });
        const inGroups = await prompt.text({ message: 'In-group communities (comma-sep, or leave blank):', placeholder: 'e.g. lgbtq, black' });
        const groups = (inGroups as string || '').split(',').map(g => g.trim()).filter(Boolean);

        const contextObj: Record<string, unknown> = {};
        if (threatCheck) contextObj["threat_context_check"] = true;
        if (groups.length) contextObj["in_group_communities"] = groups;
        if (Object.keys(contextObj).length) {
          contextJson = `'${JSON.stringify(contextObj)}'::jsonb`;
        }
      }

      if (ctx.dryRun) {
        return { success: true, summary: `Dry-run: would add "${(term as string)}" to ${listType} (${(matchType as string)}, severity ${(severity as string)})` };
      }

      sp.start('Adding term…');
      const res = await psqlPiped(ctx.config, `
        INSERT INTO index_list_terms (list_id, term, match_type, severity, context_exempt)
        SELECT l.id, '${(term as string).replace(/'/g, "''")}', '${(matchType as string)}', ${(severity as string)}, ${contextJson}
        FROM index_lists l WHERE l.type = '${listType}' LIMIT 1;
      `, 'supabase_admin');
      sp.stop('Done.');

      if (res.exitCode !== 0) {
        return { success: false, summary: `Failed: ${res.stderr.slice(0, 100)}` };
      }
      return { success: true, summary: `Added "${(term as string)}" to ${listType} list.` };
    }

    if (action === 'remove') {
      const term = await prompt.text({ message: 'Term to remove:', validate: v => (v ?? '').trim() ? undefined : 'Required' });
      if (typeof term !== 'string') return { success: false, summary: 'Cancelled.' };

      sp.start('Removing…');
      await psqlPiped(ctx.config, `
        DELETE FROM index_list_terms WHERE term = '${(term as string).replace(/'/g, "''")}';
      `, 'supabase_admin');
      sp.stop('Done.');
      return { success: true, summary: `Removed "${(term as string)}" from all lists.` };
    }

    if (action === 'hits') {
      sp.start('Loading recent hits…');
      const res = await psqlPiped(ctx.config, `
        SELECT h.action_taken, t.term, left(p.content, 60) as post_content, h.created_at::date
        FROM index_list_hits h
        JOIN index_list_terms t ON t.id = h.term_id
        LEFT JOIN posts p ON p.id = h.post_id
        ORDER BY h.created_at DESC LIMIT 15;
      `, 'supabase_admin');
      sp.stop('Done.');
      prompt.note(res.stdout.trim() || '(no hits yet)', 'Recent Index List Hits');
      return { success: true, summary: 'Hits displayed.' };
    }

    return { success: true, summary: 'Done.' };
  },
};

export default runbook;
