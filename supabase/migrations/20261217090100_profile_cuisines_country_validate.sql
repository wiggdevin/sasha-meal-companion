-- Phase 18 W5, step (b): validate step (a)'s checks (SHARE UPDATE EXCLUSIVE: reads and writes
-- continue during the scan), then SET NOT NULL on cuisines, which PostgreSQL proves from the
-- validated user_settings_cuisines_valid check (it begins `cuisines is not null and`) without a
-- second scan.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.user_settings validate constraint user_settings_cuisines_valid;
alter table public.user_settings validate constraint user_settings_country_code_check;
alter table public.user_settings validate constraint user_settings_diet_prefs_taste_check;
alter table public.user_settings alter column cuisines set not null;
