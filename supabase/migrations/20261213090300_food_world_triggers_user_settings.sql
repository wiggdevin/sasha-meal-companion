-- Phase 18 W2b, step (d): user_settings: the food-world guard (only the server moves the switch;
-- open needs every condition confirmed) and the account clock.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table (writes wait) for a catalog update only.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create trigger user_settings_food_world_guard before insert or update of food_world
  on public.user_settings for each row execute function public.user_settings_food_world_guard();
create trigger rules_clock_user_settings after insert or update or delete
  on public.user_settings for each row execute function public.rules_clock_bump();
