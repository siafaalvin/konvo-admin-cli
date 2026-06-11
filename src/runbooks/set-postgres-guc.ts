/**
 * Runbook #9 — Set Postgres GUC.
 *
 * Sets a database-scoped configuration parameter (`konvo.x`, `app.y`,
 * etc.) via ALTER DATABASE postgres SET. Connects as supabase_admin
 * (the actual superuser) since `postgres` is demoted in the Supabase
 * docker image and ALTER DATABASE on custom GUCs requires superuser.
 *
 * Encodes everything we tripped on during Phase D config (see
 * planning/houvox/KONVO-ADMIN-CLI.md §4b friction-pattern dictionary):
 *
 *   - `postgres` role can't ALTER DATABASE for custom GUCs → use
 *     supabase_admin.
 *   - ALTER SYSTEM rejects unregistered custom-namespaced params in
 *     PG 15+ → use ALTER DATABASE.
 *   - `pg_settings` doesn't show un-touched custom GUCs → verify via
 *     pg_db_role_setting catalog instead.
 *   - psql container ships without `less` → -P pager=off baked in.
 *   - Multi-line shell pastes drop continuations → SQL piped via
 *     stdin (psqlPiped), no -c argv ambiguity.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { writeAudit } from '../lib/audit.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const runbook: Runbook = {
  id:          'set-postgres-guc',
  title:       'Set Postgres GUC',
  description: 'Set a database-scoped config parameter via ALTER DATABASE (e.g. konvo.dispatch_shared_secret). Connects as supabase_admin.',
  risk:        'high',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    // 1. Parameter name (free-text). We deliberately don't restrict to
    //    a known prefix — operators may need to set core PG params too.
    const nameInput = await prompt.text({
      message: 'Parameter name',
      placeholder: 'konvo.dispatch_shared_secret',
      validate: (v) => {
        const s = (v ?? '').trim();
        if (!s) return 'Required.';
        // Accept any [a-z0-9_]+(.[a-z0-9_]+)? shape — matches both
        // 'konvo.dispatch_shared_secret' and core 'work_mem'.
        if (!/^[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(s)) {
          return 'Use lowercase a-z 0-9 _ with optional single dot (e.g. konvo.foo).';
        }
        return undefined;
      }
    });
    if (prompt.isCancel(nameInput)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const paramName = (nameInput as string).trim();

    // 2. Sensitive? If the name looks secret-y, use password prompt
    //    (masked) and skip echoing. Otherwise normal text.
    const looksSecret = /secret|password|key|token/i.test(paramName);
    const valueInput = looksSecret
      ? await prompt.password({
          message: `Value for ${paramName}`,
          mask: '•',
          validate: (v) => ((v ?? '').length === 0 ? 'Required.' : undefined)
        })
      : await prompt.text({
          message: `Value for ${paramName}`,
          validate: (v) => (((v ?? '').trim()).length === 0 ? 'Required.' : undefined)
        });
    if (prompt.isCancel(valueInput)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }
    const paramValue = looksSecret ? (valueInput as string) : (valueInput as string).trim();

    // 3. Preview (mask sensitive values).
    const displayValue = looksSecret
      ? `<${paramValue.length} chars hidden>`
      : `'${paramValue}'`;
    prompt.note(
      [
        `Will run as supabase_admin against postgres database:`,
        ``,
        `  alter database postgres`,
        `    set ${paramName} = ${displayValue};`,
        ``,
        ctx.dryRun
          ? `(dry-run — no changes will be applied)`
          : `Active sessions keep their current value; new sessions pick up the change.`
      ].join('\n'),
      'Preview'
    );

    // 4. Confirm.
    const confirmed = await prompt.confirm({
      message: `Apply this change to prod?`,
      initialValue: false
    });
    if (prompt.isCancel(confirmed) || !confirmed) {
      prompt.cancel('Aborted.');
      return { success: false, summary: 'Operator did not confirm.' };
    }

    if (ctx.dryRun) {
      return {
        success: true,
        summary: `Dry-run: would have set ${paramName}.`,
        details: { paramName, dryRun: true }
      };
    }

    // 5. Apply via SQL piped to stdin — sidesteps shell-escape issues
    //    that cost us 30+ minutes during Phase D config setup.
    //    SQL escaping: single-quote the value with the standard SQL
    //    '...''...' double-quote scheme.
    const sqlEscaped = paramValue.replace(/'/g, `''`);
    const sql = `alter database postgres set ${paramName} = '${sqlEscaped}';\n`;

    const sp = prompt.spinner();
    sp.start('Applying ALTER DATABASE…');
    const applyRes = await psqlPiped(ctx.config, sql, 'supabase_admin');
    if (applyRes.exitCode !== 0) {
      sp.stop('ALTER DATABASE failed.');
      return {
        success: false,
        summary: `psql exit ${applyRes.exitCode}: ${applyRes.stderr.trim().slice(0, 200)}`,
        details: { paramName, exitCode: applyRes.exitCode, stderr: applyRes.stderr }
      };
    }
    sp.stop('ALTER DATABASE applied.');

    // 6. Verify by querying pg_db_role_setting (NOT pg_settings, which
    //    doesn't surface un-touched custom GUCs reliably). We compare
    //    only the LENGTH of the stored value vs what we sent — the
    //    actual value is never round-tripped to the operator's terminal
    //    if it was a secret.
    const verifySql = `
      select coalesce(
        (
          select length(substring(s from '^' || $$${paramName}=$$ || '(.*)$'))
          from pg_db_role_setting,
               unnest(setconfig) as s
          where setdatabase = (select oid from pg_database where datname = 'postgres')
            and s like $$${paramName}=%$$
        ),
        0
      ) as stored_length;
    `;
    const verifyRes = await psqlPiped(ctx.config, verifySql, 'supabase_admin');
    const storedLength = parseInt(
      (verifyRes.stdout.match(/\b\d+\b/) ?? ['0'])[0]!,
      10
    );
    const expectedLength = paramValue.length;

    if (storedLength !== expectedLength) {
      return {
        success: false,
        summary: `Set succeeded but verification length mismatch: stored=${storedLength}, expected=${expectedLength}`,
        details: { paramName, storedLength, expectedLength }
      };
    }

    // Audit — never log the value, only param name + length.
    const audit = await writeAudit(ctx.config, {
      runbookId: 'set-postgres-guc',
      action:    'guc-set',
      target:    paramName,
      metadata:  { length: storedLength, looksSecret },
      dryRun:    ctx.dryRun
    });
    if (!audit.ok) {
      prompt.note('Audit log write failed (operation succeeded): ' + audit.error, 'Warning');
    }

    return {
      success: true,
      summary: `Set ${paramName} (length ${storedLength}). New sessions will pick it up.`,
      details: { paramName, storedLength }
    };
  }
};

export default runbook;
