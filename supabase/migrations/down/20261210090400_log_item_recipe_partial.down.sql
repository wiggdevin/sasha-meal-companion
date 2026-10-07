-- Reverse of 20261210090400_log_item_recipe_partial.sql. Deploy the app revert BEFORE running
-- this: lib/server/log.ts, day-context.ts and export.ts select the two columns by name. Dropping
-- the columns loses the recorded judgements; readers fall back to the current-revision guess.
drop trigger if exists log_items_judge_partial on public.log_items;
drop trigger if exists log_items_stash_partial on public.log_items;
drop function if exists public._log_item_judge_partial();
drop function if exists public._log_item_stash_partial();
drop function if exists public._log_item_carry_key(uuid);
drop function if exists public._log_item_recipe_partial(uuid, uuid);
alter table public.log_items drop column if exists recipe_rev, drop column if exists nutrition_partial;
