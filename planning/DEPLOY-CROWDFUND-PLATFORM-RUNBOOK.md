# Future runbook: deploy-crowdfund-platform

> **Status:** queued (not yet implemented).
> **Origin:** added 2026-06-16 during the manual go-live of
> `crowdfunding.thekonvo.com`. Manual setup was acceptable for the
> first install; this runbook would automate the full path for
> future re-installs (recovery, staging mirror, second campaign
> instance, etc.).

## Goal

Replace the multi-step Coolify dashboard click-through documented in
`crowdfund-platform/planning/GO-LIVE-PLAN.md` with a single CLI command:

```
bun start → Deploy crowdfund platform
```

## Deploy plan the runbook should execute

1. Pre-flight checks (all required tokens present + reachable)
2. Cloudflare API: add A records for `crowdfunding.thekonvo.com` + `supabase-cf.thekonvo.com`
3. Coolify API: create new Supabase service in Konvo Production project
4. Poll Coolify API for service-healthy
5. Read `ANON_KEY` + `SERVICE_ROLE_KEY` from new service env
6. SSH+psql: apply 3 SQL migrations against new Supabase DB:
   - `supabase-schema.sql`
   - `admin-migration.sql`
   - `beta-signups-migration.sql`
7. Coolify API: create Application from `siafaalvin/crowdfund-platform`
8. Set env vars (Supabase URL+keys, bridge URL+secret, Stripe TEST keys, site URL, campaign)
9. Trigger first deploy + poll for healthy
10. Stripe API: create TEST webhook → write `whsec_` to env → redeploy
11. End-to-end verification: GET landing + GET Studio + bridge curl test

Estimated wall-clock: 8-12 min (mostly waiting on Coolify deploys).

## Required tokens (operator stores on VPS)

| File | Purpose |
|---|---|
| `/root/.konvo-prod/coolify-api-token.txt` | Coolify REST API auth |
| `/root/.konvo-prod/cloudflare-dns-token.txt` | DNS edit scope, `thekonvo.com` zone only |
| `/root/.konvo-prod/cloudflare-zone-id.txt` | Cached zone ID for `thekonvo.com` |
| `/root/.konvo-prod/stripe-secret-key.txt` (existing) | Stripe API for webhook registration |
| `/root/.konvo-prod/crowdfund-bridge-secret.txt` (existing) | Plumbed into the new app's env |

## Idempotency

Each step checks for existing state before mutating:
- DNS records: lookup by name; skip if already pointing at the right IP
- Coolify resources: lookup by name; skip if already deployed (offer to redeploy or replace env)
- SQL migrations: each file already has `IF NOT EXISTS` guards
- Stripe webhook: lookup by URL; skip if endpoint already registered

Re-running the runbook with the same inputs should be a no-op.

## Risk classification

`high` — creates production resources + sets env vars + writes to two
external SaaS APIs (Cloudflare + Stripe). Type-to-confirm gate
required, same as bulk-import + uphold runbooks.

## Effort estimate

~3-4 hours of code + tests. Files:
- `src/runbooks/deploy-crowdfund-platform.ts` (~400 lines)
- `src/lib/coolify-api.ts` (new helper, ~150 lines)
- `src/lib/cloudflare-api.ts` (new helper, ~100 lines)
- `src/lib/stripe-api.ts` (new helper, ~80 lines)
- Tests: end-to-end with stubbed APIs

## Trigger

Build when stakeholder requests OR when a second crowdfund instance
is needed (staging mirror for `staging-crowdfunding.thekonvo.com`,
or a separate campaign).
