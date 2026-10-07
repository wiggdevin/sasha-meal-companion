-- Phase 1, Lane F. The two catalog functions the import worker calls.
-- Filename sorts after 20260912090000 (tables) and before Lane G's 20260912090100 (search RPC),
-- so Supabase's filename ordering matches the dependency order.

-- Energy, one implementation, in SQL (§3.1). Nothing recomputes Atwater in TypeScript.
-- Carbohydrate means available carbohydrate — total minus fiber where fiber is reported,
-- otherwise total, which the worker flags 'carb_basis_total'.
-- `complete` is false when any of protein, carbohydrate or fat_total is null; the worker turns
-- that into 'atwater_incomplete' and drops the revision from the energy-mismatch check.
create or replace function catalog_atwater_kcal(p_revision_id bigint)
returns table (kcal numeric, complete boolean)
language sql stable
set search_path = public
as $$
  with n as (
    select max(amount_per_100g) filter (where nutrient_code = 'protein')      as protein,
           max(amount_per_100g) filter (where nutrient_code = 'carbohydrate') as carbohydrate,
           max(amount_per_100g) filter (where nutrient_code = 'fat_total')    as fat,
           max(amount_per_100g) filter (where nutrient_code = 'fiber_total')  as fiber
      from catalog_food_nutrients
     where food_revision_id = p_revision_id)
  select round(  4 * coalesce(n.protein, 0)
               + 4 * greatest(coalesce(n.carbohydrate, 0) - coalesce(n.fiber, 0), 0)
               + 9 * coalesce(n.fat, 0), 1) as kcal,
         (n.protein is not null and n.carbohydrate is not null and n.fat is not null) as complete
    from n;
$$;

-- Reads catalog rows only, never a user row, so it stays invoker (Phase 1–2 contracts §8).
-- Supabase's default privileges grant execute to anon directly (not just via public), so both
-- revokes are needed - "from public" alone leaves anon's own grant in place, same as the
-- catalog_assert_one_active / catalog_activate_version revokes below.
revoke all on function catalog_atwater_kcal(bigint) from public;
revoke all on function catalog_atwater_kcal(bigint) from anon;
grant execute on function catalog_atwater_kcal(bigint) to authenticated, service_role;

-- Shared invariant (Task 3 fix round 1, Finding 1): every food_id in p_food_ids must end an
-- activation with exactly one active revision — no more, no fewer. Split out so
-- catalog_activate_version's own body stays under the house line budget. Not security definer on
-- its own: it only ever runs as `perform`ed by catalog_activate_version, which already carries
-- definer privileges when it calls this, and the function owner can always execute its own
-- functions regardless of the revokes below.
create or replace function catalog_assert_one_active(p_food_ids bigint[])
returns void
language plpgsql
set search_path = public
as $$
declare
  v_bad bigint;
begin
  select r.catalog_food_id into v_bad
    from catalog_food_revisions r
   where r.catalog_food_id = any (p_food_ids) and r.is_active
   group by r.catalog_food_id
  having count(*) <> 1
   limit 1;
  if v_bad is not null then
    raise exception 'catalog_activate_version: food % does not have exactly one active revision after activation', v_bad;
  end if;

  -- the group-by above only sees foods with at least one active row; a food left with zero
  -- never appears in it, so it needs its own check.
  select f into v_bad
    from unnest(p_food_ids) as f
   where not exists (select 1 from catalog_food_revisions r where r.catalog_food_id = f and r.is_active)
   limit 1;
  if v_bad is not null then
    raise exception 'catalog_activate_version: food % has no active revision after activation', v_bad;
  end if;
end;
$$;

revoke all on function catalog_assert_one_active(bigint[]) from public;
revoke all on function catalog_assert_one_active(bigint[]) from anon, authenticated;

-- Activation is one transaction (§3.1 / §7.2). An import writes one catalog_versions row per
-- source under one shared version_label; this function stands the outgoing versions down before
-- it brings the new ones up, so catalog_food_revisions_one_active never sees two active rows,
-- then asserts the invariant before it returns. Food identities are never rewritten, so
-- food_refs and user_foods.catalog_food_id survive every import.
--
-- Fix round 1 on Task 3's review (ledger-recorded, amends the brief's verbatim body):
-- Finding 1 — a food with an active revision only in the outgoing version (no row under the
-- incoming version ids) used to be deactivated in phase 1 and never reactivated, orphaning it
-- with zero active revisions; the old final assert only walked foods under the incoming version,
-- so it never saw the gap. Phase 1 now deactivates a food's outgoing revision only when that food
-- also has a revision under the incoming version; the final assert now walks every food that was
-- active before the call in this source, unioned with every food under the incoming version, so
-- an orphan (excluded from phase 1, never touched by phase 2) still gets checked and still has
-- its untouched previous revision counted as its one active row.
-- Finding 2 — a label whose versions carry zero catalog_food_revisions used to deactivate
-- everything and return success; refused up front instead.
create or replace function catalog_activate_version(p_version_label text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_ids      bigint[];
  v_sources  text[];
  v_food_ids bigint[];
begin
  select array_agg(id order by id), array_agg(distinct source)
    into v_ids, v_sources from catalog_versions where version_label = p_version_label;
  if v_ids is null then
    raise exception 'catalog_activate_version: no catalog_versions row for label %', p_version_label;
  end if;
  if not exists (select 1 from catalog_food_revisions where catalog_version_id = any (v_ids)) then
    raise exception 'catalog_activate_version: no catalog_food_revisions for label %', p_version_label;
  end if;

  -- foods this call must leave with exactly one active revision: whatever was already active in
  -- this source, plus whatever the incoming version introduces.
  select array_agg(distinct food_id) into v_food_ids from (
    select r.catalog_food_id as food_id
      from catalog_food_revisions r join catalog_versions v on v.id = r.catalog_version_id
     where v.source = any (v_sources) and v.is_active and r.is_active
    union
    select catalog_food_id from catalog_food_revisions where catalog_version_id = any (v_ids)
  ) f;

  -- 1. stand the outgoing versions down — only for a food with a replacement revision under the
  --    incoming version, so a food absent from the new release keeps its previous active one.
  update catalog_food_revisions r set is_active = false, valid_to = now()
   where r.is_active
     and r.catalog_version_id in (select v.id from catalog_versions v where v.source = any (v_sources)
                                     and v.is_active and not (v.id = any (v_ids)))
     and r.catalog_food_id in (select catalog_food_id from catalog_food_revisions
                                 where catalog_version_id = any (v_ids));
  update catalog_versions v set is_active = false
   where v.source = any (v_sources) and v.is_active and not (v.id = any (v_ids));

  -- 2. bring the new version up.
  update catalog_versions v set is_active = true where v.id = any (v_ids) and not v.is_active;
  update catalog_food_revisions r set is_active = true, valid_to = null
   where r.catalog_version_id = any (v_ids) and not r.is_active;

  -- 3. assert the invariant inside the same transaction, so a bad import rolls back whole.
  perform catalog_assert_one_active(v_food_ids);
end;
$$;

-- Privileged path: the import worker runs as service_role and nothing else may call this.
revoke all on function catalog_activate_version(text) from public;
revoke all on function catalog_activate_version(text) from anon, authenticated;
grant execute on function catalog_activate_version(text) to service_role;
