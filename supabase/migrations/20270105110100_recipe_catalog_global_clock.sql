-- W072 (scale step 10): a shared catalog write bumps ONE row, not one recipe_plan_state row per
-- account. recipe_plan_bump_global_state (recipe_catalog, catalog_food_revisions), the catalog
-- branch of recipe_plan_bump_food_ref_state and the global (null-user) branch of
-- recipe_plan_bump_allergen_evidence each ran `update recipe_plan_state set rev = rev + 1` over
-- every account: O(accounts) row writes and row locks per catalog statement. They now move
-- recipe_catalog_clock.rev, at most once per transaction (the evidence_clock last_xact pattern).
--
--   LOCK ORDER (W034, extended): 1. evidence_clock       (global)
--                                2. account_rules_clock  (per account)
--                                3. recipe_catalog_clock (global, this file)
--                                4. recipe_plan_state    (per account)
--
-- Why 3 sits between the rules row and the state row: a catalog writer already takes
-- evidence_clock (and, minting a first ref, the caller's rules row) before its catalog trigger
-- fires, and get_or_create_food_ref's membership backfill then moves the account's
-- recipe_plan_state. So the catalog clock comes after 1 and 2 and before 4. recipe_store_preview
-- and recipe_accept_preview take it FOR SHARE before their recipe_plan_state row, never after.
--
-- A preview's freshness is now "this account's rev plus the catalog rev": both only ever grow, so
-- the sum moves exactly when either does. recipe_plan_previews.state_rev stores that sum (the
-- caller's p_state_rev, lib/server/recipe-plan.ts stateRevision); the new catalog_rev column
-- records the catalog part (null on previews stored before this file). The clock starts at 0, so
-- every preview stored before it still compares equal. recipe_log_consumed, recipe_undo_consumed
-- and shopping_patch_purchase_window only LOCK the state row (they compare the selection's
-- plan_revision, not a state rev), so they are unchanged; a catalog write no longer queues them.
--
-- Every other line of each trigger function is its latest body (20261231200000).
-- recipe_store_preview is its latest body (20261128090000) with the catalog clock added;
-- recipe_accept_preview is anchor-patched (the 20261231100000 pattern, refusing a partial patch).
-- Order: APPLY TO PRODUCTION BEFORE THIS CODE DEPLOYS. While the old build runs, its previews
-- compare the account rev alone; they stay valid until the first catalog write after this file,
-- then answer 409 "Preview again" until the new build is live.
-- Down: supabase/migrations/down/20270105110100_recipe_catalog_global_clock.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table if not exists public.recipe_catalog_clock (
  id smallint primary key constraint recipe_catalog_clock_singleton check (id = 1),
  rev bigint not null default 0 constraint recipe_catalog_clock_rev check (rev >= 0),
  last_xact xid8,
  updated_at timestamptz not null default now()
);
insert into public.recipe_catalog_clock (id) values (1) on conflict (id) do nothing;
alter table public.recipe_catalog_clock enable row level security;
alter table public.recipe_catalog_clock force row level security;
drop policy if exists recipe_catalog_clock_read on public.recipe_catalog_clock;
create policy recipe_catalog_clock_read on public.recipe_catalog_clock for select to authenticated using (true);
revoke all on table public.recipe_catalog_clock from public, anon, authenticated;
grant select on table public.recipe_catalog_clock to authenticated;
grant all on table public.recipe_catalog_clock to service_role;
comment on table public.recipe_catalog_clock is
  'W072: one global revision for shared catalog changes a recipe or shopping preview depends on. '
  'Lock order step 3 (after evidence_clock and account_rules_clock, before recipe_plan_state).';

alter table public.recipe_plan_previews add column if not exists catalog_rev bigint;

-- LOCK ORDER step 3. Moves the catalog rev once per transaction; a second call in the same
-- transaction only re-locks the row it already holds.
create or replace function public._recipe_catalog_bump() returns void
  language plpgsql security definer set search_path = '' as $$
begin
  update public.recipe_catalog_clock
     set rev = rev + 1, last_xact = pg_catalog.pg_current_xact_id(), updated_at = pg_catalog.now()
   where id = 1 and last_xact is distinct from pg_catalog.pg_current_xact_id();
end $$;
revoke all on function public._recipe_catalog_bump() from public, anon, authenticated;

create or replace function public.recipe_plan_bump_global_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- W034: evidence_clock before the catalog clock (the evidence trigger runs later).
  perform public._clock_lock_evidence();
  perform public._recipe_catalog_bump();  -- W072: one row, not every account's
  return null;
end $$;
revoke all on function public.recipe_plan_bump_global_state() from public, anon, authenticated;

create or replace function public.recipe_plan_bump_allergen_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_previous uuid; v_global boolean := false;
begin
  -- W034: evidence_clock before any recipe_plan_state row (the evidence trigger runs later).
  perform public._clock_lock_evidence();
  v_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if tg_op = 'UPDATE' then
    v_previous := old.user_id;
    v_global := v_previous is distinct from v_user
      and (v_previous is null or v_user is null);
  end if;
  if v_user is null or v_global then
    perform public._recipe_catalog_bump();  -- W072: one row, not every account's
  else
    if exists (select 1 from auth.users where id=v_user) then
      insert into public.recipe_plan_state(user_id, rev) values (v_user, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
    if v_previous is not null and v_previous is distinct from v_user
      and exists (select 1 from auth.users where id=v_previous) then
      insert into public.recipe_plan_state(user_id, rev) values (v_previous, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.recipe_plan_bump_allergen_evidence() from public, anon, authenticated;

create or replace function public.recipe_plan_bump_food_ref_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ref public.food_refs%rowtype;
  v_user uuid;
begin
  -- W034: evidence_clock before any recipe_plan_state row (the evidence trigger runs later).
  perform public._clock_lock_evidence();
  v_ref := case when tg_op = 'DELETE' then old else new end;
  if v_ref.kind = 'catalog' then
    perform public._recipe_catalog_bump();  -- W072: one row, not every account's
  else
    -- On a cascading user_foods delete the parent may no longer be visible;
    -- recipe_state_user_foods already bumped that same owner's clock.
    select f.user_id into v_user from public.user_foods f where f.id = v_ref.user_food_id;
    if v_user is not null and exists (select 1 from auth.users where id = v_user) then
      insert into public.recipe_plan_state(user_id, rev) values (v_user, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.recipe_plan_bump_food_ref_state() from public, anon, authenticated;

create or replace function public.recipe_store_preview(p_user_id uuid, p_kind text, p_proof jsonb,
  p_state_rev bigint, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_rev bigint; v_catalog_rev bigint; v_expiry timestamptz;
begin
  if auth.role() is distinct from 'service_role' or p_user_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_kind not in ('recipe','shopping') or jsonb_typeof(p_proof) <> 'object'
    or pg_catalog.octet_length(p_proof::text) > 2000000 then
    raise exception 'invalid preview' using errcode = '22023';
  end if;
  v_expiry := least(p_expires_at, pg_catalog.clock_timestamp() + interval '30 minutes');
  if v_expiry is null or v_expiry <= pg_catalog.clock_timestamp() then
    raise exception 'preview authority expired' using errcode = '40001';
  end if;
  -- W072 lock order: the catalog clock (step 3) before this account's state row (step 4).
  select rev into v_catalog_rev from public.recipe_catalog_clock where id = 1 for share;
  insert into public.recipe_plan_state(user_id) values (p_user_id) on conflict do nothing;
  select rev into v_rev from public.recipe_plan_state where user_id = p_user_id for update;
  if v_rev + v_catalog_rev <> p_state_rev then raise exception 'stale preview' using errcode = '40001'; end if;
  insert into public.recipe_plan_previews(user_id, kind, proof, state_rev, catalog_rev, expires_at)
    values (p_user_id, p_kind, p_proof, p_state_rev, v_catalog_rev, v_expiry) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.recipe_store_preview(uuid, text, jsonb, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.recipe_store_preview(uuid, text, jsonb, bigint, timestamptz) to service_role;

do $migration$
declare
  definition text;
  anchor text := $a$  select rev into v_rev from public.recipe_plan_state where user_id = v_user for update;
  if v_rev is distinct from v_preview.state_rev then$a$;
  patched text := $a$  -- W072 lock order: the catalog clock (step 3) before this account's state row (step 4).
  perform 1 from public.recipe_catalog_clock where id = 1 for share;
  select rev into v_rev from public.recipe_plan_state where user_id = v_user for update;
  if v_rev + (select c.rev from public.recipe_catalog_clock c where c.id = 1)
    is distinct from v_preview.state_rev then$a$;
  occurrences integer;
begin
  select pg_get_functiondef('public.recipe_accept_preview(uuid,uuid,boolean)'::regprocedure) into definition;
  if position(patched in definition) > 0 then return; end if;
  occurrences := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if occurrences <> 1 then
    raise exception 'recipe_catalog_global_clock (recipe_accept_preview): state anchor occurs % times, expected once; refusing a partial function',
      occurrences;
  end if;
  execute replace(definition, anchor, patched);
end;
$migration$;
