-- Reverse of 20261213091100_evidence_clock_food_refs.sql.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
declare
  t record;
begin
  for t in select * from (values
    ('public.food_refs', 'evidence_clock_food_refs_ins'),
    ('public.food_refs', 'evidence_clock_food_refs_upd'),
    ('public.food_refs', 'evidence_clock_food_refs_del')) as v(tbl, trg)
  loop
    if to_regclass(t.tbl) is not null then
      execute format('drop trigger if exists %I on %s', t.trg, t.tbl);
    end if;
  end loop;
end $$;
