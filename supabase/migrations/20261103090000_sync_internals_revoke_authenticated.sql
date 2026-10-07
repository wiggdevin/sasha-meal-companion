-- Phase 9 security fix: signed-in users could call the sync internals for another account.
--
-- THE HOLE. _sync_current, _sync_upsert and _sync_tombstone are SECURITY DEFINER, take the owner
-- as p_user_id, and never compared it with auth.uid(): they trusted apply_sync_op to have done
-- that. Every migration that (re)created them revoked EXECUTE only from `public` and `anon`, but
-- Supabase's default privileges grant EXECUTE on new public functions to `authenticated` directly
-- (see 20260912090050_catalog_activate.sql), so that grant was never removed. Production answered
-- has_function_privilege('authenticated', ..., 'execute') = true for all three. Any signed-in user
-- could therefore call them over PostgREST (/rest/v1/rpc/_sync_upsert) with another user's id and
-- read, overwrite or tombstone that user's rows, bypassing RLS because the functions run as owner.
--
-- THE FIX has two layers.
--   1. Revoke EXECUTE from `authenticated` (and again from public, anon). This is the durable layer:
--      privileges belong to the function's pg_proc row and SURVIVE a later `create or replace`, so
--      the next migration that restates _sync_upsert (the house pattern) keeps the revoke. Only a
--      `drop function` + `create function` would reset it; that migration must repeat this revoke.
--   2. Assert the caller inside each function: `perform _sync_assert_caller(p_user_id);` as the
--      first statement. _sync_assert_caller raises 42501 'forbidden' when auth.uid() is set and is
--      not p_user_id; the service role and the owner (psql, migrations) have no auth.uid() and pass.
--      This is defense in depth against a future re-grant. It lives in the function BODY, so a later
--      migration that restates a function from an older full copy drops it — the revoke still holds.
--      Text-patch migrations (pg_get_functiondef + regexp_replace, 20261026090100) carry it forward.
--
-- WHY SAFE FOR CALLERS. The only SQL caller outside the three is apply_sync_op, which is SECURITY
-- DEFINER (runs as owner, so it keeps EXECUTE after the revoke) and itself starts with
-- _sync_assert_caller(p_user_id) — the guard below can never refuse a call apply_sync_op let
-- through. _sync_upsert and _sync_tombstone call _sync_current with their own p_user_id, also as
-- owner. No application code calls the internals directly (lib/ only names them in comments).
--
-- Idempotent: a function already carrying the p9_sync_caller_guard marker is skipped, and revoke /
-- grant are no-ops when already in place.

do $migration$
declare
  fn regprocedure;
  definition text;
  replaced text;
begin
  foreach fn in array array[
    'public._sync_current(uuid,text,text)'::regprocedure,
    'public._sync_upsert(uuid,text,text,jsonb,integer)'::regprocedure,
    'public._sync_tombstone(uuid,text,text,text,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(fn) into definition;
    if position('p9_sync_caller_guard' in definition) > 0 then
      continue;
    end if;
    -- First `begin` line of the body only (no 'g' flag): the guard becomes the first statement.
    replaced := regexp_replace(
      definition,
      '(\n[ \t]*begin[ \t]*\n)',
      $guard$\1  perform _sync_assert_caller(p_user_id); -- p9_sync_caller_guard
$guard$,
      'i'
    );
    if replaced = definition then
      raise exception 'Could not add the caller guard to %', fn;
    end if;
    execute replaced;
  end loop;
end;
$migration$;

revoke execute on function public._sync_current(uuid, text, text) from public, anon, authenticated;
revoke execute on function public._sync_upsert(uuid, text, text, jsonb, integer) from public, anon, authenticated;
revoke execute on function public._sync_tombstone(uuid, text, text, text, integer) from public, anon, authenticated;

grant execute on function public._sync_current(uuid, text, text) to service_role;
grant execute on function public._sync_upsert(uuid, text, text, jsonb, integer) to service_role;
grant execute on function public._sync_tombstone(uuid, text, text, text, integer) to service_role;
