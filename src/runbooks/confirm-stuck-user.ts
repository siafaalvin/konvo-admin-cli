/**
 * Runbook #2 — Confirm stuck user signup.
 *
 * The "I paid but can't get in" workflow. Prompts for an email, runs
 * a focused diagnostic against four common failure modes, and offers
 * the matching fixes:
 *
 *   1. Email not confirmed         auth.users.email_confirmed_at IS NULL
 *      → fix: UPDATE auth.users SET email_confirmed_at = now()
 *
 *   2. Profile missing             public.profiles row absent
 *      → fix: INSERT a stub profile so RLS / FK chains resolve
 *
 *   3. Access not paid             profiles.access_paid_at IS NULL
 *      → fix: UPDATE profiles SET access_paid_at = now(), access_method='manual'
 *
 *   4. Residency stuck pending     address_residencies.is_active = false
 *                                  + status = 'pending'
 *      → fix: UPDATE residency SET is_active = true, status = 'active'
 *
 * Each fix is independent. The operator picks ONE per run from a
 * menu of "applicable fixes" — the picker only shows fixes whose
 * preconditions match the current diagnosis.
 *
 * Risk: low. Single-row mutations, all reversible by clearing the
 * column back to NULL or flipping is_active back. The operator must
 * explicitly confirm.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface Diagnosis {
  userId:               string | null;
  email:                string;
  emailConfirmed:       boolean;
  profileExists:        boolean;
  accessPaid:           boolean;
  pendingResidencyId:   string | null;
}

/** Run the diagnostic SELECT, parse the unaligned key=value output. */
async function diagnose(ctx: RunbookContext, email: string): Promise<Diagnosis> {
  const sqlEsc = email.replace(/'/g, `''`);
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

with u as (
  select id, email_confirmed_at from auth.users
  where lower(email) = '${sqlEsc}'
),
p as (
  select id, access_paid_at from public.profiles
  where id = (select id from u)
),
r as (
  select id from public.address_residencies
  where user_id = (select id from u)
    and is_active = false
    and status = 'pending'
  order by created_at desc
  limit 1
)
select
  'userId='              || coalesce((select id::text from u), 'NONE')        || E'\\n' ||
  'emailConfirmed='      || (case when (select email_confirmed_at from u) is not null then 'true' else 'false' end) || E'\\n' ||
  'profileExists='       || (case when exists (select 1 from p) then 'true' else 'false' end) || E'\\n' ||
  'accessPaid='          || (case when (select access_paid_at from p) is not null then 'true' else 'false' end) || E'\\n' ||
  'pendingResidencyId='  || coalesce((select id::text from r), 'NONE');
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
  const out = res.stdout.trim();
  const get = (key: string): string => {
    const m = out.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return m ? m[1]!.trim() : '';
  };
  return {
    userId:             get('userId') === 'NONE'             ? null : get('userId'),
    email,
    emailConfirmed:     get('emailConfirmed') === 'true',
    profileExists:      get('profileExists')  === 'true',
    accessPaid:         get('accessPaid')     === 'true',
    pendingResidencyId: get('pendingResidencyId') === 'NONE' ? null : get('pendingResidencyId')
  };
}

/** Render the diagnosis as a checklist of state flags. */
function renderDiagnosis(d: Diagnosis): string {
  if (!d.userId) return c.red(`No auth.users row for ${d.email}.`);
  const tick = (ok: boolean): string => (ok ? c.green('✓') : c.red('✗'));
  return [
    `User id: ${c.dim(d.userId)}`,
    ``,
    `${tick(d.emailConfirmed)} email_confirmed_at set`,
    `${tick(d.profileExists)}  profile row exists`,
    `${tick(d.accessPaid)}  access_paid_at set`,
    d.pendingResidencyId
      ? c.yellow(`!  residency stuck pending (id: ${d.pendingResidencyId})`)
      : c.dim('   no stuck residency')
  ].join('\n');
}

/** Possible fixes given the diagnosis. */
type FixId = 'confirm-email' | 'create-profile' | 'mark-paid' | 'activate-residency' | 'do-nothing';

interface FixOption {
  id:         FixId;
  label:      string;
  hint:       string;
  applies:    boolean;
}

function applicableFixes(d: Diagnosis): FixOption[] {
  return [
    {
      id: 'confirm-email',
      label: 'Confirm email',
      hint: 'UPDATE auth.users SET email_confirmed_at = now()',
      applies: d.userId !== null && !d.emailConfirmed
    },
    {
      id: 'create-profile',
      label: 'Create profile row',
      hint: 'INSERT INTO public.profiles (id) — stub so FK chains resolve',
      applies: d.userId !== null && !d.profileExists
    },
    {
      id: 'mark-paid',
      label: 'Mark access paid (manual)',
      hint: "UPDATE profiles SET access_paid_at = now(), access_method = 'manual'",
      applies: d.userId !== null && d.profileExists && !d.accessPaid
    },
    {
      id: 'activate-residency',
      label: 'Activate stuck residency',
      hint: "UPDATE address_residencies SET is_active = true, status = 'active'",
      applies: d.pendingResidencyId !== null
    }
  ];
}

/** Run the chosen fix as a single statement. Returns success + summary. */
async function applyFix(
  ctx: RunbookContext,
  d: Diagnosis,
  fixId: FixId
): Promise<{ success: boolean; summary: string }> {
  let sql: string;
  switch (fixId) {
    case 'confirm-email':
      sql = `update auth.users set email_confirmed_at = now() where id = '${d.userId}';`;
      break;
    case 'create-profile':
      sql = `insert into public.profiles (id) values ('${d.userId}') on conflict (id) do nothing;`;
      break;
    case 'mark-paid':
      sql = `update public.profiles set access_paid_at = now(), access_method = 'manual' where id = '${d.userId}';`;
      break;
    case 'activate-residency':
      sql = `update public.address_residencies set is_active = true, status = 'active' where id = '${d.pendingResidencyId}';`;
      break;
    case 'do-nothing':
      return { success: true, summary: 'No fix applied.' };
  }
  const res = await psqlPiped(ctx.config, sql + '\n', 'supabase_admin');
  if (res.exitCode !== 0) {
    return {
      success: false,
      summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 160)}`
    };
  }
  return { success: true, summary: `Applied ${fixId}.` };
}

const runbook: Runbook = {
  id:          'confirm-stuck-user',
  title:       'Confirm stuck user',
  description: '"I paid but can\'t get in." Diagnose + fix one of: email-confirm / profile-create / mark-paid / activate-residency.',
  risk:        'low',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Email.
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
    if (prompt.isCancel(emailIn)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const email = (emailIn as string).trim().toLowerCase();

    // 2. Diagnose.
    const sp1 = prompt.spinner();
    sp1.start(`Diagnosing ${email}…`);
    let d: Diagnosis;
    try {
      d = await diagnose(ctx, email);
    } catch (err) {
      sp1.stop('Diagnosis failed.');
      return {
        success: false,
        summary: err instanceof Error ? err.message : String(err)
      };
    }
    sp1.stop('Diagnosis complete.');
    prompt.note(renderDiagnosis(d), 'Current state');

    if (!d.userId) {
      return {
        success: false,
        summary: `No auth.users row for ${email}.`,
        details: { email }
      };
    }

    // 3. Pick a fix from the applicable set.
    const fixes = applicableFixes(d).filter((f) => f.applies);
    if (fixes.length === 0) {
      return {
        success: true,
        summary: `Nothing stuck for ${email} — all four checks pass.`,
        details: { email, diagnosis: d }
      };
    }

    const choice = await prompt.select({
      message: 'Apply which fix?',
      options: [
        ...fixes.map((f) => ({ value: f.id, label: f.label, hint: c.dim(f.hint) })),
        { value: 'do-nothing' as const, label: c.dim('Do nothing — leave as-is'), hint: c.dim('Returns to menu without changes') }
      ]
    });
    if (prompt.isCancel(choice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    if (choice === 'do-nothing') {
      return { success: true, summary: `No fix applied for ${email}.`, details: { email } };
    }

    // 4. Confirm.
    const fix = fixes.find((f) => f.id === choice)!;
    prompt.note(
      [
        `User: ${c.brand(email)}  (${d.userId})`,
        `Fix:  ${fix.label}`,
        ``,
        c.dim(fix.hint),
        ctx.dryRun ? c.yellow('(dry-run — no changes will be applied)') : ''
      ].filter(Boolean).join('\n'),
      'Preview'
    );

    const confirmed = await prompt.confirm({
      message: 'Apply now?',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have applied ${fix.id} for ${email}.`,
        details: { email, fixId: fix.id, dryRun: true }
      };
    }

    // 5. Apply + re-diagnose.
    const sp2 = prompt.spinner();
    sp2.start('Applying fix…');
    const applyRes = await applyFix(ctx, d, fix.id as FixId);
    if (!applyRes.success) {
      sp2.stop('Apply failed.');
      return { success: false, summary: applyRes.summary, details: { email, fixId: fix.id } };
    }
    sp2.stop('Applied.');

    const sp3 = prompt.spinner();
    sp3.start('Re-checking state…');
    const after = await diagnose(ctx, email);
    sp3.stop('Re-check complete.');
    prompt.note(renderDiagnosis(after), 'After fix');

    return {
      success: true,
      summary: `${fix.label} for ${email}.`,
      details: { email, fixId: fix.id, before: d, after }
    };
  }
};

export default runbook;
