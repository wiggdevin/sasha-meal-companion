-- Migration 6 (phase-18 W11, docs/specs/phase-18-open-world-foods.md §W11, D7). "Use my shopping
-- list": a timed opt-in, server-written, read by every plate generator while active. `null` is
-- off; a past timestamp is also off (the read side treats "expired" the same as "unset" — no
-- separate boolean, so there is nothing for a forgotten end date to leave stuck on).
--
-- Server-written only (Sol W11 r1 BLOCK 3/4):
--   * shopping_focus_until    the end; null or past is off.
--   * shopping_focus_action   the id of the write that set the current value (minted here).
--   * shopping_focus_previous the value that write replaced, recorded by the server.
-- A direct authenticated/anon write of any of the three is refused by
-- user_settings_shopping_focus_guard (the user_settings_food_world_guard pattern: security invoker,
-- reads current_user). The sync RPC names its columns and never writes these.
--
-- shopping_focus_set(p_user_id, p_until) and shopping_focus_undo(p_user_id, p_action_id) are
-- service_role only; the route (requireRecipeUser, the Shopping gate) calls them with the session
-- user. Both lock the settings row, so two concurrent writes serialize: the second records the
-- first's value as its previous. Undo is compare-and-set on the action id: it restores the
-- recorded previous value only while the current value is still the one this action wrote (no later
-- set or Undo since), else answers `superseded` and writes nothing.
--
-- Live-safe: three nullable columns, no default (metadata-only, no table rewrite), one trigger
-- (CREATE TRIGGER holds SHARE ROW EXCLUSIVE for a catalog update only) and two functions.
-- Down: supabase/migrations/down/20261227090000_shopping_focus.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.user_settings
  add column shopping_focus_until timestamptz,
  add column shopping_focus_action uuid,
  add column shopping_focus_previous timestamptz;

comment on column public.user_settings.shopping_focus_until is
  'D7 shopping focus ("use my shopping list"): while now() < this, every plate generator ranks by '
  '(fits the slot, list/pantry coverage, score). Null or past is off. Server-written only '
  '(shopping_focus_set / shopping_focus_undo), default end = the open shopping period''s end or 7 days, '
  'max 31 days out.';
comment on column public.user_settings.shopping_focus_action is
  'The shopping_focus_set write that set shopping_focus_until; Undo names it (compare-and-set).';
comment on column public.user_settings.shopping_focus_previous is
  'The shopping_focus_until value that shopping_focus_action replaced; Undo restores it.';

-- Security invoker on purpose: current_user is the role that ran the statement, so a direct
-- PostgREST write reads 'authenticated', while the definer functions below read their owner.
create function public.user_settings_shopping_focus_guard() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
    and new.shopping_focus_until is not distinct from old.shopping_focus_until
    and new.shopping_focus_action is not distinct from old.shopping_focus_action
    and new.shopping_focus_previous is not distinct from old.shopping_focus_previous then
    return new;
  end if;
  if tg_op = 'INSERT' and new.shopping_focus_until is null and new.shopping_focus_action is null
    and new.shopping_focus_previous is null then
    return new;
  end if;
  if current_user in ('authenticated', 'anon') then
    raise exception 'shopping_focus is server-written' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.user_settings_shopping_focus_guard() from public, anon, authenticated;

create trigger user_settings_shopping_focus_guard
  before insert or update of shopping_focus_until, shopping_focus_action, shopping_focus_previous
  on public.user_settings for each row execute function public.user_settings_shopping_focus_guard();

-- One write: the server-decided end (null = off). The route computes and clamps p_until; this
-- re-checks the D7 maximum (31 days, plus a minute of clock slack) so no caller can store more.
create function public.shopping_focus_set(p_user_id uuid, p_until timestamptz) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  v_previous timestamptz;
  v_action uuid := gen_random_uuid();
begin
  if p_user_id is null then
    raise exception 'shopping_focus_set: user required' using errcode = '22023';
  end if;
  if p_until is not null and p_until > now() + interval '31 days 1 minute' then
    raise exception 'shopping_focus_set: end past the maximum' using errcode = '22023';
  end if;
  select shopping_focus_until into v_previous from public.user_settings
    where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('status', 'no_settings');
  end if;
  update public.user_settings
    set shopping_focus_until = p_until, shopping_focus_action = v_action,
        shopping_focus_previous = v_previous
    where user_id = p_user_id;
  return jsonb_build_object('status', 'applied', 'actionId', v_action,
    'until', p_until, 'previous', v_previous);
end $$;

-- Undo: compare-and-set on the action id. `superseded` when another set (or this Undo) has
-- written since; the row is left as it is.
create function public.shopping_focus_undo(p_user_id uuid, p_action_id uuid) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  v_action uuid;
  v_previous timestamptz;
  v_until timestamptz;
begin
  if p_user_id is null or p_action_id is null then
    raise exception 'shopping_focus_undo: user and action required' using errcode = '22023';
  end if;
  select shopping_focus_action, shopping_focus_previous, shopping_focus_until
    into v_action, v_previous, v_until
    from public.user_settings where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('status', 'no_settings');
  end if;
  if v_action is distinct from p_action_id then
    return jsonb_build_object('status', 'superseded', 'until', v_until);
  end if;
  update public.user_settings
    set shopping_focus_until = v_previous, shopping_focus_action = null,
        shopping_focus_previous = null
    where user_id = p_user_id;
  return jsonb_build_object('status', 'undone', 'until', v_previous);
end $$;

revoke all on function public.shopping_focus_set(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.shopping_focus_undo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.shopping_focus_set(uuid, timestamptz) to service_role;
grant execute on function public.shopping_focus_undo(uuid, uuid) to service_role;
