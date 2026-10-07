drop trigger if exists recipe_state_food_refs on public.food_refs;
drop function if exists public.recipe_plan_bump_food_ref_state();
create trigger recipe_state_food_refs after insert or update or delete on public.food_refs
  for each statement execute function public.recipe_plan_bump_global_state();
