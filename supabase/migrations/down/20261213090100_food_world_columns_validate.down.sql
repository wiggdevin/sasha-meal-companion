-- Reverse of 20261213090100_food_world_columns_validate.sql: the columns go back to nullable,
-- still checked by the (now validated) constraints. Harmless to run alone.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'user_settings' and column_name = 'food_world') then
    alter table public.user_settings alter column food_world drop not null;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'constraint_profiles' and column_name = 'condition_review_required') then
    alter table public.constraint_profiles alter column condition_review_required drop not null;
  end if;
end $$;
