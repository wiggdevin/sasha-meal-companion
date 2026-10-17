-- Reverse of 20270104100100_target_profiles_goal_rate_check_validate.sql. Validation cannot be
-- undone in place, so put the constraint back as NOT VALID (what the first file left), in one
-- statement so there is no window without a constraint.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.target_profiles
  drop constraint if exists target_profiles_goal_rate_bp_week_check,
  add constraint target_profiles_goal_rate_bp_week_check
    check (goal_rate_bp_week in (-75, -50, -25, 0, 10, 20, 25)) not valid;
