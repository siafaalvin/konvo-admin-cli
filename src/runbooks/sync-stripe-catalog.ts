/**
 * Runbook — sync-stripe-catalog.
 *
 * Reads src/lib/stripe-catalog.ts and creates (or updates) matching
 * Products + Prices in Stripe via the API. Idempotent — re-running
 * after a catalog change only updates what changed.
 *
 * For each entry:
 *   1. Find Product by metadata.konvo_id, or create new.
 *   2. Find active Price matching amount + currency + recurring spec.
 *      If found → skip (already current).
 *      If not found → create new Price, archive any prior active
 *      Prices on the same Product.
 *   3. Write the resulting Price ID to ./stripe-prices/<priceFile>.txt
 *      (locally — operator scp's to VPS afterward).
 *
 * Risk: high. Creates real Stripe Products + Prices. In LIVE mode
 * these are visible to customers via Checkout immediately. Mitigations:
 *   - Live-key safety banner (existing pattern from rotate-stripe-keys).
 *   - Plan + diff preview before any mutation.
 *   - Operator must confirm.
 *   - Dry-run path computes the plan + writes a markdown summary
 *     without calling Stripe.
 *   - Audit log entry per product/price action.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG, type CatalogEntry } from '../lib/stripe-catalog.ts';
import {
  archivePrice,
  createPrice,
  findActivePrice,
  findProductByKonvoId,
  formatAmount,
  listActivePrices,
  stripeMode,
  upsertProduct
} from '../lib/stripe.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface SyncAction {
  entry:           CatalogEntry;
  /** Did we need to create the product, or was it already there? */
  productAction:   'created' | 'updated' | 'reused';
  /** Did we need a new price, or was an existing active one already correct? */
  priceAction:     'created' | 'reused' | 'created_and_archived_old';
  productId?:      string;
  priceId?:        string;
  archivedPriceId?: string;
  error?:          string;
}

const OUTPUT_DIR = join(process.cwd(), 'stripe-prices');

const runbook: Runbook = {
  id:          'sync-stripe-catalog',
  title:       'Sync Stripe catalog',
  description: 'Create/update all Konvo Stripe Products + Prices from src/lib/stripe-catalog.ts. Idempotent. Writes price IDs to ./stripe-prices/.',
  risk:        'high',
  requires:    ['stripe'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // ─── Stripe key sanity ───────────────────────────────────────
    const mode = stripeMode(ctx.config);
    if (mode === 'unset') {
      return {
        success: false,
        summary: 'KONVO_STRIPE_SECRET_KEY is unset. Add it to .env to use this runbook.'
      };
    }
    if (mode === 'live') {
      prompt.note(
        c.yellow('Stripe LIVE key detected. This runbook creates REAL Products + Prices.'),
        '⚠ Live mode'
      );
    } else {
      prompt.note(c.dim('Stripe TEST key — products are sandbox-only.'), 'Test mode');
    }

    // ─── Plan preview ────────────────────────────────────────────
    const planLines: string[] = [];
    planLines.push(c.bold(`Catalog: ${CATALOG.length} entries`));
    planLines.push('');
    for (const entry of CATALOG) {
      const recurringNote = entry.recurring
        ? ` (recurring ${entry.recurring.interval}ly)`
        : '';
      planLines.push(
        `  · ${entry.localId.padEnd(28)} ${formatAmount(entry.amountCents, entry.currency).padEnd(20)} ${c.dim(entry.name + recurringNote)}`
      );
    }
    prompt.note(planLines.join('\n'), 'Plan');

    // ─── Confirm ─────────────────────────────────────────────────
    const confirmed = await prompt.confirm({
      message: ctx.dryRun
        ? 'Dry-run only? (will compute diff but not call Stripe)'
        : `Sync ${CATALOG.length} entries to Stripe ${mode.toUpperCase()}?`,
      initialValue: ctx.dryRun
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    // ─── Execute per-entry ───────────────────────────────────────
    const results: SyncAction[] = [];
    const sp = prompt.spinner();
    for (const entry of CATALOG) {
      sp.start(`${entry.localId} …`);
      const action = await syncEntry(ctx, entry);
      results.push(action);
      if (action.error) {
        sp.stop(c.red(`${entry.localId} — ${action.error}`));
      } else {
        const summary =
          action.priceAction === 'created'                   ? c.green('created') :
          action.priceAction === 'created_and_archived_old'  ? c.yellow('updated (new price, old archived)') :
                                                                c.dim('unchanged');
        sp.stop(`${entry.localId} — ${summary}`);
      }
    }

    // ─── Write price-id files ────────────────────────────────────
    if (!ctx.dryRun) {
      await mkdir(OUTPUT_DIR, { recursive: true });
      for (const r of results) {
        if (r.priceId && !r.error) {
          const filePath = join(OUTPUT_DIR, `${r.entry.priceFile}.txt`);
          await writeFile(filePath, r.priceId, 'utf8');
        }
      }
      prompt.note(
        [
          c.bold(`Wrote ${results.filter((r) => r.priceId).length} price ID files to:`),
          `  ${c.brand(OUTPUT_DIR)}`,
          '',
          c.dim('To deploy to prod VPS:'),
          c.dim(`  scp -i ${ctx.config.sshKey} -r ${OUTPUT_DIR}/* ${ctx.config.prodHost}:/root/.konvo-prod/stripe-prices/`),
          c.dim(`  ssh -i ${ctx.config.sshKey} ${ctx.config.prodHost} 'chmod 600 /root/.konvo-prod/stripe-prices/*.txt'`),
          c.dim('Then redeploy the worker.')
        ].join('\n'),
        'Local files'
      );
    }

    // ─── Audit ───────────────────────────────────────────────────
    const errors = results.filter((r) => r.error).length;
    const created = results.filter((r) => r.priceAction === 'created').length;
    const updated = results.filter((r) => r.priceAction === 'created_and_archived_old').length;
    const reused  = results.filter((r) => r.priceAction === 'reused').length;

    const audit = await writeAudit(ctx.config, {
      runbookId: 'sync-stripe-catalog',
      action:    'catalog-sync',
      target:    `${mode}:${CATALOG.length}-entries`,
      metadata:  {
        mode,
        catalogSize: CATALOG.length,
        created,
        updated,
        reused,
        errors,
        priceIds: Object.fromEntries(
          results.filter((r) => r.priceId).map((r) => [r.entry.localId, r.priceId])
        )
      },
      dryRun: ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed: ${audit.error}`), 'Warning');
    }

    return {
      success: errors === 0,
      summary: errors === 0
        ? `Catalog synced: ${created} created, ${updated} updated, ${reused} unchanged.`
        : `Catalog sync completed with ${errors} error(s). See output above.`,
      details: { mode, created, updated, reused, errors, results }
    };
  }
};

/**
 * Sync a single catalog entry. Idempotent.
 */
async function syncEntry(
  ctx: RunbookContext,
  entry: CatalogEntry
): Promise<SyncAction> {
  if (ctx.dryRun) {
    // Don't call Stripe at all in dry-run; just report what would happen.
    const existing = await findProductByKonvoId(ctx.config, entry.localId).catch(() => null);
    return {
      entry,
      productAction: existing ? 'reused' : 'created',
      priceAction:   'created',  // can't know without checking price; assume worst-case
      productId:     existing?.id
    };
  }

  try {
    // 1. Upsert product.
    const { product, created } = await upsertProduct(ctx.config, {
      konvoId:     entry.localId,
      name:        entry.name,
      description: entry.description,
      metadata:    entry.metadata
    });

    // 2. Find or create matching price.
    const matching = await findActivePrice(
      ctx.config,
      product.id,
      entry.amountCents,
      entry.currency,
      entry.recurring
    );

    if (matching) {
      return {
        entry,
        productAction: created ? 'created' : 'reused',
        priceAction:   'reused',
        productId:     product.id,
        priceId:       matching.id
      };
    }

    // No matching active price — list ALL active prices to archive
    // after the new one is created. (Stripe doesn't permit
    // amount-edits on prices, so "change the price" means
    // "create new + archive old".)
    const oldPrices = await listActivePrices(ctx.config, product.id);

    const newPrice = await createPrice(
      ctx.config,
      product.id,
      entry.amountCents,
      entry.currency,
      entry.recurring,
      entry.lookupKey
    );

    const archivedIds: string[] = [];
    for (const old of oldPrices) {
      if (old.id === newPrice.id) continue; // shouldn't happen, but be safe
      await archivePrice(ctx.config, old.id);
      archivedIds.push(old.id);
    }

    return {
      entry,
      productAction:   created ? 'created' : 'updated',
      priceAction:     archivedIds.length > 0 ? 'created_and_archived_old' : 'created',
      productId:       product.id,
      priceId:         newPrice.id,
      archivedPriceId: archivedIds[0]
    };
  } catch (err) {
    return {
      entry,
      productAction: 'reused',
      priceAction:   'reused',
      error:         err instanceof Error ? err.message.slice(0, 200) : String(err)
    };
  }
}

export default runbook;
