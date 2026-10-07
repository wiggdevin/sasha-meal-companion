-- Down for supabase/migrations/20260912090200_catalog_grants.sql. Lives here, not beside the
-- live migration, because `supabase db reset` applies every top-level <digits>_<name>.sql file
-- under supabase/migrations/ and does not descend into subdirectories: a sibling file stamped
-- with the same 20260912090200 timestamp would either be applied as an unintended second
-- migration or rejected as a duplicate version. Tested on a branch, never applied to production.
--
-- Reverts 090200 ONLY, not the catalog's read-only shape as a whole. Phase 0's
-- 20260911000500_rls.sql already enabled row level security on these nine tables, created their
-- <table>_read select policy for authenticated, and granted authenticated select — 090200 only
-- added `force row level security` and the explicit service_role table/sequence grants on top of
-- that. So this file leaves RLS enabled, leaves the <table>_read policy, and leaves
-- authenticated's select grant untouched; it undoes exactly 090200's increment.
do $$
declare t text;
begin
  foreach t in array array[
    'catalog_versions','catalog_foods','catalog_food_revisions','catalog_nutrients',
    'catalog_food_nutrients','catalog_barcodes','catalog_portions','catalog_ingredients',
    'catalog_dri'
  ] loop
    execute format('alter table %I no force row level security', t);
    execute format('revoke all on table %I from service_role', t);
  end loop;
end $$;

-- Undo the sequence grants 090200 added, for the same catalog_* sequences it touched.
do $$
declare s text;
begin
  for s in select sequencename from pg_sequences
            where schemaname = 'public' and sequencename like 'catalog\_%' loop
    execute format('revoke all on sequence %I from service_role', s);
  end loop;
end $$;
