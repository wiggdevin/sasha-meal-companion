-- W008 step 1 of 2 (audit 2026-10-10): drop the reserved `account_minimum` label from
-- target_profiles.kcal_min_source. 20261029090000_rate_goals.sql allowed it, but no writer ever
-- set it: derived revisions write 'macro_minimum', and every other row carries 'legacy_default'
-- or the source of the revision it pins over (lib/types.ts KCAL_MIN_SOURCES). A label with no
-- writer only invites a future caller to invent an account minimum outside the target writers.
--
-- Live-safe: the new CHECK is added NOT VALID (a catalog update under ACCESS EXCLUSIVE, no scan,
-- 3 s lock timeout). Step 2 (20261231150001) validates it under SHARE UPDATE EXCLUSIVE.
-- It refuses, writing nothing, while any row holds 'account_minimum'; such a row did not come
-- from the app (a direct table write), so the owner decides what it means, never this file.
-- Apply to production BEFORE the W008 code merges. The code never writes the label either way.
-- Down: supabase/migrations/down/20261231150000_drop_account_minimum.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from public.target_profiles where kcal_min_source = 'account_minimum') then
    raise exception '20261231150000_drop_account_minimum: target_profiles holds account_minimum rows; review them before dropping the label'
      using errcode = '55000';
  end if;
end $$;

alter table public.target_profiles
  drop constraint target_profiles_kcal_min_source_check,
  add constraint target_profiles_kcal_min_source_check
    check (kcal_min_source in ('macro_minimum', 'legacy_default')) not valid;
