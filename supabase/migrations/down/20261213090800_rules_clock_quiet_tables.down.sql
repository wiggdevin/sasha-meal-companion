-- Reverse of 20261213090800_rules_clock_quiet_tables.sql.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
declare
  t record;
begin
  for t in select * from (values
    ('public.user_dietary_profiles', 'rules_clock_user_dietary_profiles'),
    ('public.food_world_condition_confirmations', 'rules_clock_food_world_condition_confirmations'),
    ('public.user_allergen_checks', 'rules_clock_user_allergen_checks')) as v(tbl, trg)
  loop
    if to_regclass(t.tbl) is not null then
      execute format('drop trigger if exists %I on %s', t.trg, t.tbl);
    end if;
  end loop;
end $$;
