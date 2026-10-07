-- Phase 18 W2a (docs/specs/phase-18-open-world-foods.md §6 migration 2, D4): Jev comes off the
-- allergy path, fail-closed.
--
-- A stored food_allergen_evidence row with level = 'listed' and source = 'jev' is now a HOLD: the
-- app reads it as "Not verified" (lib/policy/allergens.ts storedEvidenceFromRow), never as clear.
-- Nothing automatic lifts a hold. Only an evidence review that replaces the row with deterministic
-- evidence does, and the review is logged in the two new columns (scripts/allergen-jev-holds.ts).
--
-- This migration deletes and rewrites no row. It:
--   1. adds reviewed_at / reviewed_by (both null, or both set);
--   2. replaces the monotonic trigger function so that
--      - ANY update of a hold keeps it a hold (level, source 'jev', review fields), whatever the
--        writer sends, including the origin/main warm writer's equal-rank `listed`/'ingredients'
--        re-upsert (review r2 BLOCK);
--      - the one exception is a logged review (reviewed_at newly set, reviewed_by set, a non-Jev
--        source, a deterministic level), which may replace a hold, including with not_listed.
--        A deterministic re-derive to a block (scripts/allergen-jev-holds.ts --rederive) goes
--        through this same review path, recorded as reviewed_by 'w2a-rederive';
--      - a coerced downgrade of any other row also keeps that row's own source.
--   3. refuses a DELETE of a held row (review r1 BLOCK 3): a deleted hold reads as no_evidence,
--      which the whole-food class can clear. A review replaces a hold by UPDATE, never by delete.
--      The one exception is the account cascade: a user-food row whose owner no longer exists
--      (auth.users delete cascades here) is removed with the account.
--   4. refuses TRUNCATE of the table, the one other statement that removes holds wholesale.
--
-- Old code keeps working against this schema: the columns are nullable and unread by it.
-- Guarded: refuses a second run, and refuses a database without the table.
do $$
begin
  if to_regclass('public.food_allergen_evidence') is null then
    raise exception '20261212090000_allergen_evidence_review: food_allergen_evidence is missing';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'food_allergen_evidence'
                and column_name in ('reviewed_at', 'reviewed_by')) then
    raise exception '20261212090000_allergen_evidence_review: already applied';
  end if;
end $$;

alter table public.food_allergen_evidence
  add column reviewed_at timestamptz null,
  add column reviewed_by text null;

alter table public.food_allergen_evidence
  add constraint food_allergen_evidence_reviewed_pair
    check ((reviewed_at is null) = (reviewed_by is null)),
  add constraint food_allergen_evidence_reviewed_by
    check (reviewed_by is null
      or (reviewed_by = btrim(reviewed_by) and reviewed_by <> '' and length(reviewed_by) <= 200));

create or replace function public._p13_monotonic_allergen_evidence() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_held boolean;
  v_review boolean;
begin
  v_held := old.level = 'listed' and old.source = 'jev';
  -- A logged review of a hold: the only update that may change a held row's source or level.
  v_review := v_held
    and new.source in ('label', 'ingredients', 'legacy')
    and new.level in ('listed', 'not_listed')
    and new.reviewed_at is not null and new.reviewed_by is not null
    and new.reviewed_at is distinct from old.reviewed_at;
  if v_review then
    return new;
  end if;
  if v_held then
    -- Review r2 BLOCK: ANY other update of a hold keeps it a hold. The origin/main warm writer
    -- (deployed during the switch-over) re-upserts `listed` with source 'ingredients' at equal
    -- rank; without this the hold would lose its identity and the delete guard would let it go.
    new.level := old.level;
    new.label_complete := old.label_complete;
    new.source := old.source;
    new.reviewed_at := old.reviewed_at;
    new.reviewed_by := old.reviewed_by;
    return new;
  end if;
  if public._p13_allergen_evidence_rank(new.level) < public._p13_allergen_evidence_rank(old.level) then
    new.level := old.level;
    new.label_complete := old.label_complete;
    new.source := old.source;
    new.reviewed_at := old.reviewed_at;
    new.reviewed_by := old.reviewed_by;
  end if;
  return new;
end $$;

-- security definer: the cascade check reads auth.users, which the deleting role may not see.
create or replace function public._p18_guard_allergen_hold_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.level = 'listed' and old.source = 'jev' then
    if old.user_id is not null
       and not exists (select 1 from auth.users u where u.id = old.user_id) then
      return old; -- the owning account is being deleted (on delete cascade)
    end if;
    raise exception 'food_allergen_evidence: a held Jev row (%/%) is never deleted; replace it '
      'through a logged review (scripts/allergen-jev-holds.ts --review)', old.food_key, old.allergen
      using errcode = 'P0001';
  end if;
  return old;
end $$;
revoke all on function public._p18_guard_allergen_hold_delete() from public, anon, authenticated;

create trigger food_allergen_evidence_hold_delete
  before delete on public.food_allergen_evidence
  for each row execute function public._p18_guard_allergen_hold_delete();

create or replace function public._p18_refuse_allergen_evidence_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'food_allergen_evidence: truncate would remove held Jev rows; refused'
    using errcode = 'P0001';
end $$;
revoke all on function public._p18_refuse_allergen_evidence_truncate() from public, anon, authenticated;

create trigger food_allergen_evidence_no_truncate
  before truncate on public.food_allergen_evidence
  for each statement execute function public._p18_refuse_allergen_evidence_truncate();
