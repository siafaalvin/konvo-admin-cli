/**
 * Thin Stripe SDK wrapper. Only exposes the operations the runbooks
 * actually use, so we don't accidentally surface broad capability.
 *
 * Reads `KONVO_STRIPE_SECRET_KEY` from env. Throws on access if
 * unset — runbooks that need Stripe should declare requires:
 * ['stripe'] (not yet implemented in the launcher; for now they
 * just call requireStripe() at runbook entry).
 */

import Stripe from 'stripe';
import type { Config } from './config.ts';

let cached: Stripe | null = null;

/**
 * Get a configured Stripe client. Throws if the env var is missing.
 * Caches the client across runbooks within a single CLI session.
 */
export function requireStripe(cfg: Config): Stripe {
  if (cached) return cached;
  if (!cfg.stripeSecretKey) {
    throw new Error(
      'KONVO_STRIPE_SECRET_KEY is unset. Add it to .env (sk_live_... for prod, sk_test_... for dry-runs).'
    );
  }
  cached = new Stripe(cfg.stripeSecretKey, {
    typescript: true,
    appInfo: {
      name:    'konvo-admin-cli',
      version: '0.1.0'
    }
  });
  return cached;
}

/** Mode of the loaded key — useful for safety messages. */
export function stripeMode(cfg: Config): 'live' | 'test' | 'unset' {
  if (!cfg.stripeSecretKey) return 'unset';
  return cfg.stripeSecretKey.startsWith('sk_live_') ? 'live' : 'test';
}

/**
 * Find a single customer by email. Stripe permits duplicate
 * customers per email, so we sort by created desc and return the
 * most recent — that's the one the worker would have created on
 * the user's most recent payment attempt.
 */
export async function findCustomerByEmail(
  cfg: Config,
  email: string
): Promise<Stripe.Customer | null> {
  const stripe = requireStripe(cfg);
  const search = await stripe.customers.search({
    query: `email:"${email.replace(/"/g, '\\"')}"`,
    limit: 5
  });
  if (search.data.length === 0) return null;
  // Sort newest first.
  const sorted = [...search.data].sort((a, b) => b.created - a.created);
  return sorted[0]!;
}

/** List recent successful payment intents for a customer. */
export async function listSuccessfulPaymentIntents(
  cfg: Config,
  customerId: string,
  limit = 10
): Promise<Stripe.PaymentIntent[]> {
  const stripe = requireStripe(cfg);
  const list = await stripe.paymentIntents.list({
    customer: customerId,
    limit
  });
  return list.data.filter((pi) => pi.status === 'succeeded');
}

/** Issue a full refund of a payment intent. */
export async function refundPaymentIntent(
  cfg: Config,
  paymentIntentId: string,
  reason: 'requested_by_customer' | 'duplicate' | 'fraudulent' = 'requested_by_customer'
): Promise<Stripe.Refund> {
  const stripe = requireStripe(cfg);
  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    reason
  });
}

/**
 * Format an amount in cents as the user-visible string.
 * Stripe's `amount` is always in the smallest currency unit.
 */
export function formatAmount(amountCents: number, currency: string): string {
  const symbol = currency.toLowerCase() === 'usd' ? '$' : '';
  return `${symbol}${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

// ─── Catalog management primitives ──────────────────────────────────────
// Used by the sync-stripe-catalog runbook. Find-or-create semantics so
// the runbook is idempotent.

/**
 * Find a Product by metadata.konvo_id. Stripe's search API supports
 * metadata queries on products; this lets us use stable kebab-case
 * ids instead of Stripe's `prod_xxx` ids.
 */
export async function findProductByKonvoId(
  cfg: Config,
  konvoId: string
): Promise<Stripe.Product | null> {
  const stripe = requireStripe(cfg);
  const search = await stripe.products.search({
    query: `active:'true' AND metadata['konvo_id']:'${konvoId}'`,
    limit: 1
  });
  return search.data[0] ?? null;
}

/**
 * Create or update a Product. If a product exists with metadata.konvo_id
 * matching, update its name/description/metadata. Otherwise create a new
 * one.
 *
 * Returns the (possibly newly created) Product.
 */
export async function upsertProduct(
  cfg: Config,
  spec: {
    konvoId:     string;
    name:        string;
    description: string;
    metadata?:   Record<string, string>;
  }
): Promise<{ product: Stripe.Product; created: boolean }> {
  const stripe = requireStripe(cfg);
  const existing = await findProductByKonvoId(cfg, spec.konvoId);

  const fullMetadata = { ...spec.metadata, konvo_id: spec.konvoId };

  if (existing) {
    const updated = await stripe.products.update(existing.id, {
      name:        spec.name,
      description: spec.description,
      metadata:    fullMetadata
    });
    return { product: updated, created: false };
  }

  const created = await stripe.products.create({
    name:        spec.name,
    description: spec.description,
    metadata:    fullMetadata
  });
  return { product: created, created: true };
}

/**
 * Find an active Price for a product matching amount + currency +
 * recurring spec. Returns null if no match.
 */
export async function findActivePrice(
  cfg: Config,
  productId:    string,
  amountCents:  number,
  currency:     string,
  recurring?:   { interval: 'year' | 'month'; intervalCount: number }
): Promise<Stripe.Price | null> {
  const stripe = requireStripe(cfg);
  const list = await stripe.prices.list({
    product: productId,
    active:  true,
    limit:   100
  });
  return list.data.find((p) => {
    if (p.unit_amount !== amountCents) return false;
    if (p.currency !== currency)        return false;
    if (recurring) {
      if (!p.recurring) return false;
      if (p.recurring.interval !== recurring.interval) return false;
      if ((p.recurring.interval_count ?? 1) !== recurring.intervalCount) return false;
    } else {
      if (p.recurring) return false;
    }
    return true;
  }) ?? null;
}

/**
 * List all active Prices on a Product (regardless of amount). Used when
 * we need to archive every old price after creating a new one with a
 * different amount.
 */
export async function listActivePrices(
  cfg: Config,
  productId: string
): Promise<Stripe.Price[]> {
  const stripe = requireStripe(cfg);
  const list = await stripe.prices.list({
    product: productId,
    active:  true,
    limit:   100
  });
  return list.data;
}

/**
 * Create a Price for a product, optionally with a lookup_key. If a
 * price with the same lookup_key already exists on a different
 * product/amount, transfers the lookup_key to the new price (idempotent
 * "I want this lookup_key to point at this current price").
 */
export async function createPrice(
  cfg: Config,
  productId:    string,
  amountCents:  number,
  currency:     string,
  recurring?:   { interval: 'year' | 'month'; intervalCount: number },
  lookupKey?:   string
): Promise<Stripe.Price> {
  const stripe = requireStripe(cfg);
  const params: Stripe.PriceCreateParams = {
    product:       productId,
    unit_amount:   amountCents,
    currency
  };
  if (recurring) {
    params.recurring = {
      interval:       recurring.interval,
      interval_count: recurring.intervalCount
    };
  }
  if (lookupKey) {
    params.lookup_key          = lookupKey;
    params.transfer_lookup_key = true;
  }
  return stripe.prices.create(params);
}

/**
 * Archive a Price (set active=false). Used after creating a new price
 * to replace an old one — Stripe doesn't permit price-amount edits, so
 * "change the price" actually means "create new + archive old".
 */
export async function archivePrice(
  cfg: Config,
  priceId: string
): Promise<Stripe.Price> {
  const stripe = requireStripe(cfg);
  return stripe.prices.update(priceId, { active: false });
}
