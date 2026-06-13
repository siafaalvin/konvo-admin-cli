/**
 * Runbook — manage-admin-grants.
 *
 * CRUD operations for the public.admin_grants allowlist (introduced in
 * houvox-pwa migration 0034). Each entry pre-grants a specific tier +
 * pricing band + seed geofence passes to a future signup, so when that
 * email completes auth signup, handle_new_user auto-promotes them.
 *
 * Operations:
 *   list    — show all active (unredeemed) + recent redeemed grants
 *   add     — create a new grant (or update if email already exists)
 *   inspect — show full state of a single grant by email
 *   revoke  — delete a grant (only effective before redemption — once
 *             a user signs up the grant is consumed and revoking it
 *             doesn't downgrade them)
 *
 * Risk: low. Single-row mutations on a small allowlist. Each action
 * audit-logged. Operator confirms each mutation explicitly.
 *
 * This runbook replaces the manual SSH+psql flow we used for the
 * josh@joshstanford.com + daunwilliamswrites@gmail.com grants.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface Grant {
  email:                string;
  tier_grant:           'standard' | 'resident' | 'resident_plus';
  pricing_band_grant:   'campaign' | 'standard';
  seed_geofence_passes: number;
  granted_by:           string;
  notes:                string | null;
  created_at:           string;
  redeemed_at:          string | null;
  redeemed_by:          string | null;
}

const TIER_OPTIONS = [
  { value: 'standard',       label: 'Standard',       hint: '$1 floor — basic access' },
  { value: 'resident',       label: 'Resident',       hint: 'Location-bound chat + neighborhood' },
  { value: 'resident_plus',  label: 'Resident+',      hint: 'Premium — proximity contact + low point cost' }
] as const;

const BAND_OPTIONS = [
  { value: 'standard', label: 'Standard pricing', hint: 'Full Resident+ value, no campaign discount' },
  { value: 'campaign', label: 'Campaign pricing', hint: 'Discounted lifetime ($1 / $2 tiers)' }
] as const;

const ACTION_OPTIONS = [
  { value: 'list',    label: 'List grants',                hint: 'Show all active + recent redeemed' },
  { value: 'add',     label: 'Add or update a grant',      hint: 'Create new VIP grant by email' },
  { value: 'inspect', label: 'Inspect a single grant',     hint: 'Look up by email' },
  { value: 'revoke',  label: 'Revoke a grant',             hint: 'Delete by email (pre-signup only)' },
  { value: '__exit',  label: c.dim('Cancel'),              hint: c.dim('Return to main menu') }
] as const;

const runbook: Runbook = {
  id:          'manage-admin-grants',
  title:       'Manage admin grants',
  description: 'CRUD for public.admin_grants — VIP / friend-of-Konvo / partnership tier overrides. Audit-logged.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = await prompt.select({
      message: 'What would you like to do?',
      options: [...ACTION_OPTIONS]
    });
    if (prompt.isCancel(action) || action === '__exit') {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    switch (action) {
      case 'list':    return listGrants(ctx);
      case 'add':     return addOrUpdateGrant(ctx);
      case 'inspect': return inspectGrant(ctx);
      case 'revoke':  return revokeGrant(ctx);
      default:        return { success: false, summary: `Unknown action: ${action as string}` };
    }
  }
};

async function listGrants(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

select email || E'\\x1f' ||
       tier_grant || E'\\x1f' ||
       pricing_band_grant || E'\\x1f' ||
       seed_geofence_passes::text || E'\\x1f' ||
       granted_by || E'\\x1f' ||
       coalesce(redeemed_at::text, '') || E'\\x1f' ||
       to_char(created_at, 'YYYY-MM-DD HH24:MI')
from public.admin_grants
order by redeemed_at nulls first, created_at desc
limit 50;
`;
  const sp = prompt.spinner();
  sp.start('Reading admin_grants…');
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  sp.stop('Done.');
  if (res.exitCode !== 0) {
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
  }

  const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    prompt.note(c.dim('No admin grants on prod.'), 'Empty');
    return { success: true, summary: 'admin_grants is empty.' };
  }

  const rendered = lines.map((line) => {
    const [email, tier, band, seed, by, redeemed, created] = line.split('\x1f');
    const redeemedMark = redeemed
      ? c.dim(`redeemed ${redeemed?.slice(0, 10) ?? ''}`)
      : c.green('active');
    return `  ${redeemedMark.padEnd(28)} ${email?.padEnd(36) ?? ''} ${(tier ?? '').padEnd(14)} ${(band ?? '').padEnd(10)} seed=${seed ?? '?'}  ${c.dim(`by ${by} on ${created}`)}`;
  }).join('\n');

  prompt.note(rendered, `${lines.length} grant(s)`);
  return { success: true, summary: `Listed ${lines.length} admin grant(s).` };
}

async function addOrUpdateGrant(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;

  const emailIn = await prompt.text({
    message: 'Email to grant',
    placeholder: 'friend@example.com',
    validate: (v) => {
      const s = (v ?? '').trim();
      if (!s) return 'Required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Not a valid email.';
      return undefined;
    }
  });
  if (prompt.isCancel(emailIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const email = (emailIn as string).trim().toLowerCase();

  // Check for existing grant first.
  const existing = await fetchGrant(ctx, email);
  if (existing && existing.redeemed_at) {
    prompt.note(
      c.yellow(`A grant for ${email} was already redeemed on ${existing.redeemed_at}. Adding a new grant won't downgrade the existing user.`),
      'Already redeemed'
    );
    const cont = await prompt.confirm({ message: 'Continue anyway?', initialValue: false });
    if (prompt.isCancel(cont) || !cont) {
      return { success: false, summary: 'Operator cancelled (already redeemed).' };
    }
  }
  if (existing && !existing.redeemed_at) {
    prompt.note(
      [
        `Existing unredeemed grant for ${email}:`,
        `  tier:        ${existing.tier_grant}`,
        `  band:        ${existing.pricing_band_grant}`,
        `  seed_passes: ${existing.seed_geofence_passes}`,
        `  granted_by:  ${existing.granted_by}`,
        `  notes:       ${existing.notes ?? '(none)'}`
      ].join('\n'),
      'Existing grant'
    );
  }

  const tier = await prompt.select({
    message: 'Tier',
    options: [...TIER_OPTIONS],
    initialValue: existing?.tier_grant ?? 'resident_plus'
  });
  if (prompt.isCancel(tier)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

  const band = await prompt.select({
    message: 'Pricing band',
    options: [...BAND_OPTIONS],
    initialValue: existing?.pricing_band_grant ?? 'standard'
  });
  if (prompt.isCancel(band)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

  const seedIn = await prompt.text({
    message: 'Seed geofence passes (0-3)',
    placeholder: '2',
    initialValue: String(existing?.seed_geofence_passes ?? 2),
    validate: (v) => {
      const n = parseInt((v ?? '').trim(), 10);
      if (!Number.isFinite(n) || n < 0 || n > 3) return 'Must be 0, 1, 2, or 3.';
      return undefined;
    }
  });
  if (prompt.isCancel(seedIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const seed = parseInt((seedIn as string).trim(), 10);

  const notesIn = await prompt.text({
    message: 'Notes (optional)',
    placeholder: 'Friend of Konvo. Resident+ + access bypass.',
    initialValue: existing?.notes ?? ''
  });
  if (prompt.isCancel(notesIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const notes = (notesIn as string).trim() || null;

  const seedExplain =
    seed === 0 ? '0 — normal verification (3-of-5 floor unchanged)' :
    seed === 1 ? '1 — needs 2 real passes for activation' :
    seed === 2 ? '2 — only 1 real pass needed for activation' :
                 '3 — any single attempt activates immediately';

  prompt.note(
    [
      `Email:       ${c.brand(email)}`,
      `Tier:        ${c.brand(tier as string)}`,
      `Band:        ${c.brand(band as string)}`,
      `Seed passes: ${c.brand(String(seed))} (${c.dim(seedExplain)})`,
      `Granted by:  ${c.brand(ctx.config.operator)}`,
      `Notes:       ${c.dim(notes ?? '(none)')}`,
      '',
      ctx.dryRun ? c.yellow('(dry-run — no changes will be applied)') : ''
    ].filter(Boolean).join('\n'),
    existing && !existing.redeemed_at ? 'Update preview' : 'Create preview'
  );

  const confirmed = await prompt.confirm({
    message: `${existing && !existing.redeemed_at ? 'Update' : 'Create'} this grant?`,
    initialValue: false
  });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (ctx.dryRun) {
    return {
      success: true,
      summary: `Dry-run: would have ${existing ? 'updated' : 'created'} grant for ${email}.`,
      details: { email, tier, band, seed, dryRun: true }
    };
  }

  const sqlEsc = (s: string): string => s.replace(/'/g, `''`);
  const grantedBy = ctx.config.operator;
  const sql = `
insert into public.admin_grants (email, tier_grant, pricing_band_grant, seed_geofence_passes, granted_by, notes)
values ('${sqlEsc(email)}', '${sqlEsc(tier as string)}', '${sqlEsc(band as string)}', ${seed}, '${sqlEsc(grantedBy)}', ${notes ? `'${sqlEsc(notes)}'` : 'null'})
on conflict (email) do update set
  tier_grant           = excluded.tier_grant,
  pricing_band_grant   = excluded.pricing_band_grant,
  seed_geofence_passes = excluded.seed_geofence_passes,
  granted_by           = excluded.granted_by,
  notes                = excluded.notes;
`;
  const sp = prompt.spinner();
  sp.start('Writing grant…');
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    sp.stop('Failed.');
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 160)}` };
  }
  sp.stop('Grant written.');

  // Check whether the trigger applied the grant to an existing profile
  // (migration 0046 wires admin_grants → profiles for already-signed-up
  // accounts; signups for not-yet-existing emails are handled by
  // handle_new_user at signup time).
  const stateRes = await psqlPiped(ctx.config, `
    select case when au.id is null then 'pending_signup' else 'applied_to_profile' end as state,
           p.tier::text as profile_tier,
           p.pricing_band::text as profile_band,
           p.access_paid_at is not null as paywall_bypassed,
           p.access_method::text as access_method
      from public.admin_grants ag
      left join auth.users au on lower(au.email) = lower(ag.email)
      left join public.profiles p on p.id = au.id
     where ag.email = '${sqlEsc(email)}';
  `, 'supabase_admin');

  let appliedToProfile = false;
  if (stateRes.exitCode === 0 && stateRes.stdout) {
    const line = stateRes.stdout.split('\n').find((l) => l.includes('applied_to_profile') || l.includes('pending_signup'));
    appliedToProfile = !!line && line.includes('applied_to_profile');
    if (line) {
      const parts = line.split('|').map((s) => s.trim());
      if (appliedToProfile) {
        prompt.note(
          [
            `${c.green('✓')} Grant applied to existing profile`,
            `Tier:           ${c.brand(parts[1] ?? '?')}`,
            `Pricing band:   ${c.brand(parts[2] ?? '?')}`,
            `Paywall:        ${parts[3] === 't' ? c.green('bypassed') : c.yellow('still active (!)')}`,
            `Access method:  ${parts[4] ?? '?'}`
          ].join('\n'),
          'Profile state'
        );
      } else {
        prompt.note(
          c.dim(`User has not signed up yet. Grant will auto-apply at signup time via handle_new_user.`),
          'Pending signup'
        );
      }
    }
  }

  const audit = await writeAudit(ctx.config, {
    runbookId: 'manage-admin-grants',
    action:    existing && !existing.redeemed_at ? 'grant-updated' : 'grant-created',
    target:    email,
    metadata:  { email, tier, band, seed_passes: seed, granted_by: grantedBy, notes },
    dryRun:    ctx.dryRun
  });
  if (!audit.ok) {
    prompt.note(c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`), 'Warning');
  }

  return {
    success: true,
    summary: `Grant for ${email} ${existing && !existing.redeemed_at ? 'updated' : 'created'} (${tier as string}, ${band as string}, seed=${seed})${appliedToProfile ? ' — applied to profile, paywall bypassed' : ' — pending signup'}.`,
    details: { email, tier, band, seed, appliedToProfile }
  };
}

async function inspectGrant(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;
  const emailIn = await prompt.text({
    message: 'Email',
    validate: (v) => {
      const s = (v ?? '').trim();
      if (!s) return 'Required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Not a valid email.';
      return undefined;
    }
  });
  if (prompt.isCancel(emailIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const email = (emailIn as string).trim().toLowerCase();

  const grant = await fetchGrant(ctx, email);
  if (!grant) {
    prompt.note(c.dim(`No admin_grants entry for ${email}.`), 'Not found');
    return { success: true, summary: `No grant for ${email}.` };
  }

  prompt.note(
    [
      `Email:        ${grant.email}`,
      `Tier:         ${c.brand(grant.tier_grant)}`,
      `Band:         ${c.brand(grant.pricing_band_grant)}`,
      `Seed passes:  ${c.brand(String(grant.seed_geofence_passes))}`,
      `Granted by:   ${grant.granted_by}`,
      `Notes:        ${c.dim(grant.notes ?? '(none)')}`,
      `Created:      ${grant.created_at}`,
      `Redeemed:     ${grant.redeemed_at ? c.green(grant.redeemed_at) : c.dim('not yet')}`,
      `Redeemed by:  ${grant.redeemed_by ? c.dim(grant.redeemed_by) : c.dim('—')}`
    ].join('\n'),
    'Grant detail'
  );

  return { success: true, summary: `Inspected grant for ${email}.` };
}

async function revokeGrant(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;
  const emailIn = await prompt.text({
    message: 'Email of grant to revoke',
    validate: (v) => {
      const s = (v ?? '').trim();
      if (!s) return 'Required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Not a valid email.';
      return undefined;
    }
  });
  if (prompt.isCancel(emailIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const email = (emailIn as string).trim().toLowerCase();

  const grant = await fetchGrant(ctx, email);
  if (!grant) {
    return { success: false, summary: `No admin_grants entry for ${email}.` };
  }
  if (grant.redeemed_at) {
    prompt.note(
      c.yellow(`This grant was already redeemed on ${grant.redeemed_at}. Revoking it deletes the row but does NOT downgrade the user — that requires a separate profile mutation.`),
      'Already redeemed'
    );
  }

  prompt.note(
    [
      `Email:        ${grant.email}`,
      `Tier:         ${grant.tier_grant}`,
      `Band:         ${grant.pricing_band_grant}`,
      `Seed:         ${grant.seed_geofence_passes}`,
      `Granted by:   ${grant.granted_by}`,
      `Redeemed:     ${grant.redeemed_at ?? 'not yet'}`,
      '',
      ctx.dryRun ? c.yellow('(dry-run — row will not be deleted)') : c.red('This will DELETE the row.')
    ].join('\n'),
    'Revoke preview'
  );

  const confirmed = await prompt.confirm({ message: `Delete grant for ${email}?`, initialValue: false });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (ctx.dryRun) {
    return { success: true, summary: `Dry-run: would have deleted grant for ${email}.`, details: { email, dryRun: true } };
  }

  const sqlEsc = (s: string): string => s.replace(/'/g, `''`);
  const sql = `delete from public.admin_grants where email = '${sqlEsc(email)}';\n`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 160)}` };
  }

  const audit = await writeAudit(ctx.config, {
    runbookId: 'manage-admin-grants',
    action:    'grant-revoked',
    target:    email,
    metadata:  { email, was_redeemed: !!grant.redeemed_at },
    dryRun:    ctx.dryRun
  });
  if (!audit.ok) {
    prompt.note(c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`), 'Warning');
  }

  return {
    success: true,
    summary: `Grant for ${email} revoked.`,
    details: { email, was_redeemed: !!grant.redeemed_at }
  };
}

/** Fetch a single grant by email. Returns null if not found. */
async function fetchGrant(ctx: RunbookContext, email: string): Promise<Grant | null> {
  const sqlEsc = email.replace(/'/g, `''`);
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

select email || E'\\x1f' ||
       tier_grant || E'\\x1f' ||
       pricing_band_grant || E'\\x1f' ||
       seed_geofence_passes::text || E'\\x1f' ||
       granted_by || E'\\x1f' ||
       coalesce(notes, '') || E'\\x1f' ||
       created_at::text || E'\\x1f' ||
       coalesce(redeemed_at::text, '') || E'\\x1f' ||
       coalesce(redeemed_by::text, '')
from public.admin_grants
where lower(email) = lower('${sqlEsc}')
limit 1;
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
  const line = res.stdout.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split('\x1f');
  return {
    email:                parts[0] ?? '',
    tier_grant:           (parts[1] ?? 'standard') as Grant['tier_grant'],
    pricing_band_grant:   (parts[2] ?? 'standard') as Grant['pricing_band_grant'],
    seed_geofence_passes: parseInt(parts[3] ?? '0', 10),
    granted_by:           parts[4] ?? '',
    notes:                parts[5] || null,
    created_at:           parts[6] ?? '',
    redeemed_at:          parts[7] || null,
    redeemed_by:          parts[8] || null
  };
}

export default runbook;
