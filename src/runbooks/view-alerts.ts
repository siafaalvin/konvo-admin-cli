/**
 * Runbook — View system alerts.
 *
 * Shows recent alerts from n8n workflow failures and system issues.
 * Can filter by severity and mark alerts as acknowledged.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'view-alerts',
  title:       'View system alerts',
  description: 'See recent system alerts (workflow failures, errors). You can also mark them as "seen".',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const filter = await prompt.select({
      message: 'Which alerts do you want to see?',
      options: [
        { value: 'unread',   label: 'Unread only (not yet seen)' },
        { value: 'all',      label: 'All recent alerts (last 7 days)' },
        { value: 'errors',   label: 'Errors only' },
        { value: 'critical', label: 'Critical only' },
      ],
    });

    if (typeof filter !== 'string') {
      return { ok: false, summary: 'Cancelled.' };
    }

    let whereClause = "created_at > now() - interval '7 days'";
    if (filter === 'unread') whereClause += ' AND acknowledged_at IS NULL';
    if (filter === 'errors') whereClause += " AND severity = 'error'";
    if (filter === 'critical') whereClause += " AND severity = 'critical'";

    const result = await psqlPiped(ctx, `
      SELECT id, severity, source, title,
             to_char(created_at, 'Mon DD HH24:MI') as "when",
             CASE WHEN acknowledged_at IS NOT NULL THEN '✓' ELSE '•' END as status
      FROM public.system_alerts
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT 25;
    `);

    if (!result.stdout?.trim()) {
      return { ok: true, summary: '🎉 No alerts! Everything is running smoothly.' };
    }

    console.log('\n' + result.stdout);

    const markRead = await prompt.confirm({
      message: 'Mark all displayed alerts as seen?',
      initialValue: false,
    });

    if (markRead) {
      await psqlPiped(ctx, `
        UPDATE public.system_alerts
        SET acknowledged_at = now()
        WHERE ${whereClause} AND acknowledged_at IS NULL;
      `);
      return { ok: true, summary: 'Alerts displayed and marked as seen.' };
    }

    return { ok: true, summary: 'Alerts displayed.' };
  },
};

export default runbook;
