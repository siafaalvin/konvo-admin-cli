/**
 * Runbook — Manually verify a user's address.
 *
 * HIGH RISK. Skips the geofence verification process and directly
 * marks a user's pending address residency as active. Use when a
 * user can't complete geofence (device issues, etc.) but you've
 * confirmed they live there.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'verify-address-manually',
  title:       'Manually verify a user\'s address',
  description: 'Skip geofence checks and activate a user\'s address residency directly.',
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

    // 2. Look up user and their pending residencies
    const sqlEsc = email.replace(/'/g, `''`);
    const lookupSql = `
INSERT INTO admin_audit_log (accessor, action, target_user_id, reason)
SELECT 'konvo-admin-cli:verify-address-manually', 'email_lookup', au.id, 'manual address verification'
FROM auth.users au WHERE lower(au.email) = lower('${sqlEsc}');

\\set QUIET on
\\pset format unaligned
\\pset tuples_only on
SELECT au.id::text
FROM auth.users au
WHERE lower(au.email) = '${sqlEsc}';
`;

    const sp = prompt.spinner();
    sp.start('Looking up user…');
    const userRes = await psqlPiped(ctx.config, lookupSql);
    sp.stop('Done.');

    if (userRes.exitCode !== 0) {
      return { success: false, summary: `Database error: ${userRes.stderr.trim().slice(0, 150)}` };
    }

    const userId = userRes.stdout.trim();
    if (!userId) {
      prompt.note(`No account found for ${email}.`, 'Not found');
      return { success: false, summary: `User ${email} not found.` };
    }

    // Check for pending residencies
    const pendingSql = `
\\set QUIET on
\\pset border 1
\\pset format aligned
SELECT r.id::text as residency_id,
       r.status,
       r.type::text as type,
       a.formatted as address,
       r.geofence_v2_pass_count as passes,
       to_char(r.created_at, 'YYYY-MM-DD') as requested
FROM public.address_residencies r
LEFT JOIN public.addresses a ON a.id = r.address_id
WHERE r.user_id = '${userId}'
  AND r.status = 'pending'
ORDER BY r.created_at DESC;
`;

    const sp2 = prompt.spinner();
    sp2.start('Checking for pending address verifications…');
    const pendingRes = await psqlPiped(ctx.config, pendingSql);
    sp2.stop('Done.');

    if (pendingRes.exitCode !== 0) {
      return { success: false, summary: `Database error: ${pendingRes.stderr.trim().slice(0, 150)}` };
    }

    const pendingOutput = pendingRes.stdout.trim();
    if (/\(0 rows\)/.test(pendingOutput) || !pendingOutput) {
      prompt.note(
        `${email} has no pending address verifications.\nThey may have already been verified, or haven't started the process yet.`,
        'Nothing pending'
      );
      return { success: true, summary: `No pending residency for ${email}.` };
    }

    // Show the pending residency info
    prompt.note(pendingOutput, `Pending verifications for ${email}`);

    // 3. Confirm — HIGH RISK
    prompt.note(
      [
        `⚠️  ${c.red('HIGH RISK ACTION')}`,
        '',
        `This will:`,
        `• Mark ALL pending address verifications as "active"`,
        `• Skip the normal geofence check process`,
        `• Record that verification was done by a platform admin`,
        '',
        `Only do this if you have confirmed (via other means) that`,
        `this person actually lives at the address shown above.`,
        '',
        ctx.dryRun ? c.yellow('🔸 Dry-run mode — no changes will be saved.') : ''
      ].filter(Boolean).join('\n'),
      'Warning'
    );

    const confirmed = await prompt.confirm({
      message: `Manually verify ${email}'s address? This skips all geofence checks.`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Cancelled — address NOT verified.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would manually verify address for ${email}.`,
        details: { email, userId, dryRun: true }
      };
    }

    // 4. Apply the verification
    const verifySql = `
UPDATE public.address_residencies
SET status = 'active',
    is_active = true,
    verified_via = 'platform_admin',
    verified_at = now()
WHERE user_id = '${userId}'
  AND status = 'pending';
`;

    const sp3 = prompt.spinner();
    sp3.start('Activating address…');
    const verifyRes = await psqlPiped(ctx.config, verifySql);
    sp3.stop('Done.');

    if (verifyRes.exitCode !== 0) {
      return { success: false, summary: `Failed: ${verifyRes.stderr.trim().slice(0, 150)}` };
    }

    await writeAudit(ctx.config, {
      runbookId: 'verify-address-manually',
      action:    'address-verified-manually',
      target:    userId,
      metadata:  { email },
      dryRun:    ctx.dryRun
    });

    // 5. Success
    return {
      success: true,
      summary: `${email}'s address has been manually verified and activated.`,
      details: { email, userId }
    };
  }
};

export default runbook;
