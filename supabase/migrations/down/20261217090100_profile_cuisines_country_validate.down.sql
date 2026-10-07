-- Reverse of 20261217090100_profile_cuisines_country_validate.sql: cuisines goes back to nullable,
-- still checked by the (now validated) user_settings_cuisines_valid constraint. PostgreSQL cannot
-- mark a validated constraint NOT VALID again, and validation changed no data. Runs alone and skips
-- a column that is already gone.
-- Rollback order: 20261217090200's down, this file, then 20261217090000's down.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'user_settings' and column_name = 'cuisines') then
    alter table public.user_settings alter column cuisines drop not null;
  end if;
end $$;
