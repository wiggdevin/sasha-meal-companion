-- Reverse of 20261213090400_food_world_triggers_constraint_profiles.sql.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
declare
  t record;
begin
  for t in select * from (values
    ('public.constraint_profiles', 'constraint_profiles_condition_gate'),
    ('public.constraint_profiles', 'rules_clock_constraint_profiles')) as v(tbl, trg)
  loop
    if to_regclass(t.tbl) is not null then
      execute format('drop trigger if exists %I on %s', t.trg, t.tbl);
    end if;
  end loop;
end $$;
