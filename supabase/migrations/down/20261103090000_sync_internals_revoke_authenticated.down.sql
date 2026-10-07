-- Reverse of 20261103090000_sync_internals_revoke_authenticated.sql: removes the in-function
-- caller guard only.
--
-- The `authenticated` EXECUTE grant is deliberately NOT restored. Re-granting it reopens the hole
-- the forward migration closed (any signed-in user reading, overwriting or tombstoning another
-- user's rows), and no caller needs it: apply_sync_op is SECURITY DEFINER and runs as owner.

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
    if position('p9_sync_caller_guard' in definition) = 0 then
      continue;
    end if;
    replaced := regexp_replace(
      definition,
      '\n[ \t]*perform _sync_assert_caller\(p_user_id\); -- p9_sync_caller_guard\n',
      E'\n'
    );
    execute replaced;
  end loop;
end;
$migration$;
