-- Down for 20261231200000_clock_lock_order: the function bodies as they were before W034
-- (20261128090000, 20261202090000, 20261215090000, 20261018090000, 20261231110100), then the two
-- lock helpers. This brings back the deadlock pairs of audit 2026-10-10 F23 (A096, A162, A163).
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create or replace function public.recipe_plan_bump_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  v_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  -- Cascading auth.users deletion fires child-row triggers after the parent
  -- disappears. Do not recreate an FK-backed state row for that retired user.
  if exists (select 1 from auth.users where id=v_user) then
    insert into public.recipe_plan_state(user_id, rev) values (v_user, 1)
      on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
  end if;
  if tg_op = 'UPDATE' then
    if old.user_id is distinct from new.user_id
      and exists (select 1 from auth.users where id=old.user_id) then
      insert into public.recipe_plan_state(user_id, rev) values (old.user_id, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.recipe_plan_bump_state() from public, anon, authenticated;

create or replace function public.recipe_plan_bump_global_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
  return null;
end $$;
revoke all on function public.recipe_plan_bump_global_state() from public, anon, authenticated;

create or replace function public.recipe_plan_bump_allergen_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_previous uuid; v_global boolean := false;
begin
  v_user := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if tg_op = 'UPDATE' then
    v_previous := old.user_id;
    v_global := v_previous is distinct from v_user
      and (v_previous is null or v_user is null);
  end if;
  if v_user is null or v_global then
    update public.recipe_plan_state set rev = rev + 1 where user_id is not null;
  else
    if exists (select 1 from auth.users where id=v_user) then
      insert into public.recipe_plan_state(user_id, rev) values (v_user, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
    if v_previous is not null and v_previous is distinct from v_user
      and exists (select 1 from auth.users where id=v_previous) then
      insert into public.recipe_plan_state(user_id, rev) values (v_previous, 1)
        on conflict (user_id) do update set rev = public.recipe_plan_state.rev + 1;
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.recipe_plan_bump_allergen_evidence() from public, anon, authenticated;

create or replace function public.recipe_plan_bump_food_ref_state() returns trigger
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

create or replace function catalog_write_provider_revision(
  p_user_id uuid, p_source text, p_gtin14 text, p_draft jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_label    text;
  v_ver_id   bigint;
  v_food_id  bigint;
  v_rev_id   bigint;
  v_desc     text;
  v_brand    text;
  v_category text;
  v_policy   text[];
  v_pub      timestamptz;
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
  if p_source not in ('off','fdc_branded') then
    raise exception 'bad_source' using errcode = '22023';
  end if;
  if p_gtin14 is null or p_gtin14 !~ '^[0-9]{14}$' then
    raise exception 'bad_gtin' using errcode = '22023';
  end if;
  if p_draft->'per100g' is null then raise exception 'bad_draft' using errcode = '22023'; end if;

  v_desc     := coalesce(nullif(trim(p_draft->>'description'), ''), 'Barcode ' || p_gtin14);
  v_brand    := nullif(trim(coalesce(p_draft->>'brand', '')), '');
  v_category := nullif(trim(coalesce(p_draft->>'category', '')), '');
  -- The mappers (lib/catalog/off-map.ts, fdc-map.ts) run policyCategoriesFor on every draft, so a
  -- draft that CARRIES the key is annotated and its '{}' means "clean". A draft that omits it has
  -- not been looked at — which is exactly what the OLD barcode writer sends in the window between
  -- these migrations landing in production and the app deploy that follows — and must be stored
  -- NULL so the read path keeps deriving for it. Anything else silently marks every scan in that
  -- window clean for ever.
  v_policy   := case when jsonb_typeof(p_draft->'policyCategories') = 'array'
                     then coalesce(
                            array(select jsonb_array_elements_text(p_draft->'policyCategories')),
                            '{}'::text[])
                     else null end;
  v_pub      := coalesce((p_draft->>'publishedAt')::timestamptz, now());
  v_label    := p_source || '-' || to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');

  insert into catalog_versions (source, version_label, is_active)
    values (p_source, v_label, false) on conflict (source, version_label) do nothing;
  select id into v_ver_id from catalog_versions
    where source = p_source and version_label = v_label;

  insert into catalog_foods (source, source_id) values (p_source, p_gtin14)
    on conflict (source, source_id) do nothing;
  select id into v_food_id from catalog_foods
    where source = p_source and source_id = p_gtin14;

  update catalog_food_revisions set is_active = false, valid_to = now()
   where catalog_food_id = v_food_id and is_active and catalog_version_id <> v_ver_id;

  insert into catalog_food_revisions (catalog_food_id, catalog_version_id, description, brand,
      category, policy_categories, quality_class, quality_flags, search_doc, content_hash,
      is_active, valid_from, valid_to)
  values (v_food_id, v_ver_id, v_desc, v_brand, v_category, v_policy,
      coalesce(p_draft->>'qualityClass', 'crowd'),
      coalesce(array(select jsonb_array_elements_text(p_draft->'qualityFlags')), '{}'::text[]),
      catalog_search_doc(v_desc, v_brand, v_category),
      encode(sha256(convert_to(p_draft::text, 'UTF8')), 'hex'), true, now(), null)
  on conflict (catalog_food_id, catalog_version_id) do update
    set description = excluded.description, brand = excluded.brand, category = excluded.category,
        policy_categories = excluded.policy_categories,
        quality_class = excluded.quality_class, quality_flags = excluded.quality_flags,
        search_doc = excluded.search_doc, content_hash = excluded.content_hash,
        is_active = true, valid_from = now(), valid_to = null
  returning id into v_rev_id;

  delete from catalog_food_nutrients where food_revision_id = v_rev_id;
  insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
  select v_rev_id, kv.key, nullif(kv.value, 'null'::jsonb)::numeric
    from jsonb_each(p_draft->'per100g') kv
   where exists (select 1 from catalog_nutrients c where c.code = kv.key);

  delete from catalog_portions where food_revision_id = v_rev_id;
  insert into catalog_portions (food_revision_id, description, gram_weight, seq, is_default)
  select v_rev_id, p.value->>'description', (p.value->>'gramWeight')::numeric,
         p.ord::int, p.ord = 1
    from jsonb_array_elements(coalesce(p_draft->'portions', '[]'::jsonb))
         with ordinality as p(value, ord);

  -- seq 1 carries the product's verbatim ingredients_text; later rows carry their own fragment
  -- in `name` and no raw_text. resolveBarcode reads BarcodeMatch.ingredientsText back from it.
  delete from catalog_ingredients where food_revision_id = v_rev_id;
  insert into catalog_ingredients (food_revision_id, seq, name, allergen_tags, raw_text)
  select v_rev_id, (i.value->>'seq')::int, i.value->>'name',
         coalesce(array(select jsonb_array_elements_text(i.value->'allergenTags')), '{}'::text[]),
         case when (i.value->>'seq')::int = 1 then p_draft->>'ingredientsText' else null end
    from jsonb_array_elements(coalesce(p_draft->'ingredients', '[]'::jsonb)) as i(value);

  insert into catalog_barcodes (gtin14, catalog_food_id, source, published_at)
       values (p_gtin14, v_food_id, p_source, v_pub)
  on conflict (gtin14, catalog_food_id, source) do update set published_at = excluded.published_at;

  perform get_or_create_food_ref(p_user_id, 'catalog', v_food_id, null);

  return jsonb_build_object('catalog_food_id', v_food_id, 'revision_id', v_rev_id,
                            'version_label', v_label);
end; $$;
revoke all on function catalog_write_provider_revision(uuid, text, text, jsonb) from public;
revoke all on function catalog_write_provider_revision(uuid, text, text, jsonb) from anon, authenticated;
grant execute on function catalog_write_provider_revision(uuid, text, text, jsonb) to service_role;

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
  v_fill text[] := '{}';
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
    -- Already favored only when every captured ref carries the mark (W029, A038): a ref minted
    -- after a Favor does not inherit `eats` (favor_rev = rev), so a second Favor fills it in.
    if v_status = 'eats' and not exists (select 1 from unnest(v_current) ref_id where not exists (
        select 1 from user_food_prefs pref where pref.user_id = p_user and pref.food_ref_id = ref_id
           and pref.status = 'eats')) then
      v_favored := v_favored || v_name;
    elsif v_status = 'eats' then
      v_fill := v_fill || v_name;
    else
      v_write := v_write || v_name;
    end if;
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
  -- A family already marked `eats`: only its captured refs with no pref get one, with the mark's
  -- note, as get_or_create_food_ref's backfill would. The mark's rev and favor_rev stay.
  foreach v_name in array v_fill loop
    insert into user_food_prefs (user_id, food_ref_id, status, note, rev, updated_at)
    select p_user, ref_id::uuid, 'eats', membership.note, 1, now()
      from jsonb_array_elements_text(v_sets->v_name) ref_id
      join food_membership_revisions membership
        on membership.user_id = p_user and membership.name_norm = v_name
    on conflict (user_id, food_ref_id) do nothing;
    v_favored := v_favored || v_name;
  end loop;
  return jsonb_build_object('status', 'ok', 'favored', to_jsonb(v_favored),
    'written', to_jsonb(v_write || v_fill));
end $$;
revoke all on function public.favor_food_families(uuid, text, jsonb, uuid[], bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.favor_food_families(uuid, text, jsonb, uuid[], bigint, bigint) to service_role;

drop function if exists public._clock_lock_rules(uuid);
drop function if exists public._clock_lock_evidence();
