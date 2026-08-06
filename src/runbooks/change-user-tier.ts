/**
 * Runbook — Change a user's tier.
 *
 * Upgrades or downgrades a user's subscription tier. Non-destructive
 * single-row update with a clear preview before applying.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const TIERS = [
  { value: 'viewer',        label: 'Viewer',              hint: 'Can browse but not post or message' },
  { value: 'voice',         label: 'Voice',               hint: 'Can send messages' },
  { value: 'active_voice',  label: 'Active Voice',        hint: 'Can post and message' },
  { value: 'cardholder',    label: 'Cardholder',          hint: 'Has a CallCard + messaging' },
  { value: 'resident',      label: 'Resident (AV+)',      hint: 'Verified address + full access' },
  { value: 'resident_plus', label: 'Resident+ (Pro Voice)', hint: 'Top tier — all features unlocked' },
] as const;

const runbook: Runbook = {
  id:          'change-user-tier',
  title:       'Change a user\'s tier',
  description: 'Upgrade or downgrade a user\'s subscription tier (e.g. Voice → Active Voice).',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Ask for the user's email
    const emailIn = await prompt.text({
      message: 'What is the user\'s email address?',
      placeholder: 'jane@example.com',
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

    // 2. Look up the user and their current tier
    const sqlEsc = email.replace(/'/g, `''`);
    const lookupSql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

INSERT INTO admin_audit_log (accessor, action, target_user_id, reason)
SELECT 'konvo-admin-cli:change-user-tier', 'email_lookup', au.id, 'tier change'
FROM auth.users au WHERE lower(au.email) = lower('${sqlEsc}');
SELECT coalesce(p.tier, 'none') || '|' || au.id::text
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

    const [currentTier, userId] = row.split('|');
    const currentLabel = TIERS.find(t => t.value === currentTier)?.label ?? currentTier;

    prompt.note(`Current tier: ${c.brand(currentLabel ?? 'none')}`, `User: ${email}`);

    // 3. Ask which tier to set
    const newTier = await prompt.select({
      message: 'Which tier should this user have?',
      options: TIERS.map(t => ({
        value: t.value,
        label: t.label,
        hint: t.hint
      }))
    });
    if (prompt.isCancel(newTier)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }

    const newLabel = TIERS.find(t => t.value === newTier)!.label;

    if (newTier === currentTier) {
      prompt.note('The user is already on that tier — nothing to change.', 'No change');
      return { success: true, summary: `${email} is already on ${newLabel}.` };
    }

    // 4. Show preview and confirm
    prompt.note(
      [
        `User:       ${c.brand(email)}`,
        `Change:     ${currentLabel} → ${c.green(newLabel)}`,
        '',
        ctx.dryRun ? c.yellow('🔸 Dry-run mode — no changes will be saved.') : ''
      ].filter(Boolean).join('\n'),
      'Preview'
    );

    const confirmed = await prompt.confirm({
      message: `Change ${email}'s tier to ${newLabel}?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Change cancelled — nothing was modified.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would change ${email} from ${currentLabel} to ${newLabel}.`,
        details: { email, from: currentTier, to: newTier, dryRun: true }
      };
    }

    // 5. Apply the change
    const updateSql = `UPDATE public.profiles SET tier = '${newTier}', updated_at = now() WHERE id = '${userId}';\n`;

    const sp2 = prompt.spinner();
    sp2.start('Updating tier…');
    const updateRes = await psqlPiped(ctx.config, updateSql);
    sp2.stop('Done.');

    if (updateRes.exitCode !== 0) {
      return { success: false, summary: `Failed to update: ${updateRes.stderr.trim().slice(0, 150)}` };
    }

    // Audit
    await writeAudit(ctx.config, {
      runbookId: 'change-user-tier',
      action:    `tier-changed:${currentTier}->${newTier}`,
      target:    userId!,
      metadata:  { email, from: currentTier, to: newTier },
      dryRun:    ctx.dryRun
    });

    // 6. Success
    return {
      success: true,
      summary: `${email} tier changed: ${currentLabel} → ${newLabel}.`,
      details: { email, userId, from: currentTier, to: newTier }
    };
  }
};

export default runbook;
