-- Reverse of 20261220090300_ai_calls_permission_denied.sql. Narrows any "permission_denied" rows
-- back to "error" BEFORE re-adding the stricter six-value check (same order the Phase 4 down file
-- uses, 20260920090000_phase4_ai_calls_capture.down.sql) — the stricter ADD CONSTRAINT would
-- itself fail while a row still carries the value it is about to forbid.
update ai_calls set status = 'error' where status = 'permission_denied';

alter table ai_calls drop constraint if exists ai_calls_status_check;
alter table ai_calls add constraint ai_calls_status_check
  check (status in ('ok', 'schema_invalid', 'provider_error', 'timeout', 'blocked', 'error'));
