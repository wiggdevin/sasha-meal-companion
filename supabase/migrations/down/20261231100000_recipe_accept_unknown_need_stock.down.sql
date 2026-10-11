-- Reverse of 20261231100000_recipe_accept_unknown_need_stock.sql: restores the previous
-- `recipe_accept_preview` body byte for byte. No data changes in either direction. After this, an
-- accept can again store the whole pantry stock for a line whose need is unknown (audit A049).
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
  if position('W024 (audit A049)' in definition) = 0 then return; end if;
  for i in 1 .. array_length(replacements, 1) loop
    if (length(definition) - length(replace(definition, replacements[i], '')))
       / length(replacements[i]) <> 1 then
      raise exception 'recipe_accept_unknown_need_stock down: replacement % does not occur exactly once', i;
    end if;
    definition := replace(definition, replacements[i], anchors[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke all on function public.recipe_accept_preview(uuid,uuid,boolean) from public, anon;
grant execute on function public.recipe_accept_preview(uuid,uuid,boolean) to authenticated;
