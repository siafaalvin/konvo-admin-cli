#!/usr/bin/env bun
/**
 * Export the Konvo Stripe catalog to CSV.
 *
 * The Stripe dashboard does NOT accept CSV bulk-uploads for products
 * + prices in your own account (only the Agentic Commerce sellers
 * endpoint accepts CSV, and that's not relevant here). Use the
 * sync-stripe-catalog runbook to actually create products via the
 * API.
 *
 * This script exists so you can:
 *   - Eyeball the full catalog in a spreadsheet
 *   - Share with finance / stakeholders for pricing review
 *   - Diff catalog changes via git on a structured format
 *
 * Output: stripe-catalog.csv in the current directory.
 *
 * Run with:  bun run src/scripts/export-catalog-csv.ts
 */

import { writeFile } from 'node:fs/promises';
import { CATALOG } from '../lib/stripe-catalog.ts';

const headers = [
  'local_id',
  'name',
  'description',
  'amount_cents',
  'amount_display',
  'currency',
  'pricing_type',
  'recurring_interval',
  'recurring_interval_count',
  'lookup_key',
  'price_file',
  'metadata_band',
  'metadata_tier',
  'metadata_extra'
] as const;

function escape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const rows: string[] = [headers.join(',')];

for (const e of CATALOG) {
  const amountDisplay = `$${(e.amountCents / 100).toFixed(2)}`;
  const pricingType   = e.recurring ? 'recurring' : 'one_time';
  const interval      = e.recurring?.interval ?? '';
  const intervalCount = e.recurring?.intervalCount ?? '';
  const band          = e.metadata?.['konvo_band'] ?? '';
  const tier          = e.metadata?.['konvo_tier'] ?? '';
  const extras        = Object.entries(e.metadata ?? {})
    .filter(([k]) => k !== 'konvo_band' && k !== 'konvo_tier')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  rows.push([
    escape(e.localId),
    escape(e.name),
    escape(e.description),
    String(e.amountCents),
    escape(amountDisplay),
    escape(e.currency),
    escape(pricingType),
    escape(interval),
    String(intervalCount),
    escape(e.lookupKey ?? ''),
    escape(e.priceFile),
    escape(band),
    escape(tier),
    escape(extras)
  ].join(','));
}

const output = rows.join('\n') + '\n';
const path = 'data/stripe-catalog.csv';
await writeFile(path, output, 'utf8');

console.log(`✓ Wrote ${CATALOG.length} entries to ${path}`);
console.log(`  ${rows.length - 1} rows + 1 header line`);
console.log();
console.log('Note: Stripe does NOT accept this CSV via dashboard upload.');
console.log('Use the sync-stripe-catalog runbook to create products via API.');
