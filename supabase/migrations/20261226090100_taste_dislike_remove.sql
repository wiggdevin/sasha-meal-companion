-- Followups #1 (2026-10-08, FINAL decision): taste dislikes show as read-only pills in Settings;
-- this adds an owner-scoped, idempotent way to drop ONE confirmed dislike, with an exact Undo.
-- Mirrors the W5b-2 receipt pattern (20261220090000_taste_chip_receipts.sql) at the single-key
-- scale this needs: one receipt per remove action, the advisory lock every user_settings writer
-- takes, and a server-computed receipt (never trusted from the phone) so Undo restores exactly
-- what this call took off, never a guess from the request.
--
-- Privacy: the removed key lives only in this owner-RLS row (same as taste_chip_receipts already
-- stores confirmed keys) -- never in a shared log. Any application log of this action (see
-- lib/server/taste-dislike-remove.ts) carries the action id and outcome only, never the key.
--
--   taste_dislike_removals   one immutable-until-undone row per (user_id, action_id): the key asked
--                             for, whether it was actually removed (vs. already gone), and the Undo
--                             outcome once Undo runs. Owner-only select; written only by the two
--                             functions below.
--   taste_dislike_remove      one transaction: the user_settings advisory lock + row FOR UPDATE;
--                             drops the key from diet_prefs.taste.dislikes if present (never fails
--                             when it is already absent -- `already_gone`, idempotent); bumps rev
--                             and writes one change_log row so every phone pulls it; records the
--                             receipt. A repeat of the same action id with the same key answers the
--                             stored receipt (`existing`); the same id with a different key answers
--                             `action_conflict` and writes nothing.
--   taste_dislike_remove_undo one transaction, same locks: restores the key only when this receipt
--                             actually removed it and the key is still absent (a manual re-add since
--                             needs no restore -- reported as `restored: false`); never duplicates,
--                             never exceeds the 50-dislike cap (a restore that would requires no
--                             action and is reported `capped: true`). A second Undo answers
--                             `already_undone` and writes nothing.
--
-- Apply order: this file alone, its own transaction.
-- Down: supabase/migrations/down/20261226090100_taste_dislike_remove.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.taste_dislike_removals') is not null then
    raise exception '20261226090100_taste_dislike_remove: already applied';
  end if;
end $$;

create table public.taste_dislike_removals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null,
  key text not null,
  -- Whether THIS call actually took the key off the row (false: it was already gone).
  removed boolean not null,
  settings_rev integer,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  restored boolean,
  capped boolean,
  constraint taste_dislike_removals_action unique (user_id, action_id),
  constraint taste_dislike_removals_undo check (
    (undone_at is null) = (restored is null) and (undone_at is null) = (capped is null))
);
comment on table public.taste_dislike_removals is
  'Followups #1: one remove-one-dislike action and, once Undo runs, exactly what it restored. Written only by taste_dislike_remove / taste_dislike_remove_undo. Never a shared log -- owner-select only.';

-- Immutable except the one Undo transition (restored, capped, undone_at from null together).
create function public._taste_dislike_removals_guard() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if old.undone_at is not null
     or new.undone_at is null
     or (to_jsonb(new) - array['undone_at', 'restored', 'capped'])
        is distinct from (to_jsonb(old) - array['undone_at', 'restored', 'capped']) then
    raise exception 'taste_dislike_removal_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public._taste_dislike_removals_guard() from public, anon, authenticated;

create trigger taste_dislike_removals_guard before update on public.taste_dislike_removals
  for each row execute function public._taste_dislike_removals_guard();

alter table public.taste_dislike_removals enable row level security;
create policy taste_dislike_removals_select on public.taste_dislike_removals for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on table public.taste_dislike_removals from public, anon, authenticated, service_role;
grant select on table public.taste_dislike_removals to authenticated;
grant select, insert on table public.taste_dislike_removals to service_role;

-- One valid dislike key for a REMOVE request: the same canonical-family rule a new client write
-- uses (lib/profile/taste.ts tasteDislike), checked the same way `_taste_chips_request_valid`
-- checks a whole array, for exactly one key.
create function public._taste_dislike_key_valid(p_key text) returns boolean
  language sql immutable parallel safe set search_path = '' as $fn$
    select p_key is not null
      and public.diet_prefs_taste_valid(
            jsonb_build_object('taste', jsonb_build_object('dislikes', to_jsonb(array[p_key]))))
  $fn$;
revoke all on function public._taste_dislike_key_valid(text) from public, anon, authenticated;

-- Remove. Answers `{status: removed | already_gone | existing, action_id, key, settings}`, or
-- `{status: action_conflict | settings_not_synced | settings_unreadable}` (nothing written).
-- Raises 22023 for a malformed key.
create function public.taste_dislike_remove(p_user_id uuid, p_action_id uuid, p_key text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_receipt taste_dislike_removals%rowtype;
  v_settings user_settings%rowtype;
  v_have_d text[];
  v_removed boolean;
  v_current jsonb;
  v_rev integer;
begin
  perform _sync_assert_caller(p_user_id);
  if p_action_id is null then raise exception 'action_id_required' using errcode = '22023'; end if;
  if not coalesce(_taste_dislike_key_valid(p_key), false) then
    raise exception 'bad_key' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':user_settings:settings', 0));

  select * into v_receipt from taste_dislike_removals
   where user_id = p_user_id and action_id = p_action_id;
  if found then
    if v_receipt.key <> p_key then
      return jsonb_build_object('status', 'action_conflict');
    end if;
    return jsonb_build_object('status', 'existing', 'action_id', v_receipt.action_id, 'key', v_receipt.key,
      'settings', _sync_current(p_user_id, 'user_settings', 'settings'));
  end if;

  select * into v_settings from user_settings where user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'settings_not_synced'); end if;
  v_have_d := _taste_chips_dislikes_of(v_settings.diet_prefs);
  if v_have_d is null then return jsonb_build_object('status', 'settings_unreadable'); end if;

  v_removed := p_key = any(v_have_d);
  if v_removed then
    v_current := _taste_chips_write(p_user_id,
      _taste_chips_with_dislikes(v_settings.diet_prefs,
        coalesce((select array_agg(k order by n) from unnest(v_have_d) with ordinality as h(k, n)
                   where k <> p_key), '{}'::text[])),
      coalesce(v_settings.cuisines, '{}'::text[]));
    v_rev := (v_current->>'rev')::integer;
  else
    v_current := _sync_current(p_user_id, 'user_settings', 'settings');
  end if;

  insert into taste_dislike_removals (user_id, action_id, key, removed, settings_rev)
  values (p_user_id, p_action_id, p_key, v_removed, v_rev)
  returning * into v_receipt;

  return jsonb_build_object('status', case when v_removed then 'removed' else 'already_gone' end,
    'action_id', v_receipt.action_id, 'key', v_receipt.key, 'settings', v_current);
end $$;
revoke all on function public.taste_dislike_remove(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.taste_dislike_remove(uuid, uuid, text) to authenticated, service_role;

-- The Undo, with the advisory lock already held: the receipt FOR UPDATE, then the row FOR UPDATE.
create function public._taste_dislike_remove_undo_locked(p_user uuid, p_action_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_receipt taste_dislike_removals%rowtype;
  v_settings user_settings%rowtype;
  v_have_d text[];
  v_restored boolean := false;
  v_capped boolean := false;
  v_current jsonb;
begin
  select * into v_receipt from taste_dislike_removals
   where user_id = p_user and action_id = p_action_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_receipt.undone_at is not null then
    return jsonb_build_object('status', 'already_undone', 'action_id', v_receipt.action_id,
      'key', v_receipt.key, 'restored', v_receipt.restored, 'capped', v_receipt.capped,
      'settings', _sync_current(p_user, 'user_settings', 'settings'));
  end if;

  if v_receipt.removed then
    select * into v_settings from user_settings where user_id = p_user for update;
    v_have_d := case when found then _taste_chips_dislikes_of(v_settings.diet_prefs) else '{}'::text[] end;
    if v_have_d is null then return jsonb_build_object('status', 'settings_unreadable'); end if;
    if v_receipt.key = any(v_have_d) then
      -- Already back on the row (re-added some other way since the remove) -- nothing to do.
      v_current := _sync_current(p_user, 'user_settings', 'settings');
    elsif cardinality(v_have_d) >= 50 then
      v_capped := true;
      v_current := _sync_current(p_user, 'user_settings', 'settings');
    else
      v_current := _taste_chips_write(p_user,
        _taste_chips_with_dislikes(v_settings.diet_prefs, v_have_d || v_receipt.key),
        coalesce(v_settings.cuisines, '{}'::text[]));
      v_restored := true;
    end if;
  else
    -- The remove itself was a no-op (the key was already gone) -- Undo is a no-op too.
    v_current := _sync_current(p_user, 'user_settings', 'settings');
  end if;

  update taste_dislike_removals set undone_at = now(), restored = v_restored, capped = v_capped
   where id = v_receipt.id
  returning * into v_receipt;

  return jsonb_build_object('status', 'undone', 'action_id', v_receipt.action_id, 'key', v_receipt.key,
    'restored', v_restored, 'capped', v_capped, 'settings', v_current);
end $$;
revoke all on function public._taste_dislike_remove_undo_locked(uuid, uuid) from public, anon, authenticated;

-- Undo. Answers `{status: undone | already_undone, action_id, key, restored, capped, settings}`,
-- or `{status: not_found | settings_unreadable}` (nothing written).
create function public.taste_dislike_remove_undo(p_user_id uuid, p_action_id uuid) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  perform _sync_assert_caller(p_user_id);
  if p_action_id is null then raise exception 'action_id_required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':user_settings:settings', 0));
  return _taste_dislike_remove_undo_locked(p_user_id, p_action_id);
end $$;
revoke all on function public.taste_dislike_remove_undo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.taste_dislike_remove_undo(uuid, uuid) to authenticated, service_role;
