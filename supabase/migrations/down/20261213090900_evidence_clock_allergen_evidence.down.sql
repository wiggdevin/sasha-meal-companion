-- Reverse of 20261213090900_evidence_clock_allergen_evidence.sql.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
declare
  t record;
begin
  for t in select * from (values
    ('public.food_allergen_evidence', 'evidence_clock_food_allergen_evidence_ins'),
    ('public.food_allergen_evidence', 'evidence_clock_food_allergen_evidence_upd'),
    ('public.food_allergen_evidence', 'evidence_clock_food_allergen_evidence_del')) as v(tbl, trg)
  loop
    if to_regclass(t.tbl) is not null then
      execute format('drop trigger if exists %I on %s', t.trg, t.tbl);
    end if;
  end loop;
end $$;
