-- W13 re-review fix: a backend-side guarantee that the onboarding open-default retry can never
-- re-open an account after a deliberate choice, with no UI change required.
--
-- `food_world_set_at` is null only for an account whose `food_world` has NEVER been written by an
-- explicit `POST /api/foods/world` (the column's own 'closed' default, migration 20261213090000,
-- is not a choice). Every successful write through `setFoodWorld` (lib/server/food-world.ts) now
-- stamps it, whether the write came from the onboarding default or a person's own Settings toggle.
-- A retried onboarding-default POST (`intent: "onboarding_default"`, lib/foods/world-open-client.ts)
-- is refused once this column is non-null for the account: something was already decided, by the
-- default itself or by the person, and the retry must never overwrite it. Nullable, constant
-- default (null), no backfill: a plain additive column, no NOT VALID step needed.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'user_settings' and column_name = 'food_world_set_at') then
    raise exception '20261227090100_food_world_set_at: already applied';
  end if;
end $$;

alter table public.user_settings add column food_world_set_at timestamptz default null;
comment on column public.user_settings.food_world_set_at is
  'W13 (D14): when food_world was last explicitly written by POST /api/foods/world (default-open '
  'or a person''s own toggle). Null means never written -- the pre-choice default. Server-owned, '
  'same writer as food_world itself.';
