# Backup and recovery

## What each backup preserves

- **SQL:** `scripts/backup.sh` runs one PostgreSQL 17 `pg_dump` with schema and data from one consistent snapshot. It includes cleanup statements so restoration replaces matching objects in an explicitly verified disposable destination. Ownership and ACL assignments are retained, including SECURITY DEFINER function owners and explicit REVOKE/GRANT statements. The destination must already provide the referenced roles; missing ownership/grant permissions fail the transaction. SQL does not contain Storage object bytes.
- **JSON:** `/api/jobs/backup` exports every account table that `lib/server/backup-tables.ts` lists into the private `backups` bucket (`tests/export/backup-tables.test.ts` fails until a new table is listed or excluded with a reason). Each table is read by primary key (`key > last`), streamed one page at a time, so memory stays bounded at any account count. A row that exists for the whole pass is written exactly once, but separate HTTP requests are not one database snapshot: the JSON describes itself as `consistency: keyset`; it supplements the consistent SQL backup and is not the SQL recovery source. The table order is restore order (every foreign-key parent before the tables that reference it), so the parts can be replayed table by table into an empty schema once the shared catalog and `auth.users` are in place.
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

Vercel invokes authenticated GET at 03:45, 04:45, 05:45 and 06:45 UTC (`45 3-6 * * *`); POST uses the same bearer check for an explicit run. `CRON_SECRET` must be configured. Missing/wrong bearer credentials return 401 before any backup data is read.

One pass runs per UTC date, held in `job_cursors` (migration `20261217120300`, a deploy prerequisite):

- A run claims the pass's lease (360 s). A live lease answers 409. A claim that fails (table or function missing, database unreachable) answers 503 and writes nothing: the lease is the only guard against two runs writing one pass.
- The run writes numbered parts, `meal-companion/<date>/part-NNNN-<run uuid>.json` (`user-table-export-v2-part`), each streamed a page at a time and ended at the row that would take it past 32 MiB of UTF-8. It starts no page after 240 s, saves the next start and the part paths so far in the cursor, and answers `200 { incomplete: true }`. The next fire continues.
- The run that writes the last part writes the manifest `meal-companion/<date>.json` (`user-table-export-v2`): the parts in order, the tables, the byte total. A reader follows the manifest only and joins each table's rows across its parts.
- A part upload, the manifest or a bookkeeping write still running at 285 s is abandoned; the run records `error` in `backup_runs` and releases the lease before the platform kill, and the cursor keeps every part already written. An abandoned upload that lands later does so at its own run's path, which no manifest names; such stray objects can be removed by hand.
- A cursor save that is not confirmed (database error or a lost lease) fails the run with 500, so `done` and `incomplete` always mean the progress was saved. After the pass is done, later fires answer `200 { alreadyDone: true }`.

## Evidence and limits

The deterministic script tests use fake PostgreSQL executables and temporary directories. They cover credential-free argv, private/unique publication, failed-dump preservation, completion validation, retention, concurrency exclusion, version mismatch, branch guards, checksum rejection and transactional restore invocation. They never read production data. Route tests (`tests/export/backup-route.test.ts`) cover keyset paging under concurrent inserts and deletes, composite keys with quoted text, the UTF-8 part cap, the time budget across runs, the hard stop on a part and on the manifest, a late stale upload, failed reads, failed and lost cursor saves, the fail-closed claim and auth.

Real backup and restore acceptance requires a receipt from the **exact** repaired scripts, plus the actual scheduler run and object recovery evidence. Test passes alone do not satisfy those operational checks.

**Open (W016, 2026-10-10):** no restore drill has run against the current schema. `tests/export/backup_scripts_test.py` only proves that `scripts/backup.sh` passes `pg_dump` no table, schema or data filter, so a dump includes every table a migration adds. Recovering the tables added since September 15 still needs a drill on a current-schema branch with a row-count comparison and a receipt. The September evidence below predates them.

References: [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [Supabase branch metadata API](https://supabase.com/docs/reference/api/v1-list-all-branches).

### September 15 execution evidence

Exact repaired SQL backup and restore scripts succeeded in a fresh isolated PostgreSQL database: 84 table counts matched, with 324,410 rows. All 66 public functions matched ownership and ACLs; 50 public tables/views matched ownership, ACLs and RLS settings; all 44 policies matched. Protected RPCs remained inaccessible to the anonymous role. [Receipt](../readiness/2026-09-15/sql-recovery-follow-up.json).

The exact Storage script backed up a synthetic PNG, which was restored into a new private local bucket and read back byte-for-byte. [Receipt](../readiness/2026-09-15/storage-restore-drill.json). Fresh production backups then succeeded: 16,679,032-byte SQL dump and two media objects totaling 694,540 bytes. Files are under the private `~/Backups/supabase/meal-companion/` directory; no production record contents are committed. Scheduler installation and its process exit are verified separately after this release lands.

The compiled JSON job was exercised against the real isolated Supabase API: anonymous GET returned 401, a previously failed run retried successfully (200, 54,866 bytes), and a repeat returned 409. This exposed and corrected `media_objects` ordering (`path`, not `id`); a database-backed integration regression now exercises every export table. [Receipt](../readiness/2026-09-15/backup-job-drill.json).
