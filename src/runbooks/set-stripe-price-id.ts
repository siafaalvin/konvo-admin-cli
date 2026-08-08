/**
 * Runbook — set-stripe-price-id.
 *
 * Writes a Stripe price ID to the canonical price-file location on the
 * production VPS:
 *   /root/.konvo-prod/stripe-prices/<slot>.txt   (mode 0600, root-owned)
 *
 * The verification-worker's deploy script (`coolify/production/
 * 05-deploy-worker.sh`) reads these files via the `load_v2_price`
 * helper at deploy time, and passes the values through `docker run -e`
 * so they land in the worker config schema.
 *
 * Slots correspond to the SKUs in `planning/houvox/STRIPE-V2-PRODUCTS.md`.
 *
 * Operations the runbook handles:
 *   - Pick a known slot from the catalog (13 SKUs)
 *   - Read existing file (if any) and show its current value
 *   - Take a `price_xxx` ID with regex validation
 *   - Write the file via SSH with mode 600
 *   - Verify by reading back
 *   - Audit-log the change
 *   - Remind operator to redeploy worker for the change to take effect
 *
 * Risk: high. Misconfigured price IDs cause Stripe checkout to fail
 * silently for that tier. Operator confirms each write explicitly.
 *
 * Replaces the manual SSH + heredoc flow we used to populate the
 * 12 launch SKUs and the HOA tier SKU during v0.5.
 */

import { exec } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface SkuSlot {
  slot:        string;     // file basename, e.g. 'business-hoa'
  envVar:      string;     // env var name, e.g. 'STRIPE_PRICE_BUSINESS_HOA'
  description: string;     // operator-facing label
  hint:        string;     // listed price for sanity check
}

/**
 * Canonical SKU catalog. Order matches STRIPE-V2-PRODUCTS.md: tiers,
 * business badges, points, vouch fee. Keep the slot names as kebab-case;
 * deploy script's load_v2_price call relies on this exact mapping.
 */
const SKU_CATALOG: ReadonlyArray<SkuSlot> = [
  // Single-feature address tiers (band-agnostic annual)
  { slot: 'mailbox-plus',            envVar: 'STRIPE_PRICE_MAILBOX_PLUS',            description: 'Mailbox+ (HouseCall messaging)', hint: '$5.00/year' },
  // Standard tier band
  { slot: 'standard-floor',          envVar: 'STRIPE_PRICE_STANDARD_FLOOR',          description: 'Standard $1 (floor)',           hint: '$1.00 one-time' },
  { slot: 'standard-resident',       envVar: 'STRIPE_PRICE_STANDARD_RESIDENT',       description: 'Standard Resident',             hint: '$10.00 one-time' },
  { slot: 'standard-resident-plus',  envVar: 'STRIPE_PRICE_STANDARD_RESIDENT_PLUS',  description: 'Standard Resident+',            hint: '$20.00 one-time' },
  // Campaign tier band
  { slot: 'campaign-resident',       envVar: 'STRIPE_PRICE_CAMPAIGN_RESIDENT',       description: 'Campaign Resident',             hint: '$1.00 one-time (launch promo)' },
  { slot: 'campaign-resident-plus',  envVar: 'STRIPE_PRICE_CAMPAIGN_RESIDENT_PLUS',  description: 'Campaign Resident+',            hint: '$2.00 one-time (launch promo)' },
  // Business badges (annual subscriptions)
  { slot: 'business-individual',     envVar: 'STRIPE_PRICE_BUSINESS_INDIVIDUAL',     description: 'Business — Individual professional', hint: '$45/year' },
  { slot: 'business-nonprofit',      envVar: 'STRIPE_PRICE_BUSINESS_NONPROFIT',      description: 'Business — Educational / Non-profit', hint: '$45/year' },
  { slot: 'business-hoa',            envVar: 'STRIPE_PRICE_BUSINESS_HOA',            description: 'Business — HOA / Condo Association',  hint: '$100/year' },
  { slot: 'business-corporate',      envVar: 'STRIPE_PRICE_BUSINESS_CORPORATE',      description: 'Business — Corporate',                hint: '$450/year' },
  { slot: 'business-government',     envVar: 'STRIPE_PRICE_BUSINESS_GOVERNMENT',     description: 'Business — Government',               hint: '$450,000/year' },
  // Points purchases (one-time)
  { slot: 'points-manual',           envVar: 'STRIPE_PRICE_POINTS_MANUAL',           description: 'Points — Manual reload',        hint: '$5 → 8 points' },
  { slot: 'points-auto',             envVar: 'STRIPE_PRICE_POINTS_AUTO',             description: 'Points — Auto-reload',          hint: '$5 → 12 points' },
  // Vouch fee (one-time)
  { slot: 'vouch-fee',               envVar: 'STRIPE_PRICE_VOUCH_FEE',               description: 'Vouch group fee',               hint: '$5 one-time per voucher' }
];

const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]{20,}$/;
const PRICE_DIR        = '/root/.konvo-prod/stripe-prices';

const ACTION_OPTIONS = [
  { value: 'list',   label: 'List current price IDs',     hint: 'Show what\'s loaded for each slot' },
  { value: 'set',    label: 'Set or update a price ID',   hint: 'Write a new value for one SKU slot' },
  { value: '__exit', label: c.dim('Cancel'),              hint: c.dim('Return to main menu') }
] as const;

const runbook: Runbook = {
  id:          'set-stripe-price-id',
  title:       'Set Stripe price ID',
  description: 'Write or update a price-id file in /root/.konvo-prod/stripe-prices/ (consumed by 05-deploy-worker.sh). Audit-logged.',
  risk:        'high',
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

    if (action === 'list') return listPriceIds(ctx);
    if (action === 'set')  return setPriceId(ctx);
    return { success: false, summary: `Unknown action: ${action as string}` };
  }
};

// ─── list ────────────────────────────────────────────────────────────────

async function listPriceIds(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;
  const sp = prompt.spinner();
  sp.start('Reading price files…');

  // Read all files in one SSH round-trip. For-each loop printing
  // 'slot|content' lines. Missing files print 'slot|<unset>'.
  const cmd = SKU_CATALOG.map((s) =>
    `printf '%s|' '${s.slot}'; if [ -s '${PRICE_DIR}/${s.slot}.txt' ]; then cat '${PRICE_DIR}/${s.slot}.txt' | tr -d '\\n'; else printf '<unset>'; fi; printf '\\n'`
  ).join(' && ');
  const res = await exec(ctx.config, cmd);
  sp.stop('Done.');

  if (res.exitCode !== 0) {
    return { success: false, summary: `ssh exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
  }

  const map = new Map<string, string>();
  for (const line of res.stdout.split('\n')) {
    const [slot, value] = line.split('|');
    if (slot && value !== undefined) map.set(slot, value);
  }

  const rendered = SKU_CATALOG.map((sku) => {
    const value  = map.get(sku.slot) ?? '<unset>';
    const status = value === '<unset>'
      ? c.yellow('UNSET')
      : value.startsWith('price_')
        ? c.green('SET  ')
        : c.red('INVALID');
    const display = value === '<unset>'
      ? c.dim('—')
      : value.length > 30
        ? `${value.slice(0, 24)}…${value.slice(-4)}`
        : value;
    return `  ${status} ${sku.slot.padEnd(24)} ${display.padEnd(32)} ${c.dim(sku.hint)}`;
  }).join('\n');

  prompt.note(rendered, `${SKU_CATALOG.length} SKU slot(s)`);
  return {
    success: true,
    summary: `Listed ${SKU_CATALOG.length} price-ID slots.`,
    details: { slots: SKU_CATALOG.map((s) => s.slot) }
  };
}

// ─── set ─────────────────────────────────────────────────────────────────

async function setPriceId(ctx: RunbookContext): Promise<RunbookResult> {
  const { prompt } = ctx;

  // Pick the slot. Show description + hint + current set/unset status.
  const slotChoice = await prompt.select({
    message: 'Which SKU?',
    options: SKU_CATALOG.map((sku) => ({
      value: sku.slot,
      label: sku.description,
      hint:  `${sku.envVar} · ${sku.hint}`
    }))
  });
  if (prompt.isCancel(slotChoice)) {
    prompt.cancel('Cancelled.');
    return { success: false, summary: 'Operator cancelled.' };
  }
  const sku = SKU_CATALOG.find((s) => s.slot === slotChoice);
  if (!sku) {
    return { success: false, summary: 'Unknown slot.' };
  }

  // Read the current value (if any) so we can show a diff in the
  // confirm step.
  const readRes = await exec(
    ctx.config,
    `[ -s '${PRICE_DIR}/${sku.slot}.txt' ] && cat '${PRICE_DIR}/${sku.slot}.txt' | tr -d '\\n' || true`
  );
  const currentValue = readRes.exitCode === 0 ? readRes.stdout.trim() : '';

  if (currentValue) {
    prompt.note(
      `Current value: ${c.dim(currentValue)}`,
      `${sku.envVar} (${sku.description})`
    );
  } else {
    prompt.note(
      c.dim('No current value — slot is unset.'),
      `${sku.envVar} (${sku.description})`
    );
  }

  // Take the new price ID.
  const priceIdIn = await prompt.text({
    message: `New price ID for ${sku.description}`,
    placeholder: 'price_1Q...',
    validate: (v) => {
      const s = (v ?? '').trim();
      if (!s) return 'Required.';
      if (!PRICE_ID_PATTERN.test(s)) {
        return 'Must look like price_XXXXXXXXXXXXXXXXXXXX (Stripe price ID format).';
      }
      return undefined;
    }
  });
  if (prompt.isCancel(priceIdIn)) {
    prompt.cancel('Cancelled.');
    return { success: false, summary: 'Operator cancelled.' };
  }
  const priceId = (priceIdIn as string).trim();

  if (priceId === currentValue) {
    prompt.note(c.yellow('New value is identical to current — no change needed.'), 'No-op');
    return {
      success: true,
      summary: `No change — ${sku.envVar} already set to ${priceId}.`,
      details: { slot: sku.slot, env_var: sku.envVar, value: priceId, changed: false }
    };
  }

  // Confirm.
  prompt.note(
    [
      `Slot:        ${sku.slot}`,
      `Env var:     ${sku.envVar}`,
      `Tier:        ${sku.description}`,
      `Expected:    ${sku.hint}`,
      `Old value:   ${currentValue || c.dim('<unset>')}`,
      `New value:   ${c.brand(priceId)}`,
      ``,
      c.dim(`File: ${PRICE_DIR}/${sku.slot}.txt`)
    ].join('\n'),
    'Confirm change'
  );

  const confirmed = await prompt.confirm({
    message: 'Write this price ID? Worker will need redeploy for change to take effect.',
    initialValue: false
  });
  if (prompt.isCancel(confirmed) || !confirmed) {
    prompt.cancel('Aborted.');
    return { success: false, summary: 'Operator did not confirm.' };
  }

  if (ctx.dryRun) {
    return {
      success: true,
      summary: `Dry-run: would have written ${priceId} to ${sku.slot}.txt.`,
      details: { slot: sku.slot, env_var: sku.envVar, value: priceId, dryRun: true }
    };
  }

  // Write + verify in one round-trip. printf with '\n' suffix matches
  // the existing convention (cat | tr -d '\n' is read-side tolerant).
  // Stripe price IDs are guaranteed-safe characters (price_ + alphanumeric),
  // so single-quote-escaping in shell is sufficient.
  const writeCmd = [
    `mkdir -p '${PRICE_DIR}'`,
    `printf '%s\\n' '${priceId}' > '${PRICE_DIR}/${sku.slot}.txt'`,
    `chmod 600 '${PRICE_DIR}/${sku.slot}.txt'`,
    `cat '${PRICE_DIR}/${sku.slot}.txt' | tr -d '\\n'`
  ].join(' && ');

  const sp = prompt.spinner();
  sp.start('Writing price ID…');
  const res = await exec(ctx.config, writeCmd);
  if (res.exitCode !== 0) {
    sp.stop('Failed.');
    return { success: false, summary: `ssh exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}` };
  }
  sp.stop('Written.');

  const verified = res.stdout.trim();
  if (verified !== priceId) {
    return {
      success: false,
      summary: `Verification failed — wrote '${priceId}', read back '${verified}'.`,
      details: { slot: sku.slot, env_var: sku.envVar, attempted: priceId, read_back: verified }
    };
  }

  const audit = await writeAudit(ctx.config, {
    runbookId: 'set-stripe-price-id',
    action:    'price-id-set',
    target:    sku.slot,
    metadata:  {
      slot:      sku.slot,
      env_var:   sku.envVar,
      tier:      sku.description,
      old_value: currentValue || null,
      new_value: priceId
    },
    dryRun: ctx.dryRun
  });
  if (!audit.ok) {
    prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
  }

  prompt.note(
    [
      c.green(`✓ Wrote ${priceId} to ${sku.slot}.txt`),
      ``,
      c.yellow('Worker redeploy required'),
      c.dim('Run from your local clone:'),
      c.dim('  ./coolify/production/05-deploy-worker.sh root@5.78.237.171')
    ].join('\n'),
    'Next step'
  );

  return {
    success: true,
    summary: `Wrote ${sku.envVar} = ${priceId}. Worker redeploy required for the change to take effect.`,
    details: {
      slot:      sku.slot,
      env_var:   sku.envVar,
      old_value: currentValue || null,
      new_value: priceId,
      changed:   true
    }
  };
}

export default runbook;
