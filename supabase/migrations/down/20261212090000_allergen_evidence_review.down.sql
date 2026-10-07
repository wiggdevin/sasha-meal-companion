-- Reverse of 20261212090000_allergen_evidence_review.sql. Restores the Phase 13 trigger body
-- (a coerced downgrade keeps level and label_complete only) and drops the review columns. The
-- review log in reviewed_at / reviewed_by is lost: export it first. Run only to unblock a broken
-- deploy; the app code from Phase 18 W2a reads no review column, so it keeps working.
drop trigger if exists food_allergen_evidence_no_truncate on public.food_allergen_evidence;
drop function if exists public._p18_refuse_allergen_evidence_truncate();
drop trigger if exists food_allergen_evidence_hold_delete on public.food_allergen_evidence;
drop function if exists public._p18_guard_allergen_hold_delete();

create or replace function public._p13_monotonic_allergen_evidence() returns trigger
language plpgsql set search_path = '' as $$
begin
  if public._p13_allergen_evidence_rank(new.level) < public._p13_allergen_evidence_rank(old.level) then
    new.level := old.level;
    new.label_complete := old.label_complete;
  end if;
  return new;
end $$;

alter table public.food_allergen_evidence
  drop constraint if exists food_allergen_evidence_reviewed_by,
  drop constraint if exists food_allergen_evidence_reviewed_pair,
  drop column if exists reviewed_by,
  drop column if exists reviewed_at;
