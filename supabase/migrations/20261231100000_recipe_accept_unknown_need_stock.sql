-- W024 (audit A049, spec docs/plans/2026-10-10-priority-spec-list.md W024): a shopping accept
-- stored the whole pantry stock as `confirmed_stock_grams` for a line whose need is unknown, because
-- Postgres least() ignores a NULL argument; the preview (aggregateShopping) shows no confirmed stock
-- there. The accept now writes NULL stock when the need is unknown, and unchecks an updated line
-- when its old or new need is unknown or the need grew, as the preview does. It also compares the
-- server-rebuilt need (v_expected_line), the value it writes, rather than the proof's copy.
-- Three anchors in `recipe_accept_preview`, each exactly once; a re-run is a no-op (marker: 'W024
-- (audit A049)'). Function body only: no table lock beyond the catalog row, no data change.
-- Apply to production BEFORE the W024 code merges (either order is safe; the code does not read it).
set local lock_timeout = '3s';
do $migration$
declare
  definition text;
  anchors text[] := array[
    '          least((v_expected_line->>''needGrams'')::numeric,v_stock),',
    '          confirmed_stock_grams=least((v_expected_line->>''needGrams'')::numeric,v_stock),',
    '          checked=case when need_grams is not null and (v_line->>''needGrams'')::numeric > need_grams
            then false else checked end,rev=rev+1,updated_at=now()'];
  replacements text[] := array[
    '          -- W024 (audit A049): an unknown need confirms no stock; least() would skip the NULL.
          case when v_expected_line->>''needGrams'' is null then null
            else least((v_expected_line->>''needGrams'')::numeric,v_stock) end,',
    '          confirmed_stock_grams=case when v_expected_line->>''needGrams'' is null then null
            else least((v_expected_line->>''needGrams'')::numeric,v_stock) end,',
    '          -- A checked purchase cannot hide a need that grew or became unknown (aggregateShopping).
          checked=case when need_grams is null or v_expected_line->>''needGrams'' is null
            or (v_expected_line->>''needGrams'')::numeric > need_grams
            then false else checked end,rev=rev+1,updated_at=now()'];
  i integer;
begin
  select pg_get_functiondef('public.recipe_accept_preview(uuid,uuid,boolean)'::regprocedure)
    into definition;
  if position('W024 (audit A049)' in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'recipe_accept_unknown_need_stock (recipe_accept_preview): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke all on function public.recipe_accept_preview(uuid,uuid,boolean) from public, anon;
grant execute on function public.recipe_accept_preview(uuid,uuid,boolean) to authenticated;
