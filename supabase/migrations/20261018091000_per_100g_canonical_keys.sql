-- T9 (docs/plans/2026-09-17-t9-housekeeping.md) §5: user_foods.per_100g speaks the canonical codes.
--
-- `perUnitTo100g` (lib/units.ts) returned `{protein_g, carbohydrate_g, fat_g, energy_kcal}`, and
-- two paths wrote that object straight into user_foods.per_100g: an Eats/Avoid mark
-- (lib/foods/prefs-client.ts) and the one-shot legacy backfill (lib/migrate/legacy.ts). Its only
-- reader, compute_item_snapshot (20260918090100), inner-joins jsonb_each(per_100g) on
-- catalog_nutrients.code — which knows `protein`, `carbohydrate` and `fat_total`, never the
-- `_g` spellings. So three of the four macros were dropped from every snapshot of a food written
-- through those two paths, silently. The code now emits the codes; this renames what is stored.
--
-- Idempotent: a second run matches no row. A row that already carries the canonical key keeps it
-- and merely loses the stale duplicate — the stored canonical value is never overwritten.
--
-- "Already carries" means carries a VALUE. A canonical key holding JSON null measures nothing
-- (architecture.md §3.3: null = the source did not measure it), so it is not worth keeping over
-- the number sitting beside it under the old spelling — `has_value` treats it as absent. The
-- rename still writes exactly one key either way, so a second run matches nothing.
-- log_items.snapshot rows are history and are NOT recomputed (spec §5, "Out of scope").

create or replace function pg_temp.t9_has_value(p jsonb, p_key text) returns boolean
  language sql immutable as $fn$
  select p ? p_key and jsonb_typeof(p -> p_key) <> 'null';
$fn$;

do $$
declare
  v_rows integer;
begin
  with renamed as (
    update user_foods
       set per_100g = (per_100g - 'protein_g' - 'carbohydrate_g' - 'fat_g')
         || (case when per_100g ? 'protein_g' and not pg_temp.t9_has_value(per_100g, 'protein')
                  then jsonb_build_object('protein', per_100g -> 'protein_g')
                  else '{}'::jsonb end)
         || (case when per_100g ? 'carbohydrate_g'
                   and not pg_temp.t9_has_value(per_100g, 'carbohydrate')
                  then jsonb_build_object('carbohydrate', per_100g -> 'carbohydrate_g')
                  else '{}'::jsonb end)
         || (case when per_100g ? 'fat_g' and not pg_temp.t9_has_value(per_100g, 'fat_total')
                  then jsonb_build_object('fat_total', per_100g -> 'fat_g')
                  else '{}'::jsonb end)
     where per_100g ?| array['protein_g', 'carbohydrate_g', 'fat_g']
    returning 1
  )
  select count(*) into v_rows from renamed;
  raise notice 'per_100g canonical keys: % user_foods row(s) renamed', v_rows;
end $$;
