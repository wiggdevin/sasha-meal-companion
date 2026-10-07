-- Phase 18 W4, step (c) of migration 3 (Sol W4 r1 WARN 2): the import's one writer path.
-- `catalog_replace_food_inputs` replaces the inputs of a set of dish revisions in ONE transaction:
-- it deletes every stored row of those revisions and inserts the rows it is given. A failure
-- anywhere (a bad row, a constraint, a timeout) rolls the whole call back, so every dish is left
-- fully old or fully new, never mixed. Every row must belong to one of the named revisions.
-- (Sol W4 r2 WARN 3) Every named revision must be ACTIVE at write time: the function locks those
-- revision rows FOR SHARE (a catalog activation waits until this transaction ends) and raises,
-- writing nothing, if any of them is not active, so inputs never land on a revision that a
-- concurrent activation has just retired.
--
-- Security invoker: it runs with the caller's own table rights, and only service_role may
-- execute it (the import, scripts/import-fndds-inputs.ts). authenticated and anon cannot.
-- Creating a function takes no lock on any table.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public.catalog_replace_food_inputs(p_revision_ids bigint[], p_rows jsonb)
  returns integer language plpgsql security invoker set search_path = public as $$
declare
  v_count integer;
  v_named integer;
  v_active integer;
begin
  if p_revision_ids is null or cardinality(p_revision_ids) = 0 then
    raise exception 'catalog_replace_food_inputs: no revisions named' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'catalog_replace_food_inputs: rows must be a JSON array' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
              where not ((r ->> 'food_revision_id')::bigint = any (p_revision_ids))) then
    raise exception 'catalog_replace_food_inputs: a row names a revision outside the batch' using errcode = '22023';
  end if;
  select count(distinct id) into v_named from unnest(p_revision_ids) as named(id);
  select count(*) into v_active from (
    select r.id from public.catalog_food_revisions r
     where r.id = any (p_revision_ids) and r.is_active
       for share) locked;
  if v_active <> v_named then
    raise exception 'catalog_replace_food_inputs: % of % named revisions are not active', v_named - v_active, v_named
      using errcode = '55000';
  end if;
  delete from public.catalog_food_inputs where food_revision_id = any (p_revision_ids);
  insert into public.catalog_food_inputs (food_revision_id, seq, input_catalog_food_id, grams, source, estimated)
  select (r ->> 'food_revision_id')::bigint, (r ->> 'seq')::integer, (r ->> 'input_catalog_food_id')::bigint,
         (r ->> 'grams')::numeric, r ->> 'source', (r ->> 'estimated')::boolean
    from jsonb_array_elements(p_rows) r;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.catalog_replace_food_inputs(bigint[], jsonb) from public, anon, authenticated;
grant execute on function public.catalog_replace_food_inputs(bigint[], jsonb) to service_role;
