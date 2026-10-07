-- Phase 18 W2b, step (d): the account clock on user_food_prefs (Eats and Avoid marks).
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table (writes wait) for a catalog update only.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create trigger rules_clock_user_food_prefs after insert or update or delete
  on public.user_food_prefs for each row execute function public.rules_clock_bump();
