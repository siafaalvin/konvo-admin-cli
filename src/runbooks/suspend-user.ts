/**
 * Runbook — Suspend or unsuspend a user.
 *
 * HIGH RISK. Blocks the user from logging in. Requires explicit
 * confirmation with a reason. Supports timed suspensions and
 * permanent bans.
 *
 * Written for operators with casual tech skills — prompts use plain
 * language, no jargon.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const DURATIONS = [
  { value: '24h',       label: '24 hours',   ms: 24 * 60 * 60 * 1000 },
  { value: '7d',        label: '7 days',     ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d',       label: '30 days',    ms: 30 * 24 * 60 * 60 * 1000 },
  { value: 'permanent', label: 'Permanent',  ms: null },
] as const;

const runbook: Runbook = {
  id:          'suspend-user',
  title:       'Suspend or unsuspend a user',
  description: 'Temporarily block a user from accessing Konvo. They can\'t log in until unsuspended.',
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

    // 2. Look up user and current ban status
    const sqlEsc = email.replace(/'/g, `''`);
    const lookupSql = `
INSERT INTO admin_audit_log (accessor, action, target_user_id, reason)
SELECT 'konvo-admin-cli:suspend-user', 'email_lookup', au.id, 'suspend/unsuspend user'
FROM auth.users au WHERE lower(au.email) = lower('${sqlEsc}');

\\set QUIET on
\\pset format unaligned
\\pset tuples_only on
SELECT au.id::text || '|' || coalesce(au.banned_until::text, 'none')
FROM auth.users au
WHERE lower(au.email) = '${sqlEsc}';
`;

    const sp = prompt.spinner();
    sp.start('Looking up user…');
    const lookupRes = await psqlPiped(ctx.config, lookupSql);
    sp.stop('Done.');

    if (lookupRes.exitCode !== 0) {
      return { success: false, summary: `Database error: ${lookupRes.stderr.trim().slice(0, 150)}` };
    }

    const row = lookupRes.stdout.trim();
    if (!row) {
      prompt.note(`No account found for ${email}.`, 'Not found');
      return { success: false, summary: `User ${email} not found.` };
    }

    const [userId, bannedUntilRaw] = row.split('|');
    const isBanned = bannedUntilRaw !== 'none';
    const statusText = isBanned
      ? `⛔ Currently SUSPENDED until ${bannedUntilRaw === '9999-12-31 23:59:59+00' ? 'permanently' : bannedUntilRaw}`
      : '✅ Currently active (not suspended)';

    prompt.note(statusText, `User: ${email}`);

    // 3. Ask what to do: suspend or unsuspend
    const action = await prompt.select({
      message: 'What would you like to do?',
      options: [
        { value: 'suspend',   label: '⛔ Suspend this user',   hint: 'Block them from logging in' },
        { value: 'unsuspend', label: '✅ Unsuspend this user', hint: 'Let them log back in' },
      ]
    });
    if (prompt.isCancel(action)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }

    if (action === 'unsuspend') {
      if (!isBanned) {
        prompt.note('This user is already active — nothing to undo.', 'No change');
        return { success: true, summary: `${email} is not suspended.` };
      }

      // Confirm unsuspend
      prompt.note(
        [
          `User:   ${c.brand(email)}`,
          `Action: Remove suspension — user will be able to log in again`,
          '',
          ctx.dryRun ? c.yellow('🔸 Dry-run mode — no changes will be saved.') : ''
        ].filter(Boolean).join('\n'),
        'Preview'
      );

      const confirmed = await prompt.confirm({
        message: `Unsuspend ${email}? They will be able to log in again.`,
        initialValue: false
      });
      if (prompt.isCancel(confirmed) || !confirmed) {
        prompt.cancel('Cancelled — user stays suspended.');
        return { success: false, summary: 'Operator did not confirm.' };
      }

      if (ctx.dryRun) {
        return { success: true, summary: `Dry-run: would unsuspend ${email}.`, details: { email, action: 'unsuspend', dryRun: true } };
      }

      const unsuspendSql = `UPDATE auth.users SET banned_until = NULL WHERE id = '${userId}';\n`;
      const sp2 = prompt.spinner();
      sp2.start('Removing suspension…');
      const res = await psqlPiped(ctx.config, unsuspendSql);
      sp2.stop('Done.');

      if (res.exitCode !== 0) {
        return { success: false, summary: `Failed: ${res.stderr.trim().slice(0, 150)}` };
      }

      await writeAudit(ctx.config, {
        runbookId: 'suspend-user',
        action:    'unsuspend',
        target:    userId!,
        metadata:  { email },
        dryRun:    ctx.dryRun
      });

      return { success: true, summary: `${email} has been unsuspended. They can log in now.`, details: { email, userId, action: 'unsuspend' } };
    }

    // ─── Suspend flow ──────────────────────────────────────────────────

    // 4. Ask for duration
    const duration = await prompt.select({
      message: 'How long should the suspension last?',
      options: DURATIONS.map(d => ({
        value: d.value,
        label: d.label,
        hint: d.value === 'permanent' ? '⚠️  User can NEVER log in until manually unsuspended' : undefined
      }))
    });
    if (prompt.isCancel(duration)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }

    // 5. Ask for reason
    const reasonIn = await prompt.text({
      message: 'Why are you suspending this user? (This is logged for records.)',
      placeholder: 'e.g. Harassment, spam, TOS violation',
      validate: (v) => {
        if (!(v ?? '').trim()) return 'Please provide a reason.';
        return undefined;
      }
    });
    if (prompt.isCancel(reasonIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Cancelled by operator.' };
    }
    const reason = (reasonIn as string).trim();

    // Calculate the timestamp
    const durInfo = DURATIONS.find(d => d.value === duration)!;
    let bannedUntil: string;
    if (durInfo.ms === null) {
      bannedUntil = '9999-12-31 23:59:59+00'; // "permanent"
    } else {
      const until = new Date(Date.now() + durInfo.ms);
      bannedUntil = until.toISOString();
    }

    // 6. Preview + confirm (HIGH RISK)
    prompt.note(
      [
        `⚠️  ${c.red('HIGH RISK ACTION')}`,
        '',
        `User:     ${c.brand(email)}`,
        `Duration: ${durInfo.label}`,
        `Until:    ${durInfo.ms === null ? 'PERMANENT (forever)' : bannedUntil}`,
        `Reason:   ${reason}`,
        '',
        c.red('This user will be immediately locked out of Konvo.'),
        '',
        ctx.dryRun ? c.yellow('🔸 Dry-run mode — no changes will be saved.') : ''
      ].filter(Boolean).join('\n'),
      'Suspension Preview'
    );

    const confirmed = await prompt.confirm({
      message: `Are you sure you want to suspend ${email}?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Cancelled — no suspension applied.');
      return { success: false, summary: 'Operator did not confirm suspension.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would suspend ${email} for ${durInfo.label}.`,
        details: { email, duration: duration, reason, dryRun: true }
      };
    }

    // 7. Apply suspension
    const suspendSql = `UPDATE auth.users SET banned_until = '${bannedUntil}' WHERE id = '${userId}';\n`;

    const sp3 = prompt.spinner();
    sp3.start('Applying suspension…');
    const res = await psqlPiped(ctx.config, suspendSql);
    sp3.stop('Done.');

    if (res.exitCode !== 0) {
      return { success: false, summary: `Failed: ${res.stderr.trim().slice(0, 150)}` };
    }

    await writeAudit(ctx.config, {
      runbookId: 'suspend-user',
      action:    `suspend:${duration}`,
      target:    userId!,
      metadata:  { email, duration, reason, bannedUntil },
      dryRun:    ctx.dryRun
    });

    return {
      success: true,
      summary: `${email} suspended for ${durInfo.label}. Reason: ${reason}`,
      details: { email, userId, duration, bannedUntil, reason }
    };
  }
};

export default runbook;
