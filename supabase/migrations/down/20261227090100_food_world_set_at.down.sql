-- Reverse of 20261227090100_food_world_set_at.sql. Both columns are server-owned markers: dropping
-- them never loses a decision the account made (food_world itself is unaffected). Without them the
-- onboarding default's retry refusal and the server-side starter-seed rule go away.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop trigger if exists user_settings_food_world_markers on public.user_settings;
drop function if exists public.user_settings_food_world_markers();
alter table public.user_settings drop column if exists food_world_default_due_at;
alter table public.user_settings drop column if exists food_world_set_at;
