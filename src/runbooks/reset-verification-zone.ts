/**
 * Runbook — Reset a user's verification zone.
 *
 * Clears a user's zone status so they can re-verify from a new
 * location. Used when someone moves and needs to reclaim a new
 * address without the old zone interfering.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'reset-verification-zone',
  title:       'Reset a user\'s verification zone',
  description: 'Clear a user\'s zone status so they can re-verify from a new location.',
  risk:        'low',
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

    // 2. Look up user and current zone info
    const sqlEsc = email.replace(/'/g, `''`);
    const lookupSql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

INSERT INTO admin_audit_log (accessor, action, target_user_id, reason)
SELECT 'konvo-admin-cli:reset-verification-zone', 'email_lookup', au.id, 'reset verification zone'
FROM auth.users au WHERE lower(au.email) = lower('${sqlEsc}');
SELECT au.id::text || '|||' ||
       coalesce(p.verification_zone_zip, 'none') || '|||' ||
       coalesce(p.verification_zone_country, 'none') || '|||' ||
       coalesce(p.zone_status, 'none') || '|||' ||
       coalesce(to_char(p.zone_last_checkin_at, 'YYYY-MM-DD HH24:MI'), 'never') || '|||' ||
       coalesce(to_char(p.zone_next_due_at, 'YYYY-MM-DD HH24:MI'), 'none')
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

    const [userId, zip, country, zoneStatus, lastCheckin, nextDue] = row.split('|||');

    // Show current zone info
    const hasZone = zip !== 'none' || zoneStatus !== 'none';
    const zoneLines = [
      `Zip code:      ${zip === 'none' ? 'Not set' : zip}`,
      `Country:       ${country === 'none' ? 'Not set' : country}`,
      `Zone status:   ${zoneStatus === 'none' ? 'Not set' : zoneStatus}`,
      `Last check-in: ${lastCheckin === 'never' ? 'Never' : lastCheckin}`,
      `Next due:      ${nextDue === 'none' ? 'Not scheduled' : nextDue}`,
    ];

    prompt.note(zoneLines.join('\n'), `Zone info for ${email}`);

    if (!hasZone) {
      prompt.note('This user doesn\'t have a zone set — nothing to reset.', 'No zone');
      return { success: true, summary: `${email} has no zone to reset.` };
    }

    // 3. Confirm reset
    prompt.note(
      [
        `This will:`,
        `• Clear the user's zone zip code and country`,
        `• Reset zone status back to "active"`,
        `• Remove check-in schedule`,
        '',
        `After this, the user can start fresh and verify at a new location.`,
        '',
        ctx.dryRun ? c.yellow('🔸 Dry-run mode — no changes will be saved.') : ''
      ].filter(Boolean).join('\n'),
      'What will happen'
    );

    const confirmed = await prompt.confirm({
      message: `Reset ${email}'s verification zone? They'll need to re-verify.`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Cancelled — zone was NOT reset.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would reset verification zone for ${email}.`,
        details: { email, userId, dryRun: true }
      };
    }

    // 4. Apply the reset
    const resetSql = `
UPDATE public.profiles
SET verification_zone_zip = NULL,
    verification_zone_country = NULL,
    zone_status = 'active',
    zone_last_checkin_at = NULL,
    zone_next_due_at = NULL
WHERE id = '${userId}';
`;

    const sp2 = prompt.spinner();
    sp2.start('Resetting zone…');
    const resetRes = await psqlPiped(ctx.config, resetSql);
    sp2.stop('Done.');

    if (resetRes.exitCode !== 0) {
      return { success: false, summary: `Failed: ${resetRes.stderr.trim().slice(0, 150)}` };
    }

    await writeAudit(ctx.config, {
      runbookId: 'reset-verification-zone',
      action:    'zone-reset',
      target:    userId!,
      metadata:  { email, previousZip: zip, previousCountry: country, previousStatus: zoneStatus },
      dryRun:    ctx.dryRun
    });

    // 5. Success
    return {
      success: true,
      summary: `${email}'s verification zone has been cleared. They can now verify a new location.`,
      details: { email, userId, previousZip: zip }
    };
  }
};

export default runbook;
