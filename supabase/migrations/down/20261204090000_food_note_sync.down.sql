-- A down after any explicit note edit would let a queued old membership note replay. Refuse it.
-- Lock out a concurrent note writer before the emptiness check; a non-BYPASSRLS runner fails
-- instead of silently seeing zero protected rows.
begin;
lock table public.food_note_authority in access exclusive mode;
set local row_security = off;
do $$ begin
  if exists (select 1 from food_note_authority) then
    raise exception 'food_note_authority_in_use: preserve explicit notes before rollback';
  end if;
end $$;

create or replace function set_food_membership(p_user uuid, p_name_norm text, p_status text,
                                                p_note text, p_rev bigint) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_name text := food_name_norm(p_name_norm);
  v_user_refs uuid[];
  v_catalog_refs uuid[];
  v_refs uuid[];
  v_catalog_count bigint;
  v_catalog_limit integer;
  v_truncated boolean;
  v_result jsonb;
begin
  perform _sync_assert_caller(p_user);
  if v_name = '' then raise exception 'food_name_required' using errcode = '22023'; end if;
  if p_status is not null and p_status not in ('eats','avoid') then
    raise exception 'bad_food_membership_status' using errcode = '22023';
  end if;
  if p_rev is null or p_rev < 0 then
    raise exception 'bad_food_membership_rev' using errcode = '22023';
  end if;

  -- Her own refs are never displaced by catalog duplicates.
  select coalesce(array_agg(fr.id order by fr.id), '{}'::uuid[]) into v_user_refs
    from food_refs fr
    join user_foods uf on fr.kind = 'user' and uf.id = fr.user_food_id
   where uf.user_id = p_user and uf.deleted_at is null
     and food_name_norm(uf.name) = v_name;

  select count(*) into v_catalog_count
    from food_refs fr
    join catalog_food_revisions cr
      on fr.kind = 'catalog' and cr.catalog_food_id = fr.catalog_food_id and cr.is_active
   where food_name_norm(cr.description) = v_name;

  v_catalog_limit := greatest(50 - cardinality(v_user_refs), 0);
  select coalesce(
      array_agg(ranked.id order by ranked.last_used desc nulls last, ranked.id),
      '{}'::uuid[]
    ) into v_catalog_refs
    from (
      select fr.id, pref.updated_at as last_used
        from food_refs fr
        join catalog_food_revisions cr
          on fr.kind = 'catalog' and cr.catalog_food_id = fr.catalog_food_id and cr.is_active
        left join user_food_prefs pref
          on pref.user_id = p_user and pref.food_ref_id = fr.id
       where food_name_norm(cr.description) = v_name
       order by pref.updated_at desc nulls last, fr.id
       limit v_catalog_limit
    ) ranked;

  v_refs := v_user_refs || v_catalog_refs;
  v_truncated := v_catalog_count > cardinality(v_catalog_refs);

  if p_status is null then
    with accepted as (
      insert into food_membership_revisions as membership
        (user_id, name_norm, status, note, rev, updated_at)
      values (p_user, v_name, null, p_note, p_rev, now())
      on conflict (user_id, name_norm) do update
        set status = null, note = coalesce(excluded.note, membership.note),
            rev = excluded.rev, updated_at = now()
        where membership.rev < excluded.rev
      returning rev
    ), kept_note as (
      update user_foods uf set note = coalesce(
        p_note,
        uf.note,
        (select pref.note from user_food_prefs pref
          where pref.user_id = p_user and pref.food_ref_id = any(v_refs) and pref.note is not null
          order by pref.updated_at desc limit 1)
      )
       where exists (select 1 from accepted)
         and uf.user_id = p_user and uf.deleted_at is null and food_name_norm(uf.name) = v_name
      returning uf.id
    ), deleted as (
      delete from user_food_prefs pref
       where exists (select 1 from accepted) and pref.user_id = p_user
         and pref.food_ref_id = any(v_refs)
      returning pref.food_ref_id
    )
    select jsonb_build_object('rev', membership.rev, 'status', membership.status,
                              'updated', (select count(*) from deleted),
                              'truncated', v_truncated,
                              'notes_kept', (select count(*) from kept_note))
      into v_result
      from food_membership_revisions membership
     where membership.user_id = p_user and membership.name_norm = v_name;
  else
    with accepted as (
      insert into food_membership_revisions as membership
        (user_id, name_norm, status, note, rev, updated_at)
      values (p_user, v_name, p_status, p_note, p_rev, now())
      on conflict (user_id, name_norm) do update
        set status = excluded.status, note = coalesce(excluded.note, membership.note),
            rev = excluded.rev, updated_at = now()
        where membership.rev < excluded.rev
      returning rev
    ), kept_note as (
      update user_foods uf set note = coalesce(p_note, uf.note)
       where p_note is not null and exists (select 1 from accepted)
         and uf.user_id = p_user and uf.deleted_at is null and food_name_norm(uf.name) = v_name
      returning uf.id
    ), upserted as (
      insert into user_food_prefs as pref
        (user_id, food_ref_id, status, note, rev, updated_at)
      select p_user, ref_id, p_status, p_note, 1, now()
        from unnest(v_refs) ref_id where exists (select 1 from accepted)
      on conflict (user_id, food_ref_id) do update
        set status = excluded.status, note = coalesce(excluded.note, pref.note),
            rev = pref.rev + 1, updated_at = now()
      returning pref.food_ref_id
    )
    select jsonb_build_object('rev', membership.rev, 'status', membership.status,
                              'updated', (select count(*) from upserted),
                              'truncated', v_truncated,
                              'notes_kept', (select count(*) from kept_note))
      into v_result
      from food_membership_revisions membership
     where membership.user_id = p_user and membership.name_norm = v_name;
  end if;
  return v_result;
end; $$;
revoke execute on function set_food_membership(uuid, text, text, text, bigint) from public, anon;
grant execute on function set_food_membership(uuid, text, text, text, bigint)
  to authenticated, service_role;

drop function if exists save_food_note(uuid, uuid, uuid, integer, text, text);
drop table food_note_authority;
commit;
