/**
 * Shared helpers for admin pseudonymization.
 *
 * All runbooks that look up users should use these helpers, which:
 * 1. Accept email input (necessary for support workflow)
 * 2. Log the access to admin_audit_log
 * 3. Return the user_id for subsequent queries
 *
 * The audit log records which runbook accessed which user's email.
 */

import { psqlPiped } from './ssh.ts';
import type { Config } from './config.ts';

interface UserLookupResult {
  found: boolean;
  userId?: string;
  platformId?: string;
}

/**
 * Look up a user by email and log the access.
 * Returns the user_id for subsequent (pseudonymized) queries.
 */
export async function lookupUserByEmail(
  config: Config,
  email: string,
  runbookId: string,
  reason: string
): Promise<UserLookupResult> {
  const escaped = email.replace(/'/g, "''");

  // Log the email lookup to audit trail
  const result = await psqlPiped(config, `
    INSERT INTO admin_audit_log (accessor, action, target_user_id, reason, metadata)
    SELECT 'konvo-admin-cli:${runbookId}', 'email_lookup', au.id, '${reason.replace(/'/g, "''")}',
           jsonb_build_object('email_searched', '${escaped}')
    FROM auth.users au WHERE lower(au.email) = lower('${escaped}');

    SELECT au.id::text as user_id, p.platform_id
    FROM auth.users au
    JOIN profiles p ON p.id = au.id
    WHERE lower(au.email) = lower('${escaped}');
  `, 'supabase_admin');

  const idMatch = result.stdout.match(/([0-9a-f-]{36})/);
  const pidMatch = result.stdout.match(/(hvx_[A-Z0-9]+|kvx_[a-z0-9]+)/);

  if (!idMatch) return { found: false };

  return {
    found: true,
    userId: idMatch[1],
    platformId: pidMatch?.[1] ?? undefined
  };
}

/**
 * Look up a user by platform_id (no audit needed — no PII exposed).
 */
export async function lookupUserByPlatformId(
  config: Config,
  platformId: string
): Promise<UserLookupResult> {
  const escaped = platformId.replace(/'/g, "''");

  const result = await psqlPiped(config, `
    SELECT p.id::text as user_id, p.platform_id
    FROM profiles p
    WHERE p.platform_id = '${escaped}';
  `, 'supabase_admin');

  const idMatch = result.stdout.match(/([0-9a-f-]{36})/);
  if (!idMatch) return { found: false };

  return {
    found: true,
    userId: idMatch[1],
    platformId
  };
}
