/**
 * Loads operator config from environment / .env. Does NOT throw on
 * missing values — runbooks that need a value should validate at the
 * point of use and prompt the operator if missing.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

export interface Config {
  operator:        string;
  prodHost:        string;
  sshKey:          string;
  dbUrl:           string | null;
  stripeSecretKey: string | null;
  /**
   * Local path to the houvox-pwa repo clone. Used by deploy runbooks
   * that need to spawn `./coolify/production/05-deploy-worker.sh`.
   * Defaults to the sibling-folder layout (../houvox-pwa relative to
   * the operator's konvo-admin-cli clone) which matches the typical
   * setup. Override via KONVO_PWA_REPO_PATH if your layout differs.
   */
  pwaRepoPath:     string;
}

export function loadConfig(): Config {
  const env = (Bun.env ?? process.env) as Record<string, string | undefined>;

  // Default pwa repo path = sibling folder of the konvo-admin-cli root.
  // process.cwd() should be konvo-admin-cli/ when operator runs `bun start`.
  const cwd = process.cwd();
  const siblingPwa = join(dirname(cwd), 'houvox-pwa');

  return {
    operator:        env['KONVO_OPERATOR']?.trim()         || 'unknown',
    prodHost:        env['KONVO_PROD_HOST']?.trim()        || 'root@5.78.237.171',
    sshKey:          env['KONVO_SSH_KEY']?.trim()          || join(homedir(), '.ssh', 'id_ed25519'),
    dbUrl:           env['KONVO_DB_URL']?.trim()           || null,
    stripeSecretKey: env['KONVO_STRIPE_SECRET_KEY']?.trim() || null,
    pwaRepoPath:     env['KONVO_PWA_REPO_PATH']?.trim()    || (existsSync(siblingPwa) ? siblingPwa : '')
  };
}
