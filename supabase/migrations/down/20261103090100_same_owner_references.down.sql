-- Reverse of 20261103090100_same_owner_references.sql. Rolling back reopens the 21 cross-account
-- write cases (PR #247), the four health and target references, parent owner changes and the
-- plan_days client delete, so run it only to unblock a broken deploy, and re-apply the forward
-- migration as soon as possible.
drop trigger if exists same_owner on log_items;
drop trigger if exists same_owner on favorites_meal_items;
drop trigger if exists same_owner on recipe_items;
drop trigger if exists same_owner on user_food_prefs;
drop trigger if exists same_owner on favorites_foods;
drop trigger if exists same_owner on favorites_recipes;
drop trigger if exists same_owner on duplicate_group_members;
drop trigger if exists same_owner on duplicate_groups;
drop trigger if exists same_owner on media_objects;
drop trigger if exists same_owner on coach_messages;
drop trigger if exists same_owner on ingest_events;
drop trigger if exists same_owner on health_samples;
drop trigger if exists same_owner on target_proposals;
drop trigger if exists owner_fixed on user_foods;
drop trigger if exists owner_fixed on log_entries;
drop trigger if exists owner_fixed on recipes;
drop trigger if exists owner_fixed on favorites_meals;
drop trigger if exists owner_fixed on duplicate_groups;
drop trigger if exists owner_fixed on coach_threads;
drop trigger if exists owner_fixed on ai_calls;
drop trigger if exists owner_fixed on health_sources;
drop trigger if exists owner_fixed on ingest_events;
drop trigger if exists owner_fixed on expenditure_estimates;
drop trigger if exists owner_fixed on food_refs;
drop trigger if exists owner_fixed on recipe_revisions;

drop function if exists public._same_owner_log_items();
drop function if exists public._same_owner_favorites_meal_items();
drop function if exists public._same_owner_recipe_items();
drop function if exists public._same_owner_food_ref_by_user();
drop function if exists public._same_owner_favorites_recipes();
drop function if exists public._same_owner_duplicate_group_members();
drop function if exists public._same_owner_entry_by_user();
drop function if exists public._same_owner_coach_messages();
drop function if exists public._same_owner_ingest_events();
drop function if exists public._same_owner_health_samples();
drop function if exists public._same_owner_target_proposals();
drop function if exists public._owner_fixed();
drop function if exists public._food_ref_fixed();
drop function if exists public._recipe_revision_fixed();
drop function if exists public._ingest_event_fixed();
drop function if exists public._food_ref_owner(uuid);
drop function if exists public._entry_owner(uuid);
drop function if exists public._refuse_cross_account(text);

-- coach_messages: the Phase 0 policy (20260911000500_rls.sql), thread check only.
drop policy if exists coach_messages_rw on coach_messages;
create policy coach_messages_rw on coach_messages for all to authenticated
  using  (exists (select 1 from coach_threads th where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())))
  with check (exists (select 1 from coach_threads th where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())));

-- plan_days: the Phase 0 pattern-1 policy and all four grants.
drop policy if exists plan_days_select on plan_days;
drop policy if exists plan_days_insert on plan_days;
drop policy if exists plan_days_update on plan_days;
drop policy if exists plan_days_rw on plan_days;
create policy plan_days_rw on plan_days for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant delete on table plan_days to authenticated;
