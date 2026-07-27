/**
 * Runbook — Triage (guided entry point).
 *
 * Replaces the flat runbook list with a decision-tree that routes
 * operators to the correct tool based on what they need to do.
 * Shows a dashboard summary on launch.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'triage',
  title:       '🏠 Triage (start here)',
  description: 'Guided entry point — shows dashboard + routes you to the right tool.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // ─── Dashboard ─────────────────────────────────────────────────────
    const sp = prompt.spinner();
    sp.start('Loading dashboard…');
    const dash = await psqlPiped(ctx.config, `
      SELECT
        (SELECT count(*) FROM system_alerts WHERE acknowledged_at IS NULL) as alerts,
        (SELECT count(*) FROM pending_bot_replies WHERE status = 'pending') as bot_reviews,
        (SELECT count(*) FROM address_residencies WHERE status = 'pending'
          AND geofence_v2_started_at < now() - interval '7 days') as stuck_users,
        (SELECT count(*) FROM auth.users WHERE created_at > now() - interval '24 hours') as signups_24h,
        (SELECT count(*) FROM address_residencies WHERE verified_at > now() - interval '24 hours') as verified_24h,
        (SELECT count(*) FROM collective_actions WHERE status = 'active') as active_actions;
    `, 'supabase_admin');
    sp.stop('Done.');

    // Parse dashboard values
    const nums = dash.stdout.match(/\d+/g) ?? ['0','0','0','0','0','0'];
    const [alerts, botReviews, stuckUsers, signups, verified, activeActions] = nums.map(Number);

    prompt.note([
      `  ⚠️  ${alerts} alert${alerts !== 1 ? 's' : ''}    📝 ${botReviews} pending review${botReviews !== 1 ? 's' : ''}    👤 ${stuckUsers} stuck user${stuckUsers !== 1 ? 's' : ''}`,
      `  ⚔️  ${activeActions} active collective action${activeActions !== 1 ? 's' : ''}`,
      ``,
      `  Last 24h: ${signups} signup${signups !== 1 ? 's' : ''}, ${verified} verified`
    ].join('\n'), '📊 Dashboard');

    // ─── Triage menu ───────────────────────────────────────────────────
    const action = await prompt.select({
      message: 'What do you need to do?',
      options: [
        { value: 'help_user',    label: '🆘 Help a user (support issue)' },
        { value: 'review',       label: '📝 Review bot replies' + (botReviews > 0 ? ` (${botReviews})` : '') },
        { value: 'alerts',       label: '⚠️  Check system alerts' + (alerts > 0 ? ` (${alerts})` : '') },
        { value: 'moderation',   label: '🛡️  Content moderation (flags, lists, actions)' },
        { value: 'lookup',       label: '🔍 Look up a user' },
        { value: 'billing',      label: '💳 Billing / payment issue' },
        { value: 'daily',        label: '✅ Daily check-in (guided routine)' },
        { value: 'advanced',     label: '⚙️  Advanced (full runbook list)' },
      ],
    });

    if (typeof action !== 'string') return { success: false, summary: 'Cancelled.' };

    // Route to the appropriate action
    const routes: Record<string, string> = {
      help_user:  'What is the user\'s issue?\n\n• "I paid but can\'t get in" → run: inspect-user → mark-user-paid\n• "My location won\'t verify" → run: inspect-user → verify-address-manually\n• "I\'m not getting notifications" → run: inspect-user (check push_subscriptions)\n• "Someone is harassing me" → run: inspect-user → delete-post → suspend-user',
      review:     'Run: review-bot-replies',
      alerts:     'Run: view-alerts',
      moderation: 'Run: manage-index-lists\nOr: view-recent-posts (check for flagged content)',
      lookup:     'Run: inspect-user',
      billing:    '• User paid but no access → run: mark-user-paid\n• Refund needed → manual Stripe refund (future: process-refund runbook)\n• Crowdfund backer → check crowdfund_emails table',
      daily:      'Daily check-in routine:\n1. check-system-health\n2. view-alerts (acknowledge)\n3. review-bot-replies (approve/reject)\n4. Check stuck users (>7 days pending)',
      advanced:   'Exit triage → use the full runbook picker'
    };

    if (action === 'advanced') {
      return { success: true, summary: 'Returning to full runbook list.' };
    }

    prompt.note(routes[action] ?? 'No route defined.', 'Next steps');

    return { success: true, summary: `Triage: routed to ${action}` };
  },
};

export default runbook;
