/**
 * Phase 2 runbook — Inspect database GUCs.
 *
 * Lists every database-scoped GUC (custom + selected core) the
 * Konvo stack relies on. Reads from pg_db_role_setting because
 * pg_settings does NOT surface un-touched custom GUCs reliably
 * (they only show up after a SET / RESET in the current session).
 *
 * Reports on:
 *   - All `konvo.*` GUCs currently set on the postgres database
 *   - Core PG params we care about: shared_buffers, work_mem,
 *     statement_timeout, idle_in_transaction_session_timeout
 *   - Any pg_cron-related GUCs (cron.database_name etc.)
 *
 * Secret-y values (anything with 'secret', 'password', 'key', 'token'
 * in the name) are length-only — never round-tripped to the operator
 * terminal.
 *
 * Read-only.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

interface Guc {
  name:   string;
  value:  string;   // raw value or '<N chars>' for secrets
  source: string;   // where the value came from (database / user / cluster)
}

const SECRET_RE = /secret|password|key|token/i;

async function readGucs(ctx: RunbookContext): Promise<Guc[]> {
  // We pull everything stored on the postgres DB at any role level.
  // pg_db_role_setting.setconfig is a text[] of "name=value" entries.
  const sql = `
\\set QUIET on
\\pset format unaligned
\\pset tuples_only on

with kv as (
  select
    split_part(s, '=', 1)                    as name,
    substring(s from position('=' in s) + 1) as value,
    case when setrole = 0 then 'database' else 'role:' || setrole::text end as source
  from pg_db_role_setting,
       unnest(setconfig) as s
  where setdatabase = (select oid from pg_database where datname = 'postgres')
)
select name || E'\\x1f' || value || E'\\x1f' || source
from kv
order by name;
`;
  const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
  if (res.exitCode !== 0) {
    throw new Error(`psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`);
  }
  // 0x1f (unit separator) avoids collision with values containing '|'.
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, value, source] = line.split('\x1f');
      return { name: name ?? '', value: value ?? '', source: source ?? '' };
    });
}

function formatValue(g: Guc): string {
  if (SECRET_RE.test(g.name)) {
    return c.brand(`<${g.value.length} chars set>`);
  }
  return c.brand(g.value);
}

const runbook: Runbook = {
  id:          'inspect-database-gucs',
  title:       'Inspect database GUCs',
  description: 'List every konvo.* and core GUC stored on the postgres DB. Secret values shown as length only.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const sp = prompt.spinner();
    sp.start('Reading pg_db_role_setting…');
    let gucs: Guc[];
    try {
      gucs = await readGucs(ctx);
    } catch (err) {
      sp.stop('Read failed.');
      return { success: false, summary: err instanceof Error ? err.message : String(err) };
    }
    sp.stop(`${gucs.length} GUCs stored.`);

    if (gucs.length === 0) {
      prompt.note(c.dim('No database-scoped GUCs found. Custom konvo.* params would normally appear here.'), 'Empty');
      return { success: true, summary: 'No GUCs stored on postgres database.' };
    }

    // Group: konvo.*, then everything else.
    const konvo  = gucs.filter((g) => g.name.startsWith('konvo.'));
    const other  = gucs.filter((g) => !g.name.startsWith('konvo.'));

    if (konvo.length > 0) {
      prompt.note(
        konvo.map((g) => `  ${c.dim('·')}  ${g.name.padEnd(40)} ${formatValue(g)}`).join('\n'),
        'konvo.* GUCs'
      );
    } else {
      prompt.note(c.yellow('No konvo.* GUCs set. Phase D dispatch will silently no-op.'), 'konvo.* GUCs');
    }

    if (other.length > 0) {
      prompt.note(
        other.map((g) => `  ${c.dim('·')}  ${g.name.padEnd(40)} ${formatValue(g)}`).join('\n'),
        'Other GUCs'
      );
    }

    return {
      success: true,
      summary: `${gucs.length} GUCs (${konvo.length} konvo.*, ${other.length} other).`,
      details: {
        konvoCount: konvo.length,
        otherCount: other.length,
        konvoNames: konvo.map((g) => g.name)
      }
    };
  }
};

export default runbook;
