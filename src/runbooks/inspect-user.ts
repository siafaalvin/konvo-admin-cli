/**
 * Runbook #3 — Inspect user.
 *
 * Read-only. Prompts for a platform_id OR email, runs queries against
 * PSEUDONYMIZED admin views by default. Real PII (email, address) is
 * only revealed via elevated access which logs the reason to the audit trail.
 *
 * Default view shows:
 *   - platform_id, masked email, masked name, tier, payment status
 *   - Residency zone (e.g. "Zone OR-97003-5D"), status, pass count
 *   - Geofence checks (distance/accuracy, no coordinates)
 *   - Push subscriptions
 *
 * Elevated access (optional): reveals real email + full address after
 * you provide a reason (logged to admin_audit_log).
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'inspect-user',
  title:       'Inspect user',
  description: 'Look up a user by platform ID or email. Shows pseudonymized data by default — real PII requires a reason.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const lookupMethod = await prompt.select({
      message: 'How do you want to find this user?',
      options: [
        { value: 'platform_id', label: 'By platform ID (e.g. hvx_X83AVCXF)' },
        { value: 'email',       label: 'By email address (requires elevated access)' },
      ],
    });
    if (prompt.isCancel(lookupMethod)) return { success: false, summary: 'Cancelled.' };

    let userId: string | null = null;
    let lookupDisplay = '';

    if (lookupMethod === 'platform_id') {
      const pidIn = await prompt.text({
        message: 'Platform ID',
        placeholder: 'hvx_XXXXXXXX',
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return 'Required.';
          if (!/^(hvx_|kvx_)[a-zA-Z0-9]+$/.test(s)) return 'Should start with hvx_ or kvx_';
          return undefined;
        }
      });
      if (prompt.isCancel(pidIn)) return { success: false, summary: 'Cancelled.' };
      const pid = (pidIn as string).trim();
      lookupDisplay = pid;

      // Look up user_id from platform_id
      const lookup = await psqlPiped(ctx.config,
        `SELECT id::text FROM profiles WHERE platform_id = '${pid.replace(/'/g, "''")}' LIMIT 1;`,
        'supabase_admin');
      const match = lookup.stdout.match(/([0-9a-f-]{36})/);
      if (!match) {
        prompt.note(`No user found with platform ID: ${pid}`, 'Not found');
        return { success: true, summary: `User ${pid} not found.` };
      }
      userId = match[1];

    } else {
      // Email lookup requires elevated access — log reason
      const emailIn = await prompt.text({
        message: 'User email',
        placeholder: 'user@example.com',
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return 'Required.';
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Not a valid email.';
          return undefined;
        }
      });
      if (prompt.isCancel(emailIn)) return { success: false, summary: 'Cancelled.' };
      const email = (emailIn as string).trim().toLowerCase();
      lookupDisplay = email;

      const reason = await prompt.text({
        message: 'Why do you need this user\'s data? (logged to audit trail)',
        placeholder: 'e.g. "support ticket #123" or "user reported GPS issue"',
        validate: (v) => (v ?? '').trim().length < 5 ? 'Please provide a brief reason (5+ chars).' : undefined
      });
      if (prompt.isCancel(reason)) return { success: false, summary: 'Cancelled.' };

      const lookup = await psqlPiped(ctx.config,
        `SELECT id::text FROM auth.users WHERE lower(email) = '${email.replace(/'/g, "''")}' LIMIT 1;`,
        'supabase_admin');
      const match = lookup.stdout.match(/([0-9a-f-]{36})/);
      if (!match) {
        prompt.note(`No user found with email: ${email}`, 'Not found');
        return { success: true, summary: `User ${email} not found.` };
      }
      userId = match[1];

      // Log the access
      await psqlPiped(ctx.config,
        `INSERT INTO admin_audit_log (accessor, action, target_user_id, reason)
         VALUES ('konvo-admin-cli', 'inspect_by_email', '${userId}'::uuid, '${(reason as string).replace(/'/g, "''")}');`,
        'supabase_admin');
    }

    // Now query pseudonymized views using the user_id
    const sql = `
\\set QUIET on
\\pset border 1
\\pset format aligned
\\echo SECTION:user
SELECT platform_id, masked_email, masked_name, tier, access_paid_at::date as paid_at,
       access_method, signed_up_at::date, last_sign_in_at::date as last_seen,
       banned_until
FROM admin_users_safe WHERE id = '${userId}';

\\echo SECTION:residency
SELECT zone_id, type, status, is_active, verified_via, verified_at::date,
       requires_document_upload as needs_doc, geofence_v2_pass_count as passes
FROM admin_residencies_safe WHERE platform_id = (SELECT platform_id FROM profiles WHERE id = '${userId}');

\\echo SECTION:geofence_checks
SELECT check_index,
       attempted_at IS NOT NULL as attempted,
       passed,
       round(distance_m::numeric, 0) as dist_m,
       round(accuracy_m::numeric, 0) as acc_m,
       to_char(scheduled_for, 'MM-DD HH24:MI') as scheduled,
       is_mock
FROM admin_geofence_checks_safe
WHERE platform_id = (SELECT platform_id FROM profiles WHERE id = '${userId}')
ORDER BY check_index;

\\echo SECTION:push_subs
SELECT id, created_at::date
FROM push_subscriptions
WHERE user_id = '${userId}'
ORDER BY created_at DESC LIMIT 5;
`;

    const sp = prompt.spinner();
    sp.start(`Looking up ${lookupDisplay}…`);
    const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
    sp.stop('Done.');

    if (res.exitCode !== 0) {
      return {
        success: false,
        summary: `psql error: ${res.stderr.trim().slice(0, 200)}`,
      };
    }

    // Render sections
    const sections = res.stdout.split(/^SECTION:/m).slice(1);
    for (const block of sections) {
      const newlineIdx = block.indexOf('\n');
      const name = block.slice(0, newlineIdx).trim();
      const body = block.slice(newlineIdx + 1).trim();
      const title =
        name === 'user'            ? '👤 User (pseudonymized)' :
        name === 'residency'       ? '🏠 Residency (zone only)' :
        name === 'geofence_checks' ? '📍 Geofence Checks (no coordinates)' :
        name === 'push_subs'       ? '🔔 Push Subscriptions' :
                                     name;
      prompt.note(body || '(no rows)', title);
    }

    // Offer elevated access
    const elevate = await prompt.confirm({
      message: 'Need to see the real email or address? (will be logged)',
      initialValue: false,
    });

    if (elevate) {
      const reason = await prompt.text({
        message: 'Reason for accessing raw PII:',
        placeholder: 'e.g. "verifying address for support ticket"',
        validate: (v) => (v ?? '').trim().length < 5 ? 'Reason required (5+ chars).' : undefined
      });
      if (!prompt.isCancel(reason)) {
        const elevRes = await psqlPiped(ctx.config,
          `SELECT admin_elevated_access(
            '${userId}'::uuid,
            'konvo-admin-cli',
            '${(reason as string).replace(/'/g, "''")}',
            ARRAY['email', 'address', 'name']
          );`,
          'supabase_admin');
        prompt.note(elevRes.stdout.trim(), '🔓 Elevated Access (logged)');
      }
    }

    return {
      success: true,
      summary: `Inspection complete for ${lookupDisplay}.`,
    };
  }
};

export default runbook;
