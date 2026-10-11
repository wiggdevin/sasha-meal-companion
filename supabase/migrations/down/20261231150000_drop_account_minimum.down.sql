-- Reverse of 20261231150000_drop_account_minimum.sql: put back the three-value CHECK from
-- 20261029090000_rate_goals.sql. Every row that passes the two-value CHECK passes the wider one,
-- so this adds it valid in one step. No data changes.
-- Rollback order: revert the app deploy (optional: it never writes the label), then the down files
-- from 20261231150001 back to 20261231150000.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.target_profiles
  drop constraint if exists target_profiles_kcal_min_source_check,
  add constraint target_profiles_kcal_min_source_check
    check (kcal_min_source in ('macro_minimum', 'account_minimum', 'legacy_default'));
