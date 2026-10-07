# TDEE step E migrations — production receipt (2026-10-04 MDT / 2026-10-05 UTC)

Owner instruction (Devin, 2026-10-04): apply the migrations to production and merge in order.
Tool: `scripts/apply-migrations.py --commit` from each PR's own checkout (each migration and its
ledger row in one transaction), token and project ref from ZS Vault, never printed. Each
migration is additive (nullable columns; functions read optional JSON keys), so the code on
`main` before its PR keeps working.

| Migration | PR | Backup taken first (`~/Backups/supabase/meal-companion/`) | sha256 |
|---|---|---|---|
| `20261209090000_target_seed_freeze` | #350 | `2026-10-05T043904Z-7db789c5.sql` (21,224,623 B) | `aff46b4d6cdfb7c9e11b098d770491025d3a84b3ae54d6e8e97a62a493eb7aa4` |
| `20261209090100_plan_days_day_complete` | #351 | `2026-10-05T043956Z-d5a0b8e9.sql` (21,230,917 B) | `2adbbed3370b338d2e4dd4c5d12e5df343327f374ce58f49bee1bebd17648ece` |
| `20261209090200_expenditure_v3` | #352 | `2026-10-05T044034Z-490b9d83.sql` (21,236,084 B) | `155378671dae217887b6cd8e68ed7a4bddbe258c29615638861bbebcdfe2e8ed` |

## Verification (read-only transaction after each apply)

- `target_profiles` has `initial_tdee_kcal`, `bmr_kcal`, `bmr_method`, `activity_model_version`,
  `derivation_version`; `write_target_revision` and `approve_target_proposal` both carry the seed
  columns.
- `plan_days.day_complete_at` and `user_settings.day_marks_started_on` exist; trigger
  `plan_days_record_first_mark` exists; `_sync_upsert` handles `day_complete_at`.
- `expenditure_estimates` has all eight v3 columns; `upsert_expenditure_estimate` writes
  `fluid_cycle_days`.
- Ledger head: `20261209090200`, `20261209090100`, `20261209090000`.

The dry run before the first apply named only `20261209090000`, so production matched `main`
before these three.
