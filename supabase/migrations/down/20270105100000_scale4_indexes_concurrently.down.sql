-- Reverse of 20270105100000_scale4_indexes_concurrently.sql: drops the four indexes. Nothing
-- depends on them; the circuit read, food-ref lookups and the purge go back to wider scans.
-- NOT IN A TRANSACTION, like the up file: run it with `psql -f`, never inside begin/commit.

drop index concurrently if exists public.ai_calls_circuit;
drop index concurrently if exists public.log_items_food_ref;
drop index concurrently if exists public.ai_calls_created_at;
drop index concurrently if exists public.coach_messages_ai_call;
