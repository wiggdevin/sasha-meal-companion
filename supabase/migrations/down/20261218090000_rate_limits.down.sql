-- Reverse of 20261218090000_rate_limits.sql. Deploy the code that no longer calls rate_limit_hit
-- first: with the function gone, the limiter's database call fails, and fail-closed routes answer
-- 503. The table holds only short-lived counters, so dropping it loses nothing durable.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.rate_limit_hit(text, integer, integer);
drop function if exists public.rate_limits_sweep(integer);
drop table if exists public.rate_limits;
