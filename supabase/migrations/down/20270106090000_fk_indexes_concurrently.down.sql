-- Reverse of 20270106090000_fk_indexes_concurrently.sql: drops the 30 foreign-key indexes. Nothing
-- depends on them; deletes on the referenced rows go back to scanning the referencing tables.
-- NOT IN A TRANSACTION, like the up file: run it with `psql -f`, never inside begin/commit.

drop index concurrently if exists public.catalog_barcodes_catalog_food;
drop index concurrently if exists public.user_foods_catalog_food;
drop index concurrently if exists public.user_food_prefs_food_ref;
drop index concurrently if exists public.recipe_items_food_ref;
drop index concurrently if exists public.recipe_items_food_revision;
drop index concurrently if exists public.favorites_foods_food_ref;
drop index concurrently if exists public.favorites_recipes_recipe;
drop index concurrently if exists public.favorites_meal_items_food_ref;
drop index concurrently if exists public.log_items_food_revision;
drop index concurrently if exists public.log_items_portion;
drop index concurrently if exists public.target_proposals_based_on_estimate;
drop index concurrently if exists public.duplicate_groups_merged_into_entry;
drop index concurrently if exists public.duplicate_group_members_entry;
drop index concurrently if exists public.health_samples_ingest_event;
drop index concurrently if exists public.health_samples_source;
drop index concurrently if exists public.media_objects_entry;
drop index concurrently if exists public.recipe_catalog_current_revision;
drop index concurrently if exists public.recipe_catalog_items_food_ref;
drop index concurrently if exists public.recipe_catalog_items_food_revision;
drop index concurrently if exists public.favorites_catalog_recipes_recipe;
drop index concurrently if exists public.shopping_purchase_windows_line;
drop index concurrently if exists public.shopping_purchase_window_edits_window;
drop index concurrently if exists public.recipe_plan_selections_recipe;
drop index concurrently if exists public.recipe_plan_selections_recipe_revision;
drop index concurrently if exists public.recipe_plan_selections_target;
drop index concurrently if exists public.coach_action_undos_message_fk;
drop index concurrently if exists public.coach_action_undos_thread_fk;
drop index concurrently if exists public.care_inventory_item;
drop index concurrently if exists public.care_purchase_receipts_item;
drop index concurrently if exists public.care_accolades_key;
