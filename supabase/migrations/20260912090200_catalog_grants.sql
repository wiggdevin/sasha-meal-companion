-- Phase 1, Lane F. catalog_* is shared and read-only to users (§2.2 rule 4).
-- RLS is on so the publishable key cannot write; the service role bypasses RLS and is the
-- only writer. No insert, update or delete policy exists on any table, and the table-level
-- grants are revoked as well, so a leaked publishable key can never poison food data.
do $$
declare t text;
begin
  foreach t in array array[
    'catalog_versions','catalog_foods','catalog_food_revisions','catalog_nutrients',
    'catalog_food_nutrients','catalog_barcodes','catalog_portions','catalog_ingredients',
    'catalog_dri'
  ] loop
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

-- Sequences move with their tables: the worker owns them, users never touch them.
do $$
declare s text;
begin
  for s in select sequencename from pg_sequences
            where schemaname = 'public' and sequencename like 'catalog\_%' loop
    execute format('revoke all on sequence %I from public, anon, authenticated', s);
    execute format('grant all on sequence %I to service_role', s);
  end loop;
end $$;
