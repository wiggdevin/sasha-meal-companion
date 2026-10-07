-- Phase 0 RPCs. Every function: security definer, search_path pinned to public, execute revoked
-- from public and anon. The first argument is always p_user_id (except lookup_api_token, which
-- resolves the tenant from the token hash and is service_role only).

-- A definer function called over PostgREST still sees the caller's JWT claims, so a signed-in
-- user cannot pass someone else's p_user_id. The privileged boundary calls as service_role,
-- where auth.uid() is null and p_user_id is authoritative.
create function _sync_assert_caller(p_user_id uuid) returns void
  language plpgsql stable security definer set search_path = public as $$
declare v_caller uuid := auth.uid();
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if v_caller is not null and v_caller <> p_user_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end; $$;
revoke execute on function _sync_assert_caller(uuid) from public, anon;

create function get_or_create_food_ref(p_user_id uuid, p_kind text,
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

create function revoke_api_token(p_user_id uuid, p_token_id uuid) returns boolean
  language plpgsql security definer set search_path = public as $$
begin
  perform _sync_assert_caller(p_user_id);
  update api_tokens set revoked_at = now()
    where id = p_token_id and user_id = p_user_id and revoked_at is null;
  return found;
end; $$;
revoke execute on function revoke_api_token(uuid, uuid) from public, anon;
grant execute on function revoke_api_token(uuid, uuid) to authenticated, service_role;

-- Not granted to `authenticated`: it maps a token hash to a tenant, which is the privileged
-- boundary's business only. Contracts §2's blanket grant is deliberately narrowed here.
create function lookup_api_token(p_token_hash bytea)
  returns table (id uuid, user_id uuid, scopes text[])
  language plpgsql security definer set search_path = public as $$
begin
  -- RETURN QUERY takes a SELECT, so the update is wrapped in a CTE.
  return query
    with touched as (
      update api_tokens t set last_used_at = now()
        where t.token_hash = p_token_hash
          and t.revoked_at is null
          and (t.expires_at is null or t.expires_at > now())
        returning t.id, t.user_id, t.scopes)
    select touched.id, touched.user_id, touched.scopes from touched;
end; $$;
revoke execute on function lookup_api_token(bytea) from public, anon, authenticated;
grant execute on function lookup_api_token(bytea) to service_role;

-- entity_key encoding, contracts §4. These strings must match lib/sync/keys.ts exactly.
--   user_foods | log_entries | gut_log | duplicate_groups | user_food_prefs -> lowercase uuid
--   plan_days | water_log                                                   -> YYYY-MM-DD
--   user_settings                                                           -> 'settings'
create function _sync_assert_key(p_entity text, p_key text) returns void
  language plpgsql immutable as $$
begin
  if p_key is null then raise exception 'entity_key_required' using errcode = '22023'; end if;
  if p_entity in ('user_foods','log_entries','gut_log','duplicate_groups','user_food_prefs') then
    if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity in ('plan_days','water_log') then
    if p_key !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity = 'user_settings' then
    if p_key <> 'settings' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  else
    raise exception 'unknown_entity' using errcode = '22023';
  end if;
end; $$;
revoke execute on function _sync_assert_key(text, text) from public, anon;

create function _sync_current(p_user_id uuid, p_entity text, p_key text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    select to_jsonb(t) into v from user_foods t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'user_food_prefs' then
    select to_jsonb(t) into v from user_food_prefs t
      where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
  elsif p_entity = 'log_entries' then
    select to_jsonb(e) || jsonb_build_object('items', coalesce(
             (select jsonb_agg(to_jsonb(i) order by i.seq) from log_items i where i.entry_id = e.id),
             '[]'::jsonb))
      into v from log_entries e where e.user_id = p_user_id and e.id = p_key::uuid;
  elsif p_entity = 'water_log' then
    select to_jsonb(t) into v from water_log t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'plan_days' then
    select to_jsonb(t) into v from plan_days t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'user_settings' then
    select to_jsonb(t) into v from user_settings t where t.user_id = p_user_id;
  elsif p_entity = 'gut_log' then
    select to_jsonb(t) into v from gut_log t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'duplicate_groups' then
    select to_jsonb(t) || jsonb_build_object('fingerprint', encode(t.fingerprint, 'hex'))
      into v from duplicate_groups t where t.user_id = p_user_id and t.id = p_key::uuid;
  end if;
  return v;
end; $$;
revoke execute on function _sync_current(uuid, text, text) from public, anon;

-- Insert-or-update one synced row. apply_sync_op has already decided create vs update, so a
-- single upsert per entity keeps the write path to one statement.
--
-- entity_key is client-generated and caller-supplied, so an id can collide with a row another
-- user already owns. Every ON CONFLICT DO UPDATE below is guarded by `where <table>.user_id =
-- p_user_id`: when the conflicting row belongs to someone else, the guard fails, Postgres treats
-- the upsert as DO NOTHING, and the other user's row is left untouched instead of overwritten.
-- No caller check (_sync_assert_caller) here: p_user_id is trusted from the caller, deferred to
-- apply_sync_op, which authenticates it before calling this function.
create function _sync_upsert(p_user_id uuid, p_entity text, p_key text,
                             p_payload jsonb, p_rev integer) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    insert into user_foods (id, user_id, name, brand, ingredients_text, catalog_food_id, kind,
                            per_100g, allergen_tags, rev, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'name', p_payload->>'brand',
            p_payload->>'ingredients_text', (p_payload->>'catalog_food_id')::bigint,
            coalesce(p_payload->>'kind', 'custom'),
            coalesce(p_payload->'per_100g', '{}'::jsonb),
            coalesce(array(select jsonb_array_elements_text(p_payload->'allergen_tags')), '{}'::text[]),
            p_rev, null)
    on conflict (id) do update set name = excluded.name, brand = excluded.brand,
      ingredients_text = excluded.ingredients_text, catalog_food_id = excluded.catalog_food_id,
      kind = excluded.kind, per_100g = excluded.per_100g, allergen_tags = excluded.allergen_tags,
      rev = excluded.rev
      where user_foods.user_id = p_user_id;
  elsif p_entity = 'user_food_prefs' then
    insert into user_food_prefs (user_id, food_ref_id, status, role, no_cook, note, rev, updated_at)
    values (p_user_id, p_key::uuid, p_payload->>'status', p_payload->>'role',
            coalesce((p_payload->>'no_cook')::boolean, false), p_payload->>'note', p_rev, now())
    on conflict (user_id, food_ref_id) do update set status = excluded.status,
      role = excluded.role, no_cook = excluded.no_cook, note = excluded.note,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'log_entries' then
    insert into log_entries (id, user_id, note, media_ref, eaten_at, tz, local_date, slot, method,
                             rev, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'note', p_payload->>'media_ref',
            (p_payload->>'eaten_at')::timestamptz, p_payload->>'tz',
            (p_payload->>'local_date')::date, p_payload->>'slot', p_payload->>'method', p_rev, null)
    on conflict (id) do update set note = excluded.note, media_ref = excluded.media_ref,
      eaten_at = excluded.eaten_at, tz = excluded.tz, local_date = excluded.local_date,
      slot = excluded.slot, method = excluded.method, rev = excluded.rev
      where log_entries.user_id = p_user_id;
    -- log_items are only touched when p_key resolves to a row p_user_id actually owns — otherwise
    -- the conflicting entry belongs to someone else (the update above was a no-op) and this must
    -- not delete or insert their items.
    if exists (select 1 from log_entries e where e.id = p_key::uuid and e.user_id = p_user_id) then
      delete from log_items where entry_id = p_key::uuid;
      insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot,
                             food_revision_id, portion_id, was_edited, confidence)
      select coalesce(i.id, gen_random_uuid()), p_key::uuid, i.seq, i.qty, i.unit, i.food_ref_id,
             i.grams, coalesce(i.snapshot, '{}'::jsonb), i.food_revision_id, i.portion_id,
             coalesce(i.was_edited, false), i.confidence
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric);
    end if;
  elsif p_entity = 'water_log' then
    insert into water_log (user_id, local_date, cups, rev)
    values (p_user_id, p_key::date, coalesce((p_payload->>'cups')::integer, 0), p_rev)
    on conflict (user_id, local_date) do update set cups = excluded.cups, rev = excluded.rev;
  elsif p_entity = 'plan_days' then
    insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                           rev, updated_at)
    values (p_user_id, p_key::date, p_payload->>'day_type_override',
            coalesce((p_payload->>'floor_day')::boolean, false),
            coalesce(p_payload->'swaps', '{}'::jsonb),
            coalesce(p_payload->'slot_notes', '{}'::jsonb), p_rev, now())
    on conflict (user_id, local_date) do update set day_type_override = excluded.day_type_override,
      floor_day = excluded.floor_day, swaps = excluded.swaps, slot_notes = excluded.slot_notes,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'user_settings' then
    insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                               rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                               shift_minutes, changed_at, rev)
    values (p_user_id, coalesce((p_payload->>'first_opened_at')::timestamptz, now()),
            coalesce((p_payload->>'scale_warning_dismissed')::boolean, false),
            (p_payload->>'training_kcal')::integer, (p_payload->>'rest_kcal')::integer,
            (p_payload->>'protein_g')::numeric,
            coalesce((p_payload->>'protein_locked')::boolean, true),
            (p_payload->>'ramp_override')::smallint,
            coalesce(p_payload->'slot_times', '{}'::jsonb),
            coalesce((p_payload->>'shift_minutes')::integer, 0),
            (p_payload->>'changed_at')::timestamptz, p_rev)
    on conflict (user_id) do update set first_opened_at = excluded.first_opened_at,
      scale_warning_dismissed = excluded.scale_warning_dismissed,
      training_kcal = excluded.training_kcal, rest_kcal = excluded.rest_kcal,
      protein_g = excluded.protein_g, protein_locked = excluded.protein_locked,
      ramp_override = excluded.ramp_override, slot_times = excluded.slot_times,
      shift_minutes = excluded.shift_minutes, changed_at = excluded.changed_at, rev = excluded.rev;
  elsif p_entity = 'gut_log' then
    insert into gut_log (id, user_id, local_date, tz, state, note, rev, deleted_at)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date, p_payload->>'tz',
            p_payload->>'state', p_payload->>'note', p_rev, null)
    on conflict (id) do update set local_date = excluded.local_date, tz = excluded.tz,
      state = excluded.state, note = excluded.note, rev = excluded.rev
      where gut_log.user_id = p_user_id;
  elsif p_entity = 'duplicate_groups' then
    insert into duplicate_groups (id, user_id, local_date, fingerprint, slot, state,
                                  merged_into_entry_id, decided_at, rev)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date,
            decode(p_payload->>'fingerprint', 'hex'), p_payload->>'slot',
            coalesce(p_payload->>'state', 'open'),
            (p_payload->>'merged_into_entry_id')::uuid,
            (p_payload->>'decided_at')::timestamptz, p_rev)
    on conflict (id) do update set local_date = excluded.local_date,
      fingerprint = excluded.fingerprint, slot = excluded.slot, state = excluded.state,
      merged_into_entry_id = excluded.merged_into_entry_id, decided_at = excluded.decided_at,
      rev = excluded.rev
      where duplicate_groups.user_id = p_user_id;
  end if;
  return _sync_current(p_user_id, p_entity, p_key);
end; $$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;

-- Delete and restore, for the three tombstone-capable entities only (contracts §2:
-- user_foods, log_entries, gut_log). apply_sync_op answers every other delete/restore shape
-- itself — 'unsupported' for an entity without deleted_at, an idempotent 'applied' no-op for a
-- restore of a row that was never tombstoned — so this function is never asked to guess, and
-- never raises.
--
-- No caller check (_sync_assert_caller) here either, matching _sync_upsert and _sync_current:
-- p_user_id is deferred to apply_sync_op, which authenticates it before calling this function.
create function _sync_tombstone(p_user_id uuid, p_entity text, p_key text,
                                p_kind text, p_rev integer) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare v_deleted_at timestamptz := case when p_kind = 'delete' then now() else null end;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    update user_foods set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'log_entries' then
    update log_entries set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'gut_log' then
    update gut_log set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  end if;
  return _sync_current(p_user_id, p_entity, p_key);
end; $$;
revoke execute on function _sync_tombstone(uuid, text, text, text, integer) from public, anon;

-- One op, one transaction, contracts §2. The caller (app/api/sync/ops/route.ts) issues one RPC
-- per op in array order; PostgREST wraps each call in its own transaction.
create function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_op_id   uuid    := (p_op->>'op_id')::uuid;
  v_entity  text    := p_op->>'entity';
  v_key     text    := p_op->>'entity_id';
  v_kind    text    := p_op->>'kind';
  v_base    integer := (p_op->>'base_rev')::integer;
  v_current jsonb;
  v_rev     integer;
  v_seq     bigint;
  v_after   jsonb;
begin
  perform _sync_assert_caller(p_user_id);
  if v_op_id is null then raise exception 'op_id_required' using errcode = '22023'; end if;
  if v_kind not in ('create','update','delete','restore') then
    raise exception 'bad_op_kind' using errcode = '22023';
  end if;
  perform _sync_assert_key(v_entity, v_key);

  -- contracts §2: only user_foods, log_entries and gut_log carry deleted_at. A delete or restore
  -- on any other entity is a client-shaped op this server cannot express. apply_sync_op NEVER
  -- raises for that — it answers 'unsupported' and writes nothing.
  if v_kind in ('delete', 'restore') and v_entity not in ('user_foods', 'log_entries', 'gut_log') then
    return jsonb_build_object('op_id', v_op_id, 'status', 'unsupported');
  end if;

  -- Compare-and-swap must be atomic across the read below and the write it gates: two callers
  -- racing the same (user, entity, entity_key) with the same base_rev would otherwise both read
  -- the same current rev, both pass the check, and the second write silently clobbers the first
  -- (no error, no conflict — the loser's caller sees 'applied' and never learns its write was
  -- overwritten). pg_advisory_xact_lock blocks until acquired and releases automatically at the
  -- end of this transaction (one op, one transaction, per the comment above), so the second
  -- concurrent call waits here, then re-reads the just-committed row and correctly sees a
  -- conflict (or, for a concurrent 'create', sees the row the first call just inserted).
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_entity || ':' || v_key, 0));

  -- The op_id duplicate check must run AFTER the lock, not before: two callers retrying the same
  -- op_id concurrently would otherwise both pass this check before either commits (contracts §2
  -- says an already-logged op_id answers 'duplicate' unconditionally), then serialize on the lock
  -- above. Checked only here, the loser re-reads a state that has already moved past its own
  -- base_rev/current check and answers 'conflict' instead of the contracted 'duplicate' for its
  -- own op — a retry gets fed a real-looking conflict for a write that already succeeded.
  if exists (select 1 from change_log where op_id = v_op_id) then
    return jsonb_build_object('op_id', v_op_id, 'status', 'duplicate');
  end if;

  v_current := _sync_current(p_user_id, v_entity, v_key);

  if v_kind = 'create' then
    if v_current is not null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);
    end if;
    v_rev := 1;
  else
    if v_current is null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'gone');
    end if;
    if v_current->>'deleted_at' is not null and v_kind <> 'restore' then
      return jsonb_build_object('op_id', v_op_id, 'status', 'deleted', 'entity', v_entity,
                                'deleted_at', v_current->>'deleted_at');
    end if;
    -- A restore on a row that was never tombstoned already satisfies the client's intent (this
    -- row is not deleted) — idempotent no-op, no change_log row, and NOT a new seq.
    if v_kind = 'restore' and v_current->>'deleted_at' is null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'applied',
        'rev', (v_current->>'rev')::integer,
        'seq', coalesce((select max(seq) from change_log
                           where user_id = p_user_id and entity = v_entity and entity_key = v_key), 0));
    end if;
    if v_base is null or v_base <> (v_current->>'rev')::integer then
      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);
    end if;
    v_rev := (v_current->>'rev')::integer + 1;
  end if;

  if v_kind in ('create','update') then
    v_after := _sync_upsert(p_user_id, v_entity, v_key, coalesce(p_op->'payload', '{}'::jsonb), v_rev);
  else
    v_after := _sync_tombstone(p_user_id, v_entity, v_key, v_kind, v_rev);
  end if;

  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, v_entity, v_key, v_rev, v_kind, v_op_id,
          case when v_kind = 'delete' then null else v_after end);

  return jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'rev', v_rev, 'seq', v_seq);
end; $$;
revoke execute on function apply_sync_op(uuid, jsonb) from public, anon;
grant execute on function apply_sync_op(uuid, jsonb) to authenticated, service_role;

create function sync_changes(p_user_id uuid, p_since bigint, p_limit integer)
  returns table (seq bigint, entity text, entity_key text, rev integer, op text,
                 at timestamptz, current jsonb)
  language plpgsql stable security definer set search_path = public as $$
begin
  perform _sync_assert_caller(p_user_id);
  return query
    select c.seq, c.entity, c.entity_key, c.rev, c.op, c.at, c.current
      from change_log c
     where c.user_id = p_user_id and c.seq > coalesce(p_since, 0)
     order by c.seq asc
     limit least(greatest(coalesce(p_limit, 500), 1), 500);
end; $$;
revoke execute on function sync_changes(uuid, bigint, integer) from public, anon;
grant execute on function sync_changes(uuid, bigint, integer) to authenticated, service_role;
