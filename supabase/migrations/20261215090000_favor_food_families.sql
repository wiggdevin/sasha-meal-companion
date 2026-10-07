-- Phase 18 D6, POST /api/foods/favor (Sol re-plan after round 2, Option A).
--
-- `set_food_membership` selects a name family's refs again when it writes, so a server that judged
-- one set and then called it could mark refs it never judged (a milk-blocked "Bananas, creamy"
-- beside an allowed "Bananas"), and a rule change could land between the check and the write.
-- Favor now checks and writes ONE captured ref set per family, in one transaction:
--
-- * food_membership_revisions.favor_rev (nullable): the rev a Favor write set. While
--   favor_rev = rev, get_or_create_food_ref does not copy that `eats` mark onto a newly minted
--   ref of the family (it was never judged); any later membership write advances rev and restores
--   the ordinary backfill. Avoid always carries over.
-- * favor_family_sets(p_user, p_families): the exact refs set_food_membership would write for each
--   family (same normalization, owner filter, catalog ordering and 50-ref cap), read-only, owner-
--   scoped, at most 20 families.
-- * favor_food_families(...): the write. Family advisory locks (the set_food_membership key) in
--   sorted order, then the account rules-clock row FOR UPDATE and evidence_clock FOR SHARE, compared
--   with the versions the server captured BEFORE its taste and policy reads. Then, before any write:
--   a changed ref set, an Avoid on the key family or on any selected ref or family, or a selected
--   ref outside the judged allowed ids rejects the whole call. Only then are the captured ids
--   written, all or nothing. Returns the families favored.
--
-- Both functions are service_role only: the server calls them with the session user's id
-- (lib/server/favor-plan.ts). set_food_membership is unchanged.
-- Live-safe: one nullable column (no rewrite) and function definitions.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.food_membership_revisions add column if not exists favor_rev bigint;

-- The refs set_food_membership(p_user, p_name, ...) writes, sorted (its own selection, verbatim).
create or replace function public._favor_family_refs(p_user uuid, p_name text) returns uuid[]
  language plpgsql stable security definer set search_path = public as $$
declare
  v_name text := food_name_norm(p_name);
  v_user_refs uuid[];
  v_catalog_refs uuid[];
begin
  if v_name = '' then return '{}'::uuid[]; end if;
  select coalesce(array_agg(fr.id order by fr.id), '{}'::uuid[]) into v_user_refs
    from food_refs fr
    join user_foods uf on fr.kind = 'user' and uf.id = fr.user_food_id
   where uf.user_id = p_user and uf.deleted_at is null
     and food_name_norm(uf.name) = v_name;
  select coalesce(array_agg(ranked.id), '{}'::uuid[]) into v_catalog_refs
    from (
      select fr.id
        from food_refs fr
        join catalog_food_revisions cr
          on fr.kind = 'catalog' and cr.catalog_food_id = fr.catalog_food_id and cr.is_active
        left join user_food_prefs pref
          on pref.user_id = p_user and pref.food_ref_id = fr.id
       where food_name_norm(cr.description) = v_name
       order by pref.updated_at desc nulls last, fr.id
       limit greatest(50 - cardinality(v_user_refs), 0)
    ) ranked;
  return (select coalesce(array_agg(ref_id order by ref_id), '{}'::uuid[])
            from unnest(v_user_refs || v_catalog_refs) ref_id);
end $$;
revoke all on function public._favor_family_refs(uuid, text) from public, anon, authenticated;

-- Whether any of the account's Avoid prefs names this family (any member, past the 50-ref cap too).
create or replace function public._favor_family_avoided(p_user uuid, p_name text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_food_prefs pref
      join food_refs fr on fr.id = pref.food_ref_id
      left join user_foods uf on fr.kind = 'user' and uf.id = fr.user_food_id and uf.user_id = p_user
      left join catalog_food_revisions cr
        on fr.kind = 'catalog' and cr.catalog_food_id = fr.catalog_food_id and cr.is_active
     where pref.user_id = p_user and pref.status = 'avoid'
       and food_name_norm(coalesce(uf.name, cr.description)) = food_name_norm(p_name))
    or exists (
    select 1 from food_membership_revisions membership
     where membership.user_id = p_user and membership.name_norm = food_name_norm(p_name)
       and membership.status = 'avoid');
$$;
revoke all on function public._favor_family_avoided(uuid, text) from public, anon, authenticated;

create or replace function public.favor_family_sets(p_user uuid, p_families text[]) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  perform _sync_assert_caller(p_user);
  if p_families is null or cardinality(p_families) > 20 then
    raise exception 'bad_favor_families' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', family, 'name_norm', food_name_norm(family),
             'ref_ids', to_jsonb(_favor_family_refs(p_user, family))) order by family)
      from (select distinct family from unnest(p_families) family) families
     where food_name_norm(family) <> ''), '[]'::jsonb);
end $$;
revoke all on function public.favor_family_sets(uuid, text[]) from public, anon, authenticated;
grant execute on function public.favor_family_sets(uuid, text[]) to service_role;

create or replace function public.favor_food_families(p_user uuid, p_key_family text, p_families jsonb,
  p_allowed uuid[], p_rules_rev bigint, p_evidence_rev bigint) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_key text := food_name_norm(coalesce(p_key_family, ''));
  v_sets jsonb := '{}'::jsonb;
  v_family jsonb;
  v_name text;
  v_names text[];
  v_expected uuid[];
  v_current uuid[];
  v_status text;
  v_rules bigint;
  v_evidence bigint;
  v_write text[] := '{}';
  v_favored text[] := '{}';
  v_note text;
  v_auth boolean;
begin
  perform _sync_assert_caller(p_user);
  if p_families is null or jsonb_typeof(p_families) <> 'array' or jsonb_array_length(p_families) = 0
     or jsonb_array_length(p_families) > 20 or p_allowed is null or cardinality(p_allowed) > 1000
     or array_position(p_allowed, null) is not null
     or p_rules_rev is null or p_evidence_rev is null then
    raise exception 'bad_favor_request' using errcode = '22023';
  end if;
  for v_family in select value from jsonb_array_elements(p_families) loop
    v_name := food_name_norm(v_family->>'name_norm');
    if v_name = '' or v_sets ? v_name or jsonb_typeof(v_family->'ref_ids') <> 'array' then
      raise exception 'bad_favor_request' using errcode = '22023';
    end if;
    v_sets := v_sets || jsonb_build_object(v_name, v_family->'ref_ids');
  end loop;

  -- Locks: every family (and the key family) in sorted order, then the two clocks.
  select array_agg(name order by name) into v_names
    from (select jsonb_object_keys(v_sets) as name union select v_key where v_key <> '') names;
  foreach v_name in array v_names loop
    perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':food-note:' || v_name, 0));
  end loop;
  insert into account_rules_clock (user_id, rules_rev) values (p_user, 0) on conflict (user_id) do nothing;
  select rules_rev into v_rules from account_rules_clock where user_id = p_user for update;
  select evidence_rev into v_evidence from evidence_clock where id = 1 for share;
  if v_rules is distinct from p_rules_rev or v_evidence is distinct from p_evidence_rev then
    return jsonb_build_object('status', 'rules_changed', 'rules_rev', v_rules, 'evidence_rev', v_evidence);
  end if;

  -- Preflight every family before writing any.
  if v_key <> '' and _favor_family_avoided(p_user, v_key) then
    return jsonb_build_object('status', 'avoid', 'family', v_key);
  end if;
  foreach v_name in array (select array_agg(name order by name) from jsonb_object_keys(v_sets) name) loop
    select coalesce(array_agg(ref_id::uuid order by ref_id::uuid), '{}'::uuid[]) into v_expected
      from jsonb_array_elements_text(v_sets->v_name) ref_id;
    v_current := _favor_family_refs(p_user, v_name);
    if cardinality(v_current) = 0 or v_current is distinct from v_expected then
      return jsonb_build_object('status', 'set_changed', 'family', v_name);
    end if;
    if _favor_family_avoided(p_user, v_name) or exists (select 1 from user_food_prefs pref
        where pref.user_id = p_user and pref.status = 'avoid' and pref.food_ref_id = any(v_current)) then
      return jsonb_build_object('status', 'avoid', 'family', v_name);
    end if;
    if exists (select 1 from unnest(v_current) ref_id where (ref_id = any(p_allowed)) is not true) then
      return jsonb_build_object('status', 'not_allowed', 'family', v_name);
    end if;
    select membership.status into v_status from food_membership_revisions membership
     where membership.user_id = p_user and membership.name_norm = v_name;
    if v_status = 'eats' then v_favored := v_favored || v_name; else v_write := v_write || v_name; end if;
  end loop;

  -- Write the captured ids, exactly as set_food_membership writes an `eats` mark.
  foreach v_name in array v_write loop
    v_auth := false;
    v_note := null;
    select true, authority.note into v_auth, v_note
      from food_note_authority authority where authority.user_id = p_user and authority.name_norm = v_name;
    v_auth := coalesce(v_auth, false);
    if not v_auth then v_note := null; end if;
    insert into food_membership_revisions as membership
      (user_id, name_norm, status, note, rev, favor_rev, updated_at)
    values (p_user, v_name, 'eats', v_note, 1, 1, now())
    on conflict (user_id, name_norm) do update
      set status = 'eats',
          note = case when v_auth then v_note else membership.note end,
          rev = membership.rev + 1, favor_rev = membership.rev + 1, updated_at = now();
    insert into user_food_prefs as pref (user_id, food_ref_id, status, note, rev, updated_at)
    select p_user, ref_id::uuid, 'eats', v_note, 1, now() from jsonb_array_elements_text(v_sets->v_name) ref_id
    on conflict (user_id, food_ref_id) do update
      set status = 'eats',
          note = case when v_auth then v_note else coalesce(excluded.note, pref.note) end,
          rev = pref.rev + 1, updated_at = now();
    v_favored := v_favored || v_name;
  end loop;
  return jsonb_build_object('status', 'ok', 'favored', to_jsonb(v_favored), 'written', to_jsonb(v_write));
end $$;
revoke all on function public.favor_food_families(uuid, text, jsonb, uuid[], bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.favor_food_families(uuid, text, jsonb, uuid[], bigint, bigint) to service_role;

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
      v_rev bigint;
      v_favor_rev bigint;
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
        select membership.status, membership.note, membership.rev, membership.favor_rev
          into v_status, v_note, v_rev, v_favor_rev
          from food_membership_revisions membership
         where membership.user_id = p_user_id and membership.name_norm = v_name
         order by membership.updated_at desc limit 1;
        -- A Favor mark (favor_rev = rev) covers only the refs judged when it was written: a ref
        -- minted later is not judged, so it does not inherit `eats`. Avoid always carries over,
        -- and any later membership write moves rev past favor_rev and restores the backfill.
        if v_status is not null and not (v_status = 'eats' and v_favor_rev is not distinct from v_rev) then
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
