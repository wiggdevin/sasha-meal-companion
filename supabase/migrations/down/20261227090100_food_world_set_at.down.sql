-- Reverse of 20261227090100_food_world_set_at.sql. The column is a pure marker with no reader
-- outside setFoodWorld's own refusal check, so dropping it never loses a decision the account made
-- (food_world itself is unaffected) -- only the retry-refusal guard goes away.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.user_settings drop column if exists food_world_set_at;
