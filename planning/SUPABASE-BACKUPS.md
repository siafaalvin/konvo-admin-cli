# Self-hosted Supabase backups

> **Status:** active (provisioned 2026-06-20)
> **Cron:** daily at 02:30 UTC on `5.78.237.171`
> **Script:** `/root/backups/run-supabase-backup.sh`
> **Storage:** `/root/backups/supabase/<YYYY-MM-DD>/` on VPS (local-only initially)
> **Retention:** 30 days

## What gets backed up

Per nightly run, four artifacts:

| File | Contents |
|---|---|
| `konvo-supabase-<TS>.sql.gz` | `pg_dumpall` of the Konvo Supabase Postgres (suffix `hoc46cx1c1qd643gkaqxhezq`). Includes auth.users, all public tables, RLS, functions, triggers. |
| `crowdfund-supabase-<TS>.sql.gz` | `pg_dumpall` of the crowdfund-platform Supabase Postgres (suffix `d12fsiflbur48p3s2f8dz2j2`). Same scope. |
| `konvo-storage-<TS>.tar.gz` | MinIO storage volume for Konvo (uploaded files). |
| `crowdfund-storage-<TS>.tar.gz` | MinIO storage volume for crowdfund (currently the `business-logos` bucket). |

Sample sizes from the first run (2026-06-20):
- Konvo SQL: **6.6 MB** compressed
- Crowdfund SQL: **516 KB** compressed
- Storage tarballs: **~10 KB** each (mostly empty since launch)

Daily total ≈ 7-10 MB. Annual ≈ 3 GB. Well within the 113 GB free disk on the VPS.

## What's NOT backed up (yet)

- **Off-host copy** — see "Off-host upload" below. Currently local-only, which protects against accidental deletes / migration mistakes but NOT against VPS loss / disk failure / ransomware. **Strongly recommended to enable before going LIVE with real money.**
- **Coolify configuration** — the `/data/coolify/services/.../docker-compose.yml` patches we applied (GOTRUE_SITE_URL, API_EXTERNAL_URL) and env vars. These can be reconstructed from `crowdfund-platform` repo + the `.env` file. Worth backing up explicitly later.
- **Worker secret files** — `/root/.konvo-prod/*.txt` files. Important to back up but NOT to a public storage bucket. Encrypt before uploading.
- **Stripe customer/subscription data** — owned by Stripe, not us. Stripe's own retention applies.

## How to restore

### Restore a single Postgres dump

The dumps use `pg_dumpall --clean --if-exists` so they DROP and recreate everything. **Restoring overwrites the target database.** Be very sure before running.

```bash
# 1. Pick a dump
ssh root@5.78.237.171 ls -la /root/backups/supabase/

# 2. Pipe it into the running container's psql.
#    Replace <date> + <ts> with the actual filename parts.
ssh root@5.78.237.171 \
  "zcat /root/backups/supabase/<date>/crowdfund-supabase-<ts>.sql.gz | \
   docker exec -i \$(docker ps --format '{{.Names}}' | grep '^supabase-db-d12fsi') \
     psql -U postgres -d postgres -v ON_ERROR_STOP=1"
```

For Konvo:
```bash
ssh root@5.78.237.171 \
  "zcat /root/backups/supabase/<date>/konvo-supabase-<ts>.sql.gz | \
   docker exec -i \$(docker ps --format '{{.Names}}' | grep '^supabase-db-hoc46') \
     psql -U postgres -d postgres -v ON_ERROR_STOP=1"
```

After restore, all Supabase services (auth, rest, kong, realtime, etc.) should keep working since they only talk to the DB through the connection pool — restart them anyway to drop any cached state:

```bash
ssh root@5.78.237.171 \
  "cd /data/coolify/services/d12fsiflbur48p3s2f8dz2j2 && \
   docker compose restart"
```

### Restore a single storage tarball

```bash
# 1. Stop the storage container so files aren't being written
ssh root@5.78.237.171 \
  "docker stop supabase-storage-d12fsiflbur48p3s2f8dz2j2 \
                supabase-minio-d12fsiflbur48p3s2f8dz2j2"

# 2. Replace the volume contents with the tarball
ssh root@5.78.237.171 \
  "rm -rf /data/coolify/services/d12fsiflbur48p3s2f8dz2j2/volumes/storage/* && \
   tar -xzf /root/backups/supabase/<date>/crowdfund-storage-<ts>.tar.gz \
       -C /data/coolify/services/d12fsiflbur48p3s2f8dz2j2/volumes/"

# 3. Restart
ssh root@5.78.237.171 \
  "docker start supabase-storage-d12fsiflbur48p3s2f8dz2j2 \
                supabase-minio-d12fsiflbur48p3s2f8dz2j2"
```

### Selective restore (single table)

If you just need to recover one table after an accidental DELETE:

```bash
# 1. Start a temp Postgres container in DETACHED mode so it persists
#    for subsequent docker exec calls.
CID=$(docker run -d -e POSTGRES_PASSWORD=temp postgres:16)

# 2. Wait for Postgres to accept connections (image takes a few seconds
#    to bootstrap the data dir on first start).
until docker exec "$CID" pg_isready -U postgres -q; do sleep 1; done

# 3. Pipe the dump into psql inside the container.
zcat crowdfund-supabase-<ts>.sql.gz | \
  docker exec -i "$CID" psql -U postgres -d postgres -v ON_ERROR_STOP=1

# 4. Dump just the table you need (data only, no schema — assumes the
#    target table already exists in prod).
docker exec "$CID" pg_dump -U postgres -d postgres \
  --data-only --table=public.contributions \
  > contributions.sql

# 5. Apply contributions.sql to prod (review first!).
cat contributions.sql | \
  ssh root@5.78.237.171 \
    "docker exec -i \$(docker ps --format '{{.Names}}' | grep '^supabase-db-d12fsi') \
       psql -U postgres -d postgres -v ON_ERROR_STOP=1"

# 6. Clean up the temp container.
docker rm -f "$CID"
```

In practice: easier to just `zcat | grep -A 100 'COPY public.contributions'` to extract the rows, then INSERT them manually. Document-by-document recovery is rare; usually the question is "how do I get back to <yesterday's state>" which means full restore.

## Off-host upload (recommended before LIVE)

The script auto-uploads to a remote target if `/root/.konvo-prod/backup-rclone-target.txt` exists with a configured rclone remote. To set this up:

### Option A — Backblaze B2 (cheapest, ~$0.005/GB/month)

```bash
# 1. Create a B2 account + bucket (private, single-instance)
#    https://www.backblaze.com/b2/ → create bucket "konvo-backups"

# 2. Create an Application Key with:
#    - capabilities: writeFiles, listFiles
#    - bucket: konvo-backups
#    - copy keyID + applicationKey

# 3. Install rclone on the VPS
ssh root@5.78.237.171 'curl -fsSL https://rclone.org/install.sh | bash'

# 4. Configure rclone (interactive — need to ssh in directly)
ssh root@5.78.237.171
rclone config
# n -> new remote
# name: b2-backups
# storage: 6  (Backblaze B2)
# account: <keyID>
# key: <applicationKey>
# (defaults for the rest)
# q -> quit

# 5. Tell the backup script where to upload
ssh root@5.78.237.171 \
  "echo 'b2-backups:konvo-backups' > /root/.konvo-prod/backup-rclone-target.txt && \
   chmod 600 /root/.konvo-prod/backup-rclone-target.txt"

# 6. Test
ssh root@5.78.237.171 /root/backups/run-supabase-backup.sh
ssh root@5.78.237.171 'rclone ls b2-backups:konvo-backups'
```

### Option B — Hetzner Storage Box (€3.20/month for 100 GB, fixed)

Use SFTP / SMB instead of S3-style. Same pattern with rclone but a different remote type.

### Option C — AWS S3 / Cloudflare R2

Same pattern, different remote type (`s3` for AWS or R2). Cloudflare R2 has free egress which is useful if you ever need to download backups quickly.

## Manual snapshot

To take an ad-hoc backup outside the daily schedule (e.g., before a risky migration):

```bash
ssh -i ~/.ssh/id_ed25519 root@5.78.237.171 /root/backups/run-supabase-backup.sh
```

Or via konvo-admin-cli:
```
bun start → Snapshot Supabase backups
```
(See: `src/runbooks/snapshot-supabase-backup.ts`.)

## Monitoring

The script writes per-run logs to `/root/backups/logs/backup-<TS>.log`. Logs older than 30 days are auto-deleted.

To check the most recent run succeeded:
```bash
ssh root@5.78.237.171 \
  "ls -t /root/backups/logs/*.log | head -1 | xargs tail -10"
```

A healthy run ends with `=== Backup run end ===` and shows non-zero sizes for both Postgres dumps.

## Disk monitoring

The retention policy (30 days) keeps total backup size around ~250 MB at current data volume. As tables grow (especially `auth.users` and `contributions` post-launch), compressed dumps may grow proportionally.

To monitor:
```bash
ssh root@5.78.237.171 'du -sh /root/backups/supabase/'
```

If usage exceeds 5 GB, consider:
- Reducing retention to 14 days (edit `mtime +30` in the script)
- Enabling off-host upload + lowering local retention to 7 days
