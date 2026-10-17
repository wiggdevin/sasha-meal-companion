-- TEST-ONLY helpers. Applied by scripts/db-branch.sh to a preview branch, never to production.
-- [db.seed] enabled = false in config.toml keeps `supabase db reset --linked` from installing them.

-- `supabase db reset --db-url` recreates public tables as the branch database
-- owner but does not reproduce Supabase's hosted default privileges. Restore
-- the production-equivalent service-role boundary before integration tests use
-- their admin client; without this, normal reads and writes fail with 42501.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
-- Functions get the same treatment: a function created with an explicit
-- `revoke execute ... from public, anon` (e.g. a check-constraint helper) keeps execute for its
-- owner only on a reset branch, not the service_role default a hosted project grants at create
-- time. Without this, admin-client inserts/updates that invoke such a function fail with
-- "permission denied for function ..." (42501).
grant execute on all functions in schema public to service_role;
-- The grant above would hand service_role update and delete on the immutable coach Undo
-- receipts; production grants it select and insert only (20261216090000).
do $$
begin
  if to_regclass('public.coach_action_receipts') is not null then
    revoke update, delete, truncate on table public.coach_action_receipts from service_role;
  end if;
  -- Phase 18 W6 (20261219090000): production gives service_role select, delete and a
  -- column-level insert that leaves out created_at (so no API role can back-date it and keep a
  -- far-future event past the 180-day purge). A table-level insert would cover every column.
  if to_regclass('public.food_signal_events') is not null then
    revoke all on table public.food_signal_events from service_role;
    grant select, delete on table public.food_signal_events to service_role;
    grant insert (id, user_id, client_event_id, slate_id, at, local_date, surface, kind, occasion,
                  chosen_key, offered_keys, ranking_version)
      on table public.food_signal_events to service_role;
  end if;
end $$;

-- Raw catalog read for tests/rls/security-invoker.test.ts. PostgREST cannot reach pg_class.
create or replace function test_view_options()
  returns table (view_name text, options text[])
  language sql stable security definer set search_path = public, pg_catalog as $$
  select c.relname::text, coalesce(c.reloptions, '{}'::text[])
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'; $$;
revoke execute on function test_view_options() from public, anon, authenticated;
grant execute on function test_view_options() to service_role;

-- Clear one user's rows between tests, children first.
create or replace function test_reset_user(p_user_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  -- Every other user-owned table (W075). Guarded, so a branch that predates a table still
  -- resets; children go before their parents (a selection's target FK has no cascade), and
  -- tests/migrations/test-reset-user-coverage.test.ts fails when a table with a user_id column
  -- in tests/tenancy/table-ops.json is missing from these lists.
  foreach t in array array[
    'recipe_plan_selections', 'recipe_plan_previews', 'recipe_consumed_undo_requests',
    'recipe_consumed_slot_state', 'recipe_consumed_requests',
    'shopping_purchase_window_edits', 'shopping_purchase_windows', 'shopping_lines',
    'shopping_pantry', 'shopping_periods',
    'care_points_ledger', 'care_inventory', 'care_equipped', 'care_purchase_receipts',
    'care_accolades', 'care_messages',
    'taste_chip_holds', 'taste_chip_receipts', 'taste_dislike_removals',
    'food_signal_events', 'onboarding_events', 'coach_intent_events', 'client_timings',
    'favorites_catalog_recipes', 'food_allergen_evidence', 'food_facets',
    'food_membership_ops', 'food_membership_revisions', 'food_note_authority',
    'food_world_condition_confirmations', 'user_allergen_checks', 'user_dietary_profiles',
    'ai_spend_reservations', 'ai_spend_user_days', 'job_runs', 'media_objects', 'oauth_states',
    'voice_ears', 'sync_op_receipts'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from %I where user_id = $1', t) using p_user_id;
    end if;
  end loop;
  delete from change_log     where user_id = p_user_id;
  delete from change_seq     where user_id = p_user_id;
  delete from duplicate_groups where user_id = p_user_id;
  delete from log_entries    where user_id = p_user_id;
  delete from water_log      where user_id = p_user_id;
  delete from plan_days      where user_id = p_user_id;
  delete from gut_log        where user_id = p_user_id;
  delete from user_settings  where user_id = p_user_id;
  delete from user_food_prefs where user_id = p_user_id;
  delete from recipes        where user_id = p_user_id;   -- cascades to recipe_revisions, recipe_items
  delete from favorites_meals where user_id = p_user_id;  -- cascades to favorites_meal_items
  delete from favorites_recipes where user_id = p_user_id;
  delete from favorites_foods where user_id = p_user_id;
  -- Coach Undo records and receipts (receipts are immutable to every client role; the owner
  -- deletes them here as the account cascade would).
  if to_regclass('public.coach_action_receipts') is not null then
    execute 'delete from coach_action_receipts where user_id = $1' using p_user_id;
  end if;
  delete from coach_action_undos where user_id = p_user_id;
  delete from coach_threads  where user_id = p_user_id;   -- cascades to coach_messages
  delete from user_foods     where user_id = p_user_id;   -- cascades to food_refs
  delete from health_samples where user_id = p_user_id;
  delete from ingest_events  where user_id = p_user_id;
  delete from health_sources where user_id = p_user_id;
  delete from api_tokens     where user_id = p_user_id;
  delete from target_proposals where user_id = p_user_id;
  delete from expenditure_estimates where user_id = p_user_id;
  delete from target_profiles where user_id = p_user_id;
  delete from constraint_profiles where user_id = p_user_id;
  delete from ai_calls       where user_id = p_user_id;
  -- Deleting the rows above can bump these clocks; remove the final rows last.
  foreach t in array array['recipe_plan_state', 'account_rules_clock'] loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from %I where user_id = $1', t) using p_user_id;
    end if;
  end loop;
end; $$;
revoke execute on function test_reset_user(uuid) from public, anon, authenticated;
grant execute on function test_reset_user(uuid) to service_role;

-- Raw grant read for tests/health/migration-ingest.test.ts. information_schema is not exposed
-- through PostgREST, so the test asserts grant shape through this helper.
create or replace function test_table_grants(p_tables text[])
  returns table (table_name text, privilege_type text)
  language sql stable security definer set search_path = public, pg_catalog as $$
  select g.table_name::text, g.privilege_type::text
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name = any(p_tables)
     and g.grantee = 'authenticated'; $$;
revoke execute on function test_table_grants(text[]) from public, anon, authenticated;
grant execute on function test_table_grants(text[]) to service_role;
