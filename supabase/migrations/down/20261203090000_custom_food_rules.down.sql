-- Removing this column discards account rules. Refuse rollback until they are migrated or cleared.
begin;
lock table public.constraint_profiles in access exclusive mode;
-- A role without BYPASSRLS must fail rather than silently miss other owners' rows.
set local row_security = off;
do $$ begin
  if exists (select 1 from public.constraint_profiles where custom_rules <> '[]'::jsonb) then
    raise exception 'custom_food_rules rollback refused: account rules remain';
  end if;
end $$;
revoke insert (custom_rules) on table public.constraint_profiles from authenticated;
revoke update (custom_rules) on table public.constraint_profiles from authenticated;
alter table public.constraint_profiles drop constraint if exists constraint_profiles_custom_rules_shape;
alter table public.constraint_profiles drop column if exists custom_rules;
drop function if exists public.custom_food_rules_valid(jsonb);
commit;
