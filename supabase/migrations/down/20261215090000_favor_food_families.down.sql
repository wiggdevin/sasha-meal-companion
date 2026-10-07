-- Reverse of 20261215090000_favor_food_families.sql. Revert the app deploy first: the Favor route
-- calls these functions. Restores get_or_create_food_ref to its 20261207090000 body.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.favor_food_families(uuid, text, jsonb, uuid[], bigint, bigint);
drop function if exists public.favor_family_sets(uuid, text[]);
drop function if exists public._favor_family_avoided(uuid, text);
drop function if exists public._favor_family_refs(uuid, text);

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

  -- Best-effort: the caller is owed the ref id above no matter what happens here.
  begin
    declare
      v_name text;
      v_status text;
      v_note text;
    begin
      if p_kind = 'catalog' then
        select food_name_norm(cr.description) into v_name
          from catalog_food_revisions cr
         where cr.catalog_food_id = p_catalog_food_id and cr.is_active
         order by cr.valid_from desc, cr.id desc limit 1;
      else
        select food_name_norm(f.name) into v_name from user_foods f where f.id = p_user_food_id;
      end if;
      if v_id is not null and v_name is not null and v_name <> '' then
        select membership.status, membership.note into v_status, v_note
          from food_membership_revisions membership
         where membership.user_id = p_user_id and membership.name_norm = v_name
         order by membership.updated_at desc limit 1;
        if v_status is not null then
          insert into user_food_prefs (user_id, food_ref_id, status, note, rev, updated_at)
          values (p_user_id, v_id, v_status, v_note, 1, now())
          on conflict (user_id, food_ref_id) do nothing;
        end if;
      end if;
    end;
  exception when others then
    raise warning 'get_or_create_food_ref membership backfill failed for user % ref %: %',
      p_user_id, v_id, sqlerrm;
  end;

  return v_id;
end; $$;
revoke execute on function get_or_create_food_ref(uuid, text, bigint, uuid) from public, anon;
grant execute on function get_or_create_food_ref(uuid, text, bigint, uuid) to authenticated, service_role;

alter table public.food_membership_revisions drop column if exists favor_rev;
