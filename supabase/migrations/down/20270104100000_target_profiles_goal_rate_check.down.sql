-- Reverse of 20270104100000_target_profiles_goal_rate_check.sql. No data changes.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.target_profiles drop constraint if exists target_profiles_goal_rate_bp_week_check;
