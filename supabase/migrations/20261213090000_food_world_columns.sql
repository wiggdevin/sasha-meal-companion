-- Phase 18 W2b, step (a) of the live-safe food-world sequence (docs/specs/phase-18-open-world-foods.md
-- §6 migration 1, D3, D4). Adds the two server-owned columns with constant defaults (no table
-- rewrite: existing rows read the default at once) and nullable, with CHECK constraints added NOT
-- VALID so this step takes its ACCESS EXCLUSIVE lock only for a catalog update, never a scan.
-- Step (b), 20261213090100, validates the checks and sets NOT NULL from them.
--
--   user_settings.food_world                    'closed' | 'open'; server-written only (step d).
--   constraint_profiles.condition_review_required  set by the condition gate (step d); no
--                                               authenticated column grant (20261125090200).
--
-- Apply order: 20261213090000 .. 20261213091200, each file in its own transaction. Rollback: the
-- down files in reverse order, after the app deploy is reverted.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'user_settings' and column_name = 'food_world') then
    raise exception '20261213090000_food_world_columns: already applied';
  end if;
end $$;

alter table public.user_settings add column food_world text default 'closed';
alter table public.user_settings add constraint user_settings_food_world
  check (food_world is not null and food_world in ('closed', 'open')) not valid;
comment on column public.user_settings.food_world is
  'Phase 18 D3: closed = Favored (Eats) foods only; open = the admitted open world. Server-written only.';

alter table public.constraint_profiles add column condition_review_required boolean default false;
alter table public.constraint_profiles add constraint constraint_profiles_condition_review_not_null
  check (condition_review_required is not null) not valid;
comment on column public.constraint_profiles.condition_review_required is
  'Phase 18 D4: a condition changed on an open account and awaits confirmation. Server-owned.';
