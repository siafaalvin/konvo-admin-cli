/**
 * Konvo Stripe product catalog — single source of truth.
 *
 * Mirrors planning/houvox/STRIPE-V2-PRODUCTS.md in the houvox-pwa
 * repo. The sync-stripe-catalog runbook reads this file and creates
 * (or updates) matching Products + Prices in Stripe via the API.
 *
 * Each entry has a stable `localId` (used as the Stripe product
 * `metadata.konvo_id`) and a `priceFile` name (where the resulting
 * Stripe Price ID gets written to disk + ultimately scp'd to
 * /root/.konvo-prod/stripe-prices/<priceFile>.txt on the VPS).
 *
 * To add a new product: append to CATALOG, run the
 * sync-stripe-catalog runbook. To change a price: change the
 * amount, run the runbook — it creates a new Price (Stripe doesn't
 * permit price edits) and archives the old one.
 */

export interface CatalogEntry {
  /** Stable kebab-case id; written to product.metadata.konvo_id. */
  localId:       string;
  /** Display name for Stripe dashboard. */
  name:          string;
  /** Description shown to customers in Checkout. */
  description:   string;
  /** Amount in the smallest currency unit (cents for USD). */
  amountCents:   number;
  currency:      'usd';
  /** Recurring billing for subscriptions; undefined for one-time. */
  recurring?: {
    interval:      'year' | 'month';
    intervalCount: number;
  };
  /** Filename (without .txt) for the resulting Price ID file. */
  priceFile:     string;
  /** Optional Stripe lookup_key for stable price retrieval. */
  lookupKey?:    string;
  /** Free-form metadata stored on the Product. */
  metadata?:     Record<string, string>;
}

export const CATALOG: CatalogEntry[] = [
  // ─── Standard band ─────────────────────────────────────────────
  {
    localId:     'standard-floor',
    name:        'Konvo Standard',
    description: 'Lifetime baseline membership with 1:1 code-based chat.',
    amountCents: 100,
    currency:    'usd',
    priceFile:   'standard-floor',
    lookupKey:   'standard_floor_v2',
    metadata:    { konvo_band: 'standard', konvo_tier: 'standard' }
  },
  {
    localId:     'standard-resident',
    name:        'Konvo Resident',
    description: 'Lifetime resident membership with location-verified messaging + neighborhood group chat.',
    amountCents: 1000,
    currency:    'usd',
    priceFile:   'standard-resident',
    lookupKey:   'standard_resident_v2',
    metadata:    { konvo_band: 'standard', konvo_tier: 'resident' }
  },
  {
    localId:     'standard-resident-plus',
    name:        'Konvo Resident+',
    description: 'Lifetime premium membership with priority access, lower per-action point costs, and proximity contact.',
    amountCents: 2000,
    currency:    'usd',
    priceFile:   'standard-resident-plus',
    lookupKey:   'standard_resident_plus_v2',
    metadata:    { konvo_band: 'standard', konvo_tier: 'resident_plus' }
  },

  // ─── Campaign band (promo discount) ────────────────────────────
  {
    localId:     'campaign-resident',
    name:        'Konvo Resident (Campaign)',
    description: 'Launch-campaign discounted lifetime resident membership.',
    amountCents: 100,
    currency:    'usd',
    priceFile:   'campaign-resident',
    lookupKey:   'campaign_resident_v2',
    metadata:    { konvo_band: 'campaign', konvo_tier: 'resident' }
  },
  {
    localId:     'campaign-resident-plus',
    name:        'Konvo Resident+ (Campaign)',
    description: 'Launch-campaign discounted lifetime premium membership.',
    amountCents: 200,
    currency:    'usd',
    priceFile:   'campaign-resident-plus',
    lookupKey:   'campaign_resident_plus_v2',
    metadata:    { konvo_band: 'campaign', konvo_tier: 'resident_plus' }
  },

  // ─── Business badges (annual subscriptions) ────────────────────
  {
    localId:     'business-individual',
    name:        'Konvo Business — Individual',
    description: 'Verified business badge for individual professionals (consultants, sole proprietors).',
    amountCents: 4500,
    currency:    'usd',
    recurring:   { interval: 'year', intervalCount: 1 },
    priceFile:   'business-individual',
    lookupKey:   'business_individual_yearly_v2',
    metadata:    { konvo_band: 'business', konvo_tier: 'individual' }
  },
  {
    localId:     'business-nonprofit',
    name:        'Konvo Business — Educational / Non-profit',
    description: 'Verified business badge for educational institutions and non-profit organizations.',
    amountCents: 4500,
    currency:    'usd',
    recurring:   { interval: 'year', intervalCount: 1 },
    priceFile:   'business-nonprofit',
    lookupKey:   'business_nonprofit_yearly_v2',
    metadata:    { konvo_band: 'business', konvo_tier: 'nonprofit' }
  },
  {
    localId:     'business-corporate',
    name:        'Konvo Business — Corporate',
    description: 'Verified business badge for corporate organizations.',
    amountCents: 45000,
    currency:    'usd',
    recurring:   { interval: 'year', intervalCount: 1 },
    priceFile:   'business-corporate',
    lookupKey:   'business_corporate_yearly_v2',
    metadata:    { konvo_band: 'business', konvo_tier: 'corporate' }
  },
  {
    localId:     'business-government',
    name:        'Konvo Business — Government',
    description: 'Verified business badge for government agencies and federal contractors.',
    amountCents: 45000000,
    currency:    'usd',
    recurring:   { interval: 'year', intervalCount: 1 },
    priceFile:   'business-government',
    lookupKey:   'business_government_yearly_v2',
    metadata:    { konvo_band: 'business', konvo_tier: 'government' }
  },

  // ─── Points purchases (one-time) ───────────────────────────────
  {
    localId:     'points-manual',
    name:        'Konvo Points — Manual Reload',
    description: '8 Konvo points for $5 (manual reload).',
    amountCents: 500,
    currency:    'usd',
    priceFile:   'points-manual',
    lookupKey:   'points_manual_5_8_v2',
    metadata:    { konvo_band: 'points', konvo_tier: 'manual', points_granted: '8' }
  },
  {
    localId:     'points-auto',
    name:        'Konvo Points — Auto-reload',
    description: '12 Konvo points for $5 (auto-reload bonus — requires saved payment method).',
    amountCents: 500,
    currency:    'usd',
    priceFile:   'points-auto',
    lookupKey:   'points_auto_5_12_v2',
    metadata:    { konvo_band: 'points', konvo_tier: 'auto', points_granted: '12' }
  },

  // ─── Vouch fee (one-time) ──────────────────────────────────────
  {
    localId:     'vouch-fee',
    name:        'Konvo Vouch Fee',
    description: 'Per-voucher fee for joining a vouch group ($5).',
    amountCents: 500,
    currency:    'usd',
    priceFile:   'vouch-fee',
    lookupKey:   'vouch_fee_v2',
    metadata:    { konvo_band: 'vouch', konvo_tier: 'fee' }
  }
];

/** Find a catalog entry by localId. */
export function findCatalogEntry(localId: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.localId === localId);
}
