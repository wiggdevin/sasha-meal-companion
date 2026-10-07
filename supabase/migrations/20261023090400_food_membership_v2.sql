-- U3 fix pass 2: never reject wide normalized-name families, and audit partial marks.

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

drop function if exists food_membership_contradictions(uuid);
create function food_membership_contradictions(p_user uuid)
returns table (user_id uuid, name_norm text, row_count bigint, ref_ids uuid[], kind text,
               eats_updated_at timestamptz, avoid_updated_at timestamptz)
  language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null then perform _sync_assert_caller(p_user); end if;
  return query
    with marked_families as (
      select distinct pref.user_id,
             food_name_norm(case when fr.kind = 'user' then uf.name else cr.description end) as name_norm
        from user_food_prefs pref
        join food_refs fr on fr.id = pref.food_ref_id
        left join user_foods uf on fr.kind = 'user' and uf.id = fr.user_food_id
                               and uf.user_id = pref.user_id and uf.deleted_at is null
        left join catalog_food_revisions cr
          on fr.kind = 'catalog' and cr.catalog_food_id = fr.catalog_food_id and cr.is_active
       where (p_user is null or pref.user_id = p_user)
    ), family_refs as (
      select family.user_id, family.name_norm, fr.id as food_ref_id,
             pref.status, pref.updated_at
        from marked_families family
        join food_refs fr on (
          (fr.kind = 'user' and exists (
            select 1 from user_foods uf
             where uf.id = fr.user_food_id and uf.user_id = family.user_id
               and uf.deleted_at is null and food_name_norm(uf.name) = family.name_norm
          )) or
          (fr.kind = 'catalog' and exists (
            select 1 from catalog_food_revisions cr
             where cr.catalog_food_id = fr.catalog_food_id and cr.is_active
               and food_name_norm(cr.description) = family.name_norm
          ))
        )
        left join user_food_prefs pref
          on pref.user_id = family.user_id and pref.food_ref_id = fr.id
       where family.name_norm <> ''
    )
    select family_refs.user_id, family_refs.name_norm, count(*)::bigint,
           array_agg(family_refs.food_ref_id order by family_refs.food_ref_id),
           case when count(distinct family_refs.status) > 1 then 'conflict' else 'partial' end,
           max(family_refs.updated_at) filter (where family_refs.status = 'eats'),
           max(family_refs.updated_at) filter (where family_refs.status = 'avoid')
      from family_refs
     group by family_refs.user_id, family_refs.name_norm
    having count(distinct family_refs.status) > 1
        or (count(family_refs.status) > 0 and count(family_refs.status) < count(*))
     order by family_refs.user_id, family_refs.name_norm;
end; $$;
revoke execute on function food_membership_contradictions(uuid) from public, anon;
grant execute on function food_membership_contradictions(uuid) to authenticated, service_role;
