-- Phase 18 W2b, step (d): constraint_profiles: the condition gate (a condition saved on an open
-- account closes it in the same write; removing one deletes its confirmation) and the account clock.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table (writes wait) for a catalog update only.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create trigger constraint_profiles_condition_gate
  before insert or update of conditions, condition_review_required on public.constraint_profiles
  for each row execute function public.constraint_profiles_condition_gate();
create trigger rules_clock_constraint_profiles after insert or update or delete
  on public.constraint_profiles for each row execute function public.rules_clock_bump();
