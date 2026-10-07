-- Reverse of 20261213091200_evidence_clock_catalog.sql.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
declare
  t record;
begin
  for t in select * from (values
    ('public.catalog_foods', 'evidence_clock_catalog_foods_ins'),
    ('public.catalog_foods', 'evidence_clock_catalog_foods_upd'),
    ('public.catalog_foods', 'evidence_clock_catalog_foods_del'),
    ('public.catalog_food_revisions', 'evidence_clock_catalog_food_revisions_ins'),
    ('public.catalog_food_revisions', 'evidence_clock_catalog_food_revisions_upd'),
    ('public.catalog_food_revisions', 'evidence_clock_catalog_food_revisions_del'),
    ('public.catalog_food_nutrients', 'evidence_clock_catalog_food_nutrients_ins'),
    ('public.catalog_food_nutrients', 'evidence_clock_catalog_food_nutrients_upd'),
    ('public.catalog_food_nutrients', 'evidence_clock_catalog_food_nutrients_del'),
    ('public.catalog_ingredients', 'evidence_clock_catalog_ingredients_ins'),
    ('public.catalog_ingredients', 'evidence_clock_catalog_ingredients_upd'),
    ('public.catalog_ingredients', 'evidence_clock_catalog_ingredients_del'),
    ('public.catalog_portions', 'evidence_clock_catalog_portions_ins'),
    ('public.catalog_portions', 'evidence_clock_catalog_portions_upd'),
    ('public.catalog_portions', 'evidence_clock_catalog_portions_del')) as v(tbl, trg)
  loop
    if to_regclass(t.tbl) is not null then
      execute format('drop trigger if exists %I on %s', t.trg, t.tbl);
    end if;
  end loop;
end $$;
