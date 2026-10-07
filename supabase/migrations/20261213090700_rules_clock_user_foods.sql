-- Phase 18 W2b, step (d): the account clock on user_foods (an account food's identity and nutrition).
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table (writes wait) for a catalog update only.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create trigger rules_clock_user_foods after insert or update or delete
  on public.user_foods for each row execute function public.rules_clock_bump();
