-- Advisor rls_disabled_in_public (ERROR) after the 2026-09-12 readiness sweep. catalog_synonyms
-- (20260921090000_catalog_synonyms.sql) and catalog_barcode_lookups
-- (20260919090100_phase3_barcode_cache.sql) were each created after
-- 20260912090200_catalog_grants.sql without its RLS shape, so both shipped with row level
-- security off in public even though they are shared, read-only catalog tables like the nine
-- catalog_grants.sql already covers. Same fix, same shape: RLS on and forced, a single
-- <table>_read select policy for authenticated, and only service_role can write.
do $$
declare t text;
begin
  foreach t in array array['catalog_synonyms','catalog_barcode_lookups'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using (true)',
                   t || '_read', t);
    execute format('revoke all on table %I from public, anon, authenticated', t);
    execute format('grant select on table %I to authenticated', t);
    execute format('grant all on table %I to service_role', t);
  end loop;
end $$;
