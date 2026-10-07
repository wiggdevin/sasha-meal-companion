-- Calculation audit 2026-10-05, #21: a serving of a saved recipe whose ingredients are only partly
-- measured is logged (logging marks, it never refuses), but its frozen snapshot is a partial sum.
-- Until now nothing recorded that: readers re-judged it from the recipe's CURRENT revision, so
-- completing the recipe later rewrote history and the old partial serving read as whole.
--
-- Each log item now records, when it is written, whether it came from a partly measured recipe
-- (`nutrition_partial`) and which recipe revision it was judged against (`recipe_rev`). Both are
-- NULL for anything that is not one of the owner's recipes, and for every row written before this
-- migration — readers fall back to the current-revision judgement for those (approximate).
--
-- Written by triggers, so every writer is covered (commit, sync replay, coach) without touching
-- _sync_upsert, and a client-supplied value is never trusted:
--   * BEFORE INSERT judges the item from the recipe revision in force, the same revision whose
--     per_100g compute_item_snapshot just read. _sync_upsert replaces an entry's items wholesale and
--     carries an untouched item's frozen snapshot over; the BEFORE DELETE trigger stashes each
--     deleted item's flag for the rest of the transaction, and an insert with the same id and the
--     same snapshot takes the stashed flag back, so an edit never re-judges a frozen snapshot.
--     The stash is keyed on the item id and checked against its food_ref_id and snapshot hash.
--     A recipe serving logged partial with an EMPTY snapshot (nothing measured) is the one case
--     _sync_upsert recomputes on an unrelated edit; with the same food and grams the trigger keeps
--     that serving's empty snapshot and its mark, so a later recipe edit never rewrites it.
--     It is a transaction-local setting: only SQL running inside the same transaction (the
--     definer sync functions, or a service-role session) can write it; PostgREST exposes no
--     set_config to clients.
--   * BEFORE UPDATE keeps the stored values unless the food or the snapshot changed; either change
--     is judged afresh against the revision in force (a client cannot set the columns directly).
--
-- Must be applied to production BEFORE the app change that reads these columns merges
-- (lib/server/log.ts, day-context.ts and export.ts select them by name).

alter table public.log_items
  add column if not exists nutrition_partial boolean,
  add column if not exists recipe_rev integer;

comment on column public.log_items.nutrition_partial is
  'True when written from a saved recipe whose current revision had coverage < 1 (a partial '
  'per-serving sum); false for a fully measured recipe; null for non-recipe items and rows '
  'written before 20261210090400.';
comment on column public.log_items.recipe_rev is
  'The recipes.rev the item was judged against; null when nutrition_partial is null.';

-- One recipe serving's judgement: the owner's recipe behind this food ref, at its current revision.
-- A missing revision row or a non-numeric coverage reads as partial (unknown is never whole).
create or replace function public._log_item_recipe_partial(p_food_ref_id uuid, p_owner uuid)
returns table (partial boolean, rev integer)
language sql stable security definer set search_path = '' as $$
  select case when jsonb_typeof(rv.nutrients_per_serving->'coverage') = 'number'
              then (rv.nutrients_per_serving->>'coverage')::numeric < 1
              else true end,
         r.rev
    from public.food_refs f
    join public.recipes r on r.id = f.user_food_id and r.user_id = p_owner
    left join public.recipe_revisions rv on rv.recipe_id = r.id and rv.rev = r.rev
   where f.id = p_food_ref_id
$$;

-- The stash key for one deleted item, valid for the rest of the transaction only.
create or replace function public._log_item_carry_key(p_id uuid) returns text
language sql immutable set search_path = '' as $$
  select 'meal_companion.partial_' || replace(p_id::text, '-', '_')
$$;

create or replace function public._log_item_stash_partial() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform set_config(public._log_item_carry_key(old.id),
    jsonb_build_object('s', md5(coalesce(old.snapshot, '{}'::jsonb)::text),
      'f', old.food_ref_id, 'g', old.grams, 'p', old.nutrition_partial, 'r', old.recipe_rev)::text, true);
  return old;
end $$;

create or replace function public._log_item_judge_partial() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_carry text;
  v_owner uuid;
  v_partial boolean;
  v_rev integer;
begin
  -- An update keeps the stored judgement only while the item still holds the same food AND the
  -- same frozen snapshot; a recomputed snapshot is new numbers, judged afresh.
  if tg_op = 'UPDATE' and new.food_ref_id is not distinct from old.food_ref_id
     and coalesce(new.snapshot, '{}'::jsonb) = coalesce(old.snapshot, '{}'::jsonb) then
    new.nutrition_partial := old.nutrition_partial;
    new.recipe_rev := old.recipe_rev;
    return new;
  end if;
  if tg_op = 'INSERT' then
    v_carry := nullif(current_setting(public._log_item_carry_key(new.id), true), '');
    -- Same item, same food, same frozen snapshot: the row _sync_upsert just carried over. Any
    -- other insert (a different food under the same id, a recomputed snapshot) is judged afresh.
    if v_carry is not null
       and (v_carry::jsonb->>'f') = new.food_ref_id::text
       and (v_carry::jsonb->>'s') = md5(coalesce(new.snapshot, '{}'::jsonb)::text) then
      new.nutrition_partial := (v_carry::jsonb->>'p')::boolean;
      new.recipe_rev := (v_carry::jsonb->>'r')::integer;
      return new;
    end if;
    -- An untouched recipe serving that was logged with an EMPTY snapshot (a recipe with nothing
    -- measured yet): _sync_upsert never carries `{}` forward, so an unrelated edit (a note) would
    -- recompute it from the recipe as it stands today and rewrite history. Same item, same food,
    -- same grams: the serving stays exactly as logged — its empty snapshot and its partial mark.
    if v_carry is not null
       and (v_carry::jsonb->>'p')::boolean is true
       and (v_carry::jsonb->>'f') = new.food_ref_id::text
       and (v_carry::jsonb->>'g')::numeric = new.grams
       and (v_carry::jsonb->>'s') = md5('{}'::jsonb::text) then
      new.snapshot := '{}'::jsonb;
      new.nutrition_partial := true;
      new.recipe_rev := (v_carry::jsonb->>'r')::integer;
      return new;
    end if;
  end if;
  v_owner := public._entry_owner(new.entry_id);
  select j.partial, j.rev into v_partial, v_rev
    from public._log_item_recipe_partial(new.food_ref_id, v_owner) j;
  new.nutrition_partial := v_partial;   -- null when the food is not one of the owner's recipes
  new.recipe_rev := v_rev;
  return new;
end $$;

revoke all on function public._log_item_recipe_partial(uuid, uuid) from public, anon, authenticated;
revoke all on function public._log_item_carry_key(uuid) from public, anon, authenticated;
revoke all on function public._log_item_stash_partial() from public, anon, authenticated;
revoke all on function public._log_item_judge_partial() from public, anon, authenticated;

drop trigger if exists log_items_stash_partial on public.log_items;
create trigger log_items_stash_partial before delete on public.log_items
  for each row execute function public._log_item_stash_partial();

drop trigger if exists log_items_judge_partial on public.log_items;
create trigger log_items_judge_partial before insert or update on public.log_items
  for each row execute function public._log_item_judge_partial();
