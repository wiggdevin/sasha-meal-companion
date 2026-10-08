-- Down for 20261228090000_target_writes_service_role_only. Deliberately does NOT re-grant
-- EXECUTE to `authenticated` (the same rule as 20261103090000's down): that grant is the hole
-- the up file closes, and no reviewed rollback needs it re-opened. It only restates the
-- service_role grant, which the up file kept.
--
-- An app build older than lib/server/target-writes.ts calls these RPCs on the session client and
-- gets 42501 after the up file: target writes fail closed. Rolling the app back past this change
-- therefore needs an owner decision, not this file.
set local lock_timeout = '3s';

grant execute on function public.write_target_revision(uuid, jsonb) to service_role;
grant execute on function public.write_target_revision_if_active(uuid, jsonb, uuid, bigint)
  to service_role;
grant execute on function public.write_target_revision_pair(uuid, jsonb, jsonb) to service_role;
grant execute on function public.approve_target_proposal(uuid, uuid) to service_role;
