-- Reverse of 20261213090000_food_world_columns.sql. Refuses while any account is open or has a
-- pending condition review, unless app.allow_down_data_loss = on: dropping the columns would
-- silently close accounts. It checks before it drops anything.
-- Runs alone: it drops only its own objects and skips any table that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261213091200 back to 20261213090000.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and ((exists (select 1 from information_schema.columns where table_schema = 'public'
                    and table_name = 'user_settings' and column_name = 'food_world')
           and exists (select 1 from public.user_settings where food_world is distinct from 'closed'))
       or (exists (select 1 from information_schema.columns where table_schema = 'public'
                    and table_name = 'constraint_profiles' and column_name = 'condition_review_required')
           and exists (select 1 from public.constraint_profiles where condition_review_required))) then
    raise exception 'food_world_columns down: open accounts or pending condition reviews exist; set app.allow_down_data_loss = on to drop them';
  end if;
end $$;
-- Run alone (before the trigger downs), it first drops the two triggers that name these columns.
drop trigger if exists user_settings_food_world_guard on public.user_settings;
drop trigger if exists constraint_profiles_condition_gate on public.constraint_profiles;
alter table public.user_settings drop constraint if exists user_settings_food_world,
  drop column if exists food_world;
alter table public.constraint_profiles drop constraint if exists constraint_profiles_condition_review_not_null,
  drop column if exists condition_review_required;
