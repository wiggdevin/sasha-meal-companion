# Backup and recovery

## What each backup preserves

- **SQL:** `scripts/backup.sh` runs one PostgreSQL 17 `pg_dump` with schema and data from one consistent snapshot. It includes cleanup statements so restoration replaces matching objects in an explicitly verified disposable destination. Ownership and ACL assignments are retained, including SECURITY DEFINER function owners and explicit REVOKE/GRANT statements. The destination must already provide the referenced roles; missing ownership/grant permissions fail the transaction. SQL does not contain Storage object bytes.
- **JSON:** `/api/jobs/backup` exports user-table rows into the private `backups` bucket, streamed one table page at a time so memory stays bounded at any account count (the document bytes are unchanged). Pages have stable primary-key ordering, but separate HTTP requests are not one database snapshot. The JSON describes itself as `consistency: per-request`; it supplements the consistent SQL backup and is not the SQL recovery source.
- **Storage:** `scripts/backup-storage.py` backs up the media bucket bytes and object metadata into private content-addressed files. It compares inventory before/after, verifies sizes and SHA-256, and publishes a complete directory atomically. Fourteen completed runs are retained. SQL and Storage are separate snapshots; concurrent cross-system writes are not transactionally frozen.

The SQL repair deliberately replaces two independent Supabase CLI dumps with one native PostgreSQL dump. The existing dated SQL files are never overwritten. New names include UTC time and a random suffix. Each has a `.sql.json` receipt containing SHA-256, byte count, source host/database and PostgreSQL major version. The directory is mode 0700; new files are 0600. Only recognized dated SQL backup names participate in the 14-file retention; unrelated `.sql` files are untouched. Rotation happens only after successful verification and atomic publication. The newly published dump is always retained; older candidates are ranked by modification time, not their random filename suffix.

## Mac execution

Requirements:

- `/usr/bin/python3` (Python 3.9 or later).
- PostgreSQL 17 `pg_dump` and `psql`, normally `/opt/homebrew/opt/postgresql@17/bin`. The helpers compare both client majors with `SHOW server_version_num` and refuse a mismatch. `PG_BIN` can point to an equivalent pinned directory for a drill.
- The command-backed ZS Vault items `sasha_supabase_db_url` and `supabase_access_token`, retrieved by `~/bin/zsvault`. Storage resolves the project service credential through the management API in process memory when no service key is already supplied. The launch wrapper exports its value without putting it in process arguments or the plist.

After the code is landed in the primary checkout, run:

```bash
scripts/run-backup-job.sh
scripts/check-backup-staleness.sh
scripts/install-backup-timer.sh
launchctl kickstart gui/$(id -u)/com.zs.smc-backup
launchctl print gui/$(id -u)/com.zs.smc-backup
```

The plist runs `scripts/run-backup-job.sh` from the primary checkout, at 03:15 Mac local time. It uses a non-login shell and fixed tool paths. Inspect the completed job's exit status, its private output artifact and integrity receipt, and `~/Library/Logs/smc-backup.log`; an installed timer alone is not execution proof. A sleeping/offline Mac is not an independent remote backup service. The staleness helper reports a nonzero status beyond 36 hours; wire that result into the operator's existing monitoring if unattended notification is required.

For a drill, retrieve credentials into environment variables using the approved Vault lane, then invoke `scripts/backup.sh --destination <private-drill-directory>`. Direct calls accept `SUPABASE_DB_URL`, or standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` plus `PGPASSWORD`/private `PGPASSFILE`. The Python helper parses a URL internally, passes only connection fields to PostgreSQL, and never logs raw tool stderr. Remote connections require TLS. Do not put connection URLs in positional arguments.

## Guarded restore

Create a fresh disposable target; do not choose a production database. Two target forms are accepted:

1. **Local:** explicit `127.0.0.1` or `::1`, database named `smc_restore_<name>`.
2. **Hosted:** a direct Supabase host or session pooler on port 5432. The helper uses `SUPABASE_ACCESS_TOKEN` to read current branch metadata for Sasha's production project and requires a matching child project with `is_default: false`. Production, arbitrary hosts and unverified branches are refused. Branch lookup is read-only and does not create a branch.

Provide target credentials through `SUPABASE_RESTORE_DB_URL` or the standard PG environment fields. The source `SUPABASE_DB_URL` is never reused by restore. Then:

```bash
scripts/restore-to-branch.sh /absolute/path/to/backup.sql --confirm smc_restore_drill
# Hosted target: --confirm must exactly match the verified branch project reference.
```

The matching `.sql.json` receipt is mandatory. Checksum, byte count, confirmation, target identity and PostgreSQL versions are checked before restoration. `psql -X --single-transaction --set ON_ERROR_STOP=1` makes SQL failures roll back. Older dumps without receipts require a separate reviewed recovery process; do not fabricate receipts for them.

After restore, compare the migration ledger and table counts against the dump snapshot, then test application reads and one synthetic write against that destination. Check roles, grants, Auth, extensions and Storage recovery separately. Do not point the production app at a drill database or promote a branch as part of this helper.

## Remote JSON schedule

Vercel invokes authenticated GET at 03:45 UTC; POST uses the same bearer check for an explicit run. `CRON_SECRET` must be configured. Missing/wrong bearer credentials return 401 before any backup data is read.

The UTC date is the unique run key. A successful or active run is not overwritten. An `error` run can retry immediately through a conditional update. A `running` lease older than two hours can be reclaimed; completion/error updates are bound to the lease start so an abandoned worker cannot overwrite its replacement's status. Upload failures or failed completion bookkeeping return 500. A function timeout leaves a running lease for later recovery; retries must be triggered by the scheduler/operator after expiry. The script does not claim a JSON import path has been validated.

## Evidence and limits

The deterministic script tests use fake PostgreSQL executables and temporary directories. They cover credential-free argv, private/unique publication, failed-dump preservation, completion validation, retention, concurrency exclusion, version mismatch, branch guards, checksum rejection and transactional restore invocation. They never read production data. Route tests cover paging/order, auth, failed/stale lock recovery, concurrent claims and completion-write failure.

Real backup and restore acceptance requires a receipt from the **exact** repaired scripts, plus the actual scheduler run and object recovery evidence. Test passes alone do not satisfy those operational checks.

References: [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [Supabase branch metadata API](https://supabase.com/docs/reference/api/v1-list-all-branches).

### September 15 execution evidence

Exact repaired SQL backup and restore scripts succeeded in a fresh isolated PostgreSQL database: 84 table counts matched, with 324,410 rows. All 66 public functions matched ownership and ACLs; 50 public tables/views matched ownership, ACLs and RLS settings; all 44 policies matched. Protected RPCs remained inaccessible to the anonymous role. [Receipt](../readiness/2026-09-15/sql-recovery-follow-up.json).

The exact Storage script backed up a synthetic PNG, which was restored into a new private local bucket and read back byte-for-byte. [Receipt](../readiness/2026-09-15/storage-restore-drill.json). Fresh production backups then succeeded: 16,679,032-byte SQL dump and two media objects totaling 694,540 bytes. Files are under the private `~/Backups/supabase/meal-companion/` directory; no production record contents are committed. Scheduler installation and its process exit are verified separately after this release lands.

The compiled JSON job was exercised against the real isolated Supabase API: anonymous GET returned 401, a previously failed run retried successfully (200, 54,866 bytes), and a repeat returned 409. This exposed and corrected `media_objects` ordering (`path`, not `id`); a database-backed integration regression now exercises every export table. [Receipt](../readiness/2026-09-15/backup-job-drill.json).
