-- Phase 0: architecture v2.1 §2.1. Three shapes, three patterns, written out per table rather
-- than looped, so a reader sees exactly which policy guards which table.

-- ---------- pattern 1: owner tables (user_id column) ---------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'user_foods','user_food_prefs','log_entries','water_log','plan_days','user_settings','gut_log',
    'recipes','favorites_foods','favorites_recipes','favorites_meals',
    'target_profiles','expenditure_estimates','target_proposals',
    'constraint_profiles','coach_threads','ai_calls',
    'api_tokens','health_sources','ingest_events','health_samples',
    'change_seq','change_log','duplicate_groups']
  loop
    execute format('alter table %I enable row level security', t);
    execute format($f$create policy %I on %I for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))$f$,
      t || '_rw', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table %I to authenticated', t);
  end loop;
end $$;

-- ---------- pattern 2: child tables reached through their parent ----------------------
alter table log_items enable row level security;
create policy log_items_rw on log_items for all to authenticated
  using  (exists (select 1 from log_entries e where e.id = log_items.entry_id and e.user_id = (select auth.uid())))
  with check (exists (select 1 from log_entries e where e.id = log_items.entry_id and e.user_id = (select auth.uid())));

alter table duplicate_group_members enable row level security;
create policy duplicate_group_members_rw on duplicate_group_members for all to authenticated
  using  (exists (select 1 from duplicate_groups g where g.id = duplicate_group_members.group_id and g.user_id = (select auth.uid())))
  with check (exists (select 1 from duplicate_groups g where g.id = duplicate_group_members.group_id and g.user_id = (select auth.uid())));

alter table recipe_revisions enable row level security;
create policy recipe_revisions_rw on recipe_revisions for all to authenticated
  using  (exists (select 1 from recipes r where r.id = recipe_revisions.recipe_id and r.user_id = (select auth.uid())))
  with check (exists (select 1 from recipes r where r.id = recipe_revisions.recipe_id and r.user_id = (select auth.uid())));

alter table recipe_items enable row level security;
create policy recipe_items_rw on recipe_items for all to authenticated
  using  (exists (select 1 from recipe_revisions v join recipes r on r.id = v.recipe_id
                   where v.id = recipe_items.recipe_revision_id and r.user_id = (select auth.uid())))
  with check (exists (select 1 from recipe_revisions v join recipes r on r.id = v.recipe_id
                   where v.id = recipe_items.recipe_revision_id and r.user_id = (select auth.uid())));

alter table favorites_meal_items enable row level security;
create policy favorites_meal_items_rw on favorites_meal_items for all to authenticated
  using  (exists (select 1 from favorites_meals m where m.id = favorites_meal_items.meal_id and m.user_id = (select auth.uid())))
  with check (exists (select 1 from favorites_meals m where m.id = favorites_meal_items.meal_id and m.user_id = (select auth.uid())));

-- coach_messages is reached through coach_threads the same way log_items is reached through
-- log_entries; the plan's table list omitted it, which left it unprotected (see deviation note).
alter table coach_messages enable row level security;
create policy coach_messages_rw on coach_messages for all to authenticated
  using  (exists (select 1 from coach_threads th where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())))
  with check (exists (select 1 from coach_threads th where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())));

do $$
declare t text;
begin
  foreach t in array array['log_items','duplicate_group_members','recipe_revisions',
                           'recipe_items','favorites_meal_items','coach_messages']
  loop
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table %I to authenticated', t);
  end loop;
end $$;

-- ---------- pattern 3: shared reference tables ----------------------------------------
-- Read-only to users, written by the import worker with the admin client. food_refs rows of
-- kind='user' are additionally filtered through the join to user_foods.user_id, so another
-- user's custom food never appears in search.
alter table food_refs enable row level security;
create policy food_refs_read on food_refs for select to authenticated
  using (kind = 'catalog'
         or exists (select 1 from user_foods f
                     where f.id = food_refs.user_food_id and f.user_id = (select auth.uid())));
revoke all on table food_refs from anon, authenticated;
grant select on table food_refs to authenticated;

do $$
declare t text;
begin
  foreach t in array array['catalog_versions','catalog_foods','catalog_food_revisions',
    'catalog_nutrients','catalog_food_nutrients','catalog_barcodes','catalog_portions',
    'catalog_ingredients','catalog_dri']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to authenticated using (true)',
                   t || '_read', t);
    execute format('revoke all on table %I from anon, authenticated', t);
    execute format('grant select on table %I to authenticated', t);
  end loop;
end $$;

-- ---------- views ---------------------------------------------------------------------
-- A Postgres view runs as its owner by default and would bypass the RLS of its base tables.
create view weigh_ins with (security_invoker = true) as
  select user_id, id, start_time, (start_time at time zone tz)::date as local_date, value, unit
    from health_samples where type = 'body_mass';
revoke all on weigh_ins from anon, authenticated;
grant select on weigh_ins to authenticated;
