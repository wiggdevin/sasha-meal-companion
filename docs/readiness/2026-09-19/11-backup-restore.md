# 11: Backup/restore readiness

**Outcome:** proved on a disposable local target

**Severity:** none for local recovery proof; cloud branch procedure has an owner note

## Latest backup proved

- Dump: `2026-09-19T175843Z-0a890e1b.sql`
- Location: `~/Backups/supabase/meal-companion/`
- Size: 16,942,163 bytes.
- Its JSON receipt matches the dump's byte count and SHA-256.
- Receipt format: `postgresql-plain-v1`, PostgreSQL major 17.
- Static row count in the dump's 95 COPY sections: **455,473**.

Largest COPY sections were `catalog_food_nutrients` (259,377), staging `food_nutrient` (103,189), `catalog_portions` (36,681), staging `food_portion` (22,046), `catalog_food_revisions` (13,694), and `catalog_foods` (13,694).

## Restore proof

Attempt 5 used the reset local Supabase stack on `feat/tidy-and-loops`, not production or the shared cloud branch. The local stack had 56 migrations, its `public` tables were truncated to zero, and the dump's public data was loaded.

- Attempt opened: `2026-09-19T21:41:28Z`.
- Data load: `21:41:54Z` to `21:41:57Z`, about 3 seconds.
- Attempt header through load completion: about 29 seconds, including reset, truncate, and the zero-row check.
- Restored `public` rows: **324,255**.
- Dump `public` COPY rows: **324,255**.
- Full dump COPY rows across all schemas: **455,473** in 95 COPY blocks.

The full-dump total consists of 324,255 `public`, 130,789 `catalog_staging`, 225 `auth`, 82 `realtime`, 74 `storage`, and 48 `supabase_migrations` rows. The restored `public` total therefore matches the dump exactly within the scope measured by the proof.

## User-table counts

| Table | Restored rows |
|---|---:|
| `coach_messages` | 52 |
| `coach_threads` | 16 |
| `health_samples` | 0 |
| `plan_days` | 8 |
| `recipes` | 1 |
| `target_profiles` | 0 |
| `user_food_prefs` | 21 |
| `user_foods` | 22 |
| `user_settings` | 0 |
| `water_log` | 4 |

The dump itself contains zero rows for `user_settings` and `target_profiles`. It predates the profile migration and its profile data, so both restored zeros are faithful to the backup rather than missing rows.

The local load reported eight known non-public Realtime errors: four references to the cloud-only `supabase_realtime_admin` role and four permission failures for the `realtime` schema. The local stack does not reproduce those cloud role grants. These errors did not affect the exact `public` row match. The local stack was reset again after the proof.

Earlier attempts established the target constraints: the session pooler port could not run the restore, a migrated branch collided with seeded data, and an empty local PostgreSQL database lacked the Supabase schemas and roles.

## Owner step

A future cloud branch rehearsal needs a fresh, unmigrated preview branch: the platform schemas and roles must exist, but project migrations and seed data must not already occupy the target. Do not restore this full dump over a migrated/shared branch. The disposable local recovery path is proved.
