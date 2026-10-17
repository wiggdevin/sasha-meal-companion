-- W074: the database refuses a goal_rate_bp_week outside the presets on target_profiles, the same
-- set user_settings already enforces (20261029090000_rate_goals.sql). The app only ever writes a
-- preset (lib/profile/rate-goal.ts); this makes a direct or future writer unable to store another.
--
-- Live-safe: added NOT VALID (checks new and changed rows only, no table scan); the follow-up file
-- 20270104100100 validates it. Apply the two files in order.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.target_profiles
  add constraint target_profiles_goal_rate_bp_week_check
    check (goal_rate_bp_week in (-75, -50, -25, 0, 10, 20, 25)) not valid;
