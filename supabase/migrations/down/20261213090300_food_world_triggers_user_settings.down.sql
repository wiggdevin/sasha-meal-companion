-- Reverse of 20261213090300_food_world_triggers_user_settings.sql.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
declare
  t record;
begin
  for t in select * from (values
    ('public.user_settings', 'user_settings_food_world_guard'),
    ('public.user_settings', 'rules_clock_user_settings')) as v(tbl, trg)
  loop
    if to_regclass(t.tbl) is not null then
      execute format('drop trigger if exists %I on %s', t.trg, t.tbl);
    end if;
  end loop;
end $$;
