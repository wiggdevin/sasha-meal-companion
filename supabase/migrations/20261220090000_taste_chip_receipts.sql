-- Phase 18 W5b-2 (docs/specs/phase-18-open-world-foods.md §10 "W5b-2", D6, D9 item 3): confirmed
-- taste chips are written on the server, and their Undo is decided from a server receipt only.
--
--   taste_chip_receipts   one immutable row per confirm action (unique per account and action id):
--                         the chips the caller asked for, and EXACTLY the keys this call added under
--                         the row lock. Owner-only select; written only by the two functions below.
--                         The Undo columns are set once, by taste_chips_undo, and never again.
--   taste_chips_confirm   one transaction: the user_settings advisory lock (the key apply_sync_op
--                         takes) and the row FOR UPDATE; adds each chip the row lacks, never past 50
--                         dislikes or 6 cuisines; keeps every other diet_prefs key (and every other
--                         column); bumps rev and writes one change_log row so every phone pulls the
--                         row; records the receipt. A repeat of the same action id with the same
--                         request answers the stored receipt and writes nothing; the same id with a
--                         different request answers `action_conflict` and writes nothing.
--   taste_chip_holds      one row per key a receipt added that has stayed on the row ever since (at
--                         most one per account and key). An AFTER UPDATE trigger on user_settings
--                         drops a hold the moment its key leaves the row, whoever removed it, so a key
--                         the user removes and later adds again is the user's, never the receipt's.
--   taste_chips_undo      one transaction, same locks: removes only the receipt's keys it still holds;
--                         a key it no longer holds (removed since, even if added again) is left alone
--                         and reported as gone. A second Undo answers `already_undone` and writes
--                         nothing.
--
-- Attribution never depends on a phone: the added keys are read from the row under the lock, in the
-- write's own transaction. The action id is only the request's idempotency key.
--
-- A coach confirm (source 'coach') also writes its coach Undo record (`coach_action_undos`,
-- record_mode 'taste_v1') in the same transaction; 20261220090100 teaches that table and
-- perform_coach_undo the mode. Both functions are callable by the signed-in owner (the caller check
-- refuses another account's id) and by service_role.
--
-- Live-safe: two new, empty tables, new functions and one AFTER UPDATE OF diet_prefs, cuisines
-- trigger on user_settings (CREATE TRIGGER holds SHARE ROW EXCLUSIVE for a catalog update only; the
-- trigger deletes by the holds table's primary-key prefix and finds nothing for an account with no
-- open receipt).
-- Apply order: 20261220090000, 20261220090100, 20261220090200, each file in its own transaction.
-- Down: supabase/migrations/down/20261220090000_taste_chip_receipts.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.taste_chip_receipts') is not null then
    raise exception '20261220090000_taste_chip_receipts: already applied';
  end if;
end $$;

create table public.taste_chip_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null,
  source text not null check (source in ('settings', 'onboarding', 'coach')),
  -- The coach card the chips came from: { messageId, proposalId }; coach confirms only.
  coach jsonb check (coach is null or jsonb_typeof(coach) = 'object'),
  requested_dislikes text[] not null,
  requested_cuisines text[] not null,
  added_dislikes text[] not null,
  added_cuisines text[] not null,
  -- Asked for but already on the row (not this call's), or past the cap (not written).
  present_dislikes text[] not null,
  present_cuisines text[] not null,
  capped_dislikes text[] not null,
  capped_cuisines text[] not null,
  -- The user_settings rev this confirm wrote; null when it added nothing.
  settings_rev integer,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  removed_dislikes text[],
  removed_cuisines text[],
  gone_dislikes text[],
  gone_cuisines text[],
  constraint taste_chip_receipts_action unique (user_id, action_id),
  constraint taste_chip_receipts_coach check ((source = 'coach') = (coach is not null)),
  constraint taste_chip_receipts_undo check (
    (undone_at is null) = (removed_dislikes is null) and (undone_at is null) = (removed_cuisines is null)
    and (undone_at is null) = (gone_dislikes is null) and (undone_at is null) = (gone_cuisines is null))
);
comment on table public.taste_chip_receipts is
  'Phase 18 W5b-2: one confirm of taste chips and exactly the keys it added. Written only by taste_chips_confirm / taste_chips_undo.';

-- Immutable except the one Undo transition (all four Undo columns from null, with undone_at).
create function public._taste_chip_receipts_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if old.undone_at is not null
     or new.undone_at is null
     or (to_jsonb(new) - array['undone_at', 'removed_dislikes', 'removed_cuisines', 'gone_dislikes',
           'gone_cuisines'])
        is distinct from
        (to_jsonb(old) - array['undone_at', 'removed_dislikes', 'removed_cuisines', 'gone_dislikes',
           'gone_cuisines']) then
    raise exception 'taste_receipt_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._taste_chip_receipts_guard() from public, anon, authenticated;

create trigger taste_chip_receipts_guard before update on public.taste_chip_receipts
  for each row execute function public._taste_chip_receipts_guard();

alter table public.taste_chip_receipts enable row level security;
create policy taste_chip_receipts_select on public.taste_chip_receipts for select to authenticated
  using (user_id = (select auth.uid()));
-- Hosted default privileges grant ALL on a new table to anon, authenticated and service_role.
revoke all on table public.taste_chip_receipts from public, anon, authenticated, service_role;
grant select on table public.taste_chip_receipts to authenticated;
-- service_role reads, and inserts only as the tenancy fixtures do (as coach_action_receipts); no role
-- holds UPDATE or DELETE (the account cascade removes rows).
grant select, insert on table public.taste_chip_receipts to service_role;

-- The keys each receipt still holds. No client role reads or writes it; only the functions below and
-- the release trigger do.
create table public.taste_chip_holds (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- No foreign key to taste_chip_receipts: both rows are written only by taste_chips_confirm for the
  -- same account, and both go with the account (auth.users cascade); a cross-table reference would
  -- add a cross-account edge to guard for nothing.
  receipt_id uuid not null,
  kind text not null check (kind in ('dislike', 'cuisine')),
  key text not null,
  primary key (user_id, kind, key)
);
create index taste_chip_holds_receipt on public.taste_chip_holds (receipt_id);
comment on table public.taste_chip_holds is
  'Phase 18 W5b-2: a key a taste receipt added and that has never left user_settings since. Undo removes only held keys.';
alter table public.taste_chip_holds enable row level security;
revoke all on table public.taste_chip_holds from public, anon, authenticated, service_role;
-- service_role: read, and insert as the tenancy fixtures do; no role updates or deletes.
grant select, insert on table public.taste_chip_holds to service_role;

-- The request's chips: no null, no repeat, dislikes under the diet_prefs.taste storage contract
-- (public.diet_prefs_taste_valid: at most 50, 't:<tag>' or 'f:' + 1-80 characters), cuisines from the
-- 12-word vocabulary (lib/foods/universe/vocabulary.ts CUISINES; a test holds the lists equal), at
-- most 6, and at least one chip in all. The canonical family form is the route's rule (tasteDislike).
create function public._taste_chips_request_valid(p_dislikes text[], p_cuisines text[]) returns boolean
  language sql immutable parallel safe set search_path = '' as $fn$
    select p_dislikes is not null and p_cuisines is not null
      and array_position(p_dislikes, null) is null and array_position(p_cuisines, null) is null
      and cardinality(p_dislikes) + cardinality(p_cuisines) > 0
      and public.diet_prefs_taste_valid(
            jsonb_build_object('taste', jsonb_build_object('dislikes', to_jsonb(p_dislikes))))
      and cardinality(p_cuisines) <= 6
      and p_cuisines <@ array['american', 'latin_american', 'italian', 'mediterranean', 'south_asian',
        'chinese', 'japanese', 'korean', 'southeast_asian', 'caribbean', 'african',
        'european_other']::text[]
      and cardinality(p_cuisines) = (select count(distinct c) from unnest(p_cuisines) as c)
  $fn$;
revoke all on function public._taste_chips_request_valid(text[], text[]) from public, anon, authenticated;

-- One answer shape for confirm and its repeat: the receipt as stored, and the settings row now.
create function public._taste_chips_answer(p_receipt public.taste_chip_receipts, p_status text,
  p_settings jsonb) returns jsonb
  language sql stable set search_path = '' as $fn$
    select jsonb_build_object(
      'status', p_status,
      'action_id', p_receipt.action_id,
      'added', jsonb_build_object('dislikes', to_jsonb(p_receipt.added_dislikes),
                                  'cuisines', to_jsonb(p_receipt.added_cuisines)),
      'present', jsonb_build_object('dislikes', to_jsonb(p_receipt.present_dislikes),
                                    'cuisines', to_jsonb(p_receipt.present_cuisines)),
      'capped', jsonb_build_object('dislikes', to_jsonb(p_receipt.capped_dislikes),
                                   'cuisines', to_jsonb(p_receipt.capped_cuisines)),
      'undone_at', p_receipt.undone_at,
      'settings', p_settings)
  $fn$;
revoke all on function public._taste_chips_answer(public.taste_chip_receipts, text, jsonb)
  from public, anon, authenticated;

-- The stored dislikes of a diet_prefs value, in order; null when the value cannot be read as one
-- (a non-object diet_prefs or taste; the column check keeps `dislikes` an array of strings).
create function public._taste_chips_dislikes_of(p_prefs jsonb) returns text[]
  language sql immutable set search_path = '' as $fn$
    select case
      when p_prefs is null or jsonb_typeof(p_prefs) = 'null' then '{}'::text[]
      when jsonb_typeof(p_prefs) <> 'object' then null
      when not (p_prefs ? 'taste') or jsonb_typeof(p_prefs->'taste') = 'null' then '{}'::text[]
      when jsonb_typeof(p_prefs->'taste') <> 'object' then null
      when not ((p_prefs->'taste') ? 'dislikes') then '{}'::text[]
      when jsonb_typeof(p_prefs->'taste'->'dislikes') <> 'array' then null
      else coalesce((select array_agg(d.value order by d.n)
                       from jsonb_array_elements_text(p_prefs->'taste'->'dislikes')
                            with ordinality as d(value, n)), '{}'::text[])
    end
  $fn$;
revoke all on function public._taste_chips_dislikes_of(jsonb) from public, anon, authenticated;

-- Any write that takes a held key off the row ends that hold (a sync op, an Undo, a server write);
-- deleting the row (an account reset) ends every hold of the account.
create function public._taste_chip_holds_release() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    delete from public.taste_chip_holds h where h.user_id = old.user_id;
    return null;
  end if;
  delete from public.taste_chip_holds h
   where h.user_id = new.user_id
     and ((h.kind = 'cuisine' and not (h.key = any(coalesce(new.cuisines, '{}'::text[]))))
       or (h.kind = 'dislike'
           and not (h.key = any(coalesce(public._taste_chips_dislikes_of(new.diet_prefs), '{}'::text[])))));
  return null;
end $$;
revoke all on function public._taste_chip_holds_release() from public, anon, authenticated;

create trigger taste_chip_holds_release after update of diet_prefs, cuisines on public.user_settings
  for each row when (old.diet_prefs is distinct from new.diet_prefs or old.cuisines is distinct from new.cuisines)
  execute function public._taste_chip_holds_release();
create trigger taste_chip_holds_release_row after delete on public.user_settings
  for each row execute function public._taste_chip_holds_release();

-- diet_prefs with its taste dislikes replaced by `p_dislikes`; every other key, in diet_prefs and in
-- taste, kept. Called only with a value `_taste_chips_dislikes_of` could read.
create function public._taste_chips_with_dislikes(p_prefs jsonb, p_dislikes text[]) returns jsonb
  language sql immutable set search_path = '' as $fn$
    select (case when p_prefs is null or jsonb_typeof(p_prefs) = 'null' then '{}'::jsonb else p_prefs end)
      || jsonb_build_object('taste',
           (case when jsonb_typeof(p_prefs->'taste') = 'object' then p_prefs->'taste' else '{}'::jsonb end)
           || jsonb_build_object('dislikes', to_jsonb(p_dislikes)))
  $fn$;
revoke all on function public._taste_chips_with_dislikes(jsonb, text[]) from public, anon, authenticated;

-- One server write of user_settings, as the sync feed reports it: rev + 1 and one change_log row
-- (op_id null: no client op), so every phone's next pull rebases its pending edits onto this row.
-- The caller holds the advisory lock and the row lock.
create function public._taste_chips_write(p_user uuid, p_prefs jsonb, p_cuisines text[]) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_rev integer;
  v_current jsonb;
begin
  update user_settings set diet_prefs = p_prefs, cuisines = p_cuisines, rev = coalesce(rev, 0) + 1
   where user_id = p_user
  returning rev into v_rev;
  v_current := _sync_current(p_user, 'user_settings', 'settings');
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user, next_change_seq(p_user), 'user_settings', 'settings', v_rev, 'update', null,
          v_current);
  return v_current;
end $$;
revoke all on function public._taste_chips_write(uuid, jsonb, text[]) from public, anon, authenticated;

-- Confirm. Answers `{status: applied | existing, action_id, added, present, capped, undone_at,
-- settings}` (settings: the user_settings row after the call, as the sync feed carries it), or
-- `{status}` for `action_conflict`, `settings_not_synced`, `settings_unreadable`, `unknown_proposal`,
-- `chip_not_proposed` (nothing written). Raises 22023 for a malformed request.
create function public.taste_chips_confirm(p_user_id uuid, p_action_id uuid, p_source text,
  p_dislikes text[], p_cuisines text[], p_coach jsonb default null) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_receipt taste_chip_receipts%rowtype;
  v_settings user_settings%rowtype;
  v_coach jsonb;
  v_message_id uuid;
  v_thread_id uuid;
  v_proposal jsonb;
  v_have_d text[];
  v_have_c text[];
  v_add_d text[] := '{}';
  v_add_c text[] := '{}';
  v_present_d text[] := '{}';
  v_present_c text[] := '{}';
  v_capped_d text[] := '{}';
  v_capped_c text[] := '{}';
  v_key text;
  v_current jsonb;
  v_rev integer;
begin
  perform _sync_assert_caller(p_user_id);
  if p_action_id is null then raise exception 'action_id_required' using errcode = '22023'; end if;
  if p_source is null or p_source not in ('settings', 'onboarding', 'coach') then
    raise exception 'bad_source' using errcode = '22023';
  end if;
  if not coalesce(_taste_chips_request_valid(p_dislikes, p_cuisines), false) then
    raise exception 'bad_chips' using errcode = '22023';
  end if;
  if (p_source = 'coach') <> (p_coach is not null) then
    raise exception 'bad_coach' using errcode = '22023';
  end if;
  if p_coach is not null then
    if jsonb_typeof(p_coach) <> 'object' or (p_coach - array['messageId', 'proposalId']) <> '{}'::jsonb
       or jsonb_typeof(p_coach->'messageId') <> 'string' or jsonb_typeof(p_coach->'proposalId') <> 'string'
       or (p_coach->>'messageId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or char_length(p_coach->>'proposalId') not between 1 and 64 then
      raise exception 'bad_coach' using errcode = '22023';
    end if;
    v_coach := jsonb_build_object('messageId', lower(p_coach->>'messageId'),
                                  'proposalId', p_coach->>'proposalId');
  end if;

  -- The key every user_settings writer serializes on (apply_sync_op), before any row lock.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':user_settings:settings', 0));

  select * into v_receipt from taste_chip_receipts
   where user_id = p_user_id and action_id = p_action_id;
  if found then
    if v_receipt.source <> p_source or v_receipt.coach is distinct from v_coach
       or v_receipt.requested_dislikes <> p_dislikes or v_receipt.requested_cuisines <> p_cuisines then
      return jsonb_build_object('status', 'action_conflict');
    end if;
    return _taste_chips_answer(v_receipt, 'existing', _sync_current(p_user_id, 'user_settings', 'settings'));
  end if;

  if v_coach is not null then
    -- The card must be on one of the caller's own assistant messages, and every chip one it offered.
    select m.id, m.thread_id, m.tool_calls->'tasteChips' into v_message_id, v_thread_id, v_proposal
      from coach_messages m
     where m.id = (v_coach->>'messageId')::uuid and m.user_id = p_user_id and m.role = 'assistant';
    if v_message_id is null or jsonb_typeof(v_proposal) <> 'object'
       or v_proposal->>'kind' is distinct from 'taste_chips_proposal'
       or v_proposal->>'id' is distinct from v_coach->>'proposalId'
       or jsonb_typeof(v_proposal->'dislikes') <> 'array' or jsonb_typeof(v_proposal->'cuisines') <> 'array' then
      return jsonb_build_object('status', 'unknown_proposal');
    end if;
    if exists (select 1 from unnest(p_dislikes) as k(key)
                where not exists (select 1 from jsonb_array_elements(v_proposal->'dislikes') as c(chip)
                                   where c.chip->>'key' = k.key))
       or exists (select 1 from unnest(p_cuisines) as k(key)
                   where not exists (select 1 from jsonb_array_elements(v_proposal->'cuisines') as c(chip)
                                      where c.chip->>'key' = k.key)) then
      return jsonb_build_object('status', 'chip_not_proposed');
    end if;
    -- The action id names this coach record only.
    if exists (select 1 from coach_action_undos
                where user_id = p_user_id and action_id = p_action_id::text) then
      return jsonb_build_object('status', 'action_conflict');
    end if;
  end if;

  select * into v_settings from user_settings where user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'settings_not_synced'); end if;
  v_have_d := _taste_chips_dislikes_of(v_settings.diet_prefs);
  if v_have_d is null then return jsonb_build_object('status', 'settings_unreadable'); end if;
  v_have_c := coalesce(v_settings.cuisines, '{}'::text[]);

  foreach v_key in array p_dislikes loop
    if v_key = any(v_have_d) then v_present_d := v_present_d || v_key;
    elsif cardinality(v_have_d) + cardinality(v_add_d) < 50 then v_add_d := v_add_d || v_key;
    else v_capped_d := v_capped_d || v_key;
    end if;
  end loop;
  foreach v_key in array p_cuisines loop
    if v_key = any(v_have_c) then v_present_c := v_present_c || v_key;
    elsif cardinality(v_have_c) + cardinality(v_add_c) < 6 then v_add_c := v_add_c || v_key;
    else v_capped_c := v_capped_c || v_key;
    end if;
  end loop;

  if cardinality(v_add_d) + cardinality(v_add_c) > 0 then
    v_current := _taste_chips_write(p_user_id,
      case when cardinality(v_add_d) > 0
        then _taste_chips_with_dislikes(v_settings.diet_prefs, v_have_d || v_add_d)
        else v_settings.diet_prefs end,
      v_have_c || v_add_c);
    v_rev := (v_current->>'rev')::integer;
  else
    v_current := _sync_current(p_user_id, 'user_settings', 'settings');
  end if;

  insert into taste_chip_receipts (user_id, action_id, source, coach, requested_dislikes,
    requested_cuisines, added_dislikes, added_cuisines, present_dislikes, present_cuisines,
    capped_dislikes, capped_cuisines, settings_rev)
  values (p_user_id, p_action_id, p_source, v_coach, p_dislikes, p_cuisines, v_add_d, v_add_c,
          v_present_d, v_present_c, v_capped_d, v_capped_c, v_rev)
  returning * into v_receipt;
  insert into taste_chip_holds (user_id, receipt_id, kind, key)
  select p_user_id, v_receipt.id, 'dislike', k from unnest(v_add_d) as k
  union all
  select p_user_id, v_receipt.id, 'cuisine', k from unnest(v_add_c) as k;

  if v_coach is not null then
    insert into coach_action_undos (user_id, thread_id, message_id, action_id, kind, inverse,
                                    expected_rev, bind, record_mode)
    values (p_user_id, v_thread_id, v_message_id, p_action_id::text, 'confirm_taste_chips', '{}'::jsonb,
            null, jsonb_build_object('proposalId', v_coach->>'proposalId'), 'taste_v1');
  end if;

  return _taste_chips_answer(v_receipt, 'applied', v_current);
end $$;
revoke all on function public.taste_chips_confirm(uuid, uuid, text, text[], text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.taste_chips_confirm(uuid, uuid, text, text[], text[], jsonb)
  to authenticated, service_role;

-- The Undo, with the advisory lock already held: the receipt FOR UPDATE, then the row FOR UPDATE.
-- Closes the action's coach record (taste_v1) in the same transaction.
create function public._taste_chips_undo_locked(p_user uuid, p_action_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_receipt taste_chip_receipts%rowtype;
  v_settings user_settings%rowtype;
  v_have_d text[];
  v_have_c text[];
  v_removed_d text[];
  v_removed_c text[];
  v_gone_d text[];
  v_gone_c text[];
  v_current jsonb;
begin
  select * into v_receipt from taste_chip_receipts
   where user_id = p_user and action_id = p_action_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_receipt.undone_at is not null then
    return jsonb_build_object('status', 'already_undone', 'action_id', v_receipt.action_id,
      'undone_at', v_receipt.undone_at,
      'removed', jsonb_build_object('dislikes', to_jsonb(v_receipt.removed_dislikes),
                                    'cuisines', to_jsonb(v_receipt.removed_cuisines)),
      'gone', jsonb_build_object('dislikes', to_jsonb(v_receipt.gone_dislikes),
                                 'cuisines', to_jsonb(v_receipt.gone_cuisines)),
      'settings', _sync_current(p_user, 'user_settings', 'settings'));
  end if;

  select * into v_settings from user_settings where user_id = p_user for update;
  v_have_d := case when found then _taste_chips_dislikes_of(v_settings.diet_prefs) else '{}'::text[] end;
  if v_have_d is null then return jsonb_build_object('status', 'settings_unreadable'); end if;
  v_have_c := case when found then coalesce(v_settings.cuisines, '{}'::text[]) else '{}'::text[] end;

  -- A key is this receipt's to remove only while it holds it: on the row ever since the confirm
  -- (the release trigger ends a hold when the key leaves). Held keys are on the row by construction;
  -- the presence check keeps that true even for a row the trigger could not read.
  select coalesce(array_agg(k order by n), '{}') into v_removed_d
    from unnest(v_receipt.added_dislikes) with ordinality as a(k, n)
   where k = any(v_have_d) and exists (select 1 from taste_chip_holds h where h.receipt_id = v_receipt.id
                                         and h.kind = 'dislike' and h.key = a.k);
  select coalesce(array_agg(k order by n), '{}') into v_gone_d
    from unnest(v_receipt.added_dislikes) with ordinality as a(k, n) where not (k = any(v_removed_d));
  select coalesce(array_agg(k order by n), '{}') into v_removed_c
    from unnest(v_receipt.added_cuisines) with ordinality as a(k, n)
   where k = any(v_have_c) and exists (select 1 from taste_chip_holds h where h.receipt_id = v_receipt.id
                                         and h.kind = 'cuisine' and h.key = a.k);
  select coalesce(array_agg(k order by n), '{}') into v_gone_c
    from unnest(v_receipt.added_cuisines) with ordinality as a(k, n) where not (k = any(v_removed_c));

  if cardinality(v_removed_d) + cardinality(v_removed_c) > 0 then
    v_current := _taste_chips_write(p_user,
      case when cardinality(v_removed_d) > 0
        then _taste_chips_with_dislikes(v_settings.diet_prefs,
          coalesce((select array_agg(k order by n) from unnest(v_have_d) with ordinality as h(k, n)
                     where not (k = any(v_removed_d))), '{}'::text[]))
        else v_settings.diet_prefs end,
      coalesce((select array_agg(k order by n) from unnest(v_have_c) with ordinality as h(k, n)
                 where not (k = any(v_removed_c))), '{}'::text[]));
  else
    v_current := _sync_current(p_user, 'user_settings', 'settings');
  end if;

  delete from taste_chip_holds where receipt_id = v_receipt.id;
  update taste_chip_receipts set undone_at = now(), removed_dislikes = v_removed_d,
    removed_cuisines = v_removed_c, gone_dislikes = v_gone_d, gone_cuisines = v_gone_c
   where id = v_receipt.id
  returning * into v_receipt;
  -- The coach record of this action, if the confirm came from a coach card.
  update coach_action_undos set undone_at = now()
   where user_id = p_user and action_id = p_action_id::text and kind = 'confirm_taste_chips'
     and undone_at is null;

  return jsonb_build_object('status', 'undone', 'action_id', v_receipt.action_id,
    'undone_at', v_receipt.undone_at,
    'removed', jsonb_build_object('dislikes', to_jsonb(v_removed_d), 'cuisines', to_jsonb(v_removed_c)),
    'gone', jsonb_build_object('dislikes', to_jsonb(v_gone_d), 'cuisines', to_jsonb(v_gone_c)),
    'settings', v_current);
end $$;
revoke all on function public._taste_chips_undo_locked(uuid, uuid) from public, anon, authenticated;

-- Undo. Answers `{status: undone | already_undone, action_id, undone_at, removed, gone, settings}`,
-- or `{status: not_found | settings_unreadable}` (nothing written).
create function public.taste_chips_undo(p_user_id uuid, p_action_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  perform _sync_assert_caller(p_user_id);
  if p_action_id is null then raise exception 'action_id_required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':user_settings:settings', 0));
  return _taste_chips_undo_locked(p_user_id, p_action_id);
end $$;
revoke all on function public.taste_chips_undo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.taste_chips_undo(uuid, uuid) to authenticated, service_role;
