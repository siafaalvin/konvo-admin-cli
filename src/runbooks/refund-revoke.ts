/**
 * Runbook #4 — Refund + revoke access.
 *
 * Chargebacks / "refund this user" tickets. Walks through:
 *
 *   1. Look up user by email in Postgres → confirm they exist + how
 *      they got access (stripe / crowdfund / admin).
 *   2. If access_method = 'stripe': search Stripe by email, list
 *      successful payment intents, operator picks which to refund.
 *      Issues full refund with reason 'requested_by_customer'.
 *   3. If access_method = 'crowdfund': no Stripe action; offer to
 *      remove the corresponding crowdfund_emails entry so a re-
 *      signup wouldn't auto-grant again.
 *   4. If access_method = 'admin': no Stripe action.
 *   5. In all cases: clear profiles.access_paid_at + access_method
 *      so the user gets paywalled on next sign-in.
 *
 * The auth.users row is NOT deleted. The user's account, chats,
 * and content are preserved — only platform access is revoked.
 *
 * Risk: high. Issues real refunds + reverts paid status. Mitigations:
 *   - Live-key safety banner if KONVO_STRIPE_SECRET_KEY starts with
 *     sk_live_.
 *   - Two confirmation prompts: refund (Stripe-side) and revoke
 *     (Postgres-side) shown separately so operator can do one
 *     without the other.
 *   - Dry-run path skips both mutations.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import {
  findCustomerByEmail,
  formatAmount,
  listSuccessfulPaymentIntents,
  refundPaymentIntent,
  stripeMode
} from '../lib/stripe.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface UserState {
  userId:        string | null;
  email:         string;
  accessPaidAt:  string | null;
  accessMethod:  'stripe' | 'crowdfund' | 'admin' | null;
  hasCrowdfund:  boolean;
}

async function lookupUser(ctx: RunbookContext, email: string): Promise<UserState> {
  const sqlEsc = email.replace(/'/g, `''`);
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

with u as (
  select id from auth.users where lower(email) = '${sqlEsc}'
),
p as (
  select access_paid_at, access_method from public.profiles
  where id = (select id from u)
)
select
  'userId='        || coalesce((select id::text          from u), 'NONE')   || E'\\n' ||
  'paidAt='        || coalesce((select access_paid_at::text from p), '')   || E'\\n' ||
  'method='        || coalesce((select access_method   from p), '')         || E'\\n' ||
  'hasCrowdfund='  || (case when exists (select 1 from public.crowdfund_emails where lower(email) = '${sqlEsc}') then 'true' else 'false' end);
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
  const out = res.stdout.trim();
  const get = (k: string): string => {
    const m = out.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1]!.trim() : '';
  };
  const method = get('method');
  return {
    userId:        get('userId') === 'NONE' ? null : get('userId'),
    email,
    accessPaidAt:  get('paidAt') === '' ? null : get('paidAt'),
    accessMethod:  method === '' ? null : method as UserState['accessMethod'],
    hasCrowdfund:  get('hasCrowdfund') === 'true'
  };
}

async function clearAccess(ctx: RunbookContext, userId: string): Promise<void> {
  const sql = `update public.profiles set access_paid_at = null, access_method = null where id = '${userId}';\n`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`Clear access failed: psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
}

async function deleteCrowdfundEntry(ctx: RunbookContext, email: string): Promise<void> {
  const sql = `delete from public.crowdfund_emails where lower(email) = '${email.replace(/'/g, `''`)}';\n`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`Delete crowdfund entry failed: psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
}

const runbook: Runbook = {
  id:          'refund-revoke',
  title:       'Refund + revoke access',
  description: 'Chargeback flow. Refunds via Stripe (if applicable), then clears access_paid_at. Auth row preserved.',
  risk:        'high',
  requires:    ['ssh', 'stripe'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 0. Stripe key sanity. If unset → error early. If test → warn.
    const mode = stripeMode(ctx.config);
    if (mode === 'unset') {
      return {
        success: false,
        summary: 'KONVO_STRIPE_SECRET_KEY is unset. Add it to .env to use this runbook.'
      };
    }
    if (mode === 'live') {
      prompt.note(
        c.yellow('Stripe LIVE key detected. This runbook will issue REAL refunds.'),
        '⚠ Live mode'
      );
    } else {
      prompt.note(c.dim('Stripe TEST key — refunds will be mock.'), 'Test mode');
    }

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

    // 2. Lookup user state.
    const sp1 = prompt.spinner();
    sp1.start(`Looking up ${email}…`);
    let user: UserState;
    try {
      user = await lookupUser(ctx, email);
    } catch (err) {
      sp1.stop('Lookup failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp1.stop('User state read.');

    if (!user.userId) {
      return { success: false, summary: `No auth.users row for ${email}.` };
    }

    prompt.note(
      [
        `User id:       ${c.dim(user.userId)}`,
        `Access paid:   ${user.accessPaidAt ? c.green(user.accessPaidAt) : c.red('not paid')}`,
        `Access method: ${user.accessMethod ? c.brand(user.accessMethod) : c.dim('—')}`,
        `Crowdfund row: ${user.hasCrowdfund ? c.brand('present') : c.dim('—')}`
      ].join('\n'),
      'User state'
    );

    if (!user.accessPaidAt) {
      // Edge case: revoke when there's nothing to revoke.
      const really = await prompt.confirm({
        message: 'User is already paywalled. Continue anyway (e.g. to clean a stale crowdfund row)?',
        initialValue: false
      });
      if (prompt.isCancel(really) || !really) {
        return { success: true, summary: `${email} already paywalled. Nothing to do.`, details: { email } };
      }
    }

    // 3. Stripe refund (only if method='stripe').
    let refundedPi: string | null = null;
    let refundedAmount: number | null = null;
    if (user.accessMethod === 'stripe') {
      const sp2 = prompt.spinner();
      sp2.start('Looking up Stripe customer…');
      const customer = await findCustomerByEmail(ctx.config, email);
      if (!customer) {
        sp2.stop('No Stripe customer.');
        prompt.note(
          c.yellow('access_method=stripe but no Stripe customer found by email. Will skip refund and proceed to revoke only.'),
          'Warning'
        );
      } else {
        sp2.stop(`Stripe customer: ${customer.id}`);
        const intents = await listSuccessfulPaymentIntents(ctx.config, customer.id, 10);
        if (intents.length === 0) {
          prompt.note(c.yellow('No succeeded payment intents — skipping refund.'), 'Warning');
        } else {
          const piChoice = await prompt.select({
            message: 'Which payment intent to refund?',
            options: [
              ...intents.map((pi) => ({
                value: pi.id,
                label: `${formatAmount(pi.amount, pi.currency)} — ${new Date(pi.created * 1000).toISOString().slice(0, 10)}`,
                hint:  `${pi.id}${pi.description ? ' · ' + pi.description : ''}`
              })),
              { value: '__skip', label: c.dim('Skip refund — only revoke access'), hint: c.dim('No Stripe call; just clear access_paid_at') }
            ]
          });
          if (prompt.isCancel(piChoice)) {
            prompt.cancel('Cancelled.');
            return { success: false, summary: 'Operator cancelled.' };
          }
          if (piChoice !== '__skip') {
            const target = intents.find((pi) => pi.id === piChoice)!;
            // Confirm refund.
            const refundConfirmed = await prompt.confirm({
              message: `Refund ${formatAmount(target.amount, target.currency)} on ${target.id}?`,
              initialValue: false
            });
            if (prompt.isCancel(refundConfirmed) || !refundConfirmed) {
              prompt.note(c.dim('Refund skipped.'), 'Refund');
            } else if (ctx.dryRun) {
              prompt.note(c.yellow(`(dry-run — would refund ${target.id})`), 'Refund');
              refundedPi = target.id;
              refundedAmount = target.amount;
            } else {
              const sp3 = prompt.spinner();
              sp3.start('Issuing Stripe refund…');
              try {
                const refund = await refundPaymentIntent(ctx.config, target.id);
                sp3.stop(`Refund id: ${refund.id}`);
                refundedPi = target.id;
                refundedAmount = target.amount;
              } catch (err) {
                sp3.stop('Refund failed.');
                return {
                  success: false,
                  summary: `Stripe refund failed: ${err instanceof Error ? err.message : String(err)}`,
                  details: { email }
                };
              }
            }
          }
        }
      }
    } else if (user.accessMethod) {
      prompt.note(c.dim(`access_method=${user.accessMethod} — no Stripe refund applicable.`), 'Refund');
    }

    // 4. Revoke access in Postgres.
    const revokeConfirmed = await prompt.confirm({
      message: `Clear access_paid_at for ${email}?`,
      initialValue: false
    });
    if (prompt.isCancel(revokeConfirmed) || !revokeConfirmed) {
      return {
        success: refundedPi !== null,
        summary: refundedPi
          ? `Refunded ${refundedPi} but did NOT revoke access (operator declined).`
          : 'Operator declined to revoke. No changes applied.',
        details: { email, refundedPi, refundedAmount }
      };
    }

    if (ctx.dryRun) {
      prompt.note(c.yellow('(dry-run — would clear profiles.access_paid_at)'), 'Revoke');
    } else {
      const sp4 = prompt.spinner();
      sp4.start('Clearing access_paid_at…');
      try {
        await clearAccess(ctx, user.userId);
        sp4.stop('Access cleared.');
      } catch (err) {
        sp4.stop('Revoke failed.');
        return {
          success: false,
          summary: err instanceof Error ? err.message : String(err),
          details: { email }
        };
      }
    }

    // 5. Optionally remove crowdfund_emails entry so they don't get
    //    auto-re-granted on a future signup.
    if (user.hasCrowdfund) {
      const removeCrowdfund = await prompt.confirm({
        message: `Also remove ${email} from crowdfund_emails (prevents auto-grant on re-signup)?`,
        initialValue: user.accessMethod === 'crowdfund'
      });
      if (!prompt.isCancel(removeCrowdfund) && removeCrowdfund) {
        if (ctx.dryRun) {
          prompt.note(c.yellow('(dry-run — would delete crowdfund_emails row)'), 'Crowdfund');
        } else {
          const sp5 = prompt.spinner();
          sp5.start('Deleting crowdfund_emails row…');
          try {
            await deleteCrowdfundEntry(ctx, email);
            sp5.stop('Crowdfund row deleted.');
          } catch (err) {
            sp5.stop('Crowdfund deletion failed.');
            // Don't fail the whole runbook on this — refund + revoke
            // already succeeded. Surface as warning.
            prompt.note(
              c.yellow(`Crowdfund row deletion failed: ${err instanceof Error ? err.message : String(err)}`),
              'Warning'
            );
          }
        }
      }
    }

    // Audit — record what happened. Stripe payment intent id is
    // logged as the target for traceability; the email is in metadata.
    const audit = await writeAudit(ctx.config, {
      runbookId: 'refund-revoke',
      action:    refundedPi ? 'refund-and-revoke' : 'revoke-only',
      target:    refundedPi ?? email,
      metadata:  {
        email,
        userId:        user.userId,
        accessMethod:  user.accessMethod,
        refundedPi,
        refundedAmountCents: refundedAmount,
        stripeMode: mode
      },
      dryRun: ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`), 'Warning');
    }

    return {
      success: true,
      summary: refundedPi
        ? `Refunded ${refundedPi} (${refundedAmount && formatAmount(refundedAmount, 'usd')}) and revoked access for ${email}.`
        : `Revoked access for ${email} (no Stripe refund issued).`,
      details: { email, refundedPi, refundedAmount, mode }
    };
  }
};

export default runbook;
