/**
 * Runbook — toggle-soft-signal-mode.
 *
 * Flips public.verification_settings.soft_signal_mode between 'shadow'
 * and 'enforce' (houvox-pwa migration 0133, location-verification R5).
 *
 *   shadow  — the background soft-check records signals + rolling
 *             confidence and LOGS a would-be demand (would_open_demand),
 *             but never opens a real demand. Safe to run indefinitely;
 *             it's how you measure the false-positive rate first.
 *   enforce — a sustained mismatch (>=5 samples AND confidence < 0.40)
 *             opens a GENTLE soft_signal demand (2 check-ins, 21-day
 *             grace, lowest priority). Still never restricts immediately.
 *
 * Effect is immediate: soft_signal_mode() is read on the next signal.
 * No worker restart needed.
 *
 * Before flipping to enforce, the runbook shows the shadow-mode tally
 * (signals by source + how many residencies WOULD have been demanded)
 * so you can judge the false-positive rate. Flipping to enforce is
 * high-risk (affects real users); flipping back to shadow is the undo.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface SoftSignalState {
  mode:                     'shadow' | 'enforce';
  total_signals:            number;
  gps_signals:              number;
  edge_signals:             number;
  would_open_signals:       number;
  would_open_residencies:   number;
  residencies_with_samples: number;
}

async function readState(ctx: RunbookContext): Promise<SoftSignalState> {
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

select
  'mode='                     || coalesce((select value #>> '{}' from public.verification_settings where key = 'soft_signal_mode'), 'shadow') || E'\\n' ||
  'total_signals='            || (select count(*)                    from public.residency_location_signals)::text || E'\\n' ||
  'gps_signals='              || (select count(*)                    from public.residency_location_signals where source = 'gps')::text || E'\\n' ||
  'edge_signals='             || (select count(*)                    from public.residency_location_signals where source = 'edge_geo')::text || E'\\n' ||
  'would_open_signals='       || (select count(*)                    from public.residency_location_signals where would_open_demand)::text || E'\\n' ||
  'would_open_residencies='   || (select count(distinct residency_id) from public.residency_location_signals where would_open_demand)::text || E'\\n' ||
  'residencies_with_samples=' || (select count(distinct residency_id) from public.residency_location_signals)::text;
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
  const out = res.stdout.trim();
  const get = (key: string): string => {
    const m = out.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1]!.trim() : '';
  };
  const n = (key: string): number => parseInt(get(key) || '0', 10);
  const modeRaw = get('mode');
  return {
    mode:                     modeRaw === 'enforce' ? 'enforce' : 'shadow',
    total_signals:            n('total_signals'),
    gps_signals:              n('gps_signals'),
    edge_signals:             n('edge_signals'),
    would_open_signals:       n('would_open_signals'),
    would_open_residencies:   n('would_open_residencies'),
    residencies_with_samples: n('residencies_with_samples')
  };
}

const runbook: Runbook = {
  id:          'toggle-soft-signal-mode',
  title:       'Toggle soft-signal mode (shadow ⇄ enforce)',
  description: 'Flip verification_settings.soft_signal_mode. Shows the shadow-mode would-open tally before enabling enforcement. Effect is immediate.',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // ─── Read current state + shadow tally ────────────────────────
    const sp = prompt.spinner();
    sp.start('Reading soft-signal state…');
    let state: SoftSignalState;
    try {
      state = await readState(ctx);
    } catch (err) {
      sp.stop('Read failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp.stop('State read.');

    const target: 'shadow' | 'enforce' = state.mode === 'shadow' ? 'enforce' : 'shadow';

    // False-positive picture: in shadow, would_open_residencies is how many
    // residents WOULD have been asked to re-verify. High relative to the
    // sampled population = tune before enforcing.
    const fpPct = state.residencies_with_samples > 0
      ? (100 * state.would_open_residencies / state.residencies_with_samples)
      : 0;
    const fpDisplay = state.residencies_with_samples === 0
      ? c.dim('no samples yet')
      : (fpPct >= 5 ? c.red : fpPct > 0 ? c.yellow : c.green)(
          `${state.would_open_residencies}/${state.residencies_with_samples} residencies (${fpPct.toFixed(1)}%)`
        );

    prompt.note(
      [
        c.bold('Current soft-signal state'),
        '',
        `mode:                     ${state.mode === 'enforce' ? c.yellow('enforce') : c.dim('shadow')}`,
        `signals (total):          ${state.total_signals.toLocaleString()}  (${state.gps_signals} gps / ${state.edge_signals} edge)`,
        `residencies sampled:      ${state.residencies_with_samples.toLocaleString()}`,
        `would-open (shadow FP):   ${fpDisplay}`,
        '',
        c.bold('Will flip to'),
        '',
        `mode:                     ${target === 'enforce' ? c.yellow('enforce') : c.dim('shadow')}`,
        '',
        target === 'enforce'
          ? c.yellow('Sustained mismatches will now open gentle soft_signal demands (2 check-ins, 21-day grace). Never restricts immediately.')
          : c.green('Back to shadow: signals keep logging, but no soft_signal demand will open.'),
        target === 'enforce' && state.residencies_with_samples < 20
          ? '\n' + c.red(`⚠ Only ${state.residencies_with_samples} residencies sampled — thin data. Consider waiting for more before enforcing.`)
          : '',
        target === 'enforce' && fpPct >= 5
          ? '\n' + c.red(`⚠ Would-open rate is ${fpPct.toFixed(1)}% — that many residents would get a demand right away. Tune thresholds first?`)
          : '',
        ctx.dryRun ? '\n' + c.yellow('(dry-run — no change will be applied)') : ''
      ].filter(Boolean).join('\n'),
      'Soft-signal mode'
    );

    // ─── Confirm ──────────────────────────────────────────────────
    const confirmed = await prompt.confirm({
      message: target === 'enforce'
        ? 'Enable soft-signal ENFORCEMENT now?'
        : 'Return soft-signal to shadow (log-only)?',
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have set soft_signal_mode to ${target}.`,
        details: { from: state.mode, to: target, dryRun: true }
      };
    }

    // ─── Apply (upsert so the row exists even if never seeded) ─────
    const sp2 = prompt.spinner();
    sp2.start('Updating verification_settings…');
    const applyRes = await psqlPiped(
      ctx.config,
      `insert into public.verification_settings (key, value, updated_at)
       values ('soft_signal_mode', '"${target}"'::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now();\n`,
      'supabase_admin'
    );
    if (applyRes.exitCode !== 0) {
      sp2.stop('Update failed.');
      return {
        success: false,
        summary: `psql exit ${applyRes.exitCode}: ${applyRes.stderr.trim().slice(0, 200)}`,
        details: { from: state.mode, to: target }
      };
    }
    sp2.stop('Applied.');

    // ─── Verify ───────────────────────────────────────────────────
    const sp3 = prompt.spinner();
    sp3.start('Verifying…');
    let after: SoftSignalState;
    try {
      after = await readState(ctx);
    } catch (err) {
      sp3.stop('Verify failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp3.stop('Verified.');

    if (after.mode !== target) {
      return {
        success: false,
        summary: `Apply succeeded but verify mismatch: expected ${target}, got ${after.mode}`,
        details: { expected: target, actual: after.mode }
      };
    }

    // ─── Audit ────────────────────────────────────────────────────
    const audit = await writeAudit(ctx.config, {
      runbookId: 'toggle-soft-signal-mode',
      action:    target === 'enforce' ? 'soft-signal-enforced' : 'soft-signal-shadowed',
      target:    `mode:${target}`,
      metadata:  {
        from:                     state.mode,
        to:                       target,
        residencies_with_samples: state.residencies_with_samples,
        would_open_residencies:   state.would_open_residencies,
        total_signals:            state.total_signals
      },
      dryRun: false
    });
    if (!audit.ok) {
      prompt.note(c.yellow(`Audit log write failed (operation succeeded): ${audit.error}`), 'Warning');
    }

    return {
      success: true,
      summary: target === 'enforce'
        ? `Soft-signal ENFORCE is on. Sustained mismatches will open gentle soft_signal demands.`
        : `Soft-signal back to shadow (log-only). No demands will open.`,
      details: { from: state.mode, to: target }
    };
  }
};

export default runbook;
