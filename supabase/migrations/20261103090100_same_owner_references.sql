-- Phase 9 spec 3.2: a row one account owns must never reference a row another account owns.
-- PR #247 (tests/tenancy/cross-refs.json) found 21 open cases. Each policy below checked the
-- owner column or the parent row, never the reference, so A could:
--   * insert or update her own row so it points at B's row, through ten references
--     (log_items / favorites_meal_items / recipe_items / user_food_prefs / favorites_foods
--      .food_ref_id, favorites_recipes.recipe_id, duplicate_group_members.entry_id,
--      duplicate_groups.merged_into_entry_id, media_objects.entry_id, coach_messages.ai_call_id);
--   * file a coach message in her own thread under B's user_id, which B's MCP tool then reads.
-- Review r1 of PR #250 added the four server-written references (ingest_events.source_id,
-- health_samples.source_id, health_samples.ingest_event_id, target_proposals.
-- based_on_estimate_id) and a sample's event must come from the sample's own source.
--
-- The fix is one BEFORE INSERT OR UPDATE trigger per child table. A trigger runs for every writer:
-- the signed-in client through PostgREST, the SECURITY DEFINER sync RPC (apply_sync_op →
-- _sync_upsert), the health ingest RPC and the service role. An RLS clause would cover only the
-- first, so the trigger is the one place the rule lives. The trigger functions are SECURITY
-- DEFINER, so they see the referenced row even when RLS hides it from the caller. They run with an
-- empty search_path and name every relation by schema. A refusal raises 42501, the same code as an
-- RLS refusal. coach_messages also gets user_id = auth.uid() in its policy.
--
-- A child can also become cross-account without being written, when its parent changes owner.
-- No app code changes an owner, so the owner of every referenced parent is now fixed after insert
-- (user_id on ten parents; ingest_events.source_id; food_refs.kind/user_food_id;
-- recipe_revisions.recipe_id).
--
-- Allowed, unchanged: a null reference (duplicate_groups.merged_into_entry_id,
-- media_objects.entry_id, coach_messages.ai_call_id, health_samples.ingest_event_id,
-- target_proposals.based_on_estimate_id), and a shared catalog food (food_refs.kind = 'catalog'
-- has no owner).
--
-- Also: plan_days loses its client DELETE. Spec 3 declares select, insert and update, and no app
-- code deletes plan_days as the user (sync writes go through the SECURITY DEFINER RPC).
--
-- Order: apply after 20261103090000 (PR #249), which stops a signed-in user calling the sync
-- internals for another account. Without it a direct _sync_upsert call writes rows that are
-- entirely B's, which a same-owner rule cannot see.
--
-- Idempotent: create or replace, drop ... if exists, then create. Section 4 is one DO block, so
-- its lock, its scan of existing rows and its trigger installation are one statement: atomic and
-- under the same locks whether or not the runner wraps the file in a transaction.

-- ---------- 1. owner lookups (SECURITY DEFINER: they must see rows RLS hides) -------------------
create or replace function public._refuse_cross_account(p_what text) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception 'cross_account_reference: %', p_what using errcode = '42501';
end $$;

-- The owner of a food ref, or null for a shared catalog food.
create or replace function public._food_ref_owner(p_ref uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select f.user_id from public.food_refs r join public.user_foods f on f.id = r.user_food_id
   where r.id = p_ref
$$;

create or replace function public._entry_owner(p_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select user_id from public.log_entries where id = p_id
$$;

-- ---------- 2. one same-owner trigger per child table ---------------------------------------------
create or replace function public._same_owner_log_items() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := public._food_ref_owner(new.food_ref_id);
begin
  if v_ref is not null and v_ref is distinct from public._entry_owner(new.entry_id) then
    perform public._refuse_cross_account('log_items.food_ref_id');
  end if;
  return new;
end $$;

create or replace function public._same_owner_favorites_meal_items() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := public._food_ref_owner(new.food_ref_id);
begin
  if v_ref is not null and v_ref is distinct from
       (select m.user_id from public.favorites_meals m where m.id = new.meal_id) then
    perform public._refuse_cross_account('favorites_meal_items.food_ref_id');
  end if;
  return new;
end $$;

create or replace function public._same_owner_recipe_items() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := public._food_ref_owner(new.food_ref_id);
begin
  if v_ref is not null and v_ref is distinct from (
       select p.user_id from public.recipe_revisions v join public.recipes p on p.id = v.recipe_id
        where v.id = new.recipe_revision_id) then
    perform public._refuse_cross_account('recipe_items.food_ref_id');
  end if;
  return new;
end $$;

-- user_food_prefs and favorites_foods: the same shape (user_id, food_ref_id).
create or replace function public._same_owner_food_ref_by_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_ref uuid := public._food_ref_owner(new.food_ref_id);
begin
  if v_ref is not null and v_ref is distinct from new.user_id then
    perform public._refuse_cross_account(tg_table_name || '.food_ref_id');
  end if;
  return new;
end $$;

create or replace function public._same_owner_favorites_recipes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select p.user_id from public.recipes p where p.id = new.recipe_id)
     is distinct from new.user_id then
    perform public._refuse_cross_account('favorites_recipes.recipe_id');
  end if;
  return new;
end $$;

create or replace function public._same_owner_duplicate_group_members() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public._entry_owner(new.entry_id) is distinct from
       (select g.user_id from public.duplicate_groups g where g.id = new.group_id) then
    perform public._refuse_cross_account('duplicate_group_members.entry_id');
  end if;
  return new;
end $$;

-- duplicate_groups.merged_into_entry_id and media_objects.entry_id: nullable, (user_id, entry_id).
create or replace function public._same_owner_entry_by_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_entry uuid := case tg_table_name when 'duplicate_groups'
                              then (to_jsonb(new) ->> 'merged_into_entry_id')::uuid
                              else (to_jsonb(new) ->> 'entry_id')::uuid end;
begin
  if v_entry is not null and public._entry_owner(v_entry) is distinct from new.user_id then
    perform public._refuse_cross_account(tg_table_name || case tg_table_name
      when 'duplicate_groups' then '.merged_into_entry_id' else '.entry_id' end);
  end if;
  return new;
end $$;

create or replace function public._same_owner_coach_messages() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select th.user_id from public.coach_threads th where th.id = new.thread_id)
     is distinct from new.user_id then
    perform public._refuse_cross_account('coach_messages.user_id');
  end if;
  if new.ai_call_id is not null
     and (select c.user_id from public.ai_calls c where c.id = new.ai_call_id)
         is distinct from new.user_id then
    perform public._refuse_cross_account('coach_messages.ai_call_id');
  end if;
  return new;
end $$;

create or replace function public._same_owner_ingest_events() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select s.user_id from public.health_sources s where s.id = new.source_id)
     is distinct from new.user_id then
    perform public._refuse_cross_account('ingest_events.source_id');
  end if;
  return new;
end $$;

-- A sample's source must be the sample owner's, and its event (when set) must be the owner's and
-- come from that same source: health_ingest_apply checks the source but trusts p_event_id.
create or replace function public._same_owner_health_samples() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select s.user_id from public.health_sources s where s.id = new.source_id)
     is distinct from new.user_id then
    perform public._refuse_cross_account('health_samples.source_id');
  end if;
  if new.ingest_event_id is not null and not exists (
       select 1 from public.ingest_events ev
        where ev.id = new.ingest_event_id and ev.user_id = new.user_id
          and ev.source_id = new.source_id) then
    perform public._refuse_cross_account('health_samples.ingest_event_id');
  end if;
  return new;
end $$;

create or replace function public._same_owner_target_proposals() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.based_on_estimate_id is not null
     and (select x.user_id from public.expenditure_estimates x where x.id = new.based_on_estimate_id)
         is distinct from new.user_id then
    perform public._refuse_cross_account('target_proposals.based_on_estimate_id');
  end if;
  return new;
end $$;

-- ---------- 3. a referenced parent keeps its owner -------------------------------------------------
create or replace function public._owner_fixed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id then
    perform public._refuse_cross_account(tg_table_name || '.user_id is fixed after insert');
  end if;
  return new;
end $$;

create or replace function public._food_ref_fixed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind is distinct from old.kind or new.user_food_id is distinct from old.user_food_id then
    perform public._refuse_cross_account('food_refs.user_food_id is fixed after insert');
  end if;
  return new;
end $$;

create or replace function public._recipe_revision_fixed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.recipe_id is distinct from old.recipe_id then
    perform public._refuse_cross_account('recipe_revisions.recipe_id is fixed after insert');
  end if;
  return new;
end $$;

-- An ingest event keeps its owner and its source (PR #250 review r2): moving it to another of the
-- same account's sources would leave its samples on the old source while their event names the
-- new one. No code moves an event (health_ingest_event's upsert only sets status).
create or replace function public._ingest_event_fixed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.user_id is distinct from old.user_id or new.source_id is distinct from old.source_id then
    perform public._refuse_cross_account('ingest_events.user_id/source_id is fixed after insert');
  end if;
  return new;
end $$;

-- Internal: triggers call these, nobody else needs to.
do $$
declare f text;
begin
  foreach f in array array['_refuse_cross_account(text)', '_food_ref_owner(uuid)',
    '_entry_owner(uuid)', '_same_owner_log_items()', '_same_owner_favorites_meal_items()',
    '_same_owner_recipe_items()', '_same_owner_food_ref_by_user()',
    '_same_owner_favorites_recipes()', '_same_owner_duplicate_group_members()',
    '_same_owner_entry_by_user()', '_same_owner_coach_messages()', '_same_owner_ingest_events()',
    '_same_owner_health_samples()', '_same_owner_target_proposals()', '_owner_fixed()',
    '_food_ref_fixed()', '_recipe_revision_fixed()', '_ingest_event_fixed()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ---------- 4. lock, refuse over existing violating rows, then install the triggers ------------
-- One DO block. SHARE ROW EXCLUSIVE blocks every insert, update and delete on these tables (and a
-- second run of this migration) until the transaction ends, while reads go on. Without it a write
-- could commit after its table was scanned and before its trigger exists, and stay unchecked.
-- A trigger does not re-check old rows, so a violating row would stay silently: stop instead,
-- with the count per reference, so the operator can inspect them before anything changes.
-- Each trigger fires on insert and on an update of the owner or the reference column, so a
-- repoint through either side is checked and unrelated updates (rev, sort) cost nothing.
do $$
declare
  v_report text;
  v_trg record;
begin
  execute 'lock table public.log_items, public.favorites_meal_items, public.recipe_items,
    public.user_food_prefs, public.favorites_foods, public.favorites_recipes,
    public.duplicate_group_members, public.duplicate_groups, public.media_objects,
    public.coach_messages, public.ingest_events, public.health_samples, public.target_proposals,
    public.food_refs, public.user_foods, public.log_entries, public.recipes,
    public.recipe_revisions, public.favorites_meals, public.coach_threads, public.ai_calls,
    public.health_sources, public.expenditure_estimates
    in share row exclusive mode';

  select string_agg(format('%s=%s', what, n), ', ') into v_report from (
    select 'log_items.food_ref_id' as what, count(*) as n
      from public.log_items i join public.log_entries e on e.id = i.entry_id
      join public.food_refs r on r.id = i.food_ref_id
      join public.user_foods f on f.id = r.user_food_id
     where f.user_id <> e.user_id
    union all
    select 'favorites_meal_items.food_ref_id', count(*)
      from public.favorites_meal_items i join public.favorites_meals m on m.id = i.meal_id
      join public.food_refs r on r.id = i.food_ref_id
      join public.user_foods f on f.id = r.user_food_id
     where f.user_id <> m.user_id
    union all
    select 'recipe_items.food_ref_id', count(*)
      from public.recipe_items i join public.recipe_revisions v on v.id = i.recipe_revision_id
      join public.recipes p on p.id = v.recipe_id
      join public.food_refs r on r.id = i.food_ref_id
      join public.user_foods f on f.id = r.user_food_id
     where f.user_id <> p.user_id
    union all
    select 'user_food_prefs.food_ref_id', count(*)
      from public.user_food_prefs t join public.food_refs r on r.id = t.food_ref_id
      join public.user_foods f on f.id = r.user_food_id
     where f.user_id <> t.user_id
    union all
    select 'favorites_foods.food_ref_id', count(*)
      from public.favorites_foods t join public.food_refs r on r.id = t.food_ref_id
      join public.user_foods f on f.id = r.user_food_id
     where f.user_id <> t.user_id
    union all
    select 'favorites_recipes.recipe_id', count(*)
      from public.favorites_recipes t join public.recipes p on p.id = t.recipe_id
     where p.user_id <> t.user_id
    union all
    select 'duplicate_group_members.entry_id', count(*)
      from public.duplicate_group_members t join public.duplicate_groups g on g.id = t.group_id
      join public.log_entries e on e.id = t.entry_id
     where e.user_id <> g.user_id
    union all
    select 'duplicate_groups.merged_into_entry_id', count(*)
      from public.duplicate_groups t join public.log_entries e on e.id = t.merged_into_entry_id
     where e.user_id <> t.user_id
    union all
    select 'media_objects.entry_id', count(*)
      from public.media_objects t join public.log_entries e on e.id = t.entry_id
     where e.user_id <> t.user_id
    union all
    select 'coach_messages.ai_call_id', count(*)
      from public.coach_messages t join public.ai_calls c on c.id = t.ai_call_id
     where c.user_id <> t.user_id
    union all
    select 'coach_messages.user_id', count(*)
      from public.coach_messages t join public.coach_threads th on th.id = t.thread_id
     where th.user_id <> t.user_id
    union all
    select 'ingest_events.source_id', count(*)
      from public.ingest_events t join public.health_sources s on s.id = t.source_id
     where s.user_id <> t.user_id
    union all
    select 'health_samples.source_id', count(*)
      from public.health_samples t join public.health_sources s on s.id = t.source_id
     where s.user_id <> t.user_id
    union all
    select 'health_samples.ingest_event_id', count(*)
      from public.health_samples t join public.ingest_events ev on ev.id = t.ingest_event_id
     where ev.user_id <> t.user_id or ev.source_id <> t.source_id
    union all
    select 'target_proposals.based_on_estimate_id', count(*)
      from public.target_proposals t
      join public.expenditure_estimates x on x.id = t.based_on_estimate_id
     where x.user_id <> t.user_id
  ) c where n > 0;
  if v_report is not null then
    raise exception 'same_owner_references: existing rows reference another account (%). '
      'Nothing was changed. Inspect them with the pre-check query in the PR before applying.',
      v_report using errcode = '23514';
  end if;

  for v_trg in select * from (values
    ('log_items', 'same_owner', 'entry_id, food_ref_id', '_same_owner_log_items'),
    ('favorites_meal_items', 'same_owner', 'meal_id, food_ref_id', '_same_owner_favorites_meal_items'),
    ('recipe_items', 'same_owner', 'recipe_revision_id, food_ref_id', '_same_owner_recipe_items'),
    ('user_food_prefs', 'same_owner', 'user_id, food_ref_id', '_same_owner_food_ref_by_user'),
    ('favorites_foods', 'same_owner', 'user_id, food_ref_id', '_same_owner_food_ref_by_user'),
    ('favorites_recipes', 'same_owner', 'user_id, recipe_id', '_same_owner_favorites_recipes'),
    ('duplicate_group_members', 'same_owner', 'group_id, entry_id',
     '_same_owner_duplicate_group_members'),
    ('duplicate_groups', 'same_owner', 'user_id, merged_into_entry_id', '_same_owner_entry_by_user'),
    ('media_objects', 'same_owner', 'user_id, entry_id', '_same_owner_entry_by_user'),
    ('coach_messages', 'same_owner', 'thread_id, user_id, ai_call_id', '_same_owner_coach_messages'),
    ('ingest_events', 'same_owner', 'user_id, source_id', '_same_owner_ingest_events'),
    ('health_samples', 'same_owner', 'user_id, source_id, ingest_event_id',
     '_same_owner_health_samples'),
    ('target_proposals', 'same_owner', 'user_id, based_on_estimate_id',
     '_same_owner_target_proposals')
  ) as v(tbl, name, cols, fn)
  loop
    execute format('drop trigger if exists %I on public.%I', v_trg.name, v_trg.tbl);
    execute format('create trigger %I before insert or update of %s on public.%I '
                   'for each row execute function public.%I()',
                   v_trg.name, v_trg.cols, v_trg.tbl, v_trg.fn);
  end loop;

  -- A referenced parent keeps its owner: update-only triggers.
  for v_trg in select * from (values
    ('user_foods', 'user_id', '_owner_fixed'), ('log_entries', 'user_id', '_owner_fixed'),
    ('recipes', 'user_id', '_owner_fixed'), ('favorites_meals', 'user_id', '_owner_fixed'),
    ('duplicate_groups', 'user_id', '_owner_fixed'), ('coach_threads', 'user_id', '_owner_fixed'),
    ('ai_calls', 'user_id', '_owner_fixed'), ('health_sources', 'user_id', '_owner_fixed'),
    ('ingest_events', 'user_id, source_id', '_ingest_event_fixed'),
    ('expenditure_estimates', 'user_id', '_owner_fixed'),
    ('food_refs', 'kind, user_food_id', '_food_ref_fixed'),
    ('recipe_revisions', 'recipe_id', '_recipe_revision_fixed')
  ) as v(tbl, cols, fn)
  loop
    execute format('drop trigger if exists owner_fixed on public.%I', v_trg.tbl);
    execute format('create trigger owner_fixed before update of %s on public.%I '
                   'for each row execute function public.%I()', v_trg.cols, v_trg.tbl, v_trg.fn);
  end loop;
end $$;

-- ---------- 5. coach_messages: the denormalized user_id must be the caller ---------------------
drop policy if exists coach_messages_rw on public.coach_messages;
create policy coach_messages_rw on public.coach_messages for all to authenticated
  using (user_id = (select auth.uid())
         and exists (select 1 from public.coach_threads th
                      where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())))
  with check (user_id = (select auth.uid())
         and exists (select 1 from public.coach_threads th
                      where th.id = coach_messages.thread_id and th.user_id = (select auth.uid())));

-- ---------- 6. plan_days: select, insert, update only (spec 3) ---------------------------------
drop policy if exists plan_days_rw on public.plan_days;
drop policy if exists plan_days_select on public.plan_days;
drop policy if exists plan_days_insert on public.plan_days;
drop policy if exists plan_days_update on public.plan_days;
create policy plan_days_select on public.plan_days for select to authenticated
  using (user_id = (select auth.uid()));
create policy plan_days_insert on public.plan_days for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy plan_days_update on public.plan_days for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke delete on table public.plan_days from authenticated;
