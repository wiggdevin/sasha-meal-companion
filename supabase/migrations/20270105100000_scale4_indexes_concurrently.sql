-- W044 (scale step 4): indexes for the circuit breaker's read, the food-ref reverse lookup and the
-- retention purge (20270105100100). Every statement is CREATE INDEX CONCURRENTLY, so the tables
-- keep taking writes while each index builds.
--
--   * ai_calls_circuit: lib/ai/circuit.ts `recentFailureCount` filters provider = , model_id = ,
--     status in (...) and created_at >= (the last few minutes) on every model call.
--   * log_items_food_ref: log_items.food_ref_id is a foreign key to food_refs with no index, so a
--     food-ref lookup or a food_refs delete scans every logged item.
--   * ai_calls_created_at: the ai_calls purge walks oldest first, and the spend seed reads one UTC
--     day of ai_calls across every account (20270104140000).
--   * coach_messages_ai_call: coach_messages.ai_call_id references ai_calls(id). Without it every
--     ai_calls row the purge deletes makes the foreign-key check scan coach_messages, and the
--     purge's "no coach message cites this call" test does the same.
--
-- NOT IN A TRANSACTION. CREATE INDEX CONCURRENTLY refuses to run inside a transaction block, so
-- this file has no `set local` lines and nothing but the four statements:
--   * The Supabase CLI (2.120.0, `supabase start` / `db reset` in CI and scripts/test-stack.sh)
--     runs a CONCURRENTLY statement on its own, outside the file's batch (migration-apply.ts
--     `isPipelineIncompatible`), then records the version.
--   * scripts/apply-migrations.py wraps each file in begin/commit and CANNOT apply this file: it
--     fails before building anything and stops there. Apply it by hand instead, as the PR says:
--     `psql "$DB_URL" -v ON_ERROR_STOP=1 -f <this file>` (psql runs each statement in its own
--     implicit transaction), then insert the ledger row for 20270105100000.
--   * A CONCURRENTLY build that fails part way leaves an INVALID index that IF NOT EXISTS then
--     skips. After applying, check `select indexrelid::regclass from pg_index where not
--     indisvalid`; drop any listed here with DROP INDEX CONCURRENTLY and run the file again.
--
-- Order: independent of the code and of 20270105100100; either can go first.
-- Down: supabase/migrations/down/20270105100000_scale4_indexes_concurrently.down.sql.

create index concurrently if not exists ai_calls_circuit
  on public.ai_calls (provider, model_id, status, created_at);

create index concurrently if not exists log_items_food_ref
  on public.log_items (food_ref_id);

create index concurrently if not exists ai_calls_created_at
  on public.ai_calls (created_at);

create index concurrently if not exists coach_messages_ai_call
  on public.coach_messages (ai_call_id) where ai_call_id is not null;
