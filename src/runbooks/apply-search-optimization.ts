/**
 * Runbook — Apply search performance optimization.
 *
 * Load testing (houvox-pwa/scripts/loadtest) found the live search_users does a
 * Seq Scan — it wraps the indexed column in coalesce(display_name,'') % query,
 * so the trgm/GIN indexes are never used (231ms/10k rows → ~180s projected at
 * 8M). This runbook applies the two fixes, safest-first:
 *
 *   1. INDEXES (safe, generic): trgm GIN on username + display_name, a prefix
 *      btree, and a tsvector GIN on posts.content. CREATE INDEX CONCURRENTLY —
 *      online, non-locking, idempotent. Applied on confirm.
 *
 *   2. FUNCTION (gated, reconcile-required): replace search_users with an
 *      index-friendly UNION of per-index branches. The prod body is DRIFT (not
 *      in repo migrations), so this runbook DUMPS the real definition and makes
 *      the operator confirm the rewrite preserves its semantics before applying.
 *      Declining leaves the indexes in place (still a win) and skips the swap.
 *
 * Read step (pg_get_functiondef, EXPLAIN, pg_indexes) is read-only. All writes
 * are behind explicit confirms + honour ctx.dryRun. Applies as supabase_admin.
 *
 * Risk: high (prod DDL + a live function swap). Rollback: re-CREATE the original
 * body shown in the dump; DROP INDEX CONCURRENTLY the added indexes.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

// ── Index set. TYPEAHEAD FIX = prefix btree (text_pattern_ops): index-usable at
//    ANY query length (incl. 2-char), which trgm GIN cannot do for infix ILIKE
//    (<3 chars has no full trigram). Validated 8–12ms @10k vs 168ms seq scan.
//    trgm GIN stays for search_posts / search_tags_prefix (they use ILIKE, 3+ ch).
//    CONCURRENTLY = online, no table lock. ──
const INDEX_STMTS: string[] = [
  `create extension if not exists pg_trgm;`,
  `create index concurrently if not exists user_usernames_username_prefix_idx on public.user_usernames (username text_pattern_ops) where is_active;`,
  `create index concurrently if not exists user_usernames_display_lower_prefix_idx on public.user_usernames (lower(display_name) text_pattern_ops) where is_active;`,
  `create index concurrently if not exists posts_content_trgm_idx on public.posts using gin (content gin_trgm_ops) where deleted_at is null;`,
  `create index concurrently if not exists tags_name_trgm_idx on public.tags using gin (name gin_trgm_ops);`,
  `create index concurrently if not exists tags_slug_trgm_idx on public.tags using gin (slug gin_trgm_ops);`
];

// ── PREFIX search_users (interim quick-fix; Meilisearch is the real fix — see
//    planning/PRD-meilisearch-search.md). Preserves SECURITY DEFINER + return
//    shape + similarity ranking. Behaviour change: username/display_name now
//    PREFIX-match (starts-with) not infix (contains); fuzzy typo-tolerance moves
//    to Meilisearch. Uses EXPLICIT RANGE BOUNDS (~>=~ / ~<~) rather than
//    LIKE $1||'%' because SECURITY DEFINER blocks sql-function inlining, so a
//    parameterised LIKE gets a generic plan that ignores the btree — range
//    bounds are index-usable with parameters. Validated 8–12ms @10k. ──
const OPTIMIZED_SEARCH_USERS = `CREATE OR REPLACE FUNCTION public.search_users(query text, result_limit integer DEFAULT 5)
 RETURNS TABLE(user_id uuid, username text, display_name text, avatar_url text, similarity real)
 LANGUAGE sql STABLE SECURITY DEFINER
AS $fn$
  SELECT user_id, username, display_name, avatar_url, sim FROM (
    SELECT DISTINCT ON (user_id) uu.user_id, uu.username, uu.display_name, uu.avatar_url,
           GREATEST(similarity(uu.username, query), similarity(COALESCE(uu.display_name,''), query)) AS sim
    FROM user_usernames uu
    WHERE uu.is_active AND (
      (uu.username ~>=~ lower(query) AND uu.username ~<~ (lower(query) || chr(255)))
      OR (lower(uu.display_name) ~>=~ lower(query) AND lower(uu.display_name) ~<~ (lower(query) || chr(255)))
    )
    ORDER BY uu.user_id, sim DESC
  ) d
  ORDER BY sim DESC
  LIMIT result_limit;
$fn$;`;

// EXPLAIN the UNDERLYING prefix query (a SECURITY DEFINER sql function only shows
// "Function Scan"). Want an Index/Bitmap scan on the prefix indexes, not Seq Scan.
const PLAN_PROBE = `explain (analyze, costs off) select uu.user_id
  from user_usernames uu
  where uu.is_active
    and ((uu.username ~>=~ 'al' and uu.username ~<~ ('al' || chr(255)))
      or (lower(uu.display_name) ~>=~ 'al' and lower(uu.display_name) ~<~ ('al' || chr(255))));`;

async function readOnly(ctx: RunbookContext, sql: string): Promise<string> {
  const wrapped = `\\set QUIET on\n\\pset pager off\n${sql}`;
  const res = await psqlPiped(ctx.config, wrapped, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 300)}`);
  }
  return res.stdout.trim();
}

const runbook: Runbook = {
  id:          'apply-search-optimization',
  title:       'Apply search performance optimization',
  description: 'Add trgm/tsvector indexes + swap search_users to an index-friendly form. Dumps the real function first for reconciliation.',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Read-only inspection: current function, indexes, and plan.
    const sp1 = prompt.spinner();
    sp1.start('Reading live search_users + indexes (read-only)…');
    let currentDef = '', currentIdx = '', currentPlan = '';
    try {
      currentDef =  await readOnly(ctx,
        `select pg_get_functiondef('public.search_users(text,integer)'::regprocedure);`);
      currentIdx =  await readOnly(ctx,
        `select indexname from pg_indexes where tablename in ('user_usernames','posts') order by 1;`);
      currentPlan = await readOnly(ctx, PLAN_PROBE);
    } catch (err) {
      sp1.stop('Read failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp1.stop('Live state read.');

    const usesSeqScan = /Seq Scan/i.test(currentPlan);
    prompt.note(
      [
        c.bold('Current search_users plan:'),
        currentPlan.split('\n').slice(0, 8).join('\n'),
        '',
        usesSeqScan ? c.yellow('→ Seq Scan detected: the index fix applies.')
                    : c.dim('→ No Seq Scan detected; indexes may already be in use.'),
        '',
        c.bold('Existing indexes:'),
        currentIdx || c.dim('(none)')
      ].join('\n'),
      'Read-only inspection'
    );

    prompt.note(currentDef, 'LIVE search_users definition (reconcile against this)');

    // 2. Confirm the index step (safe).
    const doIndexes = await prompt.confirm({
      message: `Apply ${INDEX_STMTS.length - 1} CONCURRENTLY indexes (safe, online)?`,
      initialValue: true
    });
    if (prompt.isCancel(doIndexes)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

    // 3. Confirm the function swap (gated on reconciliation).
    prompt.note(OPTIMIZED_SEARCH_USERS, 'Proposed index-friendly search_users');
    const doFn = await prompt.confirm({
      message: 'Swap search_users to the proposed body? Only if it matches the LIVE definition\'s columns + semantics above.',
      initialValue: false
    });
    if (prompt.isCancel(doFn)) { prompt.cancel('Cancelled.'); return { success: false, summary: 'Operator cancelled.' }; }

    if (!doIndexes && !doFn) {
      return { success: true, summary: 'Nothing selected — no changes made.' };
    }

    if (ctx.dryRun) {
      prompt.note(c.yellow('(dry-run) Would apply: '
        + [doIndexes ? 'indexes' : '', doFn ? 'search_users swap' : ''].filter(Boolean).join(' + ')),
        'Dry-run');
      return { success: true, summary: 'Dry-run — no changes applied.',
        details: { doIndexes, doFn, usesSeqScan, dryRun: true } };
    }

    const finalConfirm = await prompt.confirm({ message: 'Apply to PRODUCTION now?', initialValue: false });
    if (prompt.isCancel(finalConfirm) || !finalConfirm) { prompt.cancel('Aborted.'); return { success: false, summary: 'Operator did not confirm.' }; }

    // 4. Apply. Indexes first (each CONCURRENTLY runs in its own txn), then fn.
    if (doIndexes) {
      const sp = prompt.spinner(); sp.start('Creating indexes (CONCURRENTLY)…');
      // CONCURRENTLY cannot run inside a transaction block; send one at a time.
      for (const stmt of INDEX_STMTS) {
        const r = await psqlPiped(ctx.config, stmt + '\n', 'supabase_admin');
        if (r.exitCode !== 0) { sp.stop('Index step failed.'); return { success: false, summary: `Index failed: ${r.stderr.trim().slice(0,200)}` }; }
      }
      await psqlPiped(ctx.config, `analyze public.user_usernames; analyze public.posts;\n`, 'supabase_admin');
      sp.stop('Indexes created.');
    }

    if (doFn) {
      const sp = prompt.spinner(); sp.start('Replacing search_users…');
      const r = await psqlPiped(ctx.config, OPTIMIZED_SEARCH_USERS + '\n', 'supabase_admin');
      if (r.exitCode !== 0) { sp.stop('Function swap failed.'); return { success: false, summary: `Function swap failed: ${r.stderr.trim().slice(0,200)}` }; }
      sp.stop('search_users replaced.');
    }

    // 5. Verify — plan should no longer be a Seq Scan.
    let afterPlan = '';
    try { afterPlan = await readOnly(ctx, PLAN_PROBE); } catch { /* non-fatal */ }
    const fixed = afterPlan && !/Seq Scan/i.test(afterPlan) && /Index/i.test(afterPlan);
    prompt.note(
      [c.bold('search_users plan after apply:'), afterPlan.split('\n').slice(0, 8).join('\n'), '',
       fixed ? c.brand('✓ Bitmap/Index Scan — Seq Scan gone.') : c.yellow('⚠ Verify manually — plan not clearly index-based.')].join('\n'),
      'Verification'
    );

    // 6. Audit.
    const audit = await writeAudit(ctx.config, {
      runbookId: 'apply-search-optimization',
      action:    'search-optimization-applied',
      target:    [doIndexes ? 'indexes' : '', doFn ? 'search_users' : ''].filter(Boolean).join('+'),
      metadata:  { doIndexes, doFn, seqScanBefore: usesSeqScan, indexScanAfter: !!fixed },
      dryRun:    ctx.dryRun
    });
    if (!audit.ok) prompt.note(c.yellow(`Audit write failed (op succeeded): ${audit.error}`), 'Warning');

    return {
      success: true,
      summary: `Applied ${[doIndexes ? 'indexes' : '', doFn ? 'search_users swap' : ''].filter(Boolean).join(' + ')}. Plan index-based: ${fixed ? 'yes' : 'verify'}.`,
      details: { seqScanBefore: usesSeqScan, indexScanAfter: !!fixed }
    };
  }
};

export default runbook;
