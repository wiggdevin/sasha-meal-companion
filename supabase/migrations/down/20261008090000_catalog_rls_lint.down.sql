-- Down for supabase/migrations/20261008090000_catalog_rls_lint.sql. Lives here, not beside the
-- live migration, for the same reason as down/20260912090200_catalog_grants.down.sql: `supabase
-- db reset` applies every top-level <digits>_<name>.sql file under supabase/migrations/ and does
-- not descend into subdirectories.
--
-- Unlike catalog_grants.down.sql, RLS was never on for catalog_synonyms or
-- catalog_barcode_lookups before this migration, so this file drops the whole shape it added:
-- the <table>_read policy, then RLS itself (no force first, then disable). Tested on a branch,
-- never applied to production.
do $$
declare t text;
begin
  foreach t in array array['catalog_synonyms','catalog_barcode_lookups'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('alter table %I no force row level security', t);
    execute format('alter table %I disable row level security', t);
  end loop;
end $$;
