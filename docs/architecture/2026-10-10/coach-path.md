# Coach request path

Date: 2026-10-10. Basis: worktree `audit-2026-10-10` at `7405f41f`. Every fact below was read in code. Line numbers are from that commit. Diagram: `coach-path-dd.html` (three views: the turn, the `callModel` gates, apply and Undo).

Two database clients appear throughout:

- **RLS** is the session client. `requireUser` builds it from the caller's JWT (`lib/server/auth.ts:27`). Row-level security applies. Code still adds an explicit `user_id` filter.
- **ADMIN** is the service-role client from `adminClient()`. It skips RLS. Code must pass the user id by hand.

`app/api/coach/route.ts:71` hands both clients to `runTurn`. Each stage then picks one.

## Key point

The server never applies a coach action. A turn returns grounded actions and cards. The phone applies them through its own local write and the sync op-log (`lib/coach/apply-client.ts:119`). Server Undo is a second record, posted after the apply.

## 1. The ask box and its scope

- Every ask box sends `scope`: `component` (one meal card, one slot, one date), `page` (`today`, `body`, `foods`, `settings`) or `global`. Absent means global. Schema: `lib/coach/types.ts:34`. A scope cannot ride with `surface`, `planningSlot` or `planSlot` (`types.ts:190`).
- `lib/coach/scope.ts` is pure. It does three things:
  - `allowedKinds` maps a scope to action kinds (`scope.ts:34`).
  - `actionsInScope` drops other kinds. For a component scope it also drops any action aimed at another slot or date, or spanning dates (`from`, `through`) (`scope.ts:46`).
  - `scopeGuidance` adds one line to the transcript tail (`scope.ts:84`). The system prompt and provider schema never change with scope.
- Scope is enforced twice: on the fast path (`lib/server/coach-turn/fast-path.ts:88`) and on the model's final step (`lib/server/coach-turn/final-step.ts:57`). It narrows; it does not authorize. The client sets it, and a client can always ask the global coach.
- A component scope makes the turn a private `plan` thread (`types.ts:51`) and pins the slot on `suggest_options` and `compose_meal` (`lib/server/coach-turn/plan-slot.ts:29`).
- Scope does not filter cards, drafts or the dietary and taste proposal blocks. Those need a user tap.

## 2. Routes under `app/api/coach/*`

| Route | Limiter | Client |
|---|---|---|
| `POST /api/coach` | IP only, 120/min (`route.ts:68`). No per-user limiter. | RLS + ADMIN |
| `GET/POST /api/coach/threads`, `/threads/[id]`, `/threads/unread` | IP 120/min, then user 60/min | RLS |
| `POST /api/coach/history-sources` | IP 120/min, then user 60/min | RLS |
| `POST /api/coach/transcribe` | IP 120/min | ADMIN (`transcribe/route.ts:30`) |
| `GET/POST /api/coach/undo` (list, record) | user 60/min, after auth | RLS |
| `POST /api/coach/undo/[id]` (perform) | user 30/min, after auth | RLS |

`POST /api/coach` order: `coachEnabled` (404 when off), IP limiter, `requireUser`, `readJson` (16 KB), `runTurn`. `beforeResponseDeadline` answers a retryable 503 at 38 s whatever still runs (`route.ts:44`). `withJevBudget` gives the request three Jev calls (`lib/ai/request-budget.ts:3`).

## 3. `runTurn` stages (`lib/server/coach-turn.ts:112`)

| # | Stage | What it does | Client |
|---|---|---|---|
| 1 | `startTurn` (`coach-turn/setup.ts:33`) | Clocks. Reply deadline 35 s, save deadline 37 s. | none |
| 2 | Attachment turn (`coach-turn/attachment.ts`) | Photo, label or barcode. Checks budget, saves its own rows, skips the stages below. | ADMIN (budget) + RLS |
| 3 | `openTurn` (`setup.ts:57`) | One parallel round: budget, replay of a stored turn by `messageId`, thread, next seq. | ADMIN: `assertTurnBudget`. RLS: `storedTurn`, `resolveThread`, `nextSeq`, `threadHistory`, `readPolicyProfile` |
| 4 | `deflect` | Medical deflection. No model, no cost. | none |
| 5 | `recallHistory` | Saved-chat questions. Cited excerpts, optional model synthesis. | RLS reads. The model call goes through `callModel`. |
| 6 | `passHealthGate` (`setup.ts:110`) | A stored condition or note, with no recorded provider terms, refuses the turn with 503 `nous_unconfirmed`. | RLS (profile read) |
| 7 | `readIntent` (`coach-turn/intent.ts:31`) | Jev intent pre-pass beside the history read. Telemetry runs after the response. | Jev via `callModel` (ADMIN ledger). Telemetry ADMIN |
| 8 | `runFastPath` (`fast-path.ts:49`) | Chart, suggestions, or one grounded action. A miss carries a reason to the model. | RLS + ADMIN (ports, grounding, policy) |
| 9 | `prepareModelTurn` (`model-context.ts:26`) | Attestation check, day context, transcript. | ADMIN + RLS (`buildCoachContext(admin, client, …)`) |
| 10 | `runModelLoop` (`model-loop.ts:24`) | Up to 10 tool calls, 30 s wall clock. | Model call: ADMIN ledger. Tools: RLS + ADMIN |
| 11 | `settleFinalStep` (`final-step.ts:42`) | Scope filter, ground, policy, verify, one correction round. | RLS + ADMIN |
| 12 | `modelReply` (`reply.ts:28`) | Reply check, proposal cards, next-action chip. | RLS + ADMIN |
| 13 | `finish` (`finish.ts:32`) | Link `ai_calls`, save both rows, start the sanity pass, build the response. | RLS: `persist`. ADMIN: ledger link, plan-thread insert (`lib/server/coach-threads.ts:448`) |

The user row is saved only at stage 13, after the reply exists. A retry with the same `messageId` replays a saved turn (stage 3). An unsaved turn runs again.

## 4. Jev intent and the fast path

- `classifyIntent` (`lib/coach/intent.ts:128`) returns null when Jev is not configured or the safety check `mayReachJev` refuses the text. It calls `systemOne` with a 3 s deadline.
- Fast-path rule (`intent.ts:211`): the intent must be mechanical, confidence at least 0.95 for actions and 0.90 for chart and suggestions, every argument at least 0.90, no missing argument, and no wish text on a suggestion. A question from the coach on the last turn blocks it (`coach-turn/intent.ts:86`).
- A hit answers without a generative model: `show_chart`, `suggest_options` (the same executor as the model tool), or one action grounded by `groundActions` then `applyGroundedActionPolicies` (ADMIN). A miss sends a `Likely intent` hint to the model.
- The Plan sheet's structured request skips Jev and always takes the suggestion path.

## 5. Model path through `callModel` (`lib/ai/call.ts:191`)

Gemini goes through `generateStructured` (`lib/ai/adapter.ts:222`). OpenRouter goes through `generateOpenRouter`. Jev goes through `systemOne` (`lib/ai/typesafe.ts:205`). All three call `callModel`. Order:

1. Payload provenance: only a registered builder's payload passes (`call.ts:195`).
2. Registry: purpose, provider and data class (`lib/ai/call-registry.ts:127`). `coach` is Gemini D2. `coach-openrouter` is OpenRouter D2. `coach-intent` and `coach-verify` are Jev D1.
3. Attestation: any Google or OpenRouter call above D0 needs the provider's attestation (`call.ts:80`, `lib/ai/attestation.ts`). Jev has none.
4. Lane admission: Jev's three-call request budget (`typesafe.ts:221`, `request-budget.ts:21`).
5. Circuit: five failures in ten minutes, or one 403, opens it. Read from `ai_calls` with ADMIN (`lib/ai/circuit.ts:73,77`). A read error fails open.
6. Spend reservation: `ai_spend_reserve` against the user cap ($2) and the global cap ($50). Fails closed (`lib/ai/spend.ts:104`).
7. Transport: Gemini 3 attempts, 15 s each, 20 s whole call, backoff 250 ms then 1 s. Jev 2 attempts. The turn wall clock cuts it off.
8. One `ai_calls` row per call, then settle the reservation to actual cost (`call.ts:248`).

Coach models: `gemini-3.6-flash`, fallback `gemini-3.8-flash` on capacity. OpenRouter is a cross-provider fallback when configured and attested (`lib/ai/lanes.ts:62-101`, `model-loop.ts:72`).

## 6. Tools

Tools are read-only and run together in a batch (`tool-batch.ts:125`). The registry caps each tool per turn. `compose_meal` and `suggest_options` are capped at 1 (`lib/coach/registry.ts:187,205`).

- `compose_meal` runs `composeMeal` (`lib/coach/compose.ts:260`). Its pool is eligible Eats only, through `eligibleFoods(client)`. That call throws 409 while a rule review is pending (`lib/server/eligible-foods.ts:73`). `filterRecipeMeal` follows.
- `suggest_options` runs `suggestOptions` (`lib/coach/suggest.ts:104`). It checks rule review first, builds policy-clean candidates, then lets Jev rank a shortlist of 5 to 8 (`suggest.ts:92-94`). A Jev failure keeps formula order. Budget 8 s.
- Port clients (`lib/server/coach-ports.ts:238`): RLS for catalog search, targets, constraints, gut log, recipes, Eats lists, rule review. ADMIN for day totals, day context, expenditure, exact user-food search, `get_or_create_food_ref`, skip preview, `lookup`. Each takes `userId` from the turn, never from the model.

## 7. Action registry (`lib/coach/actions/index.ts`)

22 kinds in `ACTION_SPECS`, one file each. A spec owns its schemas, grounding, history line, prompt line, intent reader and card copy. `actions/apply.ts` binds each kind's client write and Undo; a kind without a binding does not compile. The model's actions pass: scope filter, then `groundAndExpandActions` (names to catalog foods; entries must exist), then `applyGroundedActionPolicies` (ADMIN), then the skip gate. Nothing is written.

## 8. Reply verify

`verifyReply` (`lib/coach/verify.ts:25`) runs only when the final step carries no action (`final-step.ts:174`). Jev answers `claims_unlisted_action`. At 0.80 or more the turn asks the model once more for the action. Jev down, or out of time, falls back to a regex (`claimsAction`). A second claim without an action replaces the reply with "I have not logged that yet" (`reply.ts:37`). Separately, `checkReplyLive` scans prose and cards against the account's food rules.

## 9. Client apply

`applyCoachAction` (`apply-client.ts:119`): per-action idempotency in localStorage (last 50), an in-flight guard, a 20 s timeout. The bound write goes to the local store and the outbox. The outbox posts to `POST /api/sync/ops`, which calls `apply_sync_op` with the RLS client (`app/api/sync/ops/route.ts:52`). After a successful apply the phone posts its Undo token (`startRecording`).

## 10. Server-recorded Undo

- Record: `POST /api/coach/undo` → `recordUndo` → RPC `record_coach_undo` (`lib/server/coach-undo.ts:223`). The database checks that one of the caller's coach messages carries this action id and kind.
- Perform: `POST /api/coach/undo/{id}` → `performUndo` (`coach-undo.ts:314`) → RPC `perform_coach_undo`. Only the record id is sent. The function is `SECURITY DEFINER` and keyed to `auth.uid()` (`supabase/migrations/20261220090100_coach_undo_taste_mode.sql:119`). It branches on `record_mode`:
  - `legacy`: builds the inverse from the stored token, locks the target rows, and returns 409 `undo_conflict` when the row changed since.
  - `receipt_v1`: undoes from `coach_action_receipts` only.
  - `taste_v1`: undoes from `taste_chip_receipts` only.
- `coach_action_undos` is select-only for `authenticated`. Only the two RPCs write it. Records expire after 7 days. The media-sweep cron scrubs the inverse a day later (`app/api/jobs/media-sweep/route.ts:59`).
- The phone uses its own token only when the server certainly did not undo the action (`apply-client.ts:194-205`).

## Findings for the audit

Each item names a file and line. Severity is my read, not a proven exploit.

1. **OpenRouter turns escape the turn budget and the ledger link (medium).** `assertTurnBudget` counts rows with `purpose = 'coach'` (`lib/server/coach.ts:110`). OpenRouter turns write `coach-openrouter` (`lib/ai/call-registry.ts:90`, `lib/ai/openrouter-payloads.ts:66`). The 10 per hour and 60 per day limit never counts them. `finish` links the reply to the latest `coach` row (`lib/server/coach-turn/finish.ts:26,29`, `lib/server/coach-threads.ts:311`), so an OpenRouter reply gets no link or a stale one. Only the spend cap bounds those turns.
2. **No per-user limiter on `POST /api/coach` (medium).** Only the IP limiter runs (`app/api/coach/route.ts:68`). Fast-path and deflected turns write no `coach` row (and a recall turn writes one only when it synthesizes), so they never count toward the 60 per day (`coach.ts:104`). The route header says "60/day and 10/hour per user" (`route.ts:2`). That holds for Gemini model turns only. Every `unknown` IP also shares one bucket (`lib/server/request-ip.ts`).
3. **The budget check can be raced and fails open (low).** It reads, then acts, with no lock (`coach.ts:104-122`). Parallel turns all pass. A failed read returns without blocking (`coach.ts:112`). The spend cap still holds.
4. **The circuit read has no supporting index (medium at scale).** `recentFailureCount` filters `ai_calls` by provider, model, status and `created_at`, with no `user_id` (`lib/ai/circuit.ts:40-52`). It runs twice per `callModel` (`circuit.ts:73,77`). The indexes on `ai_calls` lead with `user_id` or `spend_reservation_id` (`supabase/migrations/20260911000200_user_schema.sql:155`, `20260920090000_phase4_ai_calls_capture.sql:11`, `20261218090100_ai_spend_reservations.sql:110`). Every Jev and model call scans a table that has no retention (see `scale-review.md`).
5. **Self-imposed deadlines count as provider failures (medium).** A deadline or caller abort rejects with name `AbortError` (`lib/ai/call.ts:96-97,108-112`). `classifyFailure` maps that to `timeout` (`call.ts:70`). The circuit counts `timeout` (`circuit.ts:24`) across all users. Jev ranking runs on short deadlines: 450 ms on Plan chips (`lib/server/plan-ideas.ts:40`) and the rest of the suggest budget in the coach (`lib/coach/suggest.ts:216-223`). Five slow answers in ten minutes open the Jev circuit for every user for ten minutes. Intent, verify and ranking all degrade.
6. **Reply verify can be skipped silently (low).** The request budget allows three Jev calls (`request-budget.ts:3,25`). Intent, role advice, suggestion ranking, verify and taste chips share it. A refused call returns null (`typesafe.ts:221`) and verify falls back to the regex (`verify.ts:45`).
7. **The verify payload may carry stored conditions to Jev (known, open).** `call-registry.ts:51-54` records this as the open "incidental D2" case. The health gate checks Gemini and OpenRouter attestation only (`attestation.ts:72`). Jev has no attestation. Intent text can also carry health context.
8. **`receipt_v1` Undo has no writer (low, dead path).** The receipt table and read path exist (`coach-undo.ts:102`, migration `20261216090000_coach_action_receipts.sql:5,54`). The only named writer, `apply_coach_op`, is not in the repo. Only `taste_v1` records have a writer. Every other record is `legacy`.
9. **The wall clock does not cancel the provider call (low).** `withWallClock` races the call but passes no abort signal (`lib/server/coach-turn/deadline.ts:21-30`, `lib/server/coach-turn.ts:78-104`). A call that lost the race can run up to 20 s more, with retries. It is billed and holds its reservation. `route.ts:44` leaves late work running by design.
10. **A same-thread seq race reports "in progress" (low).** `nextSeq` reads the max seq at the start (`coach-threads.ts:299`). `persist` inserts at the end (`coach-threads.ts:465`). Two turns in one thread can take the same seq. The unique constraint turns the loser into a 503 `in_progress` for a message that is not a retry (`coach-threads.ts:466-470`).
11. **Out-of-scope asks may read as failed writes (low, UX).** The scope filter empties `actions` after the model answered. Verify then sees a claim with no action and may force the "I have not logged that yet" reply (`final-step.ts:57,174`, `reply.ts:37`).
12. **Legacy first-client slot names in the intent reader (info).** `namesSlot` still matches `coffee`, `pouches-pre`, `post-refuel` and `hot-chocolate` (`lib/coach/intent.ts:112-126`). AGENTS.md says new accounts get `Meal 1..N` only.
