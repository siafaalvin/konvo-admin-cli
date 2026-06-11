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
