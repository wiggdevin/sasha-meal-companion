-- W054 + W126, the transactional half (the indexes are 20270106090000, which cannot run in a
-- transaction). Two changes:
--
-- 1. W054: pg_trgm and unaccent move from public to the extensions schema (Supabase advisor
--    extension_in_public, docs/readiness/2026-10-17/README.md §3). ALTER EXTENSION ... SET SCHEMA
--    moves every member object by OID, so the trigram indexes keep their operator classes and need
--    no rebuild, and the unaccent dictionary moves beside unaccent(), where the one-argument form
--    looks for it. catalog_expand_query and catalog_search already carry `extensions` in their
--    search_path and call both unqualified, so they keep working. The two functions that name
--    public.unaccent are rewritten to name extensions.unaccent, with the same body otherwise; their
--    grants and search_path stay. Any new function that uses either extension must name
--    `extensions.` or carry it in its search_path; `public.unaccent` no longer exists.
-- 2. W126 (Phase 11 trigger/RPC re-audit, docs/specs/phase-11-conversations-memory.md "Re-audit
--    2026-10-17"): coach_save_turn refuses a thread that is already deleted, as
--    coach_thread_deleted. Before this a turn that read the thread live and then saved after
--    another device's delete committed still appended its messages to the deleted thread. Same
--    function otherwise; lib/server/coach-threads.ts answers the new error as 404 not_found, the
--    answer the turn's own pre-read gives a deleted thread.
--
-- Live-safe: metadata only (ALTER EXTENSION SET SCHEMA takes a brief lock on the extension, no
-- table rewrite), lock_timeout 3s. Order: apply BEFORE the code deploys or after; the old code
-- answers coach_thread_deleted as a 500 "Could not save the turn", the new code as a 404, and the
-- old function never raises it, so either order is safe. Apply it with the normal migration path
-- (it runs inside a transaction).
-- Down: supabase/migrations/down/20270106090200_extensions_schema_save_turn_deleted.down.sql.
set local lock_timeout = '3s';

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Guarded, so a rerun (or a database that already has them there) is a no-op.
do $$ begin
  if (select extnamespace from pg_extension where extname = 'pg_trgm') <> 'extensions'::regnamespace then
    alter extension pg_trgm set schema extensions;
  end if;
  if (select extnamespace from pg_extension where extname = 'unaccent') <> 'extensions'::regnamespace then
    alter extension unaccent set schema extensions;
  end if;
end $$;

create or replace function public.catalog_search_doc(p_description text, p_brand text, p_category text)
returns tsvector language sql immutable set search_path = public, pg_temp as $$
  select setweight(to_tsvector('english', extensions.unaccent(coalesce(p_description,''))), 'A')
      || setweight(to_tsvector('english', extensions.unaccent(coalesce(p_brand,''))), 'B')
      || setweight(to_tsvector('english', extensions.unaccent(coalesce(p_category,''))), 'C'); $$;

create or replace function public.food_name_norm(p_name text) returns text
  language sql immutable set search_path = public as $$
  select btrim(regexp_replace(lower(extensions.unaccent(split_part(coalesce(p_name, ''), ',', 1))),
                              '\s+', ' ', 'g'));
$$;

create or replace function public.coach_save_turn(
  p_user_id uuid,
  p_thread_id uuid,
  p_kind text,
  p_new_title text,
  p_rows jsonb,
  p_summary text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_deleted timestamptz;
  v_count int;
  v_first int;
  v_attempt int := 0;
  v_constraint text;
  v_row jsonb;
  v_saved jsonb;
begin
  if p_user_id is null or p_thread_id is null or p_rows is null
     or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'coach_turn_invalid' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 8 or p_rows->0->>'role' is distinct from 'user' then
    raise exception 'coach_turn_invalid' using errcode = 'P0001';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or (v_row->>'id') is null
       or (v_row->>'user_id')::uuid is distinct from p_user_id
       or (v_row->>'thread_id')::uuid is distinct from p_thread_id
       or coalesce(v_row->>'role', '') not in ('user', 'assistant')
       or (v_row->>'seq') is null then
      raise exception 'coach_turn_invalid' using errcode = 'P0001';
    end if;
    -- The shape the session client's insert policy allowed for the user's own question.
    if v_row->>'role' = 'user' and (
         (v_row->>'model_id') is not null or (v_row->>'ai_call_id') is not null
         or not (v_row->'tool_calls' is null
                 or jsonb_typeof(v_row->'tool_calls') = 'null'
                 or v_row->'tool_calls' = '[]'::jsonb
                 or (jsonb_typeof(v_row->'tool_calls') = 'object'
                     and ((v_row->'tool_calls') - 'attachments'::text) = '{}'::jsonb))) then
      raise exception 'coach_turn_invalid' using errcode = 'P0001';
    end if;
  end loop;

  if p_new_title is not null then
    if p_kind is null then
      raise exception 'coach_turn_invalid' using errcode = 'P0001';
    end if;
    begin
      insert into public.coach_threads (id, user_id, title, kind)
      values (p_thread_id, p_user_id, left(p_new_title, 80), p_kind);
    exception when unique_violation then
      raise exception 'coach_thread_exists' using errcode = 'P0001';
    end;
  end if;

  -- W126: a thread deleted before this lock was granted takes no more messages. The delete's
  -- UPDATE also takes FOR NO KEY UPDATE, so the two serialize and the later one sees the earlier.
  select th.user_id, th.deleted_at into v_owner, v_deleted from public.coach_threads th
   where th.id = p_thread_id for no key update;
  if v_owner is distinct from p_user_id then
    raise exception 'coach_thread_not_found' using errcode = 'P0001';
  end if;
  if v_deleted is not null then
    raise exception 'coach_thread_deleted' using errcode = 'P0001';
  end if;

  select coalesce(max(m.seq), 0) + 1 into v_first
    from public.coach_messages m where m.thread_id = p_thread_id;
  loop
    v_attempt := v_attempt + 1;
    begin
      insert into public.coach_messages (id, thread_id, user_id, role, content, seq, tool_calls,
        policy_checks, deflected, model_id, ai_call_id, created_at)
      select (r.value->>'id')::uuid, p_thread_id, p_user_id, r.value->>'role',
             coalesce(r.value->>'content', ''), v_first + (r.ordinality - 1)::int,
             coalesce(nullif(r.value->'tool_calls', 'null'::jsonb), '[]'::jsonb),
             coalesce(nullif(r.value->'policy_checks', 'null'::jsonb), '[]'::jsonb),
             coalesce((r.value->>'deflected')::boolean, false),
             r.value->>'model_id', (r.value->>'ai_call_id')::uuid,
             coalesce((r.value->>'created_at')::timestamptz, pg_catalog.now())
        from jsonb_array_elements(p_rows) with ordinality as r(value, ordinality)
       order by r.ordinality;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'coach_messages_thread_seq' then
        raise exception 'coach_message_exists' using errcode = 'P0001';
      end if;
      if v_attempt >= 3 then
        raise exception 'coach_seq_busy' using errcode = 'P0001';
      end if;
      select coalesce(max(m.seq), 0) + 1 into v_first
        from public.coach_messages m where m.thread_id = p_thread_id;
    end;
  end loop;

  update public.coach_threads
     set last_message_at = pg_catalog.now(),
         summary = coalesce(left(p_summary, 600), summary)
   where id = p_thread_id;

  select jsonb_agg(jsonb_build_object('id', r.value->>'id',
           'seq', v_first + (r.ordinality - 1)::int) order by r.ordinality)
    into v_saved
    from jsonb_array_elements(p_rows) with ordinality as r(value, ordinality);
  return v_saved;
end $$;

revoke all on function public.coach_save_turn(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.coach_save_turn(uuid, uuid, text, text, jsonb, text)
  to service_role;
