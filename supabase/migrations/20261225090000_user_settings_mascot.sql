-- UI-NEEDS SPROUT-CARE item 5 (coord.md 2026-10-07T04:15Z): the account's chosen mascot. Text, not
-- an enum, so a new mascot ships without a migration; `care_items.mascots` (20261225090200) is
-- where "which mascot can wear this" actually lives. Default 'sprout' so an existing account (and
-- a brand-new one, inserted with no sync op at all) reads a mascot without a null check anywhere.
--
-- Synced like every other user_settings field: patches the user_settings branch of _sync_upsert
-- (the meal_layout / cuisines pattern, 20261217090200) rather than redefining the whole function.
-- Semantics deliberately simpler than cuisines/country_code: mascot can never be cleared to null
-- (there is always a mascot), so an omitted key OR an explicit JSON null both keep the stored
-- value (or, for a brand-new row, fall back to the column default) -- no `mascot_null` refusal
-- needed, and no extra branch in the plpgsql body.
--
-- Live-safe: one new column with a constant default (no table rewrite); CREATE OR REPLACE
-- FUNCTION takes no table lock. Down: supabase/migrations/down/20261225090000_user_settings_mascot.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'user_settings' and column_name = 'mascot') then
    raise exception '20261225090000_user_settings_mascot: already applied';
  end if;
end $$;

alter table public.user_settings add column mascot text not null default 'sprout';
alter table public.user_settings add constraint user_settings_mascot_check
  check (char_length(mascot) between 1 and 40) not valid;

comment on column public.user_settings.mascot is
  'UI-NEEDS SPROUT-CARE item 5: the chosen mascot, free text (care_items.mascots names which '
  'items it can wear). Default ''sprout''. Synced; never cleared to null (omit or JSON null both '
  'keep the stored value).';

do $migration$
declare
  definition text;
  froms text[] := array[
    $a$cuisines, country_code, rev)$a$,
    $a$p_payload->>'country_code', p_rev)$a$,
    $a$else user_settings.country_code end,$a$];
  tos text[] := array[
    $a$cuisines, country_code, mascot, rev)$a$,
    $a$p_payload->>'country_code', coalesce(p_payload->>'mascot', 'sprout'), p_rev)$a$,
    $a$else user_settings.country_code end,
      mascot = coalesce(p_payload->>'mascot', user_settings.mascot),$a$];
  i integer;
  occurrences integer;
  done_count integer := 0;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  for i in 1 .. array_length(tos, 1) loop
    if (length(definition) - length(replace(definition, tos[i], ''))) / length(tos[i]) = 1 then
      done_count := done_count + 1;
    end if;
  end loop;
  if done_count = array_length(tos, 1) then return; end if;
  if done_count > 0 then
    raise exception 'user_settings_mascot (_sync_upsert): % of % parts already patched; refusing a partial function',
      done_count, array_length(tos, 1);
  end if;
  for i in 1 .. array_length(froms, 1) loop
    occurrences := (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]);
    if occurrences <> 1 then
      raise exception 'user_settings_mascot (_sync_upsert): anchor % occurs % times, expected once', i, occurrences;
    end if;
  end loop;
  for i in 1 .. array_length(froms, 1) loop
    definition := replace(definition, froms[i], tos[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;
