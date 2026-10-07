-- Restores get_or_create_food_ref to its pre-backfill body (no membership lookup or write).
create or replace function get_or_create_food_ref(p_user_id uuid, p_kind text,
                                       p_catalog_food_id bigint, p_user_food_id uuid)
  returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform _sync_assert_caller(p_user_id);
  if p_kind = 'catalog' then
    if p_catalog_food_id is null then raise exception 'catalog_food_id_required' using errcode = '22023'; end if;
    select id into v_id from food_refs where catalog_food_id = p_catalog_food_id;
    if v_id is null then
      insert into food_refs (kind, catalog_food_id) values ('catalog', p_catalog_food_id)
        on conflict (catalog_food_id) where catalog_food_id is not null do nothing
        returning id into v_id;
      if v_id is null then select id into v_id from food_refs where catalog_food_id = p_catalog_food_id; end if;
    end if;
  elsif p_kind = 'user' then
    if p_user_food_id is null then raise exception 'user_food_id_required' using errcode = '22023'; end if;
    if not exists (select 1 from user_foods f where f.id = p_user_food_id and f.user_id = p_user_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    select id into v_id from food_refs where user_food_id = p_user_food_id;
    if v_id is null then
      insert into food_refs (kind, user_food_id) values ('user', p_user_food_id)
        on conflict (user_food_id) where user_food_id is not null do nothing
        returning id into v_id;
      if v_id is null then select id into v_id from food_refs where user_food_id = p_user_food_id; end if;
    end if;
  else
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  return v_id;
end; $$;
revoke execute on function get_or_create_food_ref(uuid, text, bigint, uuid) from public, anon;
grant execute on function get_or_create_food_ref(uuid, text, bigint, uuid) to authenticated, service_role;
