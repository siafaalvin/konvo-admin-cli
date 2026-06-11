/**
 * Phase 2 runbook — Verify worker env.
 *
 * Inspects the actual env vars loaded by the running konvo-worker-prod
 * container and reports on the ones we expect. The most common
 * post-deploy "is this configured right?" check.
 *
 * Surfaces:
 *   - Required vars that are unset (red ✗)
 *   - Optional vars that are unset (dim ·)
 *   - Set vars (green ✓)
 *   - Length-only for secret-y vars (never echoed)
 *
 * Reads via `docker exec konvo-worker-prod printenv`. The worker
 * container ships with printenv (busybox/coreutils), which is the
 * cleanest way to dump the actual loaded env without parsing
 * `docker inspect` output.
 *
 * Read-only.
 */

import { exec } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface ExpectedVar {
  name:      string;
  required:  boolean;
  hint:      string;
}

const EXPECTED: ExpectedVar[] = [
  // ── Core ────────────────────────────────────────────────────────
  { name: 'PORT',                          required: true,  hint: 'Worker HTTP port (default 8080)' },
  { name: 'NODE_ENV',                      required: true,  hint: 'production / staging' },

  // ── Supabase ────────────────────────────────────────────────────
  { name: 'SUPABASE_URL',                  required: true,  hint: 'Internal Supabase URL (Kong)' },
  { name: 'SUPABASE_ANON_KEY',             required: true,  hint: 'Anon JWT' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY',     required: true,  hint: 'Service-role JWT — secret' },
  { name: 'SUPABASE_JWT_SECRET',           required: true,  hint: 'JWT signing secret — secret' },

  // ── Stripe ──────────────────────────────────────────────────────
  { name: 'STRIPE_SECRET_KEY',             required: true,  hint: 'sk_live_... — secret' },
  { name: 'STRIPE_WEBHOOK_SECRET',         required: true,  hint: 'whsec_... — secret' },
  { name: 'STRIPE_PRICE_ID',               required: true,  hint: 'price_... for $1 access fee' },

  // ── Centrifugo ──────────────────────────────────────────────────
  { name: 'CENTRIFUGO_API_KEY',            required: true,  hint: 'API key for token bridge — secret' },
  { name: 'CENTRIFUGO_TOKEN_HMAC_SECRET',  required: true,  hint: 'HMAC for connection tokens — secret' },
  { name: 'CENTRIFUGO_HTTP_API_URL',       required: true,  hint: 'http://centrifugo:8000/api' },

  // ── Phase D / dispatch ──────────────────────────────────────────
  { name: 'DISPATCH_SHARED_SECRET',        required: false, hint: 'Matches konvo.dispatch_shared_secret GUC — secret' },

  // ── Email + verification ────────────────────────────────────────
  { name: 'RESEND_API_KEY',                required: false, hint: 'Transactional email — secret' },
  { name: 'MAPTILER_API_KEY',              required: false, hint: 'Geocoding — secret' }
];

const SECRET_RE = /secret|password|key|token/i;

async function readWorkerEnv(ctx: RunbookContext): Promise<Map<string, string>> {
  const psRes = await exec(
    ctx.config,
    `docker ps --format '{{.Names}}' | grep -E '^konvo-worker-prod$' | head -n 1`
  );
  const containerName = psRes.stdout.trim();
  if (!containerName) {
    throw new Error('konvo-worker-prod container not found.');
  }
  const res = await exec(ctx.config, `docker exec ${containerName} printenv`);
  if (res.exitCode !== 0) {
    throw new Error(`printenv exit ${res.exitCode}: ${res.stderr.trim().slice(0, 160)}`);
  }
  const map = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return map;
}

const runbook: Runbook = {
  id:          'verify-worker-env',
  title:       'Verify worker env',
  description: 'Inspect konvo-worker-prod env vars vs the expected list. Required missing → ✗, optional missing → dim.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const sp = prompt.spinner();
    sp.start('Reading worker env…');
    let env: Map<string, string>;
    try {
      env = await readWorkerEnv(ctx);
    } catch (err) {
      sp.stop('Read failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp.stop(`Worker env: ${env.size} vars.`);

    let missingRequired = 0;
    let setRequired     = 0;
    let missingOptional = 0;
    let setOptional     = 0;

    const lines: string[] = [];
    for (const v of EXPECTED) {
      const value   = env.get(v.name);
      const isSet   = value !== undefined && value.length > 0;
      const isSecret = SECRET_RE.test(v.name);

      let icon: string;
      let valueRendering: string;
      if (isSet) {
        icon = c.green('✓');
        valueRendering = isSecret ? c.dim(`<${value!.length} chars>`) : c.dim(value!.slice(0, 60));
        if (v.required) setRequired++; else setOptional++;
      } else if (v.required) {
        icon = c.red('✗');
        valueRendering = c.red('MISSING');
        missingRequired++;
      } else {
        icon = c.dim('·');
        valueRendering = c.dim('not set');
        missingOptional++;
      }

      lines.push(`  ${icon}  ${v.name.padEnd(34)} ${valueRendering}`);
      lines.push(`     ${c.dim(v.hint)}`);
    }

    prompt.note(lines.join('\n'), 'Worker env');

    const summaryLine = `${setRequired}/${setRequired + missingRequired} required set, ${setOptional}/${setOptional + missingOptional} optional set.`;
    return {
      success: missingRequired === 0,
      summary: missingRequired === 0
        ? `All required env vars set. ${summaryLine}`
        : `Missing ${missingRequired} required env var(s). ${summaryLine}`,
      details: { setRequired, missingRequired, setOptional, missingOptional, totalSeen: env.size }
    };
  }
};

export default runbook;
