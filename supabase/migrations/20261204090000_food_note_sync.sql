-- A04: edit an account-owned food's note without replaying Eats/Avoid. Every food shown in My
-- Foods has a user_foods row, including adopted catalog food. NULL is an explicit clear here.
-- The selected row revision protects against a delayed edit overwriting a newer one.
-- Once a note is explicitly edited, old queued membership operations may still carry stale
-- non-NULL notes. This marker lets the membership RPC ignore them without changing its API.
create table food_note_authority (
  user_id uuid not null references auth.users(id) on delete cascade,
  name_norm text not null,
  note text,
  updated_at timestamptz not null default now(),
  primary key (user_id, name_norm)
);
alter table food_note_authority enable row level security;
revoke all on table food_note_authority from public, anon, authenticated;

create function save_food_note(p_user uuid, p_food_id uuid, p_food_ref_id uuid,
                               p_base_rev integer, p_expected_note text, p_note text)
  returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_note text := nullif(btrim(p_note), '');
  v_name text;
  v_locked_name text;
  v_current_rev integer;
  v_current_note text;
  v_ref_kind text;
  v_ref_user_food_id uuid;
  v_ref_catalog_food_id bigint;
  v_food record;
  v_pref record;
  v_food_count integer := 0;
  v_pref_count integer := 0;
begin
  perform _sync_assert_caller(p_user);
  if p_base_rev is null or p_base_rev < 0 then
    raise exception 'bad_food_revision' using errcode = '22023';
  end if;
  if (p_food_id is null) = (p_food_ref_id is null) then
    raise exception 'one_food_target_required' using errcode = '22023';
  end if;
  if length(v_note) > 2000 then raise exception 'food_note_too_long' using errcode = '22001'; end if;
  -- Derive the lock key before locking any row. The status RPC takes the same lock before
  -- reading the marker, so a status write cannot race an explicit clear or edit.
  if p_food_id is not null then
    select food_name_norm(uf.name) into v_name from user_foods uf
     where uf.id = p_food_id and uf.user_id = p_user and uf.deleted_at is null;
  else
    select food_name_norm(case when fr.kind = 'user' then uf.name else cr.description end)
      into v_name from user_food_prefs pref
      join food_refs fr on fr.id = pref.food_ref_id
      left join user_foods uf on fr.kind = 'user' and uf.id = fr.user_food_id
        and uf.user_id = p_user and uf.deleted_at is null
      left join catalog_food_revisions cr on fr.kind = 'catalog'
        and cr.catalog_food_id = fr.catalog_food_id and cr.is_active
     where pref.user_id = p_user and pref.food_ref_id = p_food_ref_id limit 1;
  end if;
  if v_name is null or v_name = '' then
    raise exception 'food_not_found' using errcode = '22023';
  end if;
  v_locked_name := v_name;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':food-note:' || v_name, 0));
  if p_food_id is not null then
    select food_name_norm(uf.name), uf.rev, uf.note
      into v_name, v_current_rev, v_current_note
      from user_foods uf
     where uf.id = p_food_id and uf.user_id = p_user and uf.deleted_at is null
     for update;
    if not found then raise exception 'food_not_found' using errcode = '22023'; end if;
  else
    select pref.rev, pref.note, fr.kind, fr.user_food_id, fr.catalog_food_id
      into v_current_rev, v_current_note, v_ref_kind, v_ref_user_food_id, v_ref_catalog_food_id
      from user_food_prefs pref join food_refs fr on fr.id = pref.food_ref_id
     where pref.user_id = p_user and pref.food_ref_id = p_food_ref_id
     for update of pref;
    if not found then raise exception 'food_not_found' using errcode = '22023'; end if;
    if v_ref_kind = 'user' then
      select food_name_norm(uf.name) into v_name from user_foods uf
       where uf.id = v_ref_user_food_id and uf.user_id = p_user and uf.deleted_at is null;
    else
      select food_name_norm(cr.description) into v_name from catalog_food_revisions cr
       where cr.catalog_food_id = v_ref_catalog_food_id and cr.is_active limit 1;
    end if;
    if v_name is null then raise exception 'food_not_found' using errcode = '22023'; end if;
  end if;
  if v_name <> v_locked_name then raise exception 'note_conflict' using errcode = '40001'; end if;
  if (v_current_rev <> p_base_rev
      or v_current_note is distinct from nullif(btrim(p_expected_note), ''))
      and v_current_note is distinct from v_note then
    raise exception 'note_conflict' using errcode = '40001';
  end if;

  insert into food_note_authority (user_id, name_norm, note)
  values (p_user, v_name, v_note)
  on conflict (user_id, name_norm) do update
    set note = excluded.note, updated_at = now();

  -- Never mint a membership revision just to save a note. An existing status keeps its rev.
  update food_membership_revisions
     set note = v_note, updated_at = now()
   where user_id = p_user and name_norm = v_name and note is distinct from v_note;

  for v_food in
    update user_foods uf set note = v_note, rev = uf.rev + 1
     where uf.user_id = p_user and uf.deleted_at is null
       and food_name_norm(uf.name) = v_name and uf.note is distinct from v_note
     returning uf.id, uf.rev, to_jsonb(uf) as current
  loop
    insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
    values (p_user, next_change_seq(p_user), 'user_foods', v_food.id::text,
            v_food.rev, 'update', gen_random_uuid(), v_food.current);
    v_food_count := v_food_count + 1;
  end loop;

  for v_pref in
    update user_food_prefs pref set note = v_note, rev = pref.rev + 1, updated_at = now()
     where pref.user_id = p_user and pref.note is distinct from v_note
       and exists (
         select 1 from food_refs fr
         left join user_foods uf on fr.kind = 'user' and uf.id = fr.user_food_id
         left join catalog_food_revisions cr on fr.kind = 'catalog'
           and cr.catalog_food_id = fr.catalog_food_id and cr.is_active
          where fr.id = pref.food_ref_id and (
            (fr.kind = 'user' and uf.user_id = p_user and uf.deleted_at is null
             and food_name_norm(uf.name) = v_name)
            or (fr.kind = 'catalog' and food_name_norm(cr.description) = v_name))
       )
     returning pref.food_ref_id, pref.rev, to_jsonb(pref) as current
  loop
    insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
    values (p_user, next_change_seq(p_user), 'user_food_prefs', v_pref.food_ref_id::text,
            v_pref.rev, 'update', gen_random_uuid(), v_pref.current);
    v_pref_count := v_pref_count + 1;
  end loop;

  return jsonb_build_object('food_rows', v_food_count, 'pref_rows', v_pref_count);
end; $$;
revoke execute on function save_food_note(uuid, uuid, uuid, integer, text, text) from public, anon;
grant execute on function save_food_note(uuid, uuid, uuid, integer, text, text) to authenticated, service_role;


-- Preserve the original status behavior until a note has explicit authority. Once it has,
-- old queued five-argument status writes may change membership but cannot restore stale notes.
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
  v_note text;
  v_note_authoritative boolean;
begin
  perform _sync_assert_caller(p_user);
  if v_name = '' then raise exception 'food_name_required' using errcode = '22023'; end if;
  if p_status is not null and p_status not in ('eats','avoid') then
    raise exception 'bad_food_membership_status' using errcode = '22023';
  end if;
  if p_rev is null or p_rev < 0 then
    raise exception 'bad_food_membership_rev' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':food-note:' || v_name, 0));
  select true, authority.note into v_note_authoritative, v_note
    from food_note_authority authority
   where authority.user_id = p_user and authority.name_norm = v_name;
  if not coalesce(v_note_authoritative, false) then v_note := p_note; end if;

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
      values (p_user, v_name, null, v_note, p_rev, now())
      on conflict (user_id, name_norm) do update
        set status = null,
            note = case when v_note_authoritative then v_note
                        else coalesce(excluded.note, membership.note) end,
            rev = excluded.rev, updated_at = now()
        where membership.rev < excluded.rev
      returning rev
    ), kept_note as (
      update user_foods uf set note = case when v_note_authoritative then v_note else coalesce(
        v_note,
        uf.note,
        (select pref.note from user_food_prefs pref
          where pref.user_id = p_user and pref.food_ref_id = any(v_refs) and pref.note is not null
          order by pref.updated_at desc limit 1)
      ) end
       where not coalesce(v_note_authoritative, false)
         and exists (select 1 from accepted)
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
      values (p_user, v_name, p_status, v_note, p_rev, now())
      on conflict (user_id, name_norm) do update
        set status = excluded.status,
            note = case when v_note_authoritative then v_note
                        else coalesce(excluded.note, membership.note) end,
            rev = excluded.rev, updated_at = now()
        where membership.rev < excluded.rev
      returning rev
    ), kept_note as (
      update user_foods uf set note = case when v_note_authoritative then v_note
        else coalesce(v_note, uf.note) end
       where not coalesce(v_note_authoritative, false) and v_note is not null
         and exists (select 1 from accepted)
         and uf.user_id = p_user and uf.deleted_at is null and food_name_norm(uf.name) = v_name
      returning uf.id
    ), upserted as (
      insert into user_food_prefs as pref
        (user_id, food_ref_id, status, note, rev, updated_at)
      select p_user, ref_id, p_status, v_note, 1, now()
        from unnest(v_refs) ref_id where exists (select 1 from accepted)
      on conflict (user_id, food_ref_id) do update
        set status = excluded.status,
            note = case when v_note_authoritative then v_note
                        else coalesce(excluded.note, pref.note) end,
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
