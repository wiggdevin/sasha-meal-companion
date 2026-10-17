-- Reverse of 20270105110100_recipe_catalog_global_clock.sql: recipe_accept_preview and
-- recipe_store_preview compare the account rev alone again, the three catalog triggers bump every
-- account's recipe_plan_state row again (their 20261231200000 bodies), then the clock, its bump
-- function and recipe_plan_previews.catalog_rev go. A preview stored under this file holds the sum
-- of both revs, so it answers "stale preview" once and is rebuilt. Unaccepted previews are expired first (below).
-- Order: roll the code back FIRST. The new build's stateRevision reads recipe_catalog_clock, so
-- every preview answers 503 once this has dropped it.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Expire every unaccepted preview first. Back on the account-only check, a preview stored before
-- the up file could compare equal again after a catalog change it never saw (and a sum stored under
-- it could match a later account rev). Accepted rows keep their expiry for idempotent replay.
-- The lock holds new previews out until this file commits, so none lands between the sweep and
-- the account-only check (the runner applies the file in one transaction; LOCK needs one, and a
-- DO block is one when a runner does not wrap the file).
do $sweep$
begin
  lock table public.recipe_plan_previews in share row exclusive mode;
  update public.recipe_plan_previews set expires_at = pg_catalog.now()
   where accepted_request_id is null and expires_at > pg_catalog.now();
end;
$sweep$;

do $migration$
declare
  definition text;
  patched text := $a$  select rev into v_rev from public.recipe_plan_state where user_id = v_user for update;
  -- W072: plus the committed catalog rev, read and never locked (20270105110100 header).
  if v_rev + (select c.rev from public.recipe_catalog_clock c where c.id = 1)
    is distinct from v_preview.state_rev then$a$;
  original text := $a$  select rev into v_rev from public.recipe_plan_state where user_id = v_user for update;
  if v_rev is distinct from v_preview.state_rev then$a$;
begin
  select pg_get_functiondef('public.recipe_accept_preview(uuid,uuid,boolean)'::regprocedure) into definition;
  if position(patched in definition) = 0 then return; end if;
  if (length(definition) - length(replace(definition, patched, ''))) / length(patched) <> 1 then
    raise exception 'recipe_catalog_global_clock down (recipe_accept_preview): the patched check is not as written; refusing a guess';
  end if;
  execute replace(definition, patched, original);
end;
$migration$;

create or replace function public.recipe_store_preview(p_user_id uuid, p_kind text, p_proof jsonb,
  p_state_rev bigint, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_rev bigint; v_expiry timestamptz;
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
  insert into public.recipe_plan_state(user_id) values (p_user_id) on conflict do nothing;
  select rev into v_rev from public.recipe_plan_state where user_id = p_user_id for update;
  if v_rev <> p_state_rev then raise exception 'stale preview' using errcode = '40001'; end if;
  insert into public.recipe_plan_previews(user_id, kind, proof, state_rev, expires_at)
    values (p_user_id, p_kind, p_proof, v_rev, v_expiry) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.recipe_store_preview(uuid, text, jsonb, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.recipe_store_preview(uuid, text, jsonb, bigint, timestamptz) to service_role;

create or replace function public.recipe_plan_bump_global_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- W034: evidence_clock before any recipe_plan_state row (the evidence trigger runs later).
  perform public._clock_lock_evidence();
  update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
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
    update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
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
    update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
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

drop function if exists public._recipe_catalog_bump();
alter table public.recipe_plan_previews drop column if exists catalog_rev;
drop table if exists public.recipe_catalog_clock;
