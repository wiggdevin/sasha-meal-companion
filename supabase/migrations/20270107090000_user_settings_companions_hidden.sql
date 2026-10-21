-- UI makeover W3 (docs/plans/2026-10-19-ui-makeover.md §5): the companions an account has hidden
-- from Today. A list of mascot keys (`lib/profile/mascot.ts`), free text like `mascot` itself so a
-- new companion ships without a migration; the phone drops a key it does not know. Default '{}':
-- every companion is shown until the person hides one.
--
-- Synced like every other user_settings field: patches the user_settings branch of _sync_upsert by
-- anchor (the mascot pattern, 20261225090000) rather than redefining the whole function. Semantics
-- are those of `cuisines` (20261217090200): an omitted key keeps the stored list (an insert takes
-- the default '{}'); `[]` clears it; a JSON null raises 22023 `companions_hidden_null`. A
-- non-array, a ninth key or a key outside 1-40 characters is refused by the column check, which
-- fails the op.
--
-- Live-safe: one new column with a constant default (no table rewrite), the check added NOT VALID
-- and validated in 20270107090100; CREATE OR REPLACE FUNCTION takes no table lock.
-- Down: supabase/migrations/down/20270107090000_user_settings_companions_hidden.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'user_settings' and column_name = 'companions_hidden') then
    raise exception '20270107090000_user_settings_companions_hidden: already applied';
  end if;
end $$;

-- Every element 1-40 characters, at most 8 (a CHECK cannot hold a subquery, so a small immutable
-- function does the per-element test).
create function public.companions_hidden_valid(keys text[]) returns boolean
  language sql immutable parallel safe
  set search_path = ''
as $$
  select keys is not null
    and cardinality(keys) <= 8
    and array_position(keys, null) is null
    and not exists (select 1 from unnest(keys) as k(v) where char_length(k.v) not between 1 and 40);
$$;
comment on function public.companions_hidden_valid(text[]) is
  'UI makeover W3: the storage contract of user_settings.companions_hidden (at most 8 keys, each 1-40 characters).';

alter table public.user_settings add column companions_hidden text[] not null default '{}';
alter table public.user_settings add constraint user_settings_companions_hidden_check
  check (public.companions_hidden_valid(companions_hidden)) not valid;

comment on column public.user_settings.companions_hidden is
  'UI makeover W3: mascot keys (lib/profile/mascot.ts) the account hid from Today. At most 8, each '
  '1-40 characters. Synced: omitted keeps, [] clears, JSON null is refused (companions_hidden_null).';

do $migration$
declare
  definition text;
  -- `froms[i]` is replaced by `tos[i]`; every `froms[i]` must occur exactly once before anything
  -- is replaced.
  froms text[] := array[
    $a$cuisines, country_code, mascot, rev)$a$,
    $a$coalesce(p_payload->>'mascot', 'sprout'), p_rev)$a$,
    $a$mascot = coalesce(p_payload->>'mascot', user_settings.mascot),$a$,
    $a$raise exception 'cuisines_null: send [] to clear cuisines' using errcode = '22023';$a$];
  tos text[] := array[
    $a$cuisines, country_code, mascot, companions_hidden, rev)$a$,
    $a$coalesce(p_payload->>'mascot', 'sprout'),
            array(select h.value from jsonb_array_elements_text(p_payload->'companions_hidden')
                    with ordinality as h(value, n) order by h.n),
            p_rev)$a$,
    $a$mascot = coalesce(p_payload->>'mascot', user_settings.mascot),
      companions_hidden = case when p_payload ? 'companions_hidden'
        then array(select h.value from jsonb_array_elements_text(p_payload->'companions_hidden')
                     with ordinality as h(value, n) order by h.n)
        else user_settings.companions_hidden end,$a$,
    $a$raise exception 'cuisines_null: send [] to clear cuisines' using errcode = '22023';
    end if;
    -- UI makeover W3: companions_hidden is NOT NULL; [] clears it, a JSON null is refused.
    if p_payload ? 'companions_hidden' and jsonb_typeof(p_payload->'companions_hidden') = 'null' then
      raise exception 'companions_hidden_null: send [] to show every companion' using errcode = '22023';$a$];
  done_count integer := 0;
  i integer;
  occurrences integer;
begin
  select pg_get_functiondef('public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure)
    into definition;
  -- The state is read from the patched texts only. All present exactly once: already applied, a
  -- no-op. Some: a partly patched function, which raises.
  for i in 1 .. array_length(tos, 1) loop
    if (length(definition) - length(replace(definition, tos[i], ''))) / length(tos[i]) = 1 then
      done_count := done_count + 1;
    end if;
  end loop;
  if done_count = array_length(tos, 1) then return; end if;
  if done_count > 0 then
    raise exception 'user_settings_companions_hidden (_sync_upsert): % of % parts already patched; refusing a partial function',
      done_count, array_length(tos, 1);
  end if;
  for i in 1 .. array_length(froms, 1) loop
    occurrences := (length(definition) - length(replace(definition, froms[i], ''))) / length(froms[i]);
    if occurrences <> 1 then
      raise exception 'user_settings_companions_hidden (_sync_upsert): anchor % occurs % times, expected once', i, occurrences;
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
