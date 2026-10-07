-- A former default backfill added personal restrictions to existing accounts without recording
-- provenance. Keep every value; ask those accounts to confirm each candidate before suggestions.
set local lock_timeout = '5s';

alter table public.constraint_profiles
  add column rule_review_required boolean not null default false,
  add column rule_reviewed_at timestamptz;

-- The backfill started at 2026-09-21 05:36 UTC. 05:40 is a conservative upper boundary:
-- a review is safer than treating an ambiguous rule as a confirmed personal preference.
update public.constraint_profiles as profile
   set rule_review_required = true
  from auth.users as account
 where account.id = profile.user_id
   and account.created_at < timestamptz '2026-09-21 05:40:00+00'
   and (profile.avoid_allergens && array['gluten', 'dairy', 'apple']::text[]
     or profile.banned_categories && array[
       'raw_cruciferous', 'raw_leafy_greens', 'onion_garlic', 'beans', 'simple_sugars'
     ]::text[]);

comment on column public.constraint_profiles.rule_review_required is
  'True when a pre-backfill account has ambiguous inherited food rules; never inferred from updated_at.';
comment on column public.constraint_profiles.rule_reviewed_at is
  'Set with the revision-checked explicit Keep/Remove review; null means no completed review.';
