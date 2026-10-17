-- W054 (docs/readiness/2026-10-17/README.md §3): an index behind every foreign key in public that
-- had none. The Supabase advisor listed 34; #173 (20270105100000) covered log_items.food_ref_id and
-- coach_messages.ai_call_id, and a migrated local stack on main shows the 31 below (30 indexes:
-- recipe_plan_selections (target_revision_id, user_id) serves both its single-column and its
-- two-column foreign key). Without one, every delete or key change on the referenced row scans the
-- referencing table, including the cascades an account deletion runs. Each index lists the foreign
-- key's own columns in its own order. tests/migrations/fk-indexes-db.test.ts fails when a later
-- migration adds a foreign key with no index.
--
-- NOT IN A TRANSACTION, like 20270105100000. CREATE INDEX CONCURRENTLY refuses to run inside a
-- transaction block, so this file holds nothing but the statements:
--   * The Supabase CLI runs each CONCURRENTLY statement on its own and records the version.
--   * scripts/apply-migrations.py wraps a file in begin/commit and CANNOT apply this one. Apply it
--     by hand: `psql "$DB_URL" -v ON_ERROR_STOP=1 -f <this file>` (each statement runs in its own
--     implicit transaction), then insert the ledger row for 20270106090000.
--   * A build that fails part way leaves an INVALID index that IF NOT EXISTS then skips. After
--     applying, check `select indexrelid::regclass from pg_index where not indisvalid`; drop any
--     listed here with DROP INDEX CONCURRENTLY and run the file again.
--
-- Order: independent of the code and of 20270106090200; either can go first.
-- Down: supabase/migrations/down/20270106090000_fk_indexes_concurrently.down.sql.

create index concurrently if not exists catalog_barcodes_catalog_food
  on public.catalog_barcodes (catalog_food_id);
create index concurrently if not exists user_foods_catalog_food
  on public.user_foods (catalog_food_id);
create index concurrently if not exists user_food_prefs_food_ref
  on public.user_food_prefs (food_ref_id);
create index concurrently if not exists recipe_items_food_ref
  on public.recipe_items (food_ref_id);
create index concurrently if not exists recipe_items_food_revision
  on public.recipe_items (food_revision_id);
create index concurrently if not exists favorites_foods_food_ref
  on public.favorites_foods (food_ref_id);
create index concurrently if not exists favorites_recipes_recipe
  on public.favorites_recipes (recipe_id);
create index concurrently if not exists favorites_meal_items_food_ref
  on public.favorites_meal_items (food_ref_id);
create index concurrently if not exists log_items_food_revision
  on public.log_items (food_revision_id);
create index concurrently if not exists log_items_portion
  on public.log_items (portion_id);
create index concurrently if not exists target_proposals_based_on_estimate
  on public.target_proposals (based_on_estimate_id);
create index concurrently if not exists duplicate_groups_merged_into_entry
  on public.duplicate_groups (merged_into_entry_id);
create index concurrently if not exists duplicate_group_members_entry
  on public.duplicate_group_members (entry_id);
create index concurrently if not exists health_samples_ingest_event
  on public.health_samples (ingest_event_id);
create index concurrently if not exists health_samples_source
  on public.health_samples (source_id);
create index concurrently if not exists media_objects_entry
  on public.media_objects (entry_id);
create index concurrently if not exists recipe_catalog_current_revision
  on public.recipe_catalog (id, current_revision_id);
create index concurrently if not exists recipe_catalog_items_food_ref
  on public.recipe_catalog_items (food_ref_id);
create index concurrently if not exists recipe_catalog_items_food_revision
  on public.recipe_catalog_items (food_revision_id);
create index concurrently if not exists favorites_catalog_recipes_recipe
  on public.favorites_catalog_recipes (recipe_id);
create index concurrently if not exists shopping_purchase_windows_line
  on public.shopping_purchase_windows (line_id, user_id, period_id);
create index concurrently if not exists shopping_purchase_window_edits_window
  on public.shopping_purchase_window_edits (window_id, user_id);
create index concurrently if not exists recipe_plan_selections_recipe
  on public.recipe_plan_selections (recipe_id);
create index concurrently if not exists recipe_plan_selections_recipe_revision
  on public.recipe_plan_selections (recipe_revision_id);
create index concurrently if not exists recipe_plan_selections_target
  on public.recipe_plan_selections (target_revision_id, user_id);
create index concurrently if not exists coach_action_undos_message_fk
  on public.coach_action_undos (message_id);
create index concurrently if not exists coach_action_undos_thread_fk
  on public.coach_action_undos (thread_id);
create index concurrently if not exists care_inventory_item
  on public.care_inventory (item_id);
create index concurrently if not exists care_purchase_receipts_item
  on public.care_purchase_receipts (item_id);
create index concurrently if not exists care_accolades_key
  on public.care_accolades (key);
