-- Phase 18 W5, step (a) of migration 4 `profile_cuisines_country` (docs/specs/phase-18-open-world-foods.md
-- §6 row 4, D2, D6). Live-safe: two new columns with a constant default or none (no table rewrite:
-- existing rows read the default at once), and every CHECK added NOT VALID, so this step holds its
-- ACCESS EXCLUSIVE lock only for a catalog update, never a scan. Step (b), 20261217090100,
-- validates the checks and sets cuisines NOT NULL from them; step (c), 20261217090200, teaches the
-- sync RPC the two columns.
--
--   user_settings.cuisines      text[], default '{}': the account's favored cuisines, at most 6, no
--                               duplicates, each from the 12-value vocabulary
--                               (lib/foods/universe/vocabulary.ts CUISINES).
--   user_settings.country_code  text, optional: an ISO 3166-1 alpha-2 shape (^[A-Z]{2}$). Only 'US'
--                               turns on the U.S. population prior (D2, D10). Never derived from the
--                               time zone or geolocation.
--   diet_prefs.taste            JSON, optional: { dislikes?: string[] } with at most 50 distinct
--                               keys, each 'f:' + 1-80 characters or 't:<sensory tag>'; the storage
--                               contract public.diet_prefs_taste_valid (lib/profile/taste.ts).
--
-- No state, region, race or ethnicity column (D2, D15).
--
-- Apply order: 20261217090000, 20261217090100, 20261217090200, each file in its own transaction.
-- Rollback: revert the app deploy, then the down files in reverse order.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'user_settings' and column_name in ('cuisines', 'country_code')) then
    raise exception '20261217090000_profile_cuisines_country: already applied';
  end if;
end $$;

alter table public.user_settings add column cuisines text[] default '{}';
alter table public.user_settings add column country_code text;

-- The vocabulary, no null element, at most 6, and no duplicates: the count of distinct vocabulary
-- words present equals the array's length (the training_weekdays pattern, no subquery).
alter table public.user_settings add constraint user_settings_cuisines_valid
  check (
    cuisines is not null
    and cuisines <@ array['american', 'latin_american', 'italian', 'mediterranean', 'south_asian',
      'chinese', 'japanese', 'korean', 'southeast_asian', 'caribbean', 'african',
      'european_other']::text[]
    and array_position(cuisines, null) is null
    and cardinality(cuisines) <= 6
    and cardinality(cuisines) =
      (case when 'american' = any(cuisines) then 1 else 0 end
       + case when 'latin_american' = any(cuisines) then 1 else 0 end
       + case when 'italian' = any(cuisines) then 1 else 0 end
       + case when 'mediterranean' = any(cuisines) then 1 else 0 end
       + case when 'south_asian' = any(cuisines) then 1 else 0 end
       + case when 'chinese' = any(cuisines) then 1 else 0 end
       + case when 'japanese' = any(cuisines) then 1 else 0 end
       + case when 'korean' = any(cuisines) then 1 else 0 end
       + case when 'southeast_asian' = any(cuisines) then 1 else 0 end
       + case when 'caribbean' = any(cuisines) then 1 else 0 end
       + case when 'african' = any(cuisines) then 1 else 0 end
       + case when 'european_other' = any(cuisines) then 1 else 0 end)
  ) not valid;

alter table public.user_settings add constraint user_settings_country_code_check
  check (country_code is null or country_code ~ '^[A-Z]{2}$') not valid;

-- diet_prefs.taste, a storage contract (lib/profile/taste.ts `storedTasteKey` reads exactly this):
-- absent, or an object whose only key is `dislikes`, an array of at most 50 distinct strings, each
--   't:' + one reviewed sensory tag (lib/foods/universe/vocabulary.ts SENSORY_TAGS; a test holds the
--         two lists equal), or
--   'f:' + 1-80 characters (a food family).
-- The canonical family form (lib/foods/base-name.ts `baseFoodName`) is the phone's write rule, not a
-- database rule: Unicode normalization, case and whitespace classes differ between JavaScript and
-- PostgreSQL collations, so SQL cannot prove parity. The phone keeps every key this accepts unchanged.
-- A pure function so the check can count distinct keys; it reads no table.
create function public.diet_prefs_taste_valid(prefs jsonb) returns boolean
  language sql immutable parallel safe set search_path = '' as $fn$
    select case
      when prefs is null or jsonb_typeof(prefs) <> 'object' or not (prefs ? 'taste') then true
      when jsonb_typeof(prefs->'taste') <> 'object' then false
      when (prefs->'taste') - 'dislikes' <> '{}'::jsonb then false
      when not ((prefs->'taste') ? 'dislikes') then true
      when jsonb_typeof(prefs->'taste'->'dislikes') <> 'array' then false
      when jsonb_array_length(prefs->'taste'->'dislikes') > 50 then false
      else (
        select coalesce(bool_and(jsonb_typeof(d.item) = 'string' and (
                 (d.item #>> '{}') in ('t:soft', 't:slimy', 't:spicy_hot', 't:strong_fish', 't:bitter',
                   't:crunchy', 't:chewy', 't:pungent', 't:sour', 't:creamy', 't:gamey', 't:organ_meat')
                 or (substr(d.item #>> '{}', 1, 2) = 'f:'
                     and char_length(d.item #>> '{}') between 3 and 82))), true)
               and count(*) = count(distinct d.item)
          from jsonb_array_elements(prefs->'taste'->'dislikes') as d(item)
      )
    end
  $fn$;
comment on function public.diet_prefs_taste_valid(jsonb) is
  'Phase 18 W5: the diet_prefs.taste storage contract (lib/profile/taste.ts storedTasteKey). Pure.';

alter table public.user_settings add constraint user_settings_diet_prefs_taste_check
  check (public.diet_prefs_taste_valid(diet_prefs)) not valid;

comment on column public.user_settings.cuisines is
  'Phase 18 D2: favored cuisines, at most 6, from the 12-value vocabulary. Synced (omit keeps, [] clears).';
comment on column public.user_settings.country_code is
  'Phase 18 D2: optional ISO 3166-1 alpha-2 country. Only US turns on the U.S. prior. Never inferred.';
