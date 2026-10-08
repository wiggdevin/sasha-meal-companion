-- W13 (D14): two server-owned markers on user_settings that let the SERVER decide the onboarding
-- open default and the legacy starter seed, so every device of an account agrees.
--
-- `food_world_set_at` is null only for an account whose `food_world` has NEVER been written by an
-- explicit `POST /api/foods/world` (the column's own 'closed' default, migration 20261213090000,
-- is not a choice). Every successful write through `setFoodWorld` (lib/server/food-world.ts)
-- stamps it, whether the write came from the onboarding default or a person's own Settings toggle.
-- A retried onboarding-default POST (`intent: "onboarding_default"`, lib/foods/world-open-client.ts)
-- is one conditional UPDATE that matches only while this column is null.
--
-- `food_world_default_due_at` (Sol round 4 BLOCK): stamped by the trigger below in the SAME write
-- that first sets `onboarded_at` (completed or skipped), so it exists exactly for accounts that
-- went through the W13 onboarding open default. Legacy accounts (onboarded before this migration)
-- keep null. `GET /api/foods/world` reads both markers: an account whose default is due and still
-- undecided is `openDefaultPending`, and no device seeds the legacy closed-world starter for it
-- (lib/foods/today-starter.ts) -- a device-local pending flag cannot see another device's 503.
--
-- Clients never write either marker: the trigger refuses an `authenticated` or `anon` change to
-- them (the sync RPC is security definer and the server uses service_role, so neither is
-- affected). Live-safe: two nullable columns with a constant null default (no rewrite, no
-- backfill), a new function, and one CREATE TRIGGER under lock_timeout 3s (SHARE ROW EXCLUSIVE
-- for a catalog update only).
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
alter table public.user_settings add column food_world_default_due_at timestamptz default null;
comment on column public.user_settings.food_world_set_at is
  'W13 (D14): when food_world was last explicitly written by POST /api/foods/world (default-open '
  'or a person''s own toggle). Null means never written -- the pre-choice default. Server-owned, '
  'same writer as food_world itself.';
comment on column public.user_settings.food_world_default_due_at is
  'W13 (D14): when onboarded_at was first set on this row (trigger user_settings_food_world_markers), '
  'i.e. the account went through the onboarding open default. Null for accounts onboarded before '
  'W13. Server-owned; read by GET /api/foods/world.';

create function public.user_settings_food_world_markers() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.food_world_set_at is not null or new.food_world_default_due_at is not null then
        raise exception 'food world markers are server-written' using errcode = '42501';
      end if;
    elsif new.food_world_set_at is distinct from old.food_world_set_at
       or new.food_world_default_due_at is distinct from old.food_world_default_due_at then
      raise exception 'food world markers are server-written' using errcode = '42501';
    end if;
  end if;
  if new.onboarded_at is not null and new.food_world_default_due_at is null
     and (tg_op = 'INSERT' or old.onboarded_at is null) then
    new.food_world_default_due_at := now();
  end if;
  return new;
end $$;
revoke all on function public.user_settings_food_world_markers() from public, anon, authenticated;

create trigger user_settings_food_world_markers before insert or update
  on public.user_settings for each row execute function public.user_settings_food_world_markers();
