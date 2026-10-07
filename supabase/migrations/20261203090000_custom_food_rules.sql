-- A08: owner-scoped custom rules in the existing revision-checked constraint profile.
-- Keep the storage boundary as strict as the API: other privileged writers can bypass Zod.
create or replace function public.custom_food_rules_valid(rules jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when rules is null or pg_catalog.jsonb_typeof(rules) <> 'array' then false
    when pg_catalog.jsonb_array_length(rules) > 30 then false
    else not exists (
      select 1 from pg_catalog.jsonb_array_elements(rules) as entry(value)
      where not coalesce(
        pg_catalog.jsonb_typeof(entry.value) = 'object'
        and entry.value - 'id' - 'kind' - 'text' = '{}'::jsonb
        and pg_catalog.jsonb_typeof(entry.value->'id') = 'string'
        and (entry.value->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and pg_catalog.jsonb_typeof(entry.value->'kind') = 'string'
        and entry.value->>'kind' in ('ingredient', 'cuisine', 'guidance')
        and pg_catalog.jsonb_typeof(entry.value->'text') = 'string'
        and pg_catalog.length(entry.value->>'text') between 2 and 80
        and entry.value->>'text' = pg_catalog.btrim(entry.value->>'text')
        and entry.value->>'text' !~ '[[:cntrl:]]',
        false
      )
    ) and (select pg_catalog.count(distinct entry.value->>'id')
      from pg_catalog.jsonb_array_elements(rules) as entry(value)) = pg_catalog.jsonb_array_length(rules)
    end;
$$;
alter table public.constraint_profiles
  add column custom_rules jsonb not null default '[]'::jsonb;
alter table public.constraint_profiles
  add constraint constraint_profiles_custom_rules_shape
  check (public.custom_food_rules_valid(custom_rules));
comment on column public.constraint_profiles.custom_rules is
  'Explicit ingredient/cuisine exclusions and non-enforced guidance. Each item is checked at the API and database boundaries.';
-- 20261125090200 restricted authenticated writes to named account-rule columns.
-- Extend that allowlist for this one column; server-owned review markers stay protected.
grant insert (custom_rules) on table public.constraint_profiles to authenticated;
grant update (custom_rules) on table public.constraint_profiles to authenticated;
