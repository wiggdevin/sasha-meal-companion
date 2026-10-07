-- Reverse of 20261217090000_profile_cuisines_country.sql. Refuses while any account has chosen a
-- cuisine or a country, unless app.allow_down_data_loss = on: dropping the columns would silently
-- forget those answers. It checks before it drops anything. diet_prefs.taste lives inside
-- diet_prefs and is kept; only its shape check is dropped.
-- Runs alone: it drops only its own objects and skips a column that is already gone.
-- Rollback order: revert the app deploy, then the down files from 20261217090200 back to 20261217090000.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'user_settings' and column_name = 'cuisines')
     and exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'user_settings' and column_name = 'country_code')
     and exists (select 1 from public.user_settings
                  where cardinality(cuisines) > 0 or country_code is not null) then
    raise exception 'profile_cuisines_country down: accounts have chosen cuisines or a country; set app.allow_down_data_loss = on to drop them'
      using errcode = '55000';
  end if;
end $$;
set local lock_timeout = '3s';
alter table public.user_settings
  drop constraint if exists user_settings_diet_prefs_taste_check,
  drop constraint if exists user_settings_country_code_check,
  drop constraint if exists user_settings_cuisines_valid,
  drop column if exists country_code,
  drop column if exists cuisines;
drop function if exists public.diet_prefs_taste_valid(jsonb);
