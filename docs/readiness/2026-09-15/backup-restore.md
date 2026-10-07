# Backup and restore verification — 2026-09-15

## Result

**PASS: isolated PostgreSQL logical restore. INCONCLUSIVE: production backup and recovery readiness.**

A read-only dump of the disposable synthetic database was restored into a newly created database in the same local container. Neither existing app database was reset or restored over. No production database, production user record, scheduler, or backup retention directory was accessed or changed.

| Check | Evidence |
|---|---|
| Source | `supabase_db_sasha-readiness-20260915`, database `postgres`, local port 54332 |
| Successful destination | `readiness_restore_879f4c8e3822`, same disposable container |
| Dump | Container-native `pg_dump --no-owner --no-privileges`; 11,753,136 bytes |
| SHA-256 | `934c70623c4c8cfde94ba27a04d0bb8e8af27c3d8dd110fb6bdb592be7d16629` |
| Restore | Container-native `psql --single-transaction -v ON_ERROR_STOP=1`, exit 0 |
| Migrations | 39 source migration records; 39 restored |
| Table counts | All 84 COPY-backed tables matched the exact dump snapshot row counts; zero mismatches |
| Rows | 324,341 total rows across those tables, mostly catalog/reference data; no row contents included here |
| Public tables | 47 restored |

Expected counts came from each `COPY` section in the consistent dump, not a later reread of the actively tested source database. This avoids falsely treating concurrent UI edits as restore corruption.

The first attempt, into `readiness_restore_fd3bee3d211b`, failed with `permission denied for table secrets` under the local `postgres` role. The restore transaction rolled back. A fresh database and local `supabase_admin` role succeeded. Hosted branch role permissions remain unverified. Both temporary databases are retained for this task; neither is used by the app.

Local synthetic-only working files: `/tmp/sasha-restore-drill/report.json`, `/tmp/sasha-restore-drill/synthetic.sql` (mode 0600), `/tmp/sasha-restore-drill.py`. The SQL is not attached to this report or committed.

## Source checks and limits

- `scripts/backup.sh:23` runs separate data and schema dumps, combines them, rejects files under 1 KB, and retains 14 dated SQL files. The actual script was **not executed** because it writes into the real backup directory and rotates existing backups. The drill used a single native PostgreSQL dump, so it does not prove the exact Supabase CLI dump format or two-pass consistency.
- `scripts/backup.sh:25` writes directly to the dated final filename. It does not atomically rename a fully verified final file, so interruption can leave an incomplete replacement of that day's dump.
- `scripts/restore-to-branch.sh:12` blocks one literal production project reference and requires exact typed host-derived confirmation before transactional restore. It does **not** verify that every accepted target is a Supabase branch; the comment overstates that protection. The helper was not invoked and no target confirmation was bypassed.
- Both shell helpers pass connection URLs in process arguments. The drill avoided credential-bearing arguments by using the local container's role directly.
- `app/api/jobs/backup/route.ts` writes paginated user-table JSON into the private backup bucket after a bearer check and daily lock. This is separate from the SQL backup. The drill did not validate a JSON import/recovery path, Storage object bytes, encryption keys, role grants, remote infrastructure, or scheduled execution.
- `vercel.json` contains no `/api/jobs/backup` schedule. The backup route only exports POST. No assumption is made that an external scheduler or the Mac launchd SQL backup is installed or healthy; neither scheduler was inspected or changed.
- Row-count equality and 39 migration records prove this local dump can reconstruct database structure and data counts. They do not prove production backup freshness, 14-day retention, object storage recovery, field-by-field checksums, or application acceptance against the restored database.
