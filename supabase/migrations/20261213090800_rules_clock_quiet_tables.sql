-- Phase 18 W2b, step (d): the account clock on three low-traffic tables: user_dietary_profiles,
-- food_world_condition_confirmations and user_allergen_checks.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table (writes wait) for a catalog update only.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create trigger rules_clock_user_dietary_profiles after insert or update or delete
  on public.user_dietary_profiles for each row execute function public.rules_clock_bump();
create trigger rules_clock_food_world_condition_confirmations after insert or update or delete
  on public.food_world_condition_confirmations for each row execute function public.rules_clock_bump();
create trigger rules_clock_user_allergen_checks after insert or update or delete
  on public.user_allergen_checks for each row execute function public.rules_clock_bump();
