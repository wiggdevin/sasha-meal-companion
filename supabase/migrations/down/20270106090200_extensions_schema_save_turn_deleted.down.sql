-- Reverse of 20270106090200_extensions_schema_save_turn_deleted.sql: coach_save_turn goes back to
-- its 20270104120000 body (a deleted thread takes messages again), the two unaccent callers name
-- public.unaccent again, and pg_trgm and unaccent move back to public. The extensions schema stays:
-- Supabase owns it and other extensions live there.
set local lock_timeout = '3s';

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

  select th.user_id into v_owner from public.coach_threads th
   where th.id = p_thread_id for no key update;
  if v_owner is distinct from p_user_id then
    raise exception 'coach_thread_not_found' using errcode = 'P0001';
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

alter extension pg_trgm set schema public;
alter extension unaccent set schema public;

create or replace function public.catalog_search_doc(p_description text, p_brand text, p_category text)
returns tsvector language sql immutable set search_path = public, pg_temp as $$
  select setweight(to_tsvector('english', public.unaccent(coalesce(p_description,''))), 'A')
      || setweight(to_tsvector('english', public.unaccent(coalesce(p_brand,''))), 'B')
      || setweight(to_tsvector('english', public.unaccent(coalesce(p_category,''))), 'C'); $$;

create or replace function public.food_name_norm(p_name text) returns text
  language sql immutable set search_path = public as $$
  select btrim(regexp_replace(lower(public.unaccent(split_part(coalesce(p_name, ''), ',', 1))),
                              '\s+', ' ', 'g'));
$$;
