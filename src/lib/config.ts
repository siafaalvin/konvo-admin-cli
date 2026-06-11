/**
 * Loads operator config from environment / .env. Does NOT throw on
 * missing values — runbooks that need a value should validate at the
 * point of use and prompt the operator if missing.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  operator:        string;
  prodHost:        string;
  sshKey:          string;
  dbUrl:           string | null;
  stripeSecretKey: string | null;
}

export function loadConfig(): Config {
  const env = (Bun.env ?? process.env) as Record<string, string | undefined>;

  return {
    operator:        env['KONVO_OPERATOR']?.trim()         || 'unknown',
    prodHost:        env['KONVO_PROD_HOST']?.trim()        || 'root@5.78.237.171',
    sshKey:          env['KONVO_SSH_KEY']?.trim()          || join(homedir(), '.ssh', 'id_ed25519'),
    dbUrl:           env['KONVO_DB_URL']?.trim()           || null,
    stripeSecretKey: env['KONVO_STRIPE_SECRET_KEY']?.trim() || null
  };
}
