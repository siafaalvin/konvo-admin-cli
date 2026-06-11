/**
 * SSH execution helpers. Uses Bun.spawn(['ssh', ...]) so the operator's
 * existing ~/.ssh/id_ed25519 is the only auth — no `ssh2` library, no
 * extra credentials to manage.
 *
 * Three primitives:
 *   exec(host, cmd)       — run a shell command remotely, return stdout/stderr
 *   psql(host, dbCmd)     — exec inside the Supabase Postgres container
 *   psqlPiped(host, sql)  — pipe SQL to psql via stdin (large queries / multiline)
 *
 * Quoting: we deliberately don't try to escape user input here. Runbooks
 * that take operator input MUST pass values through psql's parameterised
 * SET / SELECT mechanisms, never via shell interpolation.
 */

import type { Config } from './config.ts';

export interface ExecResult {
  stdout:    string;
  stderr:    string;
  exitCode:  number;
}

export async function exec(cfg: Config, command: string): Promise<ExecResult> {
  const proc = Bun.spawn({
    cmd: ['ssh', '-i', cfg.sshKey, cfg.prodHost, command],
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Run a one-shot psql -c against the Supabase Postgres container as the
 * given role (defaults to supabase_admin so ALTER DATABASE / DDL works).
 *
 * Note: psql's `-c` argument is the FULL query string. Quoting is the
 * caller's responsibility — usually safest to pipe SQL via stdin (see
 * `psqlPiped`) when the query has any user-supplied content.
 */
export async function psqlOneShot(
  cfg: Config,
  sql: string,
  user: 'supabase_admin' | 'postgres' = 'supabase_admin'
): Promise<ExecResult> {
  // Wrap the inner command so the docker-ps inline subshell gets the
  // right Postgres container even if Coolify regenerates the suffix.
  // The pager-off flag prevents the pager-not-found errors we hit
  // earlier in OPS-URLS § Phase D walkthrough.
  const inner = `docker exec -i $(docker ps --format '{{.Names}}' | grep -E '^supabase-db-') psql -U ${user} -d postgres -P pager=off -c ${shellQuote(sql)}`;
  return exec(cfg, inner);
}

/**
 * Pipe arbitrary SQL into psql via stdin. Best for multi-statement
 * queries, large ones, or anything where shell-escape ambiguity would
 * be a problem. The SQL never touches the shell's argv.
 */
export async function psqlPiped(
  cfg: Config,
  sql: string,
  user: 'supabase_admin' | 'postgres' = 'supabase_admin'
): Promise<ExecResult> {
  const remoteCmd = `docker exec -i $(docker ps --format '{{.Names}}' | grep -E '^supabase-db-') psql -U ${user} -d postgres -P pager=off -v ON_ERROR_STOP=1`;
  const proc = Bun.spawn({
    cmd: ['ssh', '-i', cfg.sshKey, cfg.prodHost, remoteCmd],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  // Write SQL into stdin, then close it so psql exits cleanly.
  proc.stdin.write(sql);
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/**
 * Single-quote a string for safe interpolation into a shell command
 * passed to ssh's argv[2]. Replaces any embedded single quotes with
 * the standard '\\' escape pattern. Sufficient for psql -c values.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Stream a long-running remote command's stdout/stderr to the local
 * terminal in real-time. Returns the spawned subprocess so the caller
 * can:
 *   - await `proc.exited` for completion
 *   - call `proc.kill()` on SIGINT / cancel
 *   - keep prompts UI alive while output flows below
 *
 * Use for `docker logs -f`, `journalctl -f`, `tail -f`, anything
 * interactive. Output is NOT captured into a buffer — it goes
 * directly to the inherited stdio so colors, carriage returns, and
 * progress bars survive intact.
 */
export function streamExec(
  cfg: Config,
  command: string
): import('bun').Subprocess<'ignore', 'inherit', 'inherit'> {
  return Bun.spawn({
    cmd: ['ssh', '-i', cfg.sshKey, '-t', cfg.prodHost, command],
    stdin:  'ignore',
    stdout: 'inherit',
    stderr: 'inherit'
  });
}
