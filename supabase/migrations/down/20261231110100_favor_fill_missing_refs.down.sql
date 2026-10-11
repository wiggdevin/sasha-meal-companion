-- Reverse of 20261231110100_favor_fill_missing_refs.sql: restores the 20261215090000 body of
-- favor_food_families (a family marked `eats` is favored with no write).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

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
