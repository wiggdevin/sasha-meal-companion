-- 2026-10-06 (Gemini project denial, #gemini-fallback): widens ai_calls_status_check (Phase 4,
-- 20260920090000) to the new "permission_denied" status (lib/ai/call-ledger.ts AiStatus) a 403
-- PERMISSION_DENIED classifies as (lib/ai/call.ts classifyFailure, lib/ai/failures.ts
-- isPermissionDeniedFailure). Without this, the insert fails the CHECK constraint, writeAiCall
-- swallows the error (it must not throw on top of a result the caller already has), and the
-- circuit's one-row-opens-it rule (lib/ai/circuit.ts) never sees a row to count at all.
alter table ai_calls drop constraint if exists ai_calls_status_check;
alter table ai_calls add constraint ai_calls_status_check
  check (status in
    ('ok', 'schema_invalid', 'provider_error', 'timeout', 'blocked', 'error', 'permission_denied'));
