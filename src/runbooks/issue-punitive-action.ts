/**
 * Runbook — issue-punitive-action.
 *
 * Issues a fine or suspension to a Konvo user. If the target is a
 * member of any active vouch group, joint-risk cascade fires
 * automatically (houvox-pwa migration 0049). The runbook surfaces
 * the cascade plan for operator review BEFORE writing.
 *
 * Operations:
 *   fine        — fixed dollar amount, applied immediately
 *   suspension  — duration-based (e.g. 30 days), applied immediately
 *
 * Cascade math (vouch_group_apply_cascade, migration 0036):
 *   - Fine:       50% to offender, 50% split across other members
 *   - Suspension: every member gets the full duration
 *
 * Risk: medium. Punitive actions are real money / real account
 * impact. Operator confirms each action explicitly + sees the
 * cascade preview before commit. All actions audit-logged with the
 * issued IDs.
 *
 * Section 9 placeholder. Auto-rule violations and user-facing
 * fines collection (Stripe) are post-Monday work.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface CascadeAction {
  user_id: string;
  role:    'vouchee' | 'voucher';
  action:  'fine' | 'suspend';
  cents?:  number;
  duration?: string;
}

interface CascadePlan {
  ok: boolean;
  group_id?: string;
  mode?: string;
  offender?: string;
  offender_role?: string;
  action_type?: string;
  actions?: CascadeAction[];
  reason?: string;
}

interface PreviewResult {
  ok:          boolean;
  user_id:     string;
  action_type: string;
  group_count: number;
  plans:       CascadePlan[];
}

const ACTION_OPTIONS = [
  { value: 'fine',        label: 'Issue a fine',        hint: 'Fixed dollar amount, cascades 50/50 in vouch groups' },
  { value: 'suspension',  label: 'Issue a suspension',  hint: 'Duration-based read-only; cascades full duration' },
  { value: '__exit',      label: c.dim('Cancel'),       hint: c.dim('Return to main menu') }
] as const;

const runbook: Runbook = {
  id:          'issue-punitive-action',
  title:       'Issue punitive action (fine / suspension)',
  description: 'Issues a fine or suspension to a user. Joint-risk cascade fires automatically for vouch group members. Audit-logged.',
  risk:        'medium',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const action = await prompt.select({
      message: 'What kind of punitive action?',
      options: [...ACTION_OPTIONS]
    });
    if (prompt.isCancel(action) || action === '__exit') {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    if (action === 'fine')        return issueFine(ctx);
    if (action === 'suspension')  return issueSuspension(ctx);
    return { success: false, summary: `Unknown action: ${action as string}` };
  }
};

// ─── shared helpers ──────────────────────────────────────────────────────

async function lookupUserId(ctx: RunbookContext, email: string): Promise<string | null> {
  const sqlEsc = (s: string): string => s.replace(/'/g, `''`);
  const sql = `\\t on
\\pset format unaligned
select id from auth.users where lower(email) = lower('${sqlEsc(email)}') limit 1;`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) return null;
  const out = res.stdout.trim();
  if (!out || out.length < 36) return null;
  return out.split('\n').find((l) => l.length === 36) ?? null;
}

async function previewCascade(
  ctx: RunbookContext,
  userId: string,
  actionType: 'fine' | 'suspension',
  payload: Record<string, unknown>
): Promise<PreviewResult | null> {
  const sql = `\\pset format unaligned
\\pset tuples_only on
select public.vouch_preview_cascade(
  '${userId}'::uuid,
  '${actionType}',
  '${JSON.stringify(payload).replace(/'/g, `''`)}'::jsonb
);`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) return null;
  try {
    return JSON.parse(res.stdout.trim()) as PreviewResult;
  } catch {
    return null;
  }
}

function formatPreview(preview: PreviewResult, vouchee: string): string {
  if (preview.group_count === 0) {
    return c.dim('User is not in any active vouch groups — no cascade.');
  }
  const lines: string[] = [c.brand(`Cascade plan: ${preview.group_count} group${preview.group_count === 1 ? '' : 's'}`)];
  for (const plan of preview.plans) {
    if (!plan.ok) {
      lines.push(c.yellow(`  group ${plan.group_id?.slice(0, 8) ?? '?'}: skipped (${plan.reason ?? 'unknown'})`));
      continue;
    }
    lines.push(`  group ${plan.group_id?.slice(0, 8)} (${plan.mode}):`);
    for (const a of plan.actions ?? []) {
      const isOffender = a.user_id === preview.user_id;
      const label = isOffender ? c.yellow('offender') : c.dim(a.role);
      if (a.action === 'fine') {
        const dollars = ((a.cents ?? 0) / 100).toFixed(2);
        lines.push(`    ${label} ${a.user_id.slice(0, 8)}…  fine $${dollars}`);
      } else {
        lines.push(`    ${label} ${a.user_id.slice(0, 8)}…  suspend ${a.duration ?? '?'}`);
      }
    }
  }
  return lines.join('\n');
}

// ─── fine flow ───────────────────────────────────────────────────────────

async function issueFine(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;

  const emailIn = await prompt.text({
    message: 'Target user email',
    validate: (v) => {
      const s = (v ?? '').trim();
      if (!s) return 'Required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Not a valid email.';
      return undefined;
    }
  });
  if (prompt.isCancel(emailIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const email = (emailIn as string).trim().toLowerCase();

  const lookupSp = prompt.spinner();
  lookupSp.start('Looking up user…');
  const userId = await lookupUserId(ctx, email);
  if (!userId) {
    lookupSp.stop('Not found.');
    return { success: false, summary: `No user with email ${email}.` };
  }
  lookupSp.stop(`User: ${userId}`);

  const amountIn = await prompt.text({
    message: 'Fine amount in dollars (e.g. 100 for $100)',
    validate: (v) => {
      const n = Number((v ?? '').trim());
      if (!Number.isFinite(n) || n <= 0) return 'Must be a positive number.';
      if (n > 10000) return 'Refusing — over $10,000 needs escalation.';
      return undefined;
    }
  });
  if (prompt.isCancel(amountIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const amountDollars = Number(amountIn as string);
  const amountCents   = Math.round(amountDollars * 100);

  const reasonIn = await prompt.text({
    message: 'Reason (visible to user)',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Required.' : undefined)
  });
  if (prompt.isCancel(reasonIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const reason = (reasonIn as string).trim();

  // Cascade preview
  const previewSp = prompt.spinner();
  previewSp.start('Computing cascade plan…');
  const preview = await previewCascade(ctx, userId, 'fine', { fine_cents: amountCents });
  previewSp.stop('Done.');
  if (preview) {
    prompt.note(formatPreview(preview, email), 'Cascade preview');
  } else {
    prompt.note(c.yellow('Could not compute cascade preview — proceeding anyway.'), 'Warning');
  }

  const confirmed = await prompt.confirm({
    message: `Issue $${amountDollars} fine to ${email}?`,
    initialValue: false
  });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (ctx.dryRun) {
    return {
      success: true,
      summary: `Dry-run: would have issued $${amountDollars} fine to ${email}.`,
      details: { email, user_id: userId, amount_cents: amountCents, reason, dryRun: true }
    };
  }

  const sqlEsc = (s: string): string => s.replace(/'/g, `''`);
  const sql = `select public.issue_fine(
  '${userId}'::uuid,
  ${amountCents},
  '${sqlEsc(reason)}',
  '${sqlEsc(ctx.config.operator)}',
  'admin-runbook:issue-punitive-action'
);`;
  const sp = prompt.spinner();
  sp.start('Issuing fine…');
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    sp.stop('Failed.');
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 160)}` };
  }
  sp.stop('Fine issued.');

  const audit = await writeAudit(ctx.config, {
    runbookId: 'issue-punitive-action',
    action:    'fine-issued',
    target:    email,
    metadata:  { email, user_id: userId, amount_cents: amountCents, reason, cascade_groups: preview?.group_count ?? 0 },
    dryRun:    ctx.dryRun
  });
  if (!audit.ok) {
    prompt.note(c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`), 'Warning');
  }

  return {
    success: true,
    summary: `Issued $${amountDollars} fine to ${email}.${preview && preview.group_count > 0 ? ` Cascade applied to ${preview.group_count} vouch group(s).` : ''}`,
    details: { email, user_id: userId, amount_cents: amountCents, reason, cascade_group_count: preview?.group_count ?? 0 }
  };
}

// ─── suspension flow ─────────────────────────────────────────────────────

async function issueSuspension(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;

  const emailIn = await prompt.text({
    message: 'Target user email',
    validate: (v) => {
      const s = (v ?? '').trim();
      if (!s) return 'Required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'Not a valid email.';
      return undefined;
    }
  });
  if (prompt.isCancel(emailIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const email = (emailIn as string).trim().toLowerCase();

  const lookupSp = prompt.spinner();
  lookupSp.start('Looking up user…');
  const userId = await lookupUserId(ctx, email);
  if (!userId) {
    lookupSp.stop('Not found.');
    return { success: false, summary: `No user with email ${email}.` };
  }
  lookupSp.stop(`User: ${userId}`);

  const daysIn = await prompt.text({
    message: 'Suspension duration in days',
    validate: (v) => {
      const n = Number((v ?? '').trim());
      if (!Number.isFinite(n) || n <= 0) return 'Must be a positive integer.';
      if (n > 365) return 'Refusing — over 365 days needs escalation.';
      return undefined;
    }
  });
  if (prompt.isCancel(daysIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const days = Math.floor(Number(daysIn as string));

  const reasonIn = await prompt.text({
    message: 'Reason (visible to user)',
    validate: (v) => ((v ?? '').trim().length === 0 ? 'Required.' : undefined)
  });
  if (prompt.isCancel(reasonIn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }
  const reason = (reasonIn as string).trim();

  const endsAtIso = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const durationStr = `${days} day${days === 1 ? '' : 's'}`;

  // Cascade preview
  const previewSp = prompt.spinner();
  previewSp.start('Computing cascade plan…');
  const preview = await previewCascade(ctx, userId, 'suspension', { duration: durationStr });
  previewSp.stop('Done.');
  if (preview) {
    prompt.note(formatPreview(preview, email), 'Cascade preview');
  }

  const confirmed = await prompt.confirm({
    message: `Suspend ${email} for ${durationStr}?`,
    initialValue: false
  });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (ctx.dryRun) {
    return {
      success: true,
      summary: `Dry-run: would have suspended ${email} for ${durationStr}.`,
      details: { email, user_id: userId, duration_days: days, reason, dryRun: true }
    };
  }

  const sqlEsc = (s: string): string => s.replace(/'/g, `''`);
  const sql = `select public.issue_suspension(
  '${userId}'::uuid,
  '${endsAtIso}'::timestamptz,
  '${sqlEsc(reason)}',
  '${sqlEsc(ctx.config.operator)}',
  'admin-runbook:issue-punitive-action'
);`;
  const sp = prompt.spinner();
  sp.start('Issuing suspension…');
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    sp.stop('Failed.');
    return { success: false, summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 160)}` };
  }
  sp.stop('Suspension issued.');

  const audit = await writeAudit(ctx.config, {
    runbookId: 'issue-punitive-action',
    action:    'suspension-issued',
    target:    email,
    metadata:  { email, user_id: userId, duration_days: days, ends_at: endsAtIso, reason, cascade_groups: preview?.group_count ?? 0 },
    dryRun:    ctx.dryRun
  });
  if (!audit.ok) {
    prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
  }

  return {
    success: true,
    summary: `Suspended ${email} for ${durationStr}.${preview && preview.group_count > 0 ? ` Cascade applied to ${preview.group_count} vouch group(s).` : ''}`,
    details: { email, user_id: userId, duration_days: days, ends_at: endsAtIso, reason, cascade_group_count: preview?.group_count ?? 0 }
  };
}

export default runbook;
