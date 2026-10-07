-- A user food ref belongs to exactly one account. The old statement trigger bumped
-- every account's clock even for that private ref, so two users deleting their own
-- foods could lock each other's clock rows in opposite order and deadlock. Shared
-- catalog refs still invalidate every proof; private refs invalidate only their owner.
drop trigger if exists recipe_state_food_refs on public.food_refs;

create function public.recipe_plan_bump_food_ref_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ref public.food_refs%rowtype;
  v_user uuid;
begin
  v_ref := case when tg_op = 'DELETE' then old else new end;
  if v_ref.kind = 'catalog' then
    update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
  else
    -- On a cascading user_foods delete the parent may no longer be visible;
    -- recipe_state_user_foods already bumped that same owner's clock.
    select f.user_id into v_user from public.user_foods f where f.id = v_ref.user_food_id;
    if v_user is not null and exists (select 1 from auth.users where id = v_user) then
      insert into public.recipe_plan_state(user_id, rev) values (v_user, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.recipe_plan_bump_food_ref_state() from public, anon, authenticated;
create trigger recipe_state_food_refs after insert or update or delete on public.food_refs
  for each row execute function public.recipe_plan_bump_food_ref_state();
