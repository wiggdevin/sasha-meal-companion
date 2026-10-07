-- Rate-based goals (step D, docs/plans/2026-09-22-tdee-engine-plan.md §D; ruling GPT-5.6
-- 2026-09-22).
--
-- A loss or gain goal is now a rate in basis points of body weight a week, from a fixed set of
-- presets, applied on top of the account's own TDEE and clamped to −20 % / +10 % of it. The
-- 1,200 / 1,500 kcal sex floors are gone; the lowest a target may go is the account's own macro
-- minimum (4·protein + 9·50 + 4·100), which the app writes as `kcal_min`. It is a nutrition
-- minimum, never a medical limit.

-- Under scripts/apply-migrations.py (one transaction per file): wait at most 5 s for a table
-- lock, then fail the whole file (rolled back, nothing recorded) instead of queueing every app
-- write behind this migration. Outside a transaction (a local `supabase db reset`) it is a no-op.
-- The locks, once held, last for the file; user_settings and target_profiles hold one row per
-- account and a few revisions each, so the check scans below are short (review r2, accepted).
set local lock_timeout = '5s';

-- The confirmed rate lives with the goal. Null means "not confirmed": an account from before this
-- migration derives at maintenance until the user picks one, and nothing here fills one in.
alter table user_settings
  add column goal_rate_bp_week integer constraint user_settings_goal_rate_bp_week_check
    check (goal_rate_bp_week in (-75, -50, -25, 0, 10, 20, 25));

-- Where a revision's kcal_min came from, so a legacy default (the 1,650 column default or the old
-- sex floors) is never mistaken for a floor the account chose. Every existing row was written
-- under the old rule, so the default labels them honestly; no values are rewritten.
alter table target_profiles
  add column kcal_min_source text not null default 'legacy_default'
    constraint target_profiles_kcal_min_source_check
    check (kcal_min_source in ('macro_minimum', 'account_minimum', 'legacy_default'));

-- An approved proposal now records its weight as the engine's trend weight (`trend`, block 3
-- below). The column allowed only 'weigh-in' and 'onboarding', so every approval of a proposal
-- with a trend weight would fail the check (review r1, docs/audit/code/2026-09-23-pr241-*). Widen
-- it; every existing row already passes the wider check.
alter table target_profiles
  drop constraint target_profiles_input_weight_source_check,
  add constraint target_profiles_input_weight_source_check
    check (input_weight_source in ('weigh-in', 'onboarding', 'trend'));

-- Three installed functions are patched in place by anchored replacement, each anchor required to
-- occur exactly once so every other branch is carried forward byte for byte (the pattern from
-- 20261028090000_body_fat_provenance.sql). Each block is a no-op once its first replacement is
-- present. `execute definition` runs a CREATE OR REPLACE, which keeps each function's owner and
-- privileges; the revoke and grant after each block restate them so the file reads as safe on
-- its own.

-- 1. `_sync_upsert`, user_settings branch: the rate joins the sync contract — an omitted key keeps
--    the stored value, a present JSON null clears it.
do $migration$
declare
  definition text;
  anchors text[] := array[
    'body_fat_measured_on, rev)',
    '(p_payload->>''body_fat_measured_on'')::date, p_rev)',
    'else user_settings.body_fat_measured_on end,'];
  replacements text[] := array[
    'body_fat_measured_on, goal_rate_bp_week, rev)',
    '(p_payload->>''body_fat_measured_on'')::date,
            (p_payload->>''goal_rate_bp_week'')::integer, p_rev)',
    'else user_settings.body_fat_measured_on end,
      goal_rate_bp_week = case when p_payload ? ''goal_rate_bp_week''
        then (p_payload->>''goal_rate_bp_week'')::integer
        else user_settings.goal_rate_bp_week end,'];
  i integer;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position(replacements[1] in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'rate_goals (_sync_upsert): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;

-- Caller guard and privileges, restated from 20261103090000_sync_internals_revoke_authenticated.sql
-- (PR #249). Production applies this file AFTER that migration; a fresh database applies it
-- before. Either way `_sync_upsert` leaves this file with the guard as its first statement and
-- with no EXECUTE for a client role. The anchored patch above keeps an installed guard, and a
-- create or replace keeps the privileges; this block and the revoke make that explicit. The
-- marker check keeps one guard, so 20261103090000 later skips the function.
do $migration$
declare
  definition text;
  replaced text;
begin
  select pg_get_functiondef(
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure
  ) into definition;
  if position('p9_sync_caller_guard' in definition) = 0 then
    -- First `begin` line of the body only (no 'g' flag): the guard becomes the first statement.
    replaced := regexp_replace(
      definition,
      '(\n[ \t]*begin[ \t]*\n)',
      $guard$\1  perform _sync_assert_caller(p_user_id); -- p9_sync_caller_guard
$guard$,
      'i'
    );
    if replaced = definition then
      raise exception 'Could not add the caller guard to _sync_upsert';
    end if;
    execute replaced;
  end if;
end;
$migration$;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;

-- 2. `write_target_revision`: every revision records its kcal_min source. A writer that does not
--    send one (a phone on an older bundle) gets the legacy label, not the account label.
do $migration$
declare
  definition text;
  anchors text[] := array[
    'input_activity_level, input_goal, formula_name)',
    'p_row->>''input_activity_level'', p_row->>''input_goal'', p_row->>''formula_name'')'];
  replacements text[] := array[
    'input_activity_level, input_goal, formula_name, kcal_min_source)',
    'p_row->>''input_activity_level'', p_row->>''input_goal'', p_row->>''formula_name'',
    coalesce(p_row->>''kcal_min_source'', ''legacy_default''))'];
  i integer;
begin
  select pg_get_functiondef('public.write_target_revision(uuid,jsonb)'::regprocedure)
    into definition;
  if position(replacements[1] in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'rate_goals (write_target_revision): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function write_target_revision(uuid, jsonb) from public, anon;
grant execute on function write_target_revision(uuid, jsonb) to authenticated, service_role;

-- 3. `approve_target_proposal`: an approved proposal's weight is the engine's trend weight, and
--    the row says so (`trend`, not `weigh-in`); it also carries the active row's minimum source
--    forward as it already carries the minimum itself.
do $migration$
declare
  definition text;
  anchors text[] := array[
    'then null else ''weigh-in'' end,',
    '''kcal_min'', coalesce(v_active.kcal_min, 1650),'];
  replacements text[] := array[
    'then null else ''trend'' end,',
    '''kcal_min'', coalesce(v_active.kcal_min, 1650),
    ''kcal_min_source'', coalesce(v_active.kcal_min_source, ''legacy_default''),'];
  i integer;
begin
  select pg_get_functiondef('public.approve_target_proposal(uuid,uuid)'::regprocedure)
    into definition;
  if position(replacements[1] in definition) > 0 then
    return;
  end if;
  for i in 1 .. array_length(anchors, 1) loop
    if (length(definition) - length(replace(definition, anchors[i], '')))
       / length(anchors[i]) <> 1 then
      raise exception 'rate_goals (approve_target_proposal): anchor % does not occur exactly once', i;
    end if;
    definition := replace(definition, anchors[i], replacements[i]);
  end loop;
  execute definition;
end;
$migration$;
revoke execute on function approve_target_proposal(uuid, uuid) from public, anon;
grant execute on function approve_target_proposal(uuid, uuid) to authenticated, service_role;
