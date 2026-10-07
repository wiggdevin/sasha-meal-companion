-- Phase 18 W2b, step (d): the evidence clock on food_refs.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table (writes wait) for a catalog update only.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create trigger evidence_clock_food_refs_ins after insert on public.food_refs
  referencing new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_food_refs_upd after update on public.food_refs
  referencing old table as old_rows new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_food_refs_del after delete on public.food_refs
  referencing old table as old_rows for each statement execute function public.evidence_clock_bump();
