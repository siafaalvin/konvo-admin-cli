/**
 * Runbook #3 — Inspect user.
 *
 * Read-only. Prompts for an email address, runs a multi-table join
 * against prod, and renders the user's full state (auth, profile,
 * residency, geofence-v2 progress, push subscriptions, recent
 * documents). First answer to almost every support ticket:
 *   "I paid but can't get in."
 *   "My location checks aren't passing."
 *   "I'm not receiving notifications."
 *
 * No mutations, no confirmation prompt.
 */

import { psqlPiped } from '../lib/ssh.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'inspect-user',
  title:       'Inspect user',
  description: 'Show profile, residency, geofence-v2 progress, push subs, and recent docs for a user (by email).',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // Prompt for email.
    const emailIn = await prompt.text({
      message: 'User email',
      placeholder: 'user@example.com',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Not a valid email shape.';
        return undefined;
      }
    });
    if (prompt.isCancel(emailIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const email = (emailIn as string).trim().toLowerCase();

    // Single SQL block, multiple result sets. We use `\echo` separators
    // so we can split the stdout cleanly into named sections without
    // building a full structured driver.
    const sqlEsc = email.replace(/'/g, `''`);
    const sql = `
\\set QUIET on
\\pset border 1
\\pset format aligned
\\echo SECTION:auth
select id, email, email_confirmed_at::date as confirmed,
       created_at::date as signed_up,
       last_sign_in_at::date as last_seen
from auth.users
where lower(email) = '${sqlEsc}';

\\echo SECTION:profile
select platform_id,
       display_name,
       access_paid_at is not null as paid,
       access_method,
       playback_autoplay_recordings as autoplay,
       playback_show_indicator      as badge_on
from public.profiles p
where p.id = (select id from auth.users where lower(email) = '${sqlEsc}');

\\echo SECTION:residency
select r.type::text, r.status::text, r.is_active,
       r.verified_via, r.verified_at::date,
       r.requires_document_upload as needs_doc,
       r.geofence_v2_pass_count   as v2_passes,
       a.formatted as address
from public.address_residencies r
left join public.addresses a on a.id = r.address_id
where r.user_id = (select id from auth.users where lower(email) = '${sqlEsc}')
order by r.is_active desc, r.created_at desc;

\\echo SECTION:geofence_checks
select check_index,
       attempted_at is not null as attempted,
       passed,
       round(distance_m::numeric, 0) as dist_m,
       round(accuracy_m::numeric, 0) as acc_m,
       to_char(scheduled_for, 'MM-DD HH24:MI') as scheduled,
       notification_sent_at is not null as notified
from public.residency_geofence_checks
where residency_id in (
  select id from public.address_residencies
  where user_id = (select id from auth.users where lower(email) = '${sqlEsc}')
)
order by check_index;

\\echo SECTION:push_subs
select id, device_label, last_used_at::date, failure_count, created_at::date
from public.push_subscriptions
where user_id = (select id from auth.users where lower(email) = '${sqlEsc}')
order by created_at desc
limit 10;

\\echo SECTION:document_uploads
select id, mime_type, size_bytes,
       review_status, reviewed_at::date, created_at::date
from public.document_uploads
where user_id = (select id from auth.users where lower(email) = '${sqlEsc}')
order by created_at desc
limit 10;
`;

    const sp = prompt.spinner();
    sp.start(`Looking up ${email}…`);
    const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
    sp.stop('Done.');

    if (res.exitCode !== 0) {
      return {
        success: false,
        summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`,
        details: { email, exitCode: res.exitCode }
      };
    }

    // Split stdout by SECTION: marker, render each as a clack note.
    const sections = res.stdout.split(/^SECTION:/m).slice(1);
    let userExists = false;

    for (const block of sections) {
      const newlineIdx = block.indexOf('\n');
      const name = block.slice(0, newlineIdx).trim();
      const body = block.slice(newlineIdx + 1).trim();

      // If the auth block is empty, the user doesn't exist — bail with
      // a friendly message rather than dumping six empty tables.
      if (name === 'auth' && /\(0 rows\)/.test(body)) {
        prompt.note(`No auth.users row found for ${email}.`, 'Not found');
        return {
          success: true,
          summary: `User ${email} doesn't exist on prod.`,
          details: { email, found: false }
        };
      }
      if (name === 'auth') userExists = true;

      const title =
        name === 'auth'              ? 'auth.users' :
        name === 'profile'           ? 'profiles' :
        name === 'residency'         ? 'address_residencies' :
        name === 'geofence_checks'   ? 'residency_geofence_checks' :
        name === 'push_subs'         ? 'push_subscriptions' :
        name === 'document_uploads'  ? 'document_uploads' :
                                       name;

      prompt.note(body || '(no rows)', title);
    }

    return {
      success: true,
      summary: userExists
        ? `Inspection complete for ${email}.`
        : `User ${email} not found.`,
      details: { email, found: userExists }
    };
  }
};

export default runbook;
