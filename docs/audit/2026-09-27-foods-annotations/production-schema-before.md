# Production schema before annotations release

Root read-only Supabase query against verified project `fivatgdpuenszxxnijpc`, 2026-09-27 America/Denver (`BEGIN READ ONLY; SELECT version,name FROM supabase_migrations.schema_migrations WHERE version >= '20261127090000' ORDER BY version; COMMIT;`). Returned:

- 20261127090000 recipe_catalog_shopping
- 20261128090000 recipe_plan_accept
- 20261129090000 recipe_eaten_snapshots
- 20261130090000 recipe_consumed_cas
- 20261201090000 recipe_consumed_sync
- 20261202090000 scope_recipe_food_ref_clock

These six pilot migrations are recorded in production. The new custom-rule and note-edit migrations are not yet applied. This receipt does not alone prove app deployment, feature flag or data seed.
