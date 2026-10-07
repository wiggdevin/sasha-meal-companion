-- Onboarding v2 (coordinator ruling 2026-10-06): the "prefer not to say" answer to the sex
-- question. Mifflin-St Jeor needs SOME sex term (lib/profile/energy.ts `bmr`); 'unspecified'
-- stores the user's own non-answer instead of the app silently guessing male or female.
-- Katch-McArdle (a known body fat %) needs no sex term at all, so this never reaches that branch.
--
-- Added NOT VALID (step 2, 20261224090100, validates it): a live table only ever holds
-- 'female'/'male' today, so the scan at validate time is free, but NOT VALID keeps this step's
-- lock a metadata-only ACCESS EXCLUSIVE instant, same discipline as 20261220090100.
-- Down: supabase/migrations/down/20261224090000_user_settings_sex_unspecified.down.sql (refuses
-- while any 'unspecified' row exists).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.user_settings drop constraint if exists user_settings_sex_check;
alter table public.user_settings add constraint user_settings_sex_check
  check (sex in ('female', 'male', 'unspecified')) not valid;

comment on column public.user_settings.sex is
  'female | male | unspecified (onboarding v2: "prefer not to say" — Mifflin-St Jeor then uses '
  'the midpoint sex term, lib/profile/energy.ts SEX_BMR_TERM) | null (never asked).';
