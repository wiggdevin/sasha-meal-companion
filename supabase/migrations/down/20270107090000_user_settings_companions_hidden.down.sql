-- Reverse of 20270107090000_user_settings_companions_hidden.sql: the sync branch first, then the
-- column and its check function. Refuses while any account has hidden a companion, unless
-- app.allow_down_data_loss = on: dropping the column would silently show it again.
do $$
begin
  if coalesce(current_setting('app.allow_down_data_loss', true), '') <> 'on'
     and exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'user_settings' and column_name = 'companions_hidden')
     and exists (select 1 from public.user_settings where cardinality(companions_hidden) > 0) then
    raise exception 'user_settings_companions_hidden down: accounts have hidden a companion; set app.allow_down_data_loss = on to drop it'
      using errcode = '55000';
  end if;
end $$;

do $migration$
declare
  definition text;
  pairs text[][] := array[
    [$a$cuisines, country_code, mascot, companions_hidden, rev)$a$, $a$cuisines, country_code, mascot, rev)$a$],
    [$a$coalesce(p_payload->>'mascot', 'sprout'),
            array(select h.value from jsonb_array_elements_text(p_payload->'companions_hidden')
                    with ordinality as h(value, n) order by h.n),
            p_rev)$a$,
     $a$coalesce(p_payload->>'mascot', 'sprout'), p_rev)$a$],
    [$a$mascot = coalesce(p_payload->>'mascot', user_settings.mascot),
      companions_hidden = case when p_payload ? 'companions_hidden'
        then array(select h.value from jsonb_array_elements_text(p_payload->'companions_hidden')
                     with ordinality as h(value, n) order by h.n)
        else user_settings.companions_hidden end,$a$,
     $a$mascot = coalesce(p_payload->>'mascot', user_settings.mascot),$a$],
    [$a$raise exception 'cuisines_null: send [] to clear cuisines' using errcode = '22023';
    end if;
    -- UI makeover W3: companions_hidden is NOT NULL; [] clears it, a JSON null is refused.
    if p_payload ? 'companions_hidden' and jsonb_typeof(p_payload->'companions_hidden') = 'null' then
      raise exception 'companions_hidden_null: send [] to show every companion' using errcode = '22023';$a$,
     $a$raise exception 'cuisines_null: send [] to clear cuisines' using errcode = '22023';$a$]];
  i integer;
  occurrences integer;
  found_count integer := 0;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  if position('companions_hidden' in definition) = 0 then return; end if;
  -- Every patched part must be there exactly once, or the function is left as it is and this raises.
  for i in 1 .. array_length(pairs, 1) loop
    occurrences := (length(definition) - length(replace(definition, pairs[i][1], ''))) / length(pairs[i][1]);
    if occurrences = 1 then found_count := found_count + 1; end if;
  end loop;
  if found_count <> array_length(pairs, 1) then
    raise exception 'user_settings_companions_hidden down (_sync_upsert): % of % parts found; refusing a partial function',
      found_count, array_length(pairs, 1);
  end if;
  for i in 1 .. array_length(pairs, 1) loop
    definition := replace(definition, pairs[i][1], pairs[i][2]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;

alter table public.user_settings drop constraint if exists user_settings_companions_hidden_check;
alter table public.user_settings drop column if exists companions_hidden;
drop function if exists public.companions_hidden_valid(text[]);
