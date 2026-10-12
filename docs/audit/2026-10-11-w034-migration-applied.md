# W034 migration applied to production, 2026-10-11

Project `fivatgdpuenszxxnijpc`. Owner approval: Devin, in session, 2026-10-11.

## Backup
`~/Backups/supabase/meal-companion/2026-10-11T232146Z-e2d2561c.sql` (23,784,950 bytes,
sha256 `c69f18838275e202ce7b08b71568ede95e77082c5055d31c46cb50774dd7da3d`), taken by `scripts/backup.sh` before the apply.

## Applied
Dry run (`scripts/apply-migrations.py`) listed one pending file; `--commit` applied and recorded it:
- `20261231200000_clock_lock_order` (function bodies and two lock helpers; no table or data change)

## Verified (read-only SQL)
- `supabase_migrations.schema_migrations` holds `20261231200000`.
- `_clock_lock_evidence` and `_clock_lock_rules` exist.
- `recipe_plan_bump_state`, `get_or_create_food_ref` and `catalog_write_provider_revision` call the evidence
  helper before the rules helper; the three other `recipe_plan_bump_*` triggers take the evidence row.
- `favor_food_families` names `evidence_clock` before `account_rules_clock` (the W034 comment is in the live body).
