-- W008 step 2 of 2: validate the narrowed kcal_min_source CHECK that step 1 (20261231150000)
-- added NOT VALID. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE (reads and writes continue)
-- for one scan of target_profiles.
-- Before production, this must answer 0:
--   select count(*) from public.target_profiles where kcal_min_source = 'account_minimum';
-- Down: supabase/migrations/down/20261231150001_drop_account_minimum_validate.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.target_profiles validate constraint target_profiles_kcal_min_source_check;
