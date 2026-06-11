# konvo-admin-cli

> Operator runbooks for Konvo. Interactive CLI that wraps SSH + Postgres
> + browser dashboards into prompt-driven workflows. Built so a non-
> technical operator can run common ops tasks without memorising shell
> incantations.
>
> Plan: `planning/houvox/KONVO-ADMIN-CLI.md` in the
> [houvox-pwa](https://github.com/siafaalvin/houvox-pwa) repo.
> URL/access reference: `planning/houvox/OPS-URLS.md` in the same repo.

## Setup

```bash
git clone https://github.com/siafaalvin/konvo-admin-cli.git
cd konvo-admin-cli
bun install
cp .env.example .env
# Edit .env with your operator name + VPS host
```

Requires Bun ≥1.3 and an SSH key (`~/.ssh/id_ed25519`) authorised for
the production VPS.

## Run

```bash
bun start
```

You'll get an interactive menu of available runbooks.

## Phase 1 — MVP runbook list

| # | Runbook | Risk |
|---|---|---|
| 1 | Bulk insert crowdfund emails | low |
| 2 | Confirm stuck user signup | low |
| 3 | Inspect user | read-only |
| 4 | Refund + revoke access | high |
| 5 | Run prod smoke test | read-only |
| 6 | Tail logs | read-only |
| 7 | Restart service | low |
| 8 | Apply Phase D notification config | high |
| 9 | Set Postgres GUC | high |
| 10 | Open dashboard | read-only |
| 11 | Rotate Stripe keys | high |

Phase 1: ✅ complete (11/11 runbooks, all type-checked, all dry-run-tested).

Friction patterns documented in
`planning/houvox/KONVO-ADMIN-CLI.md` §4b — the CLI's job is to make
the OPS-URLS workflows paste-safe + pager-aware + chainable with
confirmation prompts.

## Architecture

```
src/
├── index.ts              # Entry point: select runbook → run
├── lib/
│   ├── ssh.ts            # SSH connection wrapper (Bun.spawn)
│   ├── db.ts             # Postgres client (postgres.js)
│   ├── dashboards.ts     # Registry of OPS-URLS dashboards
│   └── config.ts         # Load .env / operator identity
└── runbooks/
    ├── _interface.ts     # Runbook contract
    ├── open-dashboard.ts
    ├── set-postgres-guc.ts
    └── (more...)
```

SSH execution uses `Bun.spawn(['ssh', ...])` — no `ssh2` library so
the operator's existing `~/.ssh/id_ed25519` is the only auth.

## Safety

- Every runbook execution is logged to `public.admin_audit_log` on prod
  (planned; migration ships with first mutating runbook).
- High-risk runbooks show a diff/preview + require explicit `y`
  confirmation.
- `--dry-run` flag (per the plan) skips mutations + writes audit
  entry with `dry_run: true`.

## License

Internal Konvo tooling. Not for public distribution.
