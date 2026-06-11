/**
 * Runbook contract. Every runbook in src/runbooks/ implements this
 * interface and exports a default instance.
 *
 * The CLI's index.ts collects them, presents an interactive menu, and
 * calls run(ctx) on whichever the operator picks.
 */

import type * as p from '@clack/prompts';
import type { Config } from '../lib/config.ts';

/** What the operator can choose from in the menu. */
export interface Runbook {
  /** Stable id (kebab-case). Used as the menu key + audit-log slug. */
  id: string;
  /** Short label shown in the picker. */
  title: string;
  /** One-liner shown under the title. */
  description: string;
  /**
   * Risk classifies the runbook's blast radius:
   *   read-only — pure SELECT / inspection. No mutations.
   *   low       — single-row mutations or operator-initiated tasks
   *               with a clear undo path.
   *   high      — multi-row mutations, prod config changes, refunds,
   *               key rotations. Always show diff/preview + require
   *               explicit confirmation.
   */
  risk: 'read-only' | 'low' | 'high';
  /**
   * Whether this runbook needs SSH / DB / Stripe access. The launcher
   * checks this against config presence before dispatching.
   */
  requires: Array<'ssh' | 'db' | 'stripe'>;

  run(ctx: RunbookContext): Promise<RunbookResult>;
}

export interface RunbookContext {
  config:  Config;
  prompt:  typeof p;
  /**
   * Dry-run mode. Mutating runbooks should consult this and skip the
   * actual change while still walking the prompts (useful for training
   * and testing).
   */
  dryRun:  boolean;
}

export interface RunbookResult {
  success: boolean;
  /** Short message rendered in the post-run summary. */
  summary: string;
  /** Optional structured payload — kept for future audit-log integration. */
  details?: Record<string, unknown>;
}
