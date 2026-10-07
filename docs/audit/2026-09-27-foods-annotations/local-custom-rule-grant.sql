-- Apply only to a database that already has 20261203090000_custom_food_rules.sql
-- without its final grants. Root owns execution in the isolated local test database.
begin;
grant insert (custom_rules) on table public.constraint_profiles to authenticated;
grant update (custom_rules) on table public.constraint_profiles to authenticated;
commit;
