/**
 * Runbook — reset-user-password.
 *
 * Set a Supabase user's password directly via the GoTrue admin API,
 * bypassing the email-recovery flow. Built because Gmail's link-safety
 * scanner pre-fetches recovery URLs and consumes the one-time tokens
 * before the user ever clicks them, leading to "otp_expired" errors
 * on every legitimate click.
 *
 * Supports both Supabase backends on the prod VPS:
 *
 *   konvo      — api.thekonvo.com (Konvo PWA users, app.thekonvo.com)
 *   crowdfund  — supabase-cf.thekonvo.com (crowdfunding.thekonvo.com admins)
 *
 * Service role keys are fetched via SSH from /root/.konvo-prod/* so
 * the operator never types or sees the JWT. Required files on VPS:
 *
 *   /root/.konvo-prod/service-role-key.txt                     (existing — Konvo)
 *   /root/.konvo-prod/crowdfund-supabase-service-role-key.txt  (added 2026-06-17)
 *
 * The new password is captured locally via @clack/prompts' password()
 * so it doesn't echo to the terminal scrollback. It's posted directly
 * to /auth/v1/admin/users/{id} and discarded from process memory
 * immediately after the request returns.
 *
 * Risk: high. Resetting a password is a privileged operation —
 * effectively account takeover of the target user. Type-to-confirm
 * gate before the API call. Audit-logged.
 */

import { exec } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

type BackendId = 'konvo' | 'crowdfund';

interface BackendConfig {
  id:          BackendId;
  label:       string;
  description: string;
  apiUrl:      string;
  /** Path on the prod VPS to the service-role JWT file (mode 600). */
  keyPath:     string;
  /** Where the user logs in after their password is reset. */
  loginUrl:    string;
}

const BACKENDS: Record<BackendId, BackendConfig> = {
  konvo: {
    id:          'konvo',
    label:       'Konvo PWA',
    description: 'app.thekonvo.com — main Konvo Supabase backend',
    apiUrl:      'https://api.thekonvo.com',
    keyPath:     '/root/.konvo-prod/service-role-key.txt',
    loginUrl:    'https://app.thekonvo.com/login'
  },
  crowdfund: {
    id:          'crowdfund',
    label:       'Crowdfund',
    description: 'crowdfunding.thekonvo.com — self-hosted crowdfund Supabase',
    apiUrl:      'https://supabase-cf.thekonvo.com',
    keyPath:     '/root/.konvo-prod/crowdfund-supabase-service-role-key.txt',
    loginUrl:    'https://crowdfunding.thekonvo.com/admin/login'
  }
};

interface SupabaseUser {
  id:                  string;
  email:               string;
  email_confirmed_at:  string | null;
  created_at:          string;
  last_sign_in_at:     string | null;
}

/**
 * Fetch the service role key from the prod VPS via SSH. Returns the
 * trimmed JWT or throws if the file is missing / empty / not a JWT.
 */
async function fetchServiceKey(ctx: RunbookContext, keyPath: string): Promise<string> {
  const res = await exec(ctx.config, `cat ${keyPath}`);
  if (res.exitCode !== 0) {
    throw new Error(
      `Could not read ${keyPath} on ${ctx.config.prodHost}: ${res.stderr.trim().slice(0, 160)}`
    );
  }
  const key = res.stdout.trim();
  if (!key) {
    throw new Error(`Service key file ${keyPath} is empty.`);
  }
  if (!key.startsWith('eyJ')) {
    throw new Error(`Service key file ${keyPath} does not look like a JWT (starts with "${key.slice(0, 10)}...").`);
  }
  return key;
}

/**
 * Look up a user by email via the GoTrue admin API. GoTrue's admin
 * /users endpoint accepts an `email` query parameter that returns
 * the matching user (or empty `users` array if no match).
 */
async function lookupUser(
  apiUrl: string,
  serviceKey: string,
  email: string
): Promise<SupabaseUser | null> {
  const url = `${apiUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: {
      apikey:        serviceKey,
      Authorization: `Bearer ${serviceKey}`
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`User lookup failed: HTTP ${res.status} ${body.slice(0, 160)}`);
  }
  const data = await res.json() as { users?: SupabaseUser[] };
  // GoTrue's admin users endpoint can return a list when filtered, OR
  // a list for the no-filter case. We match exact (case-insensitive)
  // email since it sometimes returns prefix matches.
  const user = (data.users ?? []).find(
    (u) => u.email?.toLowerCase() === email.toLowerCase()
  );
  return user ?? null;
}

/**
 * Set the user's password via the admin API. email_confirm=true so
 * the new credentials work immediately without a verification step.
 */
async function setPassword(
  apiUrl: string,
  serviceKey: string,
  userId: string,
  newPassword: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${apiUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      apikey:         serviceKey,
      Authorization:  `Bearer ${serviceKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      password:       newPassword,
      email_confirm:  true
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok:    false,
      error: `HTTP ${res.status}: ${body.slice(0, 200)}`
    };
  }
  return { ok: true };
}

const runbook: Runbook = {
  id:          'reset-user-password',
  title:       'Reset user password',
  description: 'Set a password directly via Supabase admin API. Bypasses email recovery (works around Gmail link prefetch).',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Backend.
    const backendChoice = await prompt.select<BackendId>({
      message: 'Which Supabase backend?',
      options: Object.values(BACKENDS).map((b) => ({
        value: b.id,
        label: b.label,
        hint:  c.dim(b.description)
      }))
    });
    if (prompt.isCancel(backendChoice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const backend = BACKENDS[backendChoice];

    // 2. Email.
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

    // 3. Fetch service key + look up user.
    const sp1 = prompt.spinner();
    sp1.start(`Looking up ${email} on ${backend.label}…`);
    let serviceKey: string;
    let user: SupabaseUser | null;
    try {
      serviceKey = await fetchServiceKey(ctx, backend.keyPath);
      user = await lookupUser(backend.apiUrl, serviceKey, email);
    } catch (err) {
      sp1.stop('Lookup failed.');
      return {
        success: false,
        summary: err instanceof Error ? err.message : String(err)
      };
    }
    if (!user) {
      sp1.stop('No matching user.');
      return {
        success: false,
        summary: `No user found with email ${email} on ${backend.label}.`,
        details: { email, backend: backend.id }
      };
    }
    sp1.stop('User found.');

    prompt.note(
      [
        `Backend: ${c.brand(backend.label)}`,
        `URL:     ${c.dim(backend.apiUrl)}`,
        ``,
        `Email:           ${c.brand(user.email)}`,
        `User ID:         ${c.dim(user.id)}`,
        `Created:         ${c.dim(user.created_at)}`,
        `Email confirmed: ${user.email_confirmed_at ? c.green('yes') : c.red('no')}`,
        `Last sign-in:    ${c.dim(user.last_sign_in_at ?? 'never')}`,
        ctx.dryRun ? '' : '',
        ctx.dryRun ? c.yellow('(dry-run — no password will be set)') : ''
      ].filter(Boolean).join('\n'),
      'Target'
    );

    // 4. Capture password (echo-suppressed) + confirm.
    const pw1 = await prompt.password({
      message: 'New password',
      validate: (v) => {
        const s = v ?? '';
        if (s.length < 8) return 'Must be at least 8 characters.';
        if (s.length > 72) return 'GoTrue rejects passwords longer than 72 bytes (bcrypt limit).';
        return undefined;
      }
    });
    if (prompt.isCancel(pw1)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const pw2 = await prompt.password({
      message: 'Confirm new password'
    });
    if (prompt.isCancel(pw2)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    if (pw1 !== pw2) {
      return { success: false, summary: 'Passwords do not match.' };
    }

    // 5. Type-to-confirm gate.
    const confirmPhrase = `reset password for ${user.email}`;
    const typed = await prompt.text({
      message: `Type ${c.brand(`"${confirmPhrase}"`)} to proceed`,
      validate: (v) => {
        if ((v ?? '').trim() !== confirmPhrase) return `Must match exactly: ${confirmPhrase}`;
        return undefined;
      }
    });
    if (prompt.isCancel(typed)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would reset password for ${email} on ${backend.label}.`,
        details: { email, backend: backend.id, userId: user.id, dryRun: true }
      };
    }

    // 6. Apply.
    const sp2 = prompt.spinner();
    sp2.start('Setting password via admin API…');
    const applyRes = await setPassword(backend.apiUrl, serviceKey, user.id, pw1 as string);
    if (!applyRes.ok) {
      sp2.stop('Set failed.');
      return {
        success: false,
        summary: `Password update rejected: ${applyRes.error}`,
        details: { email, backend: backend.id, userId: user.id }
      };
    }
    sp2.stop('Password set.');

    // 7. Audit (best-effort — failures are warned but not fatal).
    const audit = await writeAudit(ctx.config, {
      runbookId: 'reset-user-password',
      action:    'set-password',
      target:    user.id,
      metadata:  {
        email:    user.email,
        backend:  backend.id,
        apiUrl:   backend.apiUrl
      },
      dryRun:    ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note(
        c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`),
        'Warning'
      );
    }

    prompt.note(
      [
        c.green(`✓ Password updated for ${user.email}.`),
        ``,
        `Login at: ${c.brand(backend.loginUrl)}`,
        ``,
        c.dim('The user can sign in with their email + the new password.'),
        c.dim('They should rotate the password from inside the app afterward.')
      ].join('\n'),
      'Done'
    );

    return {
      success: true,
      summary: `Password reset for ${user.email} on ${backend.label}.`,
      details: {
        email:    user.email,
        backend:  backend.id,
        userId:   user.id,
        loginUrl: backend.loginUrl
      }
    };
  }
};

export default runbook;
