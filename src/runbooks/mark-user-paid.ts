/**
 * Runbook — Mark a user as paid (bypass Stripe).
 *
 * HIGH RISK. Grants paid access without a Stripe payment. Used for
 * VIPs, staff, test accounts, and crowdfund backers. Records the
 * reason for audit trail.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const REASONS = [
  { value: 'vip_grant',        label: 'VIP grant',           hint: 'Special access for important users' },
  { value: 'staff_account',    label: 'Staff account',       hint: 'Konvo team member' },
  { value: 'testing',          label: 'Testing',             hint: 'QA / test account' },
  { value: 'crowdfund_backer', label: 'Crowdfund backer',    hint: 'Backed the campaign and earned access' },
  { value: 'other',            label: 'Other',               hint: 'Custom reason (you\'ll type it next)' },
] as const;

const runbook: Runbook = {
  id:          'mark-user-paid',
  title:       'Mark a user as paid (bypass Stripe)',
  description: 'Manually grant paid access to a user without a Stripe payment. Use for VIPs, staff, or test accounts.',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Ask for the user's email
    const emailIn = await prompt.text({
      message: 'What is the user\'s email address?',
      placeholder: 'user@example.com',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Please enter an email address.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'That doesn\'t look like a valid email.';
        return undefined;
      }
    });
    if (prompt.isCancel(emailIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }
    const email = (emailIn as string).trim().toLowerCase();

    // 2. Look up user and current payment status
    const sqlEsc = email.replace(/'/g, `''`);
    const lookupSql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

INSERT INTO admin_audit_log (accessor, action, target_user_id, reason)
SELECT 'konvo-admin-cli:mark-user-paid', 'email_lookup', au.id, 'mark user paid'
FROM auth.users au WHERE lower(au.email) = lower('${sqlEsc}');
SELECT au.id::text || '|||' ||
       coalesce(p.access_paid_at::text, 'not_paid') || '|||' ||
       coalesce(p.access_method, 'none') || '|||' ||
       coalesce(p.tier, 'none')
FROM auth.users au
LEFT JOIN public.profiles p ON p.id = au.id
WHERE lower(au.email) = '${sqlEsc}';
`;

    const sp = prompt.spinner();
    sp.start('Looking up user…');
    const lookupRes = await psqlPiped(ctx.config, lookupSql);
    sp.stop('Done.');

    if (lookupRes.exitCode !== 0) {
      return { success: false, summary: `Database error: ${lookupRes.stderr.trim().slice(0, 150)}` };
    }

    const row = lookupRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    if (!row) {
      prompt.note(`No account found for ${email}.`, 'Not found');
      return { success: false, summary: `User ${email} not found.` };
    }

    const [userId, paidAt, accessMethod, currentTier] = row.split('|||');

    // Show current status
    const isPaid = paidAt !== 'not_paid';
    const statusLines = [
      `Paid:   ${isPaid ? c.green('Yes') + ` (since ${paidAt})` : c.red('No')}`,
      `Method: ${accessMethod === 'none' ? 'N/A' : accessMethod}`,
      `Tier:   ${currentTier === 'none' ? 'N/A' : currentTier}`,
    ];

    if (isPaid) {
      statusLines.push('', c.yellow('⚠️  This user already has paid access.'));
    }

    prompt.note(statusLines.join('\n'), `User: ${email}`);

    // 3. Ask for reason
    const reasonChoice = await prompt.select({
      message: 'Why are you granting paid access?',
      options: REASONS.map(r => ({ value: r.value, label: r.label, hint: r.hint }))
    });
    if (prompt.isCancel(reasonChoice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }

    let reason = reasonChoice as string;
    if (reasonChoice === 'other') {
      const customIn = await prompt.text({
        message: 'Type the reason:',
        placeholder: 'e.g. Contest winner, partner deal',
        validate: (v) => {
          if (!(v ?? '').trim()) return 'Please provide a reason.';
          return undefined;
        }
      });
      if (prompt.isCancel(customIn)) {
        prompt.cancel('Cancelled.');
        return { success: false, summary: 'Cancelled by operator.' };
      }
      reason = (customIn as string).trim();
    }

    // Ask if this is a crowdfund backer (to also insert into crowdfund_emails)
    let addToCrowdfund = false;
    if (reasonChoice === 'crowdfund_backer') {
      addToCrowdfund = true;
    }

    // 4. Preview + confirm (HIGH RISK)
    prompt.note(
      [
        `⚠️  ${c.red('HIGH RISK ACTION')}`,
        '',
        `User:   ${c.brand(email)}`,
        `Action: Grant paid access (bypasses Stripe)`,
        `Tier:   Will be set to "resident"`,
        `Reason: ${reason}`,
        addToCrowdfund ? `Extra:  Will also add to crowdfund_emails table` : '',
        '',
        `This gives the user full paid access without a payment.`,
        '',
        ctx.dryRun ? c.yellow('🔸 Dry-run mode — no changes will be saved.') : ''
      ].filter(Boolean).join('\n'),
      'Payment Grant Preview'
    );

    const confirmed = await prompt.confirm({
      message: `Grant free paid access to ${email}?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Cancelled — no access granted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would grant paid access to ${email} (reason: ${reason}).`,
        details: { email, reason, dryRun: true }
      };
    }

    // 5. Apply the change
    const reasonEsc = reason.replace(/'/g, `''`);
    let updateSql = `
UPDATE public.profiles
SET access_paid_at = now(),
    access_method = 'admin_grant',
    tier = 'resident',
    updated_at = now()
WHERE id = '${userId}';
`;

    if (addToCrowdfund) {
      updateSql += `
INSERT INTO public.crowdfund_emails (email, created_at)
VALUES ('${sqlEsc}', now())
ON CONFLICT (email) DO NOTHING;
`;
    }

    const sp2 = prompt.spinner();
    sp2.start('Granting access…');
    const updateRes = await psqlPiped(ctx.config, updateSql);
    sp2.stop('Done.');

    if (updateRes.exitCode !== 0) {
      return { success: false, summary: `Failed: ${updateRes.stderr.trim().slice(0, 150)}` };
    }

    await writeAudit(ctx.config, {
      runbookId: 'mark-user-paid',
      action:    `admin-grant:${reason}`,
      target:    userId!,
      metadata:  { email, reason, addedToCrowdfund: addToCrowdfund },
      dryRun:    ctx.dryRun
    });

    // 6. Success
    return {
      success: true,
      summary: `${email} now has paid access (reason: ${reason}).${addToCrowdfund ? ' Added to crowdfund_emails.' : ''}`,
      details: { email, userId, reason, addedToCrowdfund: addToCrowdfund }
    };
  }
};

export default runbook;
