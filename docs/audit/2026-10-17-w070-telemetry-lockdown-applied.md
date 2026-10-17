# W070 telemetry lockdown — production receipt (2026-10-17)

PR: #192, merge `d6d18fb547b3aa3f745b9fcadf2ca58b95081d96`. Project `fivatgdpuenszxxnijpc`.

## Review

GPT-6.1 Sol (xhigh) against production baselines (grants, policies, current function bodies): **APPLY**, no BLOCK.
One WARN: `down/20270105140100_client_timings_checks_not_valid.down.sql` re-adds the checks with a validating scan
under ACCESS EXCLUSIVE. Not a blocker (rollback only; `client_timings` has under 1,000 rows). Sent to the coordinator.

## Order applied

| Step | Time (UTC) | Backup |
|---|---|---|
| `20270105140000_telemetry_service_writers`, `140100_client_timings_checks_not_valid`, `140200_client_timings_checks_validate` | 12:10:28 | `2026-10-17T121003Z-80b9c844.sql` (sha256 `aa4f8093…`) |
| Merge #192 | 12:11 | — |
| Deploy live (`/api/health` = merge SHA) | 12:12:25 | — |
| `20270105140300_telemetry_insert_lockdown` (after deploy) | 12:13:14 | `2026-10-17T121252Z-beee772c.sql` (sha256 `0afc0b66…`) |

## Verified

- `record_food_signals_for(uuid,jsonb)` and `record_onboarding_events_for(uuid,jsonb)`: security definer, execute only `postgres`, `service_role`.
- `client_timings_path_check`, `client_timings_step_check`: re-added and `convalidated = true`.
- `has_table_privilege(..., 'INSERT')` is false for `authenticated` and `anon` on `client_timings`, `food_signal_events`, `onboarding_events`.
- Policies left on the three tables: only `food_signal_events_select` (authenticated, owner rows).
- `record_food_signals(jsonb)`, `record_onboarding_events(jsonb)`: execute only `postgres`, `service_role`.
- Ledger 189 of 189 recorded (max `20270105140300`). `/api/health` ok on `d6d18fb5`. Unauthenticated `POST /api/timings` answers 401.
