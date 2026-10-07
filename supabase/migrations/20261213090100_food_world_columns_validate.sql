-- Phase 18 W2b, step (b): validate step (a)'s checks (SHARE UPDATE EXCLUSIVE: reads and writes
-- continue during the scan), then SET NOT NULL, which PostgreSQL proves from the validated check
-- without a second scan. The plain not-null check is then redundant and dropped; the food_world
-- check stays, it also bounds the values.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.user_settings validate constraint user_settings_food_world;
alter table public.constraint_profiles validate constraint constraint_profiles_condition_review_not_null;
alter table public.user_settings alter column food_world set not null;
alter table public.constraint_profiles alter column condition_review_required set not null;
alter table public.constraint_profiles drop constraint constraint_profiles_condition_review_not_null;
