/**
 * Phase 2 runbook — Diagnose role permissions.
 *
 * Read-only. For a given Postgres role, dumps:
 *   - Role attributes (superuser, createdb, createrole, login, etc.)
 *   - Role memberships (which roles this role inherits from)
 *   - Schema-level USAGE grants
 *   - Table-level grants (limited to public schema for signal-noise)
 *   - RLS policies that mention the role
 *
 * Common use: "why is the worker getting permission denied on
 * public.foo?" — check whether service_role actually has the
 * grants you think it does, especially after a migration.
 */

import { psqlPiped } from '../lib/ssh.ts';
import { c } from '../lib/theme.ts';
import type { Runbook, RunbookContext, RunbookResult } from './_interface.ts';

const COMMON_ROLES = [
  'service_role',
  'authenticated',
  'anon',
  'authenticator',
  'supabase_admin',
  'postgres',
  'pgbouncer'
];

const runbook: Runbook = {
  id:          'diagnose-role-permissions',
  title:       'Diagnose role permissions',
  description: 'For a given role: attributes, memberships, schema/table grants, RLS policies. Read-only.',
  risk:        'read-only',
  requires:    ['ssh'],

  async run(ctx: RunbookContext): Promise<RunbookResult> {
    const { prompt } = ctx;

    const choice = await prompt.select({
      message: 'Which role?',
      options: [
        ...COMMON_ROLES.map((r) => ({ value: r, label: r, hint: c.dim('common Konvo role') })),
        { value: '__custom', label: c.dim('Other (type a name)'), hint: c.dim('') }
      ]
    });
    if (prompt.isCancel(choice)) {
      prompt.cancel('Cancelled.');
      return { success: false, summary: 'Operator cancelled.' };
    }

    let roleName: string;
    if (choice === '__custom') {
      const custom = await prompt.text({
        message: 'Role name',
        validate: (v) => {
          const s = (v ?? '').trim();
          if (!s) return 'Required.';
          if (!/^[a-z0-9_]+$/.test(s)) return 'lowercase a-z 0-9 _.';
          return undefined;
        }
      });
      if (prompt.isCancel(custom)) {
        prompt.cancel('Cancelled.');
        return { success: false, summary: 'Operator cancelled.' };
      }
      roleName = (custom as string).trim();
    } else {
      roleName = choice as string;
    }

    const sqlEsc = roleName.replace(/'/g, `''`);
    const sql = `
\\set QUIET on
\\pset border 1
\\pset format aligned

\\echo SECTION:exists
select count(*) > 0 as exists from pg_roles where rolname = '${sqlEsc}';

\\echo SECTION:attributes
select rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin, rolreplication, rolbypassrls
from pg_roles where rolname = '${sqlEsc}';

\\echo SECTION:memberships
select b.rolname as member_of
from pg_auth_members m
join pg_roles a on a.oid = m.member
join pg_roles b on b.oid = m.roleid
where a.rolname = '${sqlEsc}'
order by b.rolname;

\\echo SECTION:schema_usage
select nspname as schema,
       has_schema_privilege('${sqlEsc}', nspname, 'USAGE')  as can_use,
       has_schema_privilege('${sqlEsc}', nspname, 'CREATE') as can_create
from pg_namespace
where nspname not like 'pg_%' and nspname != 'information_schema'
order by nspname;

\\echo SECTION:public_table_grants
select relname as table_name,
       has_table_privilege('${sqlEsc}', relid, 'SELECT') as sel,
       has_table_privilege('${sqlEsc}', relid, 'INSERT') as ins,
       has_table_privilege('${sqlEsc}', relid, 'UPDATE') as upd,
       has_table_privilege('${sqlEsc}', relid, 'DELETE') as del
from pg_stat_user_tables
where schemaname = 'public'
order by relname;

\\echo SECTION:rls_policies_referencing
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where '${sqlEsc}' = any(roles) or roles = '{public}'::name[]
order by schemaname, tablename, policyname;
`;

    const sp = prompt.spinner();
    sp.start(`Querying permissions for ${roleName}…`);
    const res = await psqlPiped(ctx.config, sql, 'supabase_admin');
    sp.stop('Done.');
    if (res.exitCode !== 0) {
      return {
        success: false,
        summary: `psql exit ${res.exitCode}: ${res.stderr.trim().slice(0, 200)}`,
        details: { roleName }
      };
    }

    const sections = res.stdout.split(/^SECTION:/m).slice(1);
    let exists = false;
    for (const block of sections) {
      const newlineIdx = block.indexOf('\n');
      const name = block.slice(0, newlineIdx).trim();
      const body = block.slice(newlineIdx + 1).trim();

      if (name === 'exists') {
        // Body looks like " exists \n-------\n t \n(1 row)" — match literal 't'.
        exists = /\b\s*t\s*$/m.test(body) || /\| t |/.test(body);
        if (!exists) {
          prompt.note(c.red(`Role ${roleName} doesn't exist.`), 'Not found');
          return { success: false, summary: `Role ${roleName} doesn't exist.` };
        }
        continue;
      }

      const title =
        name === 'attributes'             ? 'Role attributes' :
        name === 'memberships'            ? 'Member of (inherits from)' :
        name === 'schema_usage'           ? 'Schema USAGE / CREATE' :
        name === 'public_table_grants'    ? 'public.* table grants' :
        name === 'rls_policies_referencing' ? 'RLS policies referencing role' :
                                              name;

      prompt.note(body || c.dim('(no rows)'), title);
    }

    return {
      success: true,
      summary: `Permissions report for ${roleName} complete.`,
      details: { roleName, exists }
    };
  }
};

export default runbook;
