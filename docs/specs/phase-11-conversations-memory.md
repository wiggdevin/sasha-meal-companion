# Phase 11 — Conversations and memory

**Audited: GPT-6 Sol round 13 — 0 BLOCK; FIXes applied 2026-09-23.** This build ships the
conversations list only (new chat, open, rename, server-stamped irreversible soft delete via a
`kind = 'chat'`-scoped, idempotent RPC, user-driven search capped at 50 with no pagination, paginated
list with its own dedicated resume query); see "Open for Devin" before planning implementation.
Written 2026-09-22 at Devin's
request. Revised thirteen times by the overnight run: round 1 fixed 9 BLOCK + 8 FIX against the code; round 2 cut
automatic memory writes down to explicit, user-initiated memory; round 3 found 9 more BLOCK + 2 FIX,
resolved with the smallest safe cut; round 4 found 6 more BLOCK + 5 FIX and, after Devin approved
extra rounds to clear blockers, resolved most for real (a tool/draft redesign for what became
`propose_memory`); round 5 found 4 more BLOCK + 3 FIX, three against that same redesign's
transactional fence, and cut bulk "Forget everything" to "Later"; round 6 found 4 more BLOCK + 3
FIX — three of the four BLOCKs again against account memory's write path — and cut account memory
to "Later" in full; round 7 found 2 BLOCK + 3 FIX inside the newly-shipped recall feature, fixed in
place; round 8 then found 4 MORE BLOCK, all four in that same recall feature, sharing one shape — a
guarantee enforced only through the model's own tool-calling or prose choice — so recall moved to
"Later" too; round 9 found 2 BLOCK + 3 FIX in the remaining conversations core (an incomplete RLS
grant, a missing tombstone filter, two missing backfills, no pagination, an overstated cache
guarantee), all fixed in place; round 10 (2026-09-23) then found 3 MORE BLOCK + 3 FIX, every one a
gap in round 9's OWN fixes caught on the very next pass (an ordinary chat's tombstone still had no
irreversibility guard; the new search and list pagination used two incompatible sort orders; the
new cross-device cache-eviction rule assumed one complete list page, which the new pagination made
false) — each resolved by the SIMPLEST fix, not new machinery (an irreversible-transition trigger, a
plain 50-result cap with no pagination for search, per-thread eviction-on-open instead of list-
diffing); round 11 found 1 BLOCK + 3 FIX + 1 NIT, nearly clear — the BLOCK closed one more gap in
round 10's tombstone fix (a server-stamped, idempotent RPC now owns `deleted_at` entirely, not just
the undelete direction), and the FIXes/NIT were narrow, concrete corrections (a dedicated resume
query, evicting cache on a delete retry, a preview/time trigger that recomputes on message
edit/delete too, and a corrected claim about `CACHE_LIMIT`); round 12 (2026-09-23) then found ONE
MORE BLOCK in round 11's own new RPC — `soft_delete_thread()` checked ownership but not `kind =
'chat'`, so as a `security definer` function bypassing RLS entirely, it could tombstone the
onboarding or weekly-review thread — plus four FIX-level gaps in round 11's other fixes (the
preview trigger only recomputed the NEW thread when a message moved between threads, not the OLD
one it left; the resume query's "has a message" check broke the moment an emptied thread started
falling back to `created_at`; the delete-retry cache fix assumed a 404 retry, contradicting the
RPC's own idempotent-2xx contract; and `persist()`/`writeWeeklyReview()` were still writing their
OWN `last_message_at` over the trigger's value every turn, despite the trigger being named as
"owning" that column) — every one fixed in place, none requiring a further cut; round 13
(2026-09-23) — the first non-blocking verdict, SHIP WITH FIXES, 0 BLOCK — found 4 more FIX, all
gaps in round 12's own fixes (authenticated writes could still forge the two derived list columns
directly; the backfill only recomputed a null `last_message_at`, leaving every wrong-but-non-null
value from the old manual writers in place; the Success Criteria overstated the row lock's
guarantee as "deletion always wins" rather than the commit-order guarantee it actually enforces;
three prose passages still described the pre-round-11 plain-`.update()` delete and the pre-round-11
insert-only trigger) — every one fixed in place. §2 and §3 both
carry design lessons forward for the two cut features; "Resolution of audit round 1-13" and "Open
for Devin," both at the end, have the detail; "Next audit," also at the end, names what happens
next. Part 3 of 4 in the multi-user program; depends on
Phase 9 — its tenancy security migrations
(`20261103090000`/`20261103090100`) are APPLIED to production and this spec now builds on their
exact deployed rules rather than its own prior plan (Facts, below); its device-cache isolation slice
(PR #248) is still unmerged and this spec targets that slice's API, not the one already shipped —
and reads the onboarding thread Phase 10 creates.

## Goal

A user keeps many conversations with the coach, can find and reopen any of them, and can search
back through them directly when they want to find something they said earlier — the way scrolling
up in a long chat history should work, but searchable by the user themselves. (Two earlier goals —
the coach remembering account-level facts across every conversation, and the coach searching back
through earlier conversations on the user's behalf — are "Later," §2 and §3: eight audit rounds
found structural problems specifically in those two features, cut rather than shipped half-safe.)

## Facts this spec rests on (verified 2026-09-22 against the code)

- `coach_threads` columns today: `id`, `title text` (nullable, no length check,
  `supabase/migrations/20260911000200_user_schema.sql:143`), `user_id`, `created_at`,
  `kind` (check `in ('chat','weekly_review')`, default `'chat'`,
  `supabase/migrations/20261001000000_phase7_coach.sql:9`), `rev`, `last_message_at`,
  `deleted_at` (same file, lines 10–11), `summary` (nullable, ≤ 600 chars,
  `supabase/migrations/20261020110000_coach_thread_summary.sql:14-16`). `coach_messages` has a
  denormalized `user_id` (`20261001000000_phase7_coach.sql:19-23`) and a unique `(thread_id, seq)`.
  APIs: `app/api/coach/threads/route.ts` (list, create), `app/api/coach/threads/[id]/route.ts`
  (read, soft-delete).
- **Correction — title is not new work, and it is not model-written.** The title already exists as
  a column and is already written once, at thread creation, from whichever value comes first: the
  client's own `title` in the POST body (`app/api/coach/threads/route.ts:11,45`), or — the only
  path the app itself uses today — the raw first user message, truncated to 80 characters
  (`lib/server/coach-threads.ts:159-166`, called from `lib/server/coach-turn.ts` at the deflection
  path, line 252, and the main turn path, line 797). There is no rename: `[id]/route.ts` has GET
  and DELETE only, no PATCH.
- **Correction — DELETE already soft-deletes.** `app/api/coach/threads/[id]/route.ts:62-66` sets
  `deleted_at` and 404s a second delete. What is missing is the purge job (§1) and the rename
  endpoint (§1), not the soft-delete itself.
- **Correction — there is no thread-list UI.** `ThreadSummary` (`lib/coach-client.ts:30`) and
  `listThreads()` (`lib/coach-client.ts:258-260`) exist, but their only caller,
  `app/coach/CoachScreen.tsx:61-63`, uses the list once, silently, to reopen the most recently
  active chat thread on load. No component renders a list, a sheet, search, rename, or delete.
- **Thread memory already ships and is a separate mechanism from what this spec adds.** The model
  rewrites the WHOLE thread `summary` on every final reply — prompt rule 13
  (`lib/coach/prompt.ts:110-118`), parsed by `turnStepSchema`'s `final` branch
  (`lib/coach/turn.ts:90-98`), written by `persist()` (`lib/server/coach-threads.ts:159-182`), read
  by `threadHistory()` (`lib/server/coach-threads.ts:116-132`) and rendered by `buildHistory()`
  (`lib/coach/history.ts:106-124`) together with the last `MEMORY_MESSAGES` (12,
  `lib/coach/history.ts:32`) messages, capped at 6,000 tokens
  (`MEMORY_TOKEN_CAP`, `lib/coach/history.ts:33`). The wire field is `memory`; the DB column is
  `summary`. This mechanism is out of Phase 11's reach — round 2 finding 3 (below) is about exactly
  this: deleting an account memory does not, and under this cut still does not, rewrite what a
  thread already summarized about itself.
- **Round 4 finding 10, FIX: the device-cache fact above is now stale — an unmerged Phase 9 slice
  changes the exact function signatures it cites.** Round 2/3 correctly found `cacheKey()`/
  `readCache()`/`writeCache()` already user-bound at every call site by caller convention (a plain
  `${userId}:${threadId}` string). PR #248 (Phase 9's device-cache-isolation slice, unmerged,
  `.claude/worktrees/agent-af9e42fc3664b612b/lib/coach-client.ts:85-93`) replaces that convention
  with a typed `AccountHandle` parameter — `cacheKey(h: AccountHandle, threadId)`, `readCache(h:
  AccountHandle | null, threadId)` — imported from a new `lib/account/*`-style module
  (`accountHandle`, `accountKey`, `isCurrent`, `assertCurrent`, `rethrowAccountChanged`) and also
  requires an `x-smc-account` header on data routes. Fix: Phase 11's OWN new client code
  (`searchThreads()`, §1; the memory confirm-sheet's commit call, §2) is written against the
  POST-#248 signature — an `AccountHandle` parameter, not a bare `userId` string — and Phase 11's
  new routes (`GET /api/coach/threads?q=`, `POST`/`PATCH`/`DELETE /api/coach/memories`) send/accept
  `x-smc-account` the same way every other data route will once #248 lands. This spec still needs
  no schema or migration change of its own for this — it is a client-side contract Phase 11's slices
  must simply target correctly, landing after #248 merges (§Tightening).
- **Confirmed — the context budget, and its shrink list is finite.** `CONTEXT_TOKEN_CAP = 2_500`
  (`lib/server/coach-context.ts:25`), consumed by `renderCoachContext()` (same file, lines
  206-266), which builds one JSON object and shrinks it through an ordered list of five trim steps
  (lines 246-252) until it fits, THEN RETURNS whatever it has even if it is still over the cap —
  this is, and always was, a best-effort budget with no hard floor, not something Phase 11
  introduces or can turn into a guarantee on its own (round 2 finding 15).
- **Confirmed — the tool registry shape.** `lib/coach/registry.ts` is one frozen array
  (`Object.freeze`, line 42); an entry is `{ name, description, input: z.ZodType, effect: "read" |
  "draft", maxCallsPerTurn }` (lines 21-28). `ToolName` (lines 15-16) is a closed string-literal
  union a new tool must be added to by hand. Every `ToolName` also needs a matching key in
  `makeExecutors()`'s `Record<ToolName, Executor>` return (`lib/coach/executors.ts:42,78`) or the
  build does not compile.
- **Confirmed — coach ACTIONS are a separate system from coach TOOLS, and every ACTION is
  auto-applied client-side the instant it is received; every TOOL is server-executed during the
  turn and a `"draft"` tool never applies itself.** `CoachAction` (`lib/coach/actions.ts`) is a
  discriminated union the model fills in `actions`; a received action becomes `status: "pending"`
  in chat state (`lib/coach/chat-state.ts:109-120`) and is applied automatically, with no
  confirmation step, by `applyCoachAction()` (`lib/coach/apply-client.ts`, wired from
  `components/coach/CoachShell.tsx:150-165`) — this is safe for every EXISTING action kind because
  each is reversible (Undo) and low-stakes if wrong. A TOOL, by contrast (`lib/coach/registry.ts`,
  `effect: "read" | "draft"`), runs SERVER-SIDE during the turn itself; a `"draft"` tool
  (`draft_log_entry` is the one example today) "never persists on its own" — it returns a
  `CoachDraft` the FINAL reply carries to the client (`draftToProposeResponse()`,
  `lib/coach-client.ts:283-291`), which renders a confirm sheet (`CaptureSheet`) that only writes
  when the user explicitly taps through it, via a SEPARATE endpoint. Round 4 finding 2 (below)
  found that trying to make an ACTION behave like a draft — confirm-before-apply — conflicts with
  how actions are already wired (auto-apply, persisted-as-if-happened history); §2 below makes
  `remember_fact` a TOOL, using the EXISTING draft/confirm pattern, not an action.
- **Applied to production (round 4 new fact): `20261103090000` and `20261103090100`.** Two
  migrations already live change ground Phase 11 must build on. `20261103090000` (PR #249) revokes
  a signed-in user's ability to call the sync internals (`_sync_upsert`) for another account.
  `20261103090100` (PR #250,
  `.claude/worktrees/agent-a539615ca814cfaf9/supabase/migrations/20261103090100_same_owner_references.sql`)
  adds one `before insert or update` trigger per child table that REFUSES (raises `42501`, the same
  code RLS uses) a row that references another account's parent — including
  `_same_owner_coach_messages()` (lines 140-152), which REFUSES a `coach_messages` insert whose
  `user_id` disagrees with its thread's owner, rather than correcting it — and widens
  `coach_messages`'s RLS policy to `user_id = auth.uid() AND` an `exists` check that the thread also
  belongs to `auth.uid()` (lines 393-401). It also drops `plan_days`' client `DELETE` grant. Round 2
  and 3's plan for `coach_messages` (silently CORRECT a mismatched `user_id`) directly conflicts
  with this deployed REFUSAL rule — round 4 finding 5 (below) reconciles them. Every Phase 11
  migration must sort after `20261103090100`, not only after `20261029090000`.
- **Confirmed — the coach-verify Jev check, and where its evidence actually comes from.**
  `lib/coach/verify.ts:24-58` runs one Jev `noul` question under `purpose: "coach-verify"`. The
  turn's per-tool-call `result` field (`lib/server/coach-turn.ts:520`) is only attached
  `if (persistResult)`, where `persistResult = hydrated.block !== null || (recipe?.refusals.length
  ?? 0) > 0` (`lib/server/coach-turn.ts:733`) — true only for tools that produce a persisted UI
  block. An ordinary read tool's result is computed in the same scope (the local `data` variable,
  `lib/server/coach-turn.ts:727`) but is NEVER copied into `toolCalls[i].result` unless it also
  happens to produce a block. (This fact drove round 2 finding 7's fix for `recall_conversations`'s
  evidence path — moot this round, since recall is cut to "Later," §3.)
- **Confirmed — `profile` (the current goal/weight/target line) is fetched conditionally, not
  every turn.** `buildCoachContext()`'s `Promise.all` only calls `profileContext()` when
  `needsProfileContext(classified)` is true — an `update_profile`/`set_targets`/`log_weight` intent,
  or a question containing a weight/target/calorie word (`lib/server/coach-context.ts:97-103,
  187-198`). On an ordinary turn, `profile` is `null`. §2's `goal_context` handling below accounts
  for this (round 2 finding 4).
- **Superseded — `kind = 'onboarding'` was never added, and onboarding never shipped on coach
  threads.** The `coach_threads` kind check constraint only ever grew to `'chat'`, `'plan'` and
  `'weekly_review'` (`supabase/migrations/20261126090000_coach_conversations.sql:5`); the
  onboarding system that actually shipped (`components/Onboarding/ConversationalOnboarding.tsx`)
  uses its own scope (`{ kind: "page", page: "onboarding" }`) and has no `onboarding_drafts` table
  or `coach_threads` reference anywhere in the codebase. The passages below describing a pinned
  `kind = 'onboarding'` thread, its RLS and its purge exclusion describe the Phase 10 draft design,
  not what shipped — read them as historical only.
- `app/api/export/route.ts` exists today for meals, weight, progress, recipes, favorites, water,
  body-profile and body-data. It does not export threads, messages, or memories.
- `scripts/backup.sh` runs `scripts/lib/database_backup.py`, a whole-database `pg_dump` that keeps
  the last N dumps (`--keep`, default 14, `scripts/lib/database_backup.py:125-172`) — a
  keep-last-N policy, not a 30-day one.
- House pattern for full-text search: `catalog_food_revisions` uses a plain `tsvector` column,
  `setweight()` over `unaccent()`, and a GIN index
  (`supabase/migrations/20260912090000_catalog_tables.sql:19-29`).
- House pattern for a daily cron job: `app/api/jobs/media-sweep/route.ts` — `runtime = "nodejs"`,
  rate limit first, then a bearer check against `CRON_SECRET` with `timingSafeEqual`, batched
  `adminClient()` work, an age constant, a batch-size constant.
- Settings lives at `app/settings/page.tsx`, built from `components/settings/*Section.tsx` cards.
  `DataAccountSection` (`components/settings/DataAccountSection.tsx`) already wraps `ExportCard`
  and `SyncStatus` under "Data & account."

## Scope

In (this build, after round 6's and round 8's cuts):
1. A conversations list: new chat, open, rename, delete (soft, then purged after 30 days), with
   titles from the existing first-message mechanism and the latest first. Search by title and text
   — driven by the USER, through the list's own search box.

Out, cut to "Later":
- Account memory, entirely, as of round 6: writing (whether automatic/inferred, round 2's cut, or
  explicit/user-initiated, rounds 3-6's redesigns), reading it back into context, Settings' "What
  your coach remembers," export, and bulk "Forget everything."
- Coach-driven recall, entirely, as of round 8: the `recall_conversations` tool, its Jev-backed
  verifier, and the historical-target enforcement that depended on it. The user can still search
  their own conversations directly (in scope, above) — the coach searching on the user's behalf is
  what is cut.

Eight audit rounds found structural problems concentrated in these two features specifically, never
in the conversations list itself — see "Later" for the consolidated reasons and the design lessons
carried forward for each. Also out, unrelated to either cut: embeddings/vector search, sharing
conversations, voice history.

## Why account memory and recall are cut — the short version (full history in "Later" and the
per-round Resolution tables)

Round 2 cut automatic, model-inferred memory writes to "Later" (no safe background-write primitive
in this codebase). Rounds 3-5 then found repeated structural problems in an EXPLICIT,
user-initiated version instead (a wire-shape mismatch, an auto-apply conflict, a broken Undo, an
unsafe transactional fence, a type mismatch). Round 6 found three more BLOCKs in the same write
path (non-atomic writes, a trigger with no permission to run, a response field with no client
consumer) and the coordinator's explicit instruction was to cut the whole feature rather than
attempt a fourth redesign.

Round 7 then found and fixed genuine in-core gaps in the SEPARATE recall feature (self-recall,
a text-only Jev fallback, a missing writer, an unprotected pinned thread, an unlabeled historical
number) — real progress, not a repeat of the memory pattern. But round 8 found FOUR MORE BLOCKs, all
in that same recall feature, all sharing one shape: a guarantee enforced only through the model's
own tool-calling choice or its own prose, never through something that holds independent of what the
model does. Three straight rounds (6, 7, 8) narrowing down to the same feature is the same signal
account memory gave at round 6 — cut it, per the coordinator's decision, rather than attempt a
fourth design under the same pattern. See "Later" for what ships instead and what a future attempt
should carry forward, for both cut features.

## Decisions made by this run

Each decision below replaces a PROPOSED line or an open question from the draft. Devin can
override any of them; the reason is there so he can see why the run picked it.

1. **DECIDED (run), applies to account memory's "Later" design — delete keeps the memory, drops the
   citation.** A memory that cites only a deleted thread stays; only `source_thread_id`/
   `source_message_id` are cleared. Reason: `coach_memories` rows are account facts, not thread
   content. Not shipped this round (§2, round 6 cut) — carried forward as a design decision for
   whenever account memory ships.
2. **DECIDED (run), applies to account memory's "Later" design — keep the proposed memory `kind`
   list**: `preference | fact | goal_context | routine | dislike`. Reason: covers every
   account-level fact category this spec's writing rule allows (medical stays out, in
   `constraint_profiles`, per Phase 10's confirm rule). Not shipped this round.
3. **DECIDED (run) — full-text search (Postgres `tsvector` + GIN), not embeddings.** Reason: house
   pattern already running for catalog search; no new extension, no embedding calls, no new
   provider cost. Shipped this round through the conversations list's own search box (§1); coach-
   driven recall built on the same infrastructure is cut to "Later" (§3, round 8).
4. **DECIDED (run), superseded by the round 2 cut, now moot under the round 6 cut — memory writes
   are synchronous and user-initiated, not a background job.** Kept for the historical record only;
   no memory writes ship this round at all.
5. **DECIDED (run) — the 30-day purge deletes from Postgres on schedule; it does not scrub backup
   dumps.** A full-database backup taken before a purge can still hold the purged rows until it
   rolls off the keep-last-14 rotation. No table's purge scrubs backups today; Phase 11 does not
   invent a stronger guarantee for itself. (The `memories` export kind this decision originally
   referenced is deferred with the rest of account memory, §2.)

## 1. Conversations

- List at the top of the chat shell (a sheet on phone). Each row: title, one-line preview, relative
  time. The onboarding thread (`kind = 'onboarding'`, Phase 10) and the weekly review are pinned
  labels, not ordinary chats — **round 6 finding 6: no Rename or Delete control on either**, since
  Phase 10's own RLS refuses both for an onboarding thread and neither pinned row is meant to be an
  editable conversation.
- **Round 7 finding 4, FIX: hiding the Delete BUTTON is not the same as refusing the DELETE, and
  Phase 10's restriction only covers `kind = 'onboarding'`.** The onboarding thread is safe because
  Phase 10's own RLS refuses an authenticated user's `UPDATE`/`DELETE` on it outright — but Phase
  10's spec never mentions `kind = 'weekly_review'`, and the existing `DELETE` route filters only by
  owner and id, not kind (`app/api/coach/threads/[id]/route.ts:62-66`), under RLS that still permits
  owner `UPDATE`/`DELETE` for any kind (`supabase/migrations/20260911000500_rls.sql:12-22`) — so a
  direct API or PostgREST call CAN soft-delete the weekly-review thread today, hiding it, while
  `writeWeeklyReview()` (`lib/server/coach.ts:105-116`) would then create a SECOND, active one next
  Sunday (it looks for `kind = 'weekly_review' and deleted_at is null`, finds none, inserts one) —
  and the purge job (§1, `kind = 'chat'` only) would never clean up the orphaned first one, since it
  deliberately excludes this kind. Fix, Phase 11's OWN migration (this concept — pinned, non-chat
  threads — belongs to Phase 11, not Phase 10, so Phase 11 owns extending it): the SAME restrictive
  shape Phase 10 gives `kind = 'onboarding'` (RLS refuses `authenticated` `UPDATE`/`DELETE` on
  `coach_threads`, and `insert`/`update`/`delete` on `coach_messages`, when the thread's `kind =
  'weekly_review'`; `resolveThread()` 404s a normal turn for that kind too, the same way it already
  will for onboarding). **Round 9 finding 1, BLOCK: `UPDATE`/`DELETE` is not the whole list —
  `INSERT` was left open.** The owner RLS pattern-1 grant permits `authenticated` `INSERT` on
  `coach_threads` (`supabase/migrations/20260911000500_rls.sql:17`), and nothing in the round-7
  fix refused one carrying `kind = 'weekly_review'` — a direct PostgREST call could create a SECOND
  pinned weekly-review thread of the user's own, before the cron ever runs (which itself only
  reuses an EXISTING active one, `lib/server/coach.ts:105`, so it would not notice or fix a
  user-created duplicate). Fix: the same migration also refuses `authenticated` `INSERT` on
  `coach_threads` when `kind = 'weekly_review'` (and, for symmetry with what Phase 10 already does,
  confirms `kind = 'onboarding'` is refused too, not only update/delete) — the service-role writer
  (`writeWeeklyReview()`, `admin` client) is unaffected, since these restrictive policies apply to
  `authenticated` only. Test: a direct `authenticated` `INSERT` carrying `kind = 'weekly_review'`
  is refused, run BEFORE any weekly review exists for the account (the gap the cron's own
  find-or-create logic would not otherwise catch). Test also: a direct `DELETE`/`UPDATE` against
  the weekly-review thread's id is refused, matching the onboarding test already specified.
- Title: unchanged mechanism — the first user message, truncated to 80 characters
  (`lib/server/coach-threads.ts:159-166`). New work: a rename control (`PATCH
  /api/coach/threads/[id]`, owner-checked the same way GET and DELETE already are), shown only on
  `kind = 'chat'` rows.
- **"New chat" must not pre-create an empty, untitled thread — and round 6 finding 4 found round
  4's remount fix cannot actually fire a second time.** `POST /api/coach/threads` can already create
  a thread with no title (`app/api/coach/threads/route.ts:37-46`), but `persist()` only derives a
  title from the first message when the turn arrives with `req.threadId === null`
  (`lib/server/coach-threads.ts:159-166`) — "new chat" still calls no route; the thread is still
  created lazily on the first send. Round 4's fix (`key={threadId ?? "new"}`) assumed the PARENT's
  `threadId` prop would change to the newly-created thread's real id once the first turn resolves —
  it does not: `CoachScreen`'s `resume.threadId` state starts and stays `null` for a lazily-created
  thread (`app/coach/CoachScreen.tsx:99`), `onThreadSaved` only writes `localStorage`
  (`rememberCoachThread`), and `CoachShell` learns the real id purely INTERNALLY, in its own
  reducer, after the turn (`components/coach/CoachShell.tsx:232`). So after the first message ever
  sent, a SECOND "new chat" press would compute the SAME key (`"new"`, since the parent's copy of
  `threadId` never changed) — no key change, no remount, the old transcript stays. Fix: a
  generation counter, not a value derived from a possibly-stale `threadId`. `CoachScreen`'s
  `CoachConversation` gets one more piece of state, `const [chatGen, setChatGen] = useState(0)`.
  "New chat" calls `setChatGen((g) => g + 1)` (a fresh, always-different key on EVERY press,
  regardless of what the parent does or does not know about the thread that just got created).
  Opening a thread from the list sets `resume.threadId` to that real id directly — already unique,
  no generation bump needed. Deleting the OPEN thread does both: reset to `threadId: null` AND bump
  `chatGen`, the same as "new chat." `CoachChat`'s `key` prop becomes the join of `resume.userId`,
  `resume.threadId` (or a fallback marker when null), and `chatGen` — changes on every one of the
  three triggers, never depends on `CoachShell` ever reporting its internally-learned id back up.
  Any in-flight load for the PREVIOUS thread is cancelled by the remount unmounting its effect (the
  existing `current`/`alive` guard flags already stop a stale response from applying after unmount).
  Test: send a first message (lazy-creating a thread), press "new chat," send another message
  (lazy-creating a SECOND thread), press "new chat" again — each press must show an empty composer,
  and the two created threads must both appear, separately, in the list. Also: switch threads while
  a turn is in flight — the old thread's late reply must not appear in the newly opened one.
- **Round 2 finding 11, FIX: the list needs a preview, and search needs an endpoint.** The current
  list response is `id, title, kind, last_message_at` only (`app/api/coach/threads/route.ts:23-31`)
  — no preview text, and no search at all. Fix: `coach_threads` gets one more denormalized column,
  `last_message_preview text` (≤ 160 chars). `GET /api/coach/threads` and `ThreadSummary`
  (`lib/coach-client.ts:30`) both widen to carry it. A new client method, `searchThreads(query)`
  (`lib/coach-client.ts`), calls a new `GET /api/coach/threads?q=<query>` branch on the SAME route,
  which delegates to §Tightening's search RPC. **Round 7 finding 3, FIX: `persist()` is not the
  only writer of `coach_messages`, so setting the preview only there misses a whole thread kind.**
  The round-2 plan set `last_message_preview` by hand in the SAME `persist()` update that already
  writes `last_message_at` — but `writeWeeklyReview()` (`lib/server/coach.ts:123-133`) is a
  SEPARATE writer for the weekly-review thread, inserting a `coach_messages` row and updating only
  `last_message_at`, never touching `last_message_preview`; every weekly review would show a blank
  preview forever. This is the exact shape §Tightening's search-doc reasoning already names (SIX
  known `persist()` call sites, and now a SEVENTH, wholly separate writer function) — the same fix
  applies, on the parent row this time: a trigger on `coach_messages` keeps `coach_threads`'
  `last_message_preview` (and, per round 11 finding 4 below, `last_message_at` too) in sync,
  maintained centrally, so no app code path (today's six, `writeWeeklyReview()`'s one, or any
  future writer) can forget it.
  **Round 12 finding 5, FIX: naming the trigger as the owner of `last_message_at` is not the same
  as making it the ONLY writer — two existing functions still write their OWN, later value right
  after the insert the trigger already fired on.** `persist()`
  (`lib/server/coach-threads.ts:173`, `patch.last_message_at = new Date().toISOString()`, then
  `.update(patch)`) and `writeWeeklyReview()` (`lib/server/coach.ts:132-133`, `.update({
  last_message_at: new Date().toISOString() })`) both patch `coach_threads.last_message_at` with
  the APPLICATION's own wall-clock read, AFTER their own message insert has already fired the
  trigger below — silently overwriting the trigger's (more correct, message-`created_at`-derived)
  value with a slightly later one, every single turn. Fix: BOTH writers drop this manual
  `last_message_at` write entirely — `persist()`'s `patch` object keeps `summary` when present but
  no longer sets `last_message_at`; `writeWeeklyReview()`'s trailing `.update(...)` call is removed
  outright, since setting the preview was the only OTHER thing it did and that is already the
  trigger's job too. The trigger (below) becomes the sole writer of both columns, for every path
  that inserts a `coach_messages` row today or in the future — that is what "owns" means here, not
  merely "computes a value nothing then overwrites."
  **Round 11 finding 4, FIX: an `after insert` trigger goes stale the moment a user directly
  EDITS or DELETES their latest message — direct `UPDATE`/`DELETE` on `coach_messages` is already
  permitted by RLS (`supabase/migrations/20260911000500_rls.sql:55-58`, a `for all` grant scoped
  through the parent thread).** An insert-only trigger has nothing to say about a later edit or
  delete of what it already wrote — the preview (and `last_message_at`) would keep showing content
  the thread no longer actually ends with. Fix: the trigger fires on `after insert or update or
  delete on coach_messages`, and instead of copying the triggering row's own value, it RECOMPUTES
  from whichever message is now actually latest: a small function, `refresh_thread_preview(p_thread
  _id uuid)`, runs `update coach_threads set last_message_preview = (select left(content, 160) from
  coach_messages where thread_id = p_thread_id order by seq desc limit 1), last_message_at =
  coalesce((select created_at from coach_messages where thread_id = p_thread_id order by seq desc
  limit 1), coach_threads.created_at) where id = p_thread_id`. **Round 12 finding 2, FIX: an
  `UPDATE` can change `thread_id` itself — the deployed ownership rule allows moving a message
  between the SAME user's own threads — and recomputing only the NEW thread leaves the OLD one's
  preview stale.** The trigger calls `refresh_thread_preview()` for `new.thread_id` on every
  insert/update, AND — only when `tg_op = 'UPDATE' and old.thread_id is distinct from
  new.thread_id` — ALSO calls it for `old.thread_id`, so a moved message refreshes BOTH threads it
  ever touched, not only the one it ends up in; a delete calls it once, for `old.thread_id` (the
  row no longer exists to read `new` from). **Round 12 finding 3, FIX (see also the resume-query
  fix below): a thread whose only message is deleted falls back to `created_at` as its
  `last_message_at` — correct for LIST ORDERING, but that same non-null value had been treated
  elsewhere as proof the thread has a message, which is no longer true.** The list itself is
  unaffected (an emptied thread sorting by its own `created_at` is exactly the desired behavior,
  matching a never-messaged thread); the resume query (below) is the ONE place this ambiguity
  actually mattered, and is fixed there directly, not by changing what this trigger stores. Test:
  edit the latest message's content — the list preview updates to match; delete the latest message
  — the list preview and time fall back to the next-latest message, or to the thread's own
  `created_at` if none remain; move a message to a DIFFERENT thread the same user owns — both the
  origin and destination threads' previews update correctly. **Round 5
  finding 6, FIX (still applies): a NEW column is empty for every EXISTING thread until it next
  gets a message.** The SAME migration that adds the trigger also runs a one-time backfill,
  `update coach_threads t set last_message_preview = left(m.content, 160) from (select distinct on
  (thread_id) thread_id, content from coach_messages order by thread_id, seq desc) m where
  m.thread_id = t.id and t.last_message_preview is null`, covering every existing thread
  regardless of which writer created its latest message. **Round 9 finding 3, FIX: `last_message_at`
  ITSELF needs the same backfill — it is not new, and was never guaranteed either.** Phase 7 added
  `last_message_at` as a bare nullable column with no backfill of its own
  (`supabase/migrations/20261001000000_phase7_coach.sql:11`), and §1's own first bullet already
  promises "latest first" and a relative time on EVERY row — a pre-Phase-7 thread with a null
  `last_message_at` breaks both. **Round 13 finding 2, FIX: a `where ... is null` backfill only
  fills GAPS — it leaves every value `persist()`/`writeWeeklyReview()` already wrote WRONG in
  place, which round 12 finding 5 (above) just proved those functions were doing every turn until
  this build.** Every thread that already has a message carries a `last_message_at` stamped by the
  application's own later wall-clock read, not the message's `created_at` — non-null, so a
  `... is null` backfill skips it and leaves it wrong forever. Fix: the backfill statement drops
  the `is null` condition on `last_message_at` and recomputes it UNCONDITIONALLY, from the message
  row, for every thread that has at least one message — `update coach_threads t set
  last_message_preview = coalesce(t.last_message_preview, m.content_preview),
  last_message_at = m.created_at from (select distinct on (thread_id) thread_id, left(content, 160)
  as content_preview, created_at from coach_messages order by thread_id, seq desc) m where
  m.thread_id = t.id` — `last_message_preview` still only fills a null (a good existing preview is
  never a target of forgery the way a manually-set timestamp is), but `last_message_at` is always
  overwritten from the actual latest message, never conditioned on its current value. A thread with
  no messages at all still gets no row from this `update` (nothing to compute from) and keeps
  `last_message_at is null`, exactly as `coalesce(last_message_at, created_at)` already expects
  (§Tightening, pagination). Test: a pre-migration thread whose `last_message_at` is already
  non-null but does NOT match its latest message's `created_at` (the exact shape `persist()` and
  `writeWeeklyReview()` produced before round 12) is corrected by the backfill to the message's
  actual `created_at`; a thread from before Phase 7 shipped (null `last_message_at`) still gets one;
  a weekly review generated after this ships shows a real preview in the list, not a blank row.
- **Round 9 finding 4, FIX, TIGHTENED by round 10 finding 4: the list route has no page limit, and
  Supabase silently truncates at 1,000 rows; the ordering value must never be null.**
  `GET /api/coach/threads` (`app/api/coach/threads/route.ts:23-31`) selects the whole list in one
  unpaged query; `supabase/config.toml:10` sets `max_rows = 1000` project-wide, past which
  PostgREST truncates the response with no error — a long-lived account quietly loses access to its
  oldest conversations, breaking the "a user can find any conversation" promise (Success criteria)
  with no warning to anyone. Fix: stable cursor pagination, matching the shape this codebase already
  uses elsewhere for paged reads (`?before=<seq>&limit=50` on `GET /api/coach/threads/[id]`,
  §Facts) — `GET /api/coach/threads` takes `?before=<cursor>&limit=<n, default 50, max 100>`,
  ordered by `coalesce(last_message_at, created_at) desc, id desc` for a stable tiebreak, returning
  a `nextCursor` built from that SAME pair. **Round 10 finding 4: `last_message_at` is nullable, and
  an EMPTY thread (created but never messaged, `app/api/coach/threads/route.ts:37-46`) has no
  backfill to fill it — a bare `last_message_at` cursor would have no value to order that row by.**
  Fix: `coalesce(last_message_at, created_at)` is the ONE ordering value used everywhere — the
  query's `order by`, the cursor's own value, and the relative time the list row displays — so
  every thread, including one with no messages yet, sorts and displays correctly with no special
  case. The list UI loads the first page, then loads more on scroll (the same "load older" pattern
  `Transcript`'s own message history already uses inside a thread). **Round 10 finding 5, FIX:
  pagination changes the RESPONSE SHAPE, and an existing caller reads the old one.**
  `listThreads()` (`lib/coach-client.ts:258-260`) currently returns a bare `ThreadSummary[]`, and
  `CoachScreen.tsx:61` calls `.find()` directly on that array to pick the most recent chat thread
  to resume — both need to change together with the route, in the SAME PR, or the resume path
  breaks silently. Fix: `listThreads()`'s return type becomes `{ threads: ThreadSummary[];
  nextCursor: string | null }`, matching the route. **Round 11 finding 2, FIX: page one, ordered by
  `coalesce(last_message_at, created_at)`, is NOT the same as "the most recent chat that has a
  message" — an empty thread's `created_at` can easily be more recent than a real conversation's
  `last_message_at`, so enough empty chats (`app/api/coach/threads/route.ts:37-46` permits creating
  one) can fill page one and push the actual most-recently-MESSAGED chat to page two, where
  `CoachScreen.tsx:61`'s `.find(t => t.lastMessageAt !== null)` would never see it.** Fix: resume
  does not reuse the general paginated list at all — it is a SEPARATE, dedicated, unpaged query
  (a new small route or an RPC, not `GET /api/coach/threads`), returning at most one row, so an
  empty thread can never shadow it regardless of how the general list happens to be paged.
  `CoachScreen.tsx:61` calls THIS instead of `listThreads()`. **Round 12 finding 3, FIX: `last_
  message_at is not null` stopped being proof of "has a message" the moment the round-11 preview
  trigger started falling back to `created_at` for an EMPTIED thread (its last message deleted) —
  that thread's `last_message_at` is non-null too, just no longer messaged.** Fix: the resume
  query checks for an ACTUAL message row directly, not the derived timestamp: `select t.id from
  coach_threads t where t.user_id = auth.uid() and t.kind = 'chat' and t.deleted_at is null and
  exists (select 1 from coach_messages m where m.thread_id = t.id) order by t.last_message_at desc
  limit 1` — the `exists` clause is the actual proof; `last_message_at` is used only for the
  `order by`, exactly as the general list already uses it, never as a stand-in for "has a
  message." Test: create 60 empty chats (more than one page), then send a message in an OLDER chat
  created before all of them — reload — confirm resume still opens that messaged chat, not an
  empty one. Separately: message a chat, then delete that message (emptying it) — confirm resume
  does NOT select that now-empty chat, even though its `last_message_at` is still non-null (round
  12 finding 3). Also: an account with more than 1,000 threads (or a lower test-only limit) can
  still reach its oldest one through repeated pagination of the GENERAL list, not truncated
  silently; an empty thread (no messages) appears in the list at its creation time, not blank or
  missing.
- Delete: sets `deleted_at` (already shipped); new work is a daily purge job, on the
  `app/api/jobs/media-sweep/route.ts` pattern, that hard-deletes `coach_messages` rows (and then
  the `coach_threads` row) 30 days after `deleted_at`. Four fixes, all from the audit:
  - **A soft-deleted thread must not take new turns, including mid-flight and on replay (round 1
    finding 5, sharpened by round 2 finding 8, sharpened again by round 3 finding 7, and again by
    round 8 findings 3 and 5).** `resolveThread()` (`lib/server/coach-threads.ts:98-108`) gets
    `.is("deleted_at", null)` added to its `.select("id")` query, so a soft-deleted thread 404s the
    same way a foreign one already does, BEFORE the model call. A `before insert on coach_messages`
    trigger refuses the insert when the parent thread's `deleted_at` is not null. **Round 3 found
    this trigger alone is not atomic against a CONCURRENT soft-delete**: a plain read of
    `deleted_at` inside the trigger can see the row as still active if a competing transaction has
    not committed its own delete yet, then both commit and the insert lands anyway. Smallest safe
    fix, no new machinery: the trigger's read becomes `select deleted_at from coach_threads where
    id = new.thread_id for update` — one locking clause, standard Postgres, not a new subsystem —
    which forces the insert to wait for any in-flight delete on that same thread row to finish
    first. **Round 8 finding 5, FIX: the trigger only fires on INSERT, but the deployed RLS also
    permits an owner's `UPDATE` of an existing message** (`20261103090100_same_owner_references.sql
    :393`), including `thread_id` — a user could re-point an existing message at a deleted thread
    and the insert-only trigger would never see it. Fix: `before insert or update of thread_id on
    coach_messages`, same locked check, same function — one trigger definition, two firing events.
    `storedTurn()` (`lib/server/coach-threads.ts:60-88`) gets the SAME `deleted_at` check added to
    its own thread lookup, so replaying an already-saved message cannot hand back a transcript for a
    thread the user has since deleted. **Round 8 finding 3, BLOCK: `storedTurn()` is not the only
    replay path.** `runTurn()` branches to attachment turns BEFORE it ever reaches `storedTurn()`
    (`lib/server/coach-turn.ts:228`), and the attachment path has its OWN, separate replay function,
    `replay()` (`lib/server/coach-attachments.ts:93-113`), which reads `coach_messages` back by id
    with no `deleted_at` check of any kind — an attachment retry against a deleted thread would
    succeed where an ordinary retry already correctly 404s. Fix: `replay()` gets the identical
    `deleted_at` check `storedTurn()` already has, on the same join to `coach_threads`. Test: a
    retried attachment turn against a thread deleted since the original request is refused, the
    same as an ordinary retry already is.
  - **Round 10 finding 1, BLOCK, REPLACED by round 11 finding 1: blocking the null→non-null-back
    transition was not enough — the TIMESTAMP itself was still user-controlled.** Authenticated
    owners still have direct `UPDATE` (and `INSERT`) on `coach_threads` for `kind = 'chat'`
    (`supabase/migrations/20260911000500_rls.sql:17`, the shared pattern-1 grant, untouched for this
    kind) — round 10's trigger stopped an undelete, but said nothing about the VALUE of
    `deleted_at` once it is non-null: a direct call could still insert a brand-new thread with
    `deleted_at` already set to a past date (making it purge-eligible immediately, skipping the
    30-day grace entirely), or `UPDATE` an existing tombstone's `deleted_at` further into the
    future (never becoming purge-eligible). Fix, the smallest version that closes both: `deleted_at`
    becomes a column `authenticated` cannot write AT ALL, directly — the value is always stamped by
    the database, never accepted from the client.
    1. **A single `before insert or update on coach_threads` trigger, for `authenticated` only**
       (skipped entirely when the caller is `service_role`, exactly as round 10's did): on
       `INSERT`, forces `new.deleted_at := null` regardless of what the client sent — a new thread
       is never born already deleted. On `UPDATE`, refuses the write outright whenever
       `new.deleted_at is distinct from old.deleted_at` — ANY change to the column, in either
       direction or to a different non-null value, not only the null→non-null-back case round 10
       covered. `authenticated` can still rename a thread. **Round 13 finding 1, FIX: this trigger
       guarded `deleted_at` only — the SAME pattern-1 grant that let a client forge `deleted_at`
       (`supabase/migrations/20260911000500_rls.sql:17`) also lets a direct `INSERT` or `UPDATE`
       set `last_message_preview` or `last_message_at` to any value the client wants, including a
       fake preview or a future timestamp, since those are ordinary columns on the same
       `for all`-granted table.** Fix: the same trigger ALSO forces `new.last_message_preview :=
       null` and `new.last_message_at := null` on `INSERT` (a new thread is never born with a
       preview or a time it hasn't earned), and on `UPDATE` refuses the write whenever
       `new.last_message_preview is distinct from old.last_message_preview` OR
       `new.last_message_at is distinct from old.last_message_at` — with ONE exception: the check
       is skipped when `current_user` is the maintenance function's owner, not the `authenticated`
       role, because `refresh_thread_preview()` (below) is redefined `security definer, set
       search_path = ''`, owned by a privileged role — so its own internal `update coach_threads`
       runs as that owner, not as `authenticated`, and this guard tells the two apart by role, the
       same way `soft_delete_thread()` already tells a legitimate elevated write from a client one.
       `authenticated` gets no execute grant on `refresh_thread_preview()` itself (`revoke execute
       ... from public, anon, authenticated; grant execute ... to service_role;`) — only the
       trigger mechanism invokes it. Test: a direct authenticated `INSERT` on `coach_threads`
       carrying a non-null `last_message_preview` or `last_message_at` lands with both null; a
       direct `UPDATE` attempting to set either column to any value is refused; sending an ordinary
       message still updates both columns correctly through the trigger path, unaffected.
    2. **Soft delete becomes an RPC, not a plain `.update()`.** `soft_delete_thread(p_thread_id
       uuid)`, `security definer`, `set search_path = ''`, following the house pattern
       (`write_target_revision_pair`, `revoke execute ... from public, anon; grant execute ... to
       authenticated, service_role;`): checks the thread belongs to `auth.uid()` **AND that its
       `kind = 'chat'`** (RLS is bypassed inside a `security definer` function, so both checks are
       the function's own job, not RLS's — round 12 finding 1, BLOCK: a `security definer` function
       does not inherit the RLS restrictions that keep an authenticated user from touching the
       onboarding or weekly-review thread; without its OWN `kind = 'chat'` check, this RPC would be
       a backdoor around Phase 10's own protection and §1's own `kind = 'weekly_review'` RLS —
       accepting a request against either pinned kind and tombstoning it anyway, since the function
       runs with elevated privilege and RLS never gets a chance to refuse it), then sets `deleted_at
       = now()` ONLY if it is currently null. **Round 12 finding 4, FIX: what a REPEAT call returns
       needs its own contract, distinct from "unknown/foreign thread."** A second call for a thread
       the caller OWNS and that is ALREADY deleted returns success (2xx) — the RPC is idempotent by
       design, so calling it again is not an error, it is confirmation that the delete already
       happened. A call for a thread the caller does NOT own, or that does not exist, or that is not
       `kind = 'chat'`, returns not-found (404) — the SAME answer a first, ordinary failed attempt
       would get, so a caller cannot distinguish "never existed" from "not yours" (no id
       enumeration). The `DELETE` handler (`app/api/coach/threads/[id]/route.ts:55-71`) calls this
       RPC instead of `.update({ deleted_at: ... })` and returns the RPC's own 2xx/404 verdict
       directly — the TIMESTAMP itself is always `now()` as the database's own clock sees it, never
       a value the client supplies or could backdate/postdate.
    Test: a direct `INSERT` carrying a non-null `deleted_at` lands with it null anyway; a direct
    `UPDATE` attempting to set, clear, or change an existing `deleted_at` value is refused; the RPC,
    called twice in a row for the same OWNED thread, succeeds (2xx) both times with the SAME
    timestamp persisted from the first call; the RPC called against the onboarding thread, the
    weekly-review thread, or another account's thread, is refused (404) every time, never
    tombstoning it.
  - ~~A citation must clear for every way a thread can be soft-deleted~~ — **moot this round.**
    This existed only to clean up `coach_memories.source_thread_id`/`source_message_id`, and
    account memory is cut to "Later" (§2) — there is no citation column to clear. **Round 13
    finding 4, FIX: this bullet still described the pre-round-11 `.update()` design — corrected.**
    The `DELETE` handler (`app/api/coach/threads/[id]/route.ts:55-71`) calls the
    `soft_delete_thread()` RPC (§1, round 11 finding 1, `kind = 'chat'`-scoped per round 12 finding
    1), not a plain `.update({ deleted_at: ... })` — no citation-clearing trigger is needed for
    THIS build regardless, since there is no citation column this round, but the delete PATH itself
    is the RPC, not a direct update. (The lesson — a trigger that must write a table the calling
    role has no grant on needs `SECURITY DEFINER` with a fixed search path — is carried forward in
    §2 for whenever account memory ships and this citation exists again.)
  - **Round 2 finding 9 / round 6 finding 6, BLOCK+FIX, CORRECTED by round 13 finding 4: the purge,
    and Delete itself, must never touch the onboarding thread — but once Delete goes through a
    `security definer` RPC (round 11/12), RLS is no longer what protects it from THAT path.**
    Phase 10's plan blocks an authenticated user's `UPDATE` or `DELETE` on a `kind = 'onboarding'`
    thread at the RLS layer entirely (`docs/specs/phase-10-conversational-onboarding.md:606-612`,
    "The onboarding thread is closed to every other writer") and states plainly that the UI needs
    no Delete control for it. That RLS block still matters — it is what refuses a DIRECT,
    non-app PostgREST write against the onboarding thread, and §1's own `kind = 'weekly_review'`
    RLS (round 7 finding 4, round 9 finding 1) does the same for the weekly review. But the APP's
    OWN delete route no longer goes through RLS at all: it calls `soft_delete_thread()`, a
    `security definer` function that bypasses RLS by design — so for THIS path specifically, the
    RPC's OWN `kind = 'chat'` check (round 12 finding 1) is what refuses the onboarding or
    weekly-review thread, not RLS. Both guards are real and both are needed, for two different
    write paths (the app's RPC, and a direct database write) — neither is "the primary" one to the
    exclusion of the other. Fix: the conversations list UI (§1's first bullet) hides Rename and
    Delete for the pinned onboarding and weekly-review rows — they are labels, not editable rows,
    matching Phase 10's own design rather than merely tolerating it. The purge query stays scoped
    to `kind = 'chat'` only, as defense in depth. Test: a direct `DELETE /api/coach/threads/[id]`
    call (going through the RPC) against the onboarding thread's id is refused by the RPC's own
    `kind` check; a direct, non-app PostgREST write against the SAME thread is separately refused
    by Phase 10's RLS — both paths tested, neither assumed to cover the other.
  - **Round 8 finding 6, FIX, REWORKED by round 9 finding 5 and round 10 findings 3 and 6: a
    deleted thread is still sitting in the device cache after the server call succeeds — the
    deleting device is fixed by a direct removal; another device is fixed on OPEN, not by
    comparing against a page of the list.** PR #248's cache API
    (`.claude/worktrees/agent-af9e42fc3664b612b/lib/coach-client.ts:85-111`) stores each thread's
    transcript in `localStorage` under an account-scoped key, per device. Two parts:
    1. **The deleting device.** `lib/coach-client.ts` gets one more small function, `removeCache(h:
       AccountHandle | null, threadId: string): void`. **Round 10 finding 6, FIX: the earlier draft
       called `cacheKey(h, threadId)` directly with a possibly-null `h`, but `cacheKey()` requires a
       non-null `AccountHandle` — a type error, not just an edge case.** Fix, matching
       `writeCache()`'s own existing guard exactly: `if (h === null) return; cacheStorage()
       .removeItem(cacheKey(h, threadId));`. The client's delete handler calls it immediately after
       a successful `DELETE /api/coach/threads/[id]` response, before updating the list UI. **Round
       11 finding 3, FIX, CORRECTED by round 12 finding 4: a lost response needs its retry to be
       SAFE, and the RPC's own idempotent contract (above) already makes it so — evict on 2xx, not
       on a 404 that no longer means what it used to.** If the server commits the delete but the
       response never reaches the client (a dropped connection, an app backgrounded mid-request), a
       retry of the SAME delete call now goes through `soft_delete_thread()` (finding 1, above),
       which returns 2xx for a repeat call against a thread the caller owns — deleted or not — and
       404 only for a thread the caller does not own, that does not exist, or that is not `kind =
       'chat'`. Fix: the delete handler calls `removeCache()` (and clears an open transcript, if
       this thread is the one currently showing) on a 2xx from that specific delete call, INCLUDING
       a retry's 2xx — never on a 404, which now means "not yours or not found," not "already
       deleted," and evicting on it would let a mistyped or foreign id clear a cache entry it has no
       business touching. Test: delete a thread, simulate a lost response (server commits, client
       never sees the 2xx), retry the same delete — confirm the RETRY's 2xx clears the cache and
       any open transcript, not left stale; a delete attempt against an id the account does not own
       gets a 404 and does NOT touch that account's own cache for any thread.
    2. **Every other device — round 10 finding 3, BLOCK: "evict anything absent from the list" is
       wrong once the list is PAGED, because an active thread can simply be on a page the device
       has not fetched yet, and would be wrongly evicted as if deleted.** Round 9's fix (compare a
       fetched list page against the cache, evict what's missing) assumed one complete list; §1's
       own pagination fix (above) makes that assumption false. Fix, smaller and more precise:
       eviction happens per-thread, at the point a specific cached thread is actually OPENED, not
       by diffing a page. `getThread()`/`fetchOlder()` (`lib/coach-client.ts:262-275`) already call
       `GET /api/coach/threads/[id]`, which already 404s for a deleted thread
       (`.is("deleted_at", null)`, existing behavior). The client's open-thread path calls
       `removeCache()` on THAT 404 the same way the delete handler does on a successful delete, and
       clears the transcript from view if it was already showing (the user had it open when it was
       deleted elsewhere). **Round 11 finding 5 (NIT): `CACHE_LIMIT` does not do what the earlier
       draft said it does — say what it actually does instead.** `CACHE_LIMIT` (`lib/coach-client
       .ts:22,104`) trims the MESSAGE LIST inside one already-cached thread's own entry to its last
       50 messages — it has no effect on WHICH thread keys exist in `localStorage`, and evicts no
       thread's cache entry as a whole. Fix, a documentation-only correction: a cached thread the
       user never reopens stays in `localStorage`, in full, until that device either opens it
       (triggering the 404-based eviction above) or the user/browser clears that origin's site
       storage — there is no automatic whole-entry aging, by `CACHE_LIMIT` or anything else. This
       is a narrower, honest guarantee: "opening a deleted thread on any device always shows it is
       gone and clears the stale cache for it," not "every device's cache is proactively swept
       clean on any schedule." Test: a thread active and cached on a device, but sitting on list
       page two the device has not fetched, is NOT evicted by a page-one-only list fetch; the SAME
       thread, if deleted and then explicitly opened on that device, 404s and is evicted and
       cleared from view at that point.
- Search BY THE USER: Postgres full-text (Decision 3): a plain `tsvector` column on
  `coach_messages` (over `content`) and `coach_threads` (over `title`), `setweight`/`unaccent` as in
  `catalog_search_doc()`, a GIN index on each, exposed through the list's own search box
  (`searchThreads()`, above). §Tightening below specifies how these columns stay current and how
  the query itself is exposed. This is the ONLY search this build ships — the user searches their
  own past conversations directly; the COACH does not search on the user's behalf this round (§3,
  round 8 cut).

## 2. Account memory — CUT to "Later" (round 6)

**Round 6, BLOCKs 1-3 of 4: three more BLOCKs, all against account-memory WRITES, on the fourth
round to specify that one feature (round 4: 3 BLOCK; round 5: 4 BLOCK, 3 against the same write
path; round 6: 3 BLOCK, again against the write path). Per the coordinator's explicit instruction —
"cut harder... move account memory writes to Later entirely if memory keeps producing BLOCKs" — this
is now cut, not attempted a fourth design.** The three findings, for the record: (1) a contradiction
must insert a new row, mark an old one superseded, AND possibly evict over the cap — three writes
the round-5 "ordinary, no transaction" design left non-atomic, so a failure mid-sequence could hide
a fact, leave two contradicting ones active, or blow the cap; (2) the citation-clearing trigger on
`coach_threads` needs to `UPDATE coach_memories`, but `coach_memories` has NO update policy for
`authenticated` at all (by round 4's own design) and a default `SECURITY INVOKER` trigger runs as
the deleting user, who has no such grant — the trigger as specified could not actually run; (3) the
new `memoryProposal` response field has no real client consumer — `nextChatState()`
(`lib/coach/chat-state.ts:109`) does not know this field exists and drops it, so nothing would ever
render the Save/Not now card the whole design exists to show. Three real, structural gaps, every one
inside the account-memory WRITE path specifically (not the schema, not recall, not the conversation
list) — the pattern across rounds 4-6 is the signal, not any one finding.

**What ships instead:** conversations (§1, unchanged) and recall (§3, unchanged — `recall_conversations`
searches conversation THREADS and MESSAGES, a full-text index, nothing to do with `coach_memories`).
Account memory — the `coach_memories` table, `propose_memory`, `MemoryProposal`, the commit/PATCH/
DELETE routes, the account-memory context-block injection, the `goal_context` staleness guard, the
Settings "What your coach remembers" section (§4 old content, below), and the structured-field
write-time exclusion (round 6 finding 7) — is ALL deferred to "Later," as one feature, not shipped
this round. See "Later" for what a future attempt should carry forward from six rounds of findings,
so it does not restart from zero.

**Lessons carried forward for a future attempt** (schema, RLS, and architecture choices worth
reusing, not re-deriving):
- Schema: `coach_memories(id, user_id, kind in (preference|fact|goal_context|routine|dislike),
  text ≤ 200 chars, source_thread_id, source_message_id, confirmed, superseded boolean,
  superseded_by, created_at, updated_at)`. Use `superseded boolean` for "active," never
  `superseded_by is null` (an `on delete set null` FK can resurrect a row).
- RLS: owner `select`/`delete` only, no `insert`/`update` for `authenticated` — every write
  goes through a validated server route running the medical judge, so a memory can never become
  medical text through a direct database write, including Edit.
- Architecture: a memory save is a PROPOSAL needing confirmation, which is a `"draft"` TOOL
  (`effect: "draft"`) with ITS OWN response field and client component — never a `CoachAction`
  (auto-applies, no confirm step) and never literally `CoachDraft`/`CaptureSheet` (food-specific;
  define a distinct type and component instead).
- Safety: the medical judge is a probability, not a boolean — thresholded (≥ 0.50 refuses,
  matching Devin's own more conservative established value), and a failed/unavailable judge also
  refuses (fail-closed). A `goal_context` memory needs the CURRENT profile/target state injected
  alongside it whenever it is shown, or it can read as authoritative when it is stale — and the
  write-time judge must also refuse a candidate that restates a number or rule a structured field
  (`target_profiles`, `day_templates` (does not exist; phase 9 §2 is Later), `constraint_profiles`) already owns, checked at EVERY write
  path (create, Edit, and any future bulk path), not only where it was first specified (round 6
  finding 7).
- Atomicity: dedupe (`same`/`updates`/`contradicts`) plus cap eviction is 2-3 related writes that
  must succeed or fail together — a real transaction or a tightly-scoped `SECURITY DEFINER`
  function is needed, following `write_target_revision_pair`'s house pattern (explicit
  `revoke`/`grant execute`, an internal caller-identity check, no caller-suppliable account
  parameter) — with the Jev judges called from the ROUTE, in JavaScript, before that transaction
  opens, never described as running "inside" one.
- Client wiring: a new response field needs an explicit reducer case or callback wired into
  whatever consumes the turn response (`nextChatState()`, `lib/coach/chat-state.ts:109`, drops any
  field it does not know about) — naming a field on a type is not the same as the client
  displaying it.
- A citation-clearing trigger that runs as an ordinary user (`SECURITY INVOKER`) cannot `UPDATE` a
  table that user has no update grant on — it needs `SECURITY DEFINER` with a fixed, empty
  `search_path`, matching the house pattern already used elsewhere in this codebase.

## 3. Recall across conversations

**Round 8, BLOCKs 1-4 of 4: all four findings are inside coach-driven recall
(`recall_conversations`, its Jev verifier, and the historical-target guarantee that rides on it).**
Per the coordinator's decision — Devin accepted the cut — this whole mechanism moves to "Later."
The four findings, for the record: (1) the Jev-unavailable fallback only fired when the model
actually CALLED `recall_conversations`, but the turn schema lets a final reply skip every tool call
entirely, so the model could simply answer from its own guess with no tool call and no fallback ever
triggering; (2) a failed-verification fallback swapped the REPLY TEXT but not the actions/drafts/
cards riding alongside it, so "I can't check that" could still ship with a guessed food silently
added to Avoid; (3) the deleted-thread replay check (§1) only covered `storedTurn()`, missing the
attachment-turn's own separate replay path — fixed directly in §1, since it is a core conversations
bug, not a recall one; (4) the historical-target label and prompt line (round 7's fix) were
advisory only — nothing enforced that a present-day number came from a successful CURRENT read
rather than model prose, so the "never presented as current" success criterion had no actual gate
behind it. Findings 1, 2 and 4 are structural: each is a case where TEXT-level fixes (a fallback
message, a prompt line) cannot enforce a guarantee that needs to hold regardless of what the model
chooses to say or call — the same shape of problem across three straight rounds (6, 7, 8) on this
one feature.

**What ships instead:** conversations (§1) with full-text search THE USER drives directly through
the list's own search box — the user finds their own past conversations by searching for them, the
same tool this spec has shipped since round 1. The coach does not search on the user's behalf this
round.

**Lessons carried forward for a future attempt** (do not re-derive from round 1):
- A tool the model may or may not call cannot be the sole gate for a correctness guarantee — the
  guarantee needs to hold whether or not the model chooses to invoke the tool, which likely means
  checking retrieval evidence exists BEFORE trusting any claim shaped like "what I said earlier,"
  not only after a specific tool call is observed.
- A failed-verification fallback must discard EVERYTHING the turn produced that depended on the
  unverified claim — actions, drafts, cards — not just swap the reply text. Persist and return the
  fallback as if it were the whole turn's output, not a text patch over a turn that still happened.
- A "historical, not current" guarantee needs an enforcement point OUTSIDE model prose — likely a
  deterministic check (matching the existing `reply-check.ts` pattern, which already validates
  foods, not free-form numbers) that refuses to let a present-day numeric claim through unless a
  current-revision read actually succeeded this turn, rather than a label plus a prompt instruction
  the model can still ignore or misapply.
- Exclude the active thread from any conversation search (round 7 finding 1's fix, still correct);
  carry source thread and date with any retrieved evidence, not a bare snippet (also still correct).
- The full-text search infrastructure itself (`search_doc` columns, GIN indexes, the
  `security invoker` RPC, §Tightening) is NOT recall-specific — it is shared with §1's user-driven
  search and ships this round; a future recall attempt reuses it rather than rebuilding it.

## 4. The user's control

This version has no Settings "What your coach remembers" section, because there are no memories to
show — the whole feature (writing, reading, editing, exporting, deleting) is cut to "Later"
with the rest of account memory (see §2 and "Later"). `app/api/export/route.ts` and
`ExportCard.tsx` are UNCHANGED this build — no `memories` kind, no download button — since
there is nothing yet to export.

## Later (deferred out of this spec's build)

- **Account memory, entirely (round 6 cut).** Six audit rounds put a total of roughly a dozen BLOCK
  findings against pieces of this one feature — writing (rounds 2, 4, 5, 6), reading/staleness
  (round 2), recall-claim verification (round 2's original design lived here before it moved to
  §3), and the client wiring to show a proposal at all (round 6). Round 6's specific three: writes
  are not atomic across dedupe + supersede + cap eviction; the citation-clearing trigger needs
  `SECURITY DEFINER` and did not have it; `memoryProposal` had no client consumer. Per the
  coordinator's explicit instruction this round, the feature — schema, writes, reads, Settings,
  export — is cut to Later as ONE unit rather than re-specified a fourth time. §2 carries forward
  the concrete design lessons (schema shape, RLS pattern, the tool-not-action architecture, the
  medical threshold, the atomicity requirement, the client-wiring requirement, the trigger-privilege
  requirement) so a future attempt starts from round 6's findings, not from round 1's. Two things
  folded into this same cut, no longer separate items: bulk "Forget everything" (round 5 had
  already deferred this on its own; it is now moot, since there is no per-memory write to bulk) and
  automatic, model-inferred memory writes (round 2's original deferral, for the same underlying
  reason — this codebase has no safe background-write primitive yet, `lib/server/after-response.ts`
  is deliberately best-effort).
- **Suppressing a forgotten fact inside a thread's own rolling `summary`.** Not applicable to this
  build (no memories are written to forget), but the underlying gap is real and will resurface
  whenever account memory ships: deleting a memory would not rewrite what a thread already
  summarized about itself (round 2 finding 3, round 3 finding 1) — that reaches into Phase 7's
  shipped thread-summary mechanism and needs its own review, whenever account memory is picked back
  up.
- **Coach-driven recall, entirely (round 8 cut).** `recall_conversations`, its Jev-backed verifier,
  and the historical-target enforcement built on top of it — three straight rounds (6, 7, 8) found
  BLOCK findings here, round 8's four all sharing one shape: a guarantee enforced only through the
  model's own choice to call a tool or its own prose, never through something that holds
  independent of what the model does. §3 carries forward the concrete lessons (verify retrieval
  independent of tool-call observation; discard the WHOLE turn's dependent output — actions, drafts,
  cards — on a failed verification, not just the reply text; enforce "historical, not current"
  deterministically, the way `reply-check.ts` already validates foods, not through a label and a
  prompt line alone) so a future attempt starts from round 8's findings. The full-text search
  infrastructure itself is NOT part of this cut — it ships this round as the user's own search
  (§1) and a future recall attempt reuses it rather than rebuilding it.

## Tightening for implementability

- **Round 4 finding 5, BLOCK: the migration floor moved, and Phase 11 is now the FOURTH program
  slice into this window, not the first.** `20261103090000` and `20261103090100` are APPLIED to
  production (Facts, above); Phase 9's own plan uses `20261104`–`20261107`, Phase 10 starts at
  `20261110`. Fix: every Phase 11 migration this build actually needs (the `coach_messages`
  deleted-thread-lock trigger, now firing on `insert or update of thread_id` — round 8 finding 5 —
  the three search columns plus their GIN indexes and maintenance triggers, `coach_threads.
  last_message_preview` and its maintenance trigger and backfill — round 5 finding 6, round 7
  finding 3 — the `kind = 'weekly_review'` restrictive RLS and `resolveThread()` block — round 7
  finding 4 — the `kind = 'onboarding'` widening if Phase 10 has not already done it) is
  timestamped `20261115` onward — not `20261029090000`, which is now three program slices stale.
  Re-check `ls supabase/migrations | sort | tail -1` at implementation time regardless. (No
  `coach_memories` table, no `coach_memory_state` table, no `coach_memories` RLS or reference
  triggers this round — all deferred with account memory, §2. No `coach-search.ts` recall RPC or
  recall executor/port — deferred with recall, §3; only the user-facing search RPC below ships.)
- **Ownership trigger (round 2 findings 1, 14; RECONCILED with production by round 4 finding 5):**
  Phase 11 adds NO ownership-correcting trigger on `coach_messages` — the deployed
  `_same_owner_coach_messages()` (`20261103090100_same_owner_references.sql`) already REFUSES a
  mismatch. The `coach_messages` deleted-thread-lock trigger (§1, round 3 finding 7, row-locked, now
  covering `insert or update of thread_id` per round 8 finding 5) is a SEPARATE trigger Phase 11
  still adds, refusing a write into a soft-deleted thread — unrelated to ownership. No
  `coach_threads` citation-clearing trigger this round (moot — §1, round 6).
- **Round 3 finding 11, FIX: RLS has always let `coach_messages.user_id` disagree with the thread
  owner for rows written before `20261103090100`.** Not this spec's own migration to fix — it
  predates Phase 11 and is production's own backfill to run, called out here only so Phase 11's own
  reference trigger (deferred, §2) does not silently assume clean data whenever it ships.
- **Round 3 finding 10, FIX: the scheduled backup has its own separate, hardcoded table list.**
  `scripts/backup.sh` is a manual, whole-database dump; the DAILY, automated one is
  `app/api/jobs/backup/route.ts`, which enumerates specific tables into Supabase Storage (`TABLES`,
  lines 36-48). Not relevant to this build's schema changes (no new owner table this round), noted
  here for whenever `coach_memories` ships (§2's lessons already flag it).
- **Search-doc and preview maintenance:** the catalog precedent (`catalog_food_revisions`) has an
  import worker write its `search_doc` by hand, which works because the catalog has one or two
  writer call sites. `coach_messages` is written from SIX different `persist()` call sites in
  `lib/server/coach-turn.ts` (lines 252, 354, 397, 423, 466, 799) PLUS `writeWeeklyReview()`
  (`lib/server/coach.ts:123-133`, round 7 finding 3) — this spec deviates from the cited precedent
  for that reason: `coach_messages.search_doc` (over `content`), `coach_threads.search_doc` (over
  `title`), and `coach_threads.last_message_preview`/`last_message_at` (over the latest message's
  `content`/`created_at`, an `after insert or update or delete on coach_messages` trigger
  RECOMPUTING the parent row rather than copying the triggering row — round 11 finding 4, round 12
  finding 2, above) are each maintained by a trigger, so no app code path — the seven known today,
  or any future one — can forget any of them, and a direct edit or delete of the latest message is
  caught too, not only its original insert. **Round 13 finding 4, FIX: this summary still said
  `after insert` only, contradicting the resolved insert/update/delete trigger above — corrected.**
  The same migration backfills every existing row once, for all three (§1, round 13 finding 2,
  above — `last_message_at` is recomputed unconditionally, not only where null).
- **Search query surface:** §1's search box reads through `lib/server/coach-search.ts`, wrapping a
  `security invoker` Postgres RPC callable from the RLS-scoped client, so RLS still applies even
  though the query joins `coach_threads` and `coach_messages`. `plainto_tsquery('english',
  public.unaccent(:query))` against each `search_doc`, ordered by `ts_rank`. This is the ONLY
  caller this round — recall (§3) would have been a second caller of the same RPC, deferred with
  the rest of that feature. **Round 9 finding 2, BLOCK: RLS does not hide a tombstone, and neither
  does this RPC as specified.** Owner RLS (`supabase/migrations/20260911000500_rls.sql:17`) is a
  `for all` grant scoped by `user_id`, with no `deleted_at` clause — RLS lets an owner read their
  OWN soft-deleted rows, exactly as it must for the purge job and for `GET /api/coach/threads/[id]`
  to keep working during the 30-day grace window; the LIST route compensates with its own explicit
  `.is("deleted_at", null)` (`app/api/coach/threads/route.ts:23-31`), which this RPC was not
  specified to match. Without it, searching a term that only appears in a deleted thread's title or
  message would resurrect that thread in the results. Fix: the RPC's own `where` clause adds
  `coach_threads.deleted_at is null`, covering BOTH the thread-title match and the message-content
  match (a message search still joins back to its thread to check this, even though
  `coach_messages` itself has no `deleted_at` of its own). Test: a query matching only a deleted
  thread's title, and separately one matching only a deleted thread's message content, both return
  nothing. **Round 10 finding 2, BLOCK: search does NOT get cursor pagination — round 9's fix, if
  applied here too, would mix two incompatible orders.** The RPC's own result order is `ts_rank`
  (relevance); §1's list-pagination cursor is `coalesce(last_message_at, created_at), id` (recency)
  — a cursor built from one order cannot correctly page a result set produced by the other: a
  high-ranked OLD hit near the end of page one, followed by a lower-ranked but NEWER hit that
  should also appear, could be skipped entirely, and the same thread could be returned twice if it
  matches more than one message. Fix, the simplest correct scope: search is NOT paginated. It
  returns the top 50 matching THREADS by rank (`select distinct on (thread_id) ... order by
  thread_id, ts_rank desc`, then re-sorted by rank for the final 50), no `nextCursor`, no `?before=`
  parameter — stated as a known limit, not silently truncated: a search matching more than 50
  distinct threads shows the 50 highest-ranked and no more, and the search UI does not offer a
  "load more" control the way the list does. This is a real, accepted limit (50 distinct threads
  covers what a full-text search realistically needs to surface at once), not the SAME "silent
  1,000-row cutoff" problem round 9 finding 4 fixed for the unfiltered list — 50 is a deliberate,
  stated cap, not an accidental platform limit. Test: a search matching more than 50 distinct
  threads returns exactly the 50 highest-ranked, with no `nextCursor` in the response; the SAME
  thread matched by two different messages appears once, not twice.
- **Cron registration:** `vercel.json`'s `crons` array lists six jobs today and none of this spec's.
  Add `{"path": "/api/jobs/coach-purge", "schedule": "0 4 * * *"}`.
- **Round 4 finding 11, FIX: `media-sweep` does not "iterate users" — it runs one bounded,
  age-filtered, ungrouped batch query.** Confirmed by reading it: `select path from media_objects
  where deleted_at is null and created_at < cutoff`, then a plain loop over the first `BATCH` rows
  (`app/api/jobs/media-sweep/route.ts:41-50`) — no per-user grouping exists to imitate. Fix, the
  SAME bounded-batch shape, applied correctly: the purge job's query is `select id, user_id from
  coach_threads where kind = 'chat' and deleted_at is not null and deleted_at < cutoff limit
  BATCH`, then a loop that deletes each thread's `coach_messages` and the `coach_threads` row
  itself using THAT ROW'S OWN verified `user_id` for any scoped write or log line.
- **Service-role paths:** the purge job (§1) runs as `adminClient()`, filtering every query and
  write by an explicitly-known `user_id` from its own bounded batch (above). Add it to Phase 9's
  cross-user service-role route list.
- **Device caches and `x-smc-account` (round 4 finding 10):** `lib/coach-client.ts`'s cache
  functions are already user-bound today by caller convention (see the corrected Fact above), and
  need no schema change — but PR #248 (Phase 9's device-cache-isolation slice, unmerged) changes
  their actual TypeScript signatures to take an `AccountHandle`, and requires an `x-smc-account`
  header on data routes. Phase 11's new client code (`searchThreads()`, §1) is written against that
  POST-#248 signature from the start, and Phase 11's new routes (`GET /api/coach/threads?q=`)
  accept/require `x-smc-account` the same way every other data route will. This spec's slices land
  after PR #248 merges, not before it.
- **Round 8 finding 6, FIX: PR #248's cache API has no eviction function — Phase 11 adds the one it
  needs.** `removeCache(h, threadId)` (§1) is a new, small addition to `lib/coach-client.ts`,
  landing in the SAME PR-#248-dependent slice as `searchThreads()` — not a change to PR #248 itself,
  just one more function following its established `readCache`/`writeCache` shape.

## Testing

- Trigger tests: a forged `coach_messages` insert with a mismatched `user_id` is REFUSED (`42501`),
  matching the deployed `_same_owner_coach_messages()` (round 4 finding 5); an insert into a
  soft-deleted thread is refused, from both a fresh request and a retried one going through
  `storedTurn()` (round 2 finding 8); the SAME insert, raced against a concurrent soft-delete of its
  thread, is refused rather than landing in the gap between them (round 3 finding 7); an owner's
  direct `UPDATE` that re-points an EXISTING message's `thread_id` at a deleted thread is refused
  the same way (round 8 finding 5).
- Purge test: a `kind = 'chat'` thread purges 30 days after soft-delete; an `'onboarding'` or
  `'weekly_review'` thread never does, even when soft-deleted and backdated (round 2 finding 9); a
  direct `DELETE`/`UPDATE` against the onboarding thread's id is refused by Phase 10's own RLS
  (round 6 finding 6), and the SAME against the weekly-review thread's id is refused by Phase 11's
  own new RLS (round 7 finding 4).
- Thread-switch test (round 6 finding 4): send a first message (lazy-creating a thread), press "new
  chat," send another message (lazy-creating a SECOND thread), press "new chat" again — each press
  shows an empty composer and both created threads appear separately in the list. Opening a
  different thread, or deleting the open thread, while a turn is in flight discards that turn's
  late reply rather than showing it in the newly opened one.
- Attachment-retry test (round 8 finding 3): retry an attachment turn (photo/barcode) whose thread
  has since been soft-deleted — refused, the same as an ordinary text-turn retry already is.
- Weekly-review preview and time test (round 7 finding 3, round 9 finding 3): a weekly review
  generated after this ships shows a real `last_message_preview` AND a real `last_message_at` in
  the list, neither blank; a thread from before Phase 7 shipped (a pre-existing null
  `last_message_at`) shows a real relative time and sorts correctly after the backfill.
- Weekly-review INSERT test (round 9 finding 1): a direct, authenticated `INSERT` into
  `coach_threads` carrying `kind = 'weekly_review'` is refused, tested before any weekly review
  exists for the account (so the cron's own find-or-create logic is not the thing masking the gap).
- Server-stamped tombstone test (round 10 finding 1, replaced by round 11 finding 1, scoped by
  round 12 finding 1): a direct, authenticated `INSERT` into `coach_threads` carrying a non-null
  `deleted_at` lands with it null; a direct `UPDATE` that sets, clears, or changes an existing
  `chat` thread's `deleted_at` in ANY way is refused; calling `soft_delete_thread()` twice on the
  same OWNED `chat` thread succeeds (2xx) both times with the timestamp from the FIRST call
  unchanged; calling `soft_delete_thread()` against the onboarding thread, the weekly-review
  thread, or another account's thread is refused (404) every time, never tombstoning it; a direct
  `DELETE` against a `chat` thread, deleted or not, is refused — hard deletion only succeeds as
  `service_role` (the purge job).
- Device-cache test (round 8 finding 6, reworked by round 9 finding 5, round 10 findings 3 and 6,
  and round 11/12 finding 3-4): delete a thread on device A, then read ITS OWN cache entry directly
  (`readCache`) — confirm nothing comes back. Retry the SAME delete after simulating a lost
  response — confirm the RETRY's 2xx (not a 404) clears device A's cache (round 12 finding 4); a
  delete attempt against an id the account does not own returns 404 and touches no cache entry. On
  device B, a thread cached but sitting on a list page device B has not fetched is NOT evicted
  merely by device B fetching page one; the SAME thread, once explicitly OPENED on device B after
  being deleted, 404s and IS evicted and cleared from view at that point. `removeCache(null,
  threadId)` does not throw (round 10 finding 6).
- Search: a query matching only one old message's text returns that thread from the list's own
  search box; a query matching another account's message returns nothing (cross-user suite); a
  query matching only a DELETED thread's title or message content returns nothing (round 9 finding
  2); a query matching more than 50 distinct threads returns exactly the 50 highest-ranked, no
  `nextCursor`, and a thread matched by two different messages appears once, not twice (round 10
  finding 2).
- Pagination and resume test (round 9 finding 4, round 10 findings 4 and 5, round 11 finding 2,
  round 12 finding 3): an account with more threads than the page limit can still reach its oldest
  thread through repeated `?before=`/`nextCursor` pages, not truncated silently; an empty
  (never-messaged) thread appears in the list, ordered by its `created_at`, not missing or
  erroring; create 60 empty chats, then message an older, pre-existing chat, reload — confirm
  resume opens the messaged chat via its own dedicated query, not an empty one that happens to sort
  higher on page one; message a chat, then delete that message (emptying it) — confirm resume does
  NOT select it despite its non-null `last_message_at`.
- Preview/time freshness test (round 11 finding 4, round 12 findings 2 and 5): directly edit, then
  separately delete, a thread's latest message — confirm the list's preview and relative time
  update to match the new actual latest message (or fall back to the thread's own `created_at` if
  none remain), not the edited/deleted content; move a message to a DIFFERENT thread the same
  account owns — confirm BOTH the origin and destination threads' previews update, not only the
  destination; confirm `persist()` and `writeWeeklyReview()` no longer write `last_message_at`
  themselves — the value after a turn matches the trigger's own computation, not a later
  application-clock read.

## Testing on Preview

Devin and Sasha both need invite-coded test accounts on the Preview build (Phase 9 provides the
invite flow). Steps:

1. Sign in as a test account. Open the coach, send a first message (lazy-creating a thread), then
   press "new chat" and send another (lazy-creating a second thread), then press "new chat" again.
   Confirm each press shows an empty composer and both threads exist, separately, in the list
   (round 6 finding 4).
2. Open the conversations list. Confirm: every thread you started is there, latest first, with a
   title and a one-line preview. Rename one thread; reload; confirm it stuck. Search for a word
   that only appears in one old message, using the list's own search box; confirm that thread is
   the result. Confirm the onboarding thread and the weekly review show as pinned labels with NO
   rename or delete control, and once a weekly review has run, confirm ITS row also shows a real
   preview, not blank (round 6 finding 6, round 7 finding 3).
3. Delete one ordinary chat thread. Confirm it disappears immediately from the list AND from THIS
   device's local cache (close and reopen the app; the deleted thread's transcript does not come
   back — round 8 finding 6). If a second signed-in device already had that thread open or cached,
   confirm the narrower promise: it may still show the transcript locally until that device
   explicitly reopens the thread, at which point the server refuses it and the local copy clears
   (round 9 finding 5, round 10 finding 3) — not an automatic cross-device wipe from a list refresh
   alone. Attempt, directly against the API, to un-delete the thread (clear `deleted_at`) or
   hard-delete it outright — confirm both are refused (round 10 finding 1); its messages are still
   in the database right after the ordinary soft-delete. On Preview only, the purge route accepts a
   backdating override (for example `?before=<ISO date>`, refused outside Preview) so the 30-day
   cutoff can be tested without waiting: a thread deleted less than 30 days ago survives a purge
   run; one backdated past 30 days is purged. Separately, attempt to delete the onboarding thread
   AND the weekly-review thread via a direct API call — confirm both are refused (RLS, not this
   spec's UI; round 7 finding 4 for the weekly-review one).

## Slices (PR-sized)

1. `coach_messages` deleted-thread-lock trigger (row-locked, round 3 finding 7, firing on `insert or
   update of thread_id` per round 8 finding 5) + the SAME check added to the attachment-turn's
   separate `replay()` path (round 8 finding 3) + the three search columns, their GIN indexes and
   their maintenance triggers + `coach_threads.last_message_preview`/`last_message_at` and their
   SHARED `refresh_thread_preview()` function, called on insert/update/delete of `coach_messages`
   for `new.thread_id` AND, when an `UPDATE` moves a message between threads, `old.thread_id` too
   (round 7 finding 3, round 11 finding 4, round 12 finding 2 — firing for `persist()`,
   `writeWeeklyReview()`, and any direct message edit/move/delete alike, now the sole writer of
   both columns per round 12 finding 5) + ONE backfill migration covering search docs, previews,
   AND `last_message_at` together (round 5 finding 6, round 7 finding 3, round 9 finding 3) +
   `resolveThread()`'s `deleted_at` check + the `deleted_at` lockdown trigger (INSERT normalizes to
   null, UPDATE refuses any change) + `soft_delete_thread()` RPC, scoped to `kind = 'chat'` (round
   10 finding 1, replaced by round 11 finding 1, scoped by round 12 finding 1) + `revoke delete ...
   from authenticated` on `coach_threads` + `kind = 'weekly_review'` restrictive RLS covering
   `INSERT` as well as `UPDATE`/`DELETE` (round 7 finding 4, round 9 finding 1) and its
   `resolveThread()` block + (if still needed) the `kind = 'onboarding'` constraint widening. Every
   migration timestamped `20261115` onward (round 4 finding 5) and landing AFTER PR #248 merges
   (round 4 finding 10). No `coach_memories` table, no recall infrastructure this round (§2 round 6
   cut, §3 round 8 cut).
2. Conversations list UI: sheet, the `chatGen`-keyed remount fix so "new chat"/open/delete each
   correctly reset the transcript and cancel stale in-flight loads (round 6 finding 4), rename
   (`PATCH`, hidden for pinned threads per round 6 finding 6), delete calling `soft_delete_thread()`
   (round 11 finding 1, hidden for pinned threads, refused by the RPC itself for either pinned kind
   per round 12 finding 1) and the new `removeCache()` on a 2xx from that specific delete call,
   INCLUDING a retry's 2xx, never a 404 (round 11 finding 3, corrected by round 12 finding 4) —
   null-safe per round 10 finding 6, narrowed to the deleting device per round 9 finding 5, with
   per-thread eviction-on-open for other devices per round 10 finding 3 — search box
   (`searchThreads()`, `lib/server/coach-search.ts`'s RPC, excluding deleted threads per round 9
   finding 2, top-50-by-rank with NO pagination per round 10 finding 2), cursor pagination on the
   LIST endpoint only (`coalesce(last_message_at, created_at)` as the one ordering/cursor value,
   round 9 finding 4, round 10 finding 4), `listThreads()`'s widened return shape, a SEPARATE
   dedicated resume query keyed on an ACTUAL message existing, not a non-null `last_message_at`
   (round 11 finding 2, round 12 finding 3), and `CoachScreen`'s updated resume consumer (round 10
   finding 5), preview text.
3. Purge job (`app/api/jobs/coach-purge/route.ts`, a bounded age-filtered batch over
   `coach_threads`, NOT a media-sweep-style user-iteration — round 4 finding 11 — registered in
   `vercel.json` with the Preview-only backdating override, scoped to `kind = 'chat'` only) + a
   device-cache account-switching test against the POST-PR-#248 `AccountHandle` API (round 4
   finding 10) + cross-user service-role tests.

Each slice keeps its own tests and its own Preview-testable step above; slice 1 lands before
slices 2 and 3, which can land in either order relative to each other.

## Success criteria

- A user can create, find, rename and delete an ordinary conversation; the list survives reload and
  a new device. "New chat," pressed any number of times in a row, always starts a genuinely empty
  thread (round 6 finding 4).
- The onboarding thread and the weekly review show as pinned labels with no rename or delete
  control, have a real preview AND a real relative time once each has a message (round 9 finding 3
  for pre-existing threads), and a direct attempt to `INSERT`, `UPDATE` or `DELETE` a thread of
  EITHER kind is refused by RLS (Phase 10's own for onboarding; Phase 11's new one for weekly
  review, round 7 finding 4, round 9 finding 1).
- Switching threads (new chat, opening one, deleting the open one) while a turn is in flight never
  shows that turn's late reply in the wrong thread.
- A soft-deleted thread never accepts a new message or a re-pointed existing one, whether from a
  fresh request, an attachment retry, one in flight when the delete happened, or a
  retried/replayed one (round 8 findings 3 and 5).
- Once a `chat` thread's `deleted_at` is set, it can never be cleared back to null, and the row can
  never be hard-deleted, by an authenticated user directly — only the purge job, as `service_role`,
  performs a hard delete, and only after the 30-day grace window (round 10 finding 1). The delete
  RPC itself never tombstones the onboarding or weekly-review thread, regardless of running with
  elevated privilege (round 12 finding 1); calling it twice on the same owned thread always
  succeeds (round 11 finding 1), never turning a lost-response retry into a user-visible error.
- Deleting a conversation removes it from the server and from the deleting device's own cache
  immediately, including on a retry after a lost first response. Another signed-in device is not
  guaranteed to drop a cached copy it has not opened, but the SERVER always refuses that thread the
  moment the device tries to open it, clearing the stale local copy at that point (round 8 finding
  6, reworked by round 9 finding 5, round 10 finding 3, and round 11/12 finding 3-4) — no device can
  OPEN or resume a conversation that has been deleted, even from a stale, unopened cached copy.
  **Round 13 finding 3, FIX: this is a COMMIT-ORDER guarantee from the row lock (round 3 finding 7,
  above), not a promise that deletion always wins a race against an in-flight turn.** The lock
  forces a soft-delete and a concurrent message insert on the same thread to commit one after the
  other, never interleaved — but if the insert commits FIRST, the delete still succeeds right after
  it, and the turn's reply, already dispatched to the ORIGINATING device, is still delivered and its
  actions still auto-applied there (`lib/server/coach-turn.ts:799`, `components/coach/CoachShell.tsx
  :150,238`) — that ONE reply can land after the thread is gone. What the lock does NOT allow: a
  SECOND message, or a resume/open from any device, once the delete has committed — those always
  see the thread as gone. Test: two devices, one deletes a thread while the other has a turn already
  in flight on it; the deleting device never sees the thread again; the other device may still show
  that one in-flight reply once, but the thread is gone from its list on next reload and any further
  message to it 404s.
- The list's preview and relative time always reflect the thread's ACTUAL latest message, kept
  current by one trigger that is the sole writer of both columns — not overwritten by an app-code
  path that still writes its own value afterward (round 12 finding 5) — and correctly refreshed on
  a direct edit, move, or delete of a message, not only on the original insert (round 11 finding 4,
  round 12 finding 2).
- A deleted conversation never reappears in a search result, by title or by message content (round
  9 finding 2). An account with more conversations than one page can still reach its oldest one
  through list pagination, not a silent 1,000-row cutoff (round 9 finding 4, round 10 finding 4);
  search itself returns the 50 highest-ranked matching conversations and states that limit rather
  than silently truncating past it or mixing two incompatible sort orders (round 10 finding 2).
- The 30-day purge never removes an onboarding or weekly-review thread.
- Coach-driven recall (`recall_conversations`) is NOT in this build's success criteria — it is cut
  to "Later" (§3) after three straight rounds (6, 7, 8) found structural problems specifically in
  that feature, the last round finding every guarantee it promised had no enforcement independent
  of the model's own tool-calling or prose choices.
- No search result or thread is readable by another account, including through a direct, non-app
  PostgREST call.
- Account memory (saving, reading, editing, deleting, exporting a remembered fact) is NOT in this
  build's success criteria — it is cut to "Later" (§2) after six audit rounds found structural
  problems specifically in that feature.

## Resolution of audit round 1

Source: `docs/audit/specs/2026-09-22-phase-11-r1-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 9 BLOCK, 8 FIX). Every finding was checked against the current code
before being applied. Note: round 2 (below) went on to remove the entire background-write
mechanism findings 2, 6, 7, 9 and 14 (in part) were fixing — see "Round 2 scope cut." Their
resolutions below are kept as the historical record of what round 1 asked for and how it was
answered at the time; §2 above reflects the current, post-cut design.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §2 — `coach_memories` got its own RLS policy set (owner select/delete, trigger-guarded owner update, no owner insert), plus a same-account trigger on `source_thread_id`/`source_message_id`. Superseded by round 2 finding 2, which removed owner update entirely. | Confirmed: the draft's pattern-1 `for all` grant would let an authenticated user's own JWT insert a row with `confirmed = true` and any `kind`/`text` directly through PostgREST, bypassing the judge — `supabase/migrations/20260911000500_rls.sql:5-22` is genuinely `for all`, no per-column limit. |
| 2 | BLOCK | §2 — widened `TurnStep` and an explicit `remember` line in `turnStepCandidate()`. Removed by the round 2 cut: there is no `remember` envelope field any more. | Confirmed by reading both files: `TurnStep`'s `final` variant had no `remember` field, and `turnStepCandidate()` builds its `candidate` object field-by-field — a value not given its own line is dropped even if the zod schema allows it. |
| 3 | BLOCK | §3 — `ExecutorPorts`/`makeExecutors()`/`defaultPorts()` wiring and a new `lib/server/coach-search.ts`, specified alongside the registry entry. Still current. | Confirmed: `makeExecutors()` returns `Record<ToolName, Executor>` — a `ToolName` with no executor entry does not compile. |
| 4 | BLOCK | §3 — evidence and unconditional check specified; superseded by round 2 finding 7's more complete fix (independent evidence capture, split verdicts). | Confirmed: `ReplyToolResult`/`toolNames()` kept only tool names, and the call site gated on `actions.length === 0`. |
| 5 | BLOCK | §1 (`resolveThread()` `deleted_at` check) + §4 (the "forget" promise narrowed). Both still current; round 2 finding 8 added the persist-time and replay-time checks §1 now has, and round 2 finding 3 sharpened why the "forget" narrowing is necessary. | Confirmed: `resolveThread()` had no `deleted_at` filter. |
| 6 | BLOCK | §2 — `superseded boolean` column replaces `superseded_by is null` as "active." Still current. | Confirmed by re-deriving the schema's own logic: `on delete set null` on the self-referencing FK, with "active" defined as that FK being null, meant deleting the newer row un-set the older row's FK. |
| 7 | BLOCK | §2 — durable work intent, sweep job, `forgotten_at` fence. Withdrawn entirely by the round 2 cut — there is no background writer left to make durable or fence. | Confirmed: `afterResponse()` swallows a missing request scope with a warning, and a retried POST replayed through `storedTurn()` without re-running the turn loop. |
| 8 | BLOCK | §Tightening — triggers maintain all three search columns; a backfill added; a third index added; a `security invoker` RPC specified. Still current. | Confirmed: `coach_messages` is written from six `persist()` call sites, against the catalog's one import worker. |
| 9 | BLOCK | §2 — durability judge extended to reject structured-field overlap; prompt rule extended. Superseded in part by round 2 finding 4's `needsProfileContext` fix, which addresses the same risk from the READ side. | Confirmed the risk (`target_profiles`/`day_templates` can change without any link from a `coach_memories` row). |
| 10 | FIX | Facts section corrected: the device cache is already user-bound; the draft's proposed `cacheKey()` change withdrawn. Still current. | Confirmed by reading every call site of `readCache`/`writeCache`/`cacheKey`. |
| 11 | FIX | §1 — citation clearing at soft-delete. Superseded by round 2 finding 13's atomic RPC. | Confirmed: `on delete set null` only fires at hard-delete, 30 days later under this spec's own design. |
| 12 | FIX | §Tightening — cron registration; Preview backdating override. `coach-memory-sweep` entry withdrawn with the sweep job; `coach-purge` entry still current. | Confirmed: `vercel.json` listed six jobs and neither new route. |
| 13 | FIX | §4 — `ExportCard.tsx` widened for `"memories"`. Still current. | Confirmed: `components/ExportCard.tsx` hardcoded exactly `"meals" | "progress"`. |
| 14 | FIX | §2 — account memory as a sixth, last shrink step. Still current; round 2 finding 15 added the "best-effort, not a guarantee" wording. | Confirmed: the `shrink` array is finite and the function returns its result even over cap. |
| 15 | FIX | §2 — dedupe changed from full-text top-5 to same-kind exhaustive. Superseded by round 2 finding 10's all-active-memory fix. | Accepted the lexical-search gap; chose exhaustive compare over embeddings. |
| 16 | FIX | §4 — memory controls online-only. Still current. | Confirmed the gap; matched the existing coach-chat precedent. |
| 17 | FIX | §1 — "new chat" as a client-side reset. Still current. | Confirmed: `POST /api/coach/threads` can create an untitled thread, and `persist()` only derives a title when `req.threadId === null`. |

**Rejected: none outright.** Every finding pointed at a real gap once checked against the code.

## Resolution of audit round 2

Source: `docs/audit/specs/2026-09-22-phase-11-r2-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 10 BLOCK, 5 FIX). Every finding was checked against the current
code before being applied; none is rejected. Findings 1, 5, 6 and 10 are resolved together by the
round 2 scope cut (moving automatic memory writes to "Later"), since they were four angles on the
same underlying gap — an unattended background writer this codebase has no safe primitive for yet.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §2 — the round 2 scope cut removes the sweep job this finding was about. The underlying claim (`coach_messages.user_id` cannot be trusted) still applies to citations, so a new `coach_messages` trigger forces `user_id` to the thread's real owner on every insert. | Confirmed: RLS on `coach_messages` checks the thread owner, not the `user_id` column itself (`supabase/migrations/20260911000500_rls.sql:55-68`), so a forged row could carry a mismatched `user_id`. |
| 2 | BLOCK | §2 — removed owner `update` (and `insert`) on `coach_memories` entirely; Edit now goes through `PATCH /api/coach/memories/[id]`, which runs the same medical judge as create. | Confirmed: round 1's trigger-guarded owner `update` still allowed a direct PostgREST update to `text`/`kind` with no judge in the path. |
| 3 | BLOCK | §4 — the "forget" promise narrowed further, explicitly naming the thread-summary gap; moved to "Later" as a stated, not silently ignored, limitation. | Confirmed: the thread's own rolling `summary` (`lib/server/coach-threads.ts:116-131`; `lib/coach/history.ts:106-123`) is untouched by a `coach_memories` delete, and prompt rule 13 tells the model to carry its OWN summary's facts forward regardless. |
| 4 | BLOCK | §2 — `buildCoachContext()`'s profile fetch now also fires whenever an active `goal_context` memory exists, not only when `needsProfileContext()` already says so. | Confirmed: `profile` is fetched conditionally (`lib/server/coach-context.ts:187-198`), so on an ordinary turn there was nothing for "current state wins" to compare against. |
| 5 | BLOCK | §2 — round 2 scope cut removes the writer this fence was protecting against; "Forget everything" is now a single hard-delete with nothing else writing concurrently. | Confirmed: the round 1 fence read `forgotten_at` before writing, a genuine read-then-write race, and `coach_memory_state` had pattern-1 authenticated write access that could tamper with the fence value itself. |
| 6 | BLOCK | §2 — round 2 scope cut removes the dual eligible-writer path (`afterResponse()` + sweep) this finding was about. | Confirmed: a null `remember_processed_at` made both paths eligible to process the same message, and a crash between candidate writes and the marker replayed partial work. |
| 7 | BLOCK | §3 — recall evidence is now captured independently of `persistResult`/UI-block logic, at the exact point a tool's `data` is computed; `verifyReply()` returns two separate verdicts instead of one combined `flagged`. | Confirmed: `toolCalls[i].result` is only set `if (persistResult)` (`lib/server/coach-turn.ts:733`), which is false for a plain read tool like `recall_conversations`; `verifyReply()`'s return type was one `{ flagged, p }`. |
| 8 | BLOCK | §1 — a `before insert` trigger on `coach_messages` refuses an insert into a soft-deleted thread (atomic, no check-then-insert window), and `storedTurn()`'s replay path gets the same `deleted_at` check. | Confirmed: the round 1 fix only checked `deleted_at` in `resolveThread()`, before the model call — a delete during the call, or a replay through `storedTurn()` (which never calls `resolveThread()`), both bypassed it. |
| 9 | BLOCK | §1 — the purge query is scoped to `kind = 'chat'` only; onboarding and weekly-review threads are never hard-deleted. | Confirmed: `onboarding_drafts.thread_id references coach_threads` with no delete action specified (`docs/specs/phase-10-conversational-onboarding.md:349-353`), so hard-deleting a referenced onboarding thread would break that foreign key. |
| 10 | BLOCK | §2 — dedupe now compares a new candidate against ALL of the account's active memories, not only those with the same `kind`, affordable under the round 2 scope cut's lower write volume. | Confirmed: the round 1 fix's same-kind restriction meant "vegetarian" (`preference`) and "eats meat now" (`fact`) could be assigned different kinds and never meet. |
| 11 | FIX | §1 — `coach_threads` gets `last_message_preview`, set in the same `persist()` update as `last_message_at`; a new `searchThreads()` client method and a `?q=` branch on `GET /api/coach/threads`. | Confirmed: the list response is `id, title, kind, last_message_at` only (`app/api/coach/threads/route.ts:23-31`) — no preview field, no search branch. |
| 12 | FIX | §2 — `buildCoachContext()`'s `Promise.all` explicitly gets a `memories` entry; `CoachContext` gets a `memories` field. | Confirmed: `buildCoachContext()` (`lib/server/coach-context.ts:182-198`) loaded day, lists, recipes, profile and activity only — no memory fetch existed in the actual function despite being named in a slice. |
| 13 | FIX | §1 — one `security invoker` RPC, `soft_delete_thread()`, sets `deleted_at` and clears citations in one transaction; the `DELETE` handler calls it instead of two separate updates. | Confirmed: the round 1 fix was two separate database requests, and the second could fail after the first already committed. |
| 14 | FIX | §2 — the reference trigger also checks that a cited message belongs to its cited thread, and that `superseded_by` belongs to the same account. | Confirmed: the round 1 trigger checked `source_thread_id` and `source_message_id` for the same user, but not that the message belonged to that thread, and not `superseded_by` at all. |
| 15 | FIX | §2 — the cap is now stated as best-effort, matching `renderCoachContext()`'s existing, always-best-effort contract, instead of claiming account memory's placement makes it exact. | Confirmed: the five existing shrink steps can already leave the context over `CONTEXT_TOKEN_CAP` before any memory is added — a sixth step at the end cannot retroactively guarantee a cap the first five did not. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code. The four
findings resolved by the scope cut (1, 5, 6, 10) are not rejected — their underlying claims are
accepted in full; the fix is removing the mechanism they were all pointing at, per the coordinator's
explicit instruction to cut scope rather than spend the last audit round on a bigger fix.

## Resolution of audit round 3

Source: `docs/audit/specs/2026-09-22-phase-11-r3-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 9 BLOCK, 2 FIX). This is the FINAL allowed audit round for this
spec tonight — no further round runs. Every finding was checked against the current code and a
change applied in the spec text; per the coordinator's instruction, the run cut or deferred a
feature rather than adding new machinery wherever the fix would otherwise have needed it. None is
rejected. Because there is no further audit this session, EVERY BLOCK below is also listed, in
full, under "Open for Devin" — a same-session, self-applied fix is not the same as a verified one,
and Devin should read and accept or override each before this spec is treated as ready to plan
from.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §4 — the "forget" copy, success criterion, and Preview step 6 narrowed a third time: a forgotten fact may still surface unprompted in the SAME thread it was first mentioned in, through that thread's own untouched summary. | Confirmed: `lib/coach/history.ts:106-123` injects a thread's `summary` on every later turn IN THAT THREAD, and prompt rule 13 (`lib/coach/prompt.ts:110-118`) tells the model to carry its facts forward regardless of any `coach_memories` delete. |
| 2 | BLOCK | §2 — the `goal_context` guard now reads TYPED memory rows, fetched before the profile decision, not the rendered `string[]` the Reading section separately described; rendering to the 800-character string happens last, inside `renderCoachContext()`. | Confirmed by re-reading the spec's own two sections side by side: one said `CoachContext.memories: string[]`, the other tested `m.kind` on the same field — a real internal inconsistency, not a misreading. |
| 3 | BLOCK | §2 — a `null`/failed medical-judge result now refuses the write (fail-closed) for both create and edit, instead of being undefined behavior. | Confirmed: `systemOne()` returns `null` on a missing key, budget rejection, timeout, or malformed answer (`lib/ai/typesafe.ts:239-261,284-326`), and the earlier draft never said what the write route does with that `null` while still promising an absolute "no medical memory" guarantee. |
| 4 | BLOCK | §2 — `remember_fact` no longer auto-applies; it renders as a confirm card (reusing the existing `draft_log_entry`/confirm-sheet pattern) and only writes on an explicit tap, so "explicit only" is a UI fact instead of a prompt sentence. | Confirmed: `apply-client.ts` applies every action automatically on receipt (`components/coach/CoachShell.tsx` wiring), and the write route as specified only checked medical content, never whether the user had actually asked to be remembered. |
| 5 | BLOCK | §2, "Later" — two narrow races (two devices both inserting near-simultaneously; an in-flight save landing just after "Forget everything") are documented as accepted limitations, with Settings copy saying so, rather than fixed with new transactional machinery. Real cross-device serialization is deferred to "Later." | Confirmed: `apply-client.ts`'s in-flight guard is process-local (lines 33-46) and cannot see a second device or tab, and a client-side 20-second timeout does not cancel the corresponding server write. |
| 6 | BLOCK | §2 — dedupe changed from "compare against every active memory" (up to 200 Jev calls) to ONE batched Jev call against the 50 most recent active memories, accepting that a contradiction against an older memory outside that window is not caught automatically. | Confirmed: a default 3-second-per-call Jev judge deadline (`lib/ai/typesafe.ts:12,284-287`) against a possible 200 sequential calls could vastly exceed the client's 20-second timeout (`lib/coach/apply-client.ts:35,41-46`). |
| 7 | BLOCK | §1 — the `coach_messages` deleted-thread trigger now row-locks the parent thread (`for update`) so it cannot interleave with a concurrent soft-delete; citation-clearing moved from an RPC only the app's own route calls into a trigger on `coach_threads` itself, firing for every delete path including a direct client `UPDATE`. | Confirmed: a plain trigger read of `deleted_at` has no defense against a concurrent, not-yet-committed delete, and `coach_threads` still carries the shared pattern-1 `for all` policy (`supabase/migrations/20260911000500_rls.sql:12-22`), so a direct PostgREST update could set `deleted_at` without ever calling `soft_delete_thread()`. |
| 8 | BLOCK | §2 — `remember_fact` now specifies its flat wire shape, its strict re-parse on persisted replay, its `actionLine()` history-rendering case, and its Undo token, matching what every other `CoachAction` already needs. | Confirmed by reading `lib/coach/actions.ts:188-270,311-405,518-560`, `lib/coach/history.ts:51-91`, and `lib/coach/apply-shared.ts:25-56` — the earlier draft named only the union member and the client dispatcher, skipping four required pieces every existing action has. |
| 9 | BLOCK | §3 — recall evidence is now captured per-hit (bounded per snippet, not one flat 500-character slice of the combined result), and the Jev-unavailable fallback flags ANY retrospective phrase, with no exemption for having called `recall_conversations` this turn. | Confirmed: the earlier fallback's exemption ("recall wasn't called AND memory was empty") let a reply that called `recall_conversations`, got an empty or unrelated result, and fabricated a claim anyway pass unflagged — exactly the case the required test needed to catch. |
| 10 | FIX | §Tightening — `coach_memories` added to `app/api/jobs/backup/route.ts`'s hardcoded `TABLES` list, in the same PR that creates the table. | Confirmed: the DAILY automated backup (distinct from the manual `scripts/backup.sh` pg_dump) enumerates specific tables (`app/api/jobs/backup/route.ts:36-48`) built from the RLS migration's table lists — a new table is invisible to it unless added by hand. |
| 11 | FIX | §Tightening — the ownership-trigger migration also backfills existing `coach_messages.user_id` mismatches from `coach_threads.user_id` and reports how many rows it corrected. | Confirmed: RLS has always checked the thread owner, not the `user_id` column (`supabase/migrations/20260911000500_rls.sql:55-68`), so pre-existing rows could already disagree, and a trigger added going forward does nothing for rows already in the table. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code.

## Resolution of audit round 4

Source: `docs/audit/specs/2026-09-22-phase-11-r4-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 6 BLOCK, 5 FIX). Devin approved extra audit rounds specifically to
clear blockers, so this round resolves as much as the smallest SAFE cut allows — several items
round 3 had left as documented limitations are now genuinely fixed, not re-documented, per the
coordinator's instruction. None rejected. New facts this round supplied and this spec now depends
on: `20261103090000`/`20261103090100` applied to production; PR #248 (device-cache isolation,
`x-smc-account`) in progress; the Phase 9 plan's own migration window (`20261104`–`20261107`) and
Phase 10's start (`20261110`).

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §2 — `remember_fact` is no longer a `CoachAction`; it is a new `"draft"` TOOL, `propose_memory`. Tool args are `z.unknown()` at the wire layer, never subject to `providerActionSchema`'s named-field/positional-array limit. | Confirmed: `providerActionSchema` uses required, capped named fields plus two positional catch-all arrays specifically to stay within a documented provider property ceiling (`lib/coach/actions.ts:237-270`) — two new named action fields would have pushed against it. |
| 2 | BLOCK | §2 — resolved by the same redesign: a tool's draft never enters `chat-state`'s `actions` array, so it cannot become `"pending"` and auto-apply, and it is never persisted into `tool_calls.actions` for `actionLine()` to render as history. | Confirmed: a received action becomes `status: "pending"` and is applied automatically (`lib/coach/chat-state.ts:109-120`; `components/coach/CoachShell.tsx:150-165`), with no separate "proposed, unconfirmed" state in that pipeline. |
| 3 | BLOCK | §2 — resolved by removal: with no `CoachAction` and no generic Undo token, "undo" for `same`/`updates`/`contradicts` is just the ordinary Edit/Delete every memory already has, not a single generic inverse. | Confirmed: a single delete-by-id Undo token is the wrong inverse for an update (would delete the row the save just correctly changed) and for a supersede (would leave the old row stranded, still marked superseded). |
| 4 | BLOCK | §2 — one new table, `coach_memory_state`, and one Postgres function, `commit_memory()`, using a per-account row lock to serialize "Forget everything" against any in-flight save, in one transaction — closing this round's finding AND, as a side effect, round 3's separately-accepted duplicate-save limitation. | Confirmed: the round 3 draft accepted this race as documented, and round 4 correctly rejected that as unsafe for a privacy control; `apply-client.ts`'s in-flight guard is process-local and a client timeout does not stop the server write (`lib/coach/apply-client.ts:33-46,122-153`). |
| 5 | BLOCK | Facts, §1, §2, §Tightening — the `coach_messages` ownership-correction trigger from round 2/3 is WITHDRAWN; Phase 11 relies on the deployed `_same_owner_coach_messages()` trigger, which REFUSES a mismatch instead of correcting it. Every new migration now sorts after `20261103090100`, at `20261115` onward, given the Phase 9/10 migration windows already claimed. | Confirmed by reading the applied migration directly (`.claude/worktrees/agent-a539615ca814cfaf9/supabase/migrations/20261103090100_same_owner_references.sql:140-152,393-401`) — it raises `42501` on a mismatch and widens `coach_messages` RLS to require both `user_id = auth.uid()` and thread ownership. |
| 6 | BLOCK | §2 — a `null` OR a `noul` probability ≥ 0.50 now refuses a memory write, at the draft tool, the commit route, and Settings Edit alike; the Preview step for a medical ask now correctly expects a refusal BEFORE any card, since the judge runs in the tool executor, not at commit time. | Confirmed: `noul` returns a probability, not a boolean (`lib/ai/typesafe.ts:67,124-126`), and the earlier draft defined no cut point for a non-null answer while promising an absolute guarantee. |
| 7 | FIX | §1, Slices — `CoachShell` is keyed by `threadId` at its call site so "new chat," opening a thread, and deleting the open thread each force a real remount instead of relying on a lazy reducer initializer that only runs once. | Confirmed: `initialShellState` is a lazy `useReducer` initializer that runs once on mount (`components/coach/CoachShell.tsx:118-121`), and `CoachChat`/`CoachScreen` key their mount on the user, not the thread (`app/coach/CoachScreen.tsx:117-119`) — changing the `threadId` prop alone does not reset it. |
| 8 | BLOCK | §2 — resolved by removal, the same as findings 1, 2, 3: no action means no wire shape, no replay re-parse, no history-rendering case, and no Undo token are needed for `remember_fact` at all. | Confirmed by reading `lib/coach/actions.ts:188-270,311-405,518-560`, `lib/coach/history.ts:51-91`, and `lib/coach/apply-shared.ts:25-56` — the four pieces the action system requires, none of which apply to a draft tool. |
| 9 | FIX | §3 — the recall-claim Jev question is narrowed to claims about an EARLIER, DIFFERENT conversation, explicitly excluding account memory and the current thread's own context, instead of broadening the evidence fed to it. | Confirmed: the prompt already permits claims sourced from account memory or the current thread's own injected context, but the verifier as previously specified could only check against `recall_conversations` snippets — a true, legitimate claim from either other source would have read as unsupported. |
| 10 | FIX | Facts, §Tightening — Phase 11's own new client code and routes are specified against the POST-PR-#248 `AccountHandle` cache API and `x-smc-account` header, landing after that PR merges, instead of the pre-#248 shape this spec previously (correctly, at the time) described as final. | Confirmed by reading the unmerged slice directly (`.claude/worktrees/agent-af9e42fc3664b612b/lib/coach-client.ts:85-93`) — `cacheKey`/`readCache`/`writeCache` all gain a required `AccountHandle` parameter. |
| 11 | FIX | §Tightening, Slices — the purge job's citation is corrected: `media-sweep` runs one bounded, ungrouped, age-filtered batch query, not a per-user iteration; the purge job is specified against that actual shape, using each swept thread row's own `user_id`. | Confirmed by reading `app/api/jobs/media-sweep/route.ts:41-50` directly — a flat `select ... where deleted_at is null and created_at < cutoff`, no per-user grouping exists. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code, including
the one (5) that required reconciling this spec's own prior-round plan with a migration that had
since shipped to production out from under it.

## Resolution of audit round 5

Source: `docs/audit/specs/2026-09-22-phase-11-r5-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 4 BLOCK, 3 FIX). The coordinator's explicit steer this round: prefer
cutting to "Later" over adding more machinery. Findings 1-3 all attacked the SAME round-4 mechanism
(`commit_memory()` + `coach_memory_state`), on its second attempt — that pattern is the signal this
run acted on: bulk "Forget everything" is cut to "Later" rather than given a third design. None
rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §2 — the `commit_memory()` RPC is withdrawn entirely (with the fence it existed for). The commit route goes back to an ordinary server route resolving `userId` from `requireUser(req)`, never a caller-suppliable parameter. | Confirmed: `commit_memory(p_user_id uuid, ...)` had no `revoke`/`grant execute` restriction and no internal `auth.uid()` check, while the codebase's own privileged-RPC pattern does both (`supabase/migrations/20261023091000_target_revision_transactions.sql:71,79,85`) — Postgres grants a new function to `PUBLIC` by default. |
| 2 | BLOCK | §2 — resolved by the same withdrawal: the medical and dedupe judges run as ordinary `await`ed JavaScript in the route handler, never described as running "inside a transaction." | Confirmed: `systemOne()` calls out over `fetch` (`lib/ai/typesafe.ts:284`) — there is no SQL implementation for a Jev call, so a Postgres function could never have run it as step 3 claimed. |
| 3 | BLOCK | §2, §4 — resolved by the same withdrawal: `coach_memory_state` no longer exists, so there is no fence row for a direct PostgREST write to tamper with. | Confirmed: the spec's own round 2 resolution had already named and removed this exact class of hole (pattern-1 RLS giving `authenticated` direct write access to a table meant to be tamper-proof) — round 4 reintroduced it under a different table name. |
| 4 | BLOCK | §2 — a new, distinct `MemoryProposal` type and `memoryProposal` response field, captured from `propose_memory`'s own tool result, NOT `CoachDraft`; a new, small confirm component, NOT `CaptureSheet`. | Confirmed: `CoachDraft` requires `draftId`, `slot` and food `items` (`lib/coach/types.ts:51`), the turn captures a draft only from `draft_log_entry` by name (`lib/server/coach-turn.ts:735`), and `CoachScreen` routes every `draft` to the food-only `CaptureSheet` (`app/coach/CoachScreen.tsx:100,121`) — none of which fits a `{ memKind, text }` proposal. |
| 5 | FIX | §2 — accepted as a documented limitation matching existing precedent: `memoryProposal: null` on a replayed turn, the same as `draft` itself already returns on replay. | Confirmed: `storedTurn()` hardcodes `draft: null` unconditionally (`lib/server/coach-threads.ts:86`) — `draft_log_entry`'s own draft already has this exact loss-on-retry characteristic, accepted by the shipped app; Phase 11 matches it rather than building new persist/replay plumbing for one field only. |
| 6 | FIX | §1, §Tightening — the SAME migration that adds `last_message_preview` also backfills it for every existing thread from that thread's latest message. | Confirmed: the search-doc backfill (already specified) covers a different pair of columns; nothing in the prior draft populated `last_message_preview` for a thread that predates the column. |
| 7 | FIX | §2 — the near-user REMINDER line (`lib/server/coach-turn.ts:510`) gets one added clause carving out remembering as a tool call, not a final action; the live eval now includes the literal phrase "remember this." | Confirmed: the reminder says a save is carried out "ONLY by the `actions` array," written before `propose_memory` existed and now directly contradicting it. |

**Rejected: none.** Findings 1-3 are not treated as "partially rejected" for being resolved by
removal rather than a fix in place — the underlying claims are accepted in full; removing the
mechanism they describe is the fix, per the coordinator's explicit instruction this round.

## Resolution of audit round 6

Source: `docs/audit/specs/2026-09-22-phase-11-r6-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 4 BLOCK, 3 FIX). The coordinator's own framing: Phase 11 was "not
converging (6→4→4)" across rounds 4-6, all three concentrated in account memory's write path.
Instruction: cut harder — ship the smallest safe core (conversations, rename, soft delete,
full-text search, `recall_conversations`) and move account memory writes to "Later" entirely. This
run did that. None rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §2 — moot: account memory (including the non-atomic contradiction/supersede/cap-evict sequence this finding is about) is cut to "Later" as a whole. The atomicity requirement is carried forward as a design lesson for whenever it ships. | Confirmed: the round-5 "ordinary `adminClient()` writes" design left a contradiction's insert + supersede + a possible cap eviction as 2-3 independent writes with no shared transaction — a failure between them could hide a fact or exceed the cap. |
| 2 | BLOCK | §1, §2 — moot: there is no `coach_memories` table this round, so there are no citations to clear and no trigger needed. The `SECURITY DEFINER` + fixed-search-path requirement is carried forward as a design lesson. | Confirmed: `coach_memories` has no `authenticated` update policy (by round 4's own design), and a default `SECURITY INVOKER` trigger runs as the deleting user — it could not have updated a table it has no grant on. |
| 3 | BLOCK | §2 — moot: there is no `memoryProposal` field or confirm card this round. The "a new response field needs an explicit client consumer" requirement is carried forward as a design lesson. | Confirmed: `nextChatState()` (`lib/coach/chat-state.ts:109`) has no case for an unknown field and would silently drop `memoryProposal` — nothing would ever render the card. |
| 4 | BLOCK | §1 — `CoachScreen`'s `CoachConversation` gets a `chatGen` counter, bumped on every "new chat" press and on deleting the open thread; `CoachChat`'s key joins user id, thread id (or a fallback), and `chatGen` — a fresh key on every reset, never dependent on `CoachShell` ever reporting a lazily-created thread's real id back to the parent. | Confirmed: `resume.threadId` stays `null` after a lazy thread creation (`app/coach/CoachScreen.tsx:99`), `onThreadSaved` only writes `localStorage`, and `CoachShell` learns the real id purely internally (`components/coach/CoachShell.tsx:232`) — round 4's `key={threadId ?? "new"}` would compute the SAME `"new"` key on a second "new chat" press, never remounting. |
| 5 | FIX | §2 — moot: no dedupe judge ships this round; its result-contract and failure-rule requirements are carried forward as design lessons. | Confirmed: the round-5 design named "one batched judgment" without a validated response schema or a defined `null`-result behavior. |
| 6 | FIX | §1 — the onboarding thread and weekly review get NO rename/delete control in the UI; the purge stays `kind = 'chat'`-scoped as defense in depth, but the PRIMARY guarantee is now correctly attributed to Phase 10's own RLS block on `UPDATE`/`DELETE` for `kind = 'onboarding'`, not to this spec's purge filter; the Preview step is replaced with an attempted-delete-is-refused check. The "delete or edit that conversation" Settings copy this finding also flagged is moot — that copy lived in the now-cut §4. | Confirmed: `docs/specs/phase-10-conversational-onboarding.md:606-612` states plainly that Phase 10's RLS refuses an authenticated user's update/delete on an onboarding thread, and that no Delete control is needed for it — Phase 11 ships after Phase 10 in this program's own order, so this rule is already in place by the time Phase 11's UI matters. |
| 7 | FIX | §2 — moot: the structured-field write-time exclusion this finding is about belongs to account-memory writes, cut to "Later." Carried forward as a design lesson: enforce it at every write path (create, Edit, any future bulk path), not only where the prompt states it. | Confirmed: the prompt-only rule had no enforcement at either `POST` or `PATCH`, so a stale calorie target could be saved or edited into memory and read as current. |

**Rejected: none.** Findings 1, 2, 3, 5 and 7 are not "partially rejected" for being resolved by
cutting the feature they describe rather than fixing it in place — their underlying claims are
accepted in full, carried forward as design lessons in §2, exactly matching how round 5 treated its
own findings 1-3.

## Resolution of audit round 7

Source: `docs/audit/specs/2026-09-22-phase-11-r7-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 2 BLOCK, 3 FIX). The coordinator's own framing: the core is
converging (round 6's cut brought the finding count down sharply). Every finding this round is
inside the shipped core (conversations, recall) — none is about the deferred account-memory
feature. None rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §3 — `recallConversations` gets an `excludeThreadId` parameter, sourced from `runTurn()`'s already-resolved `threadId`; the search RPC excludes it; recall evidence now carries each hit's source thread and date, not a bare snippet. | Confirmed: nothing in the prior draft excluded the active thread from the search, so `recall_conversations` could "recall" the very conversation it is running in, while the verifier's question assumed every hit was from an earlier, different one. |
| 2 | BLOCK | §3 — the Jev-unavailable fallback is now structural (was `recall_conversations` called this turn) instead of textual (does the reply contain a retrospective phrase), with its own neutral "can't check reliably right now" text, separate from the unlisted-action fallback. | Confirmed: a reply like "Peanuts" answering "what did I say I was avoiding?" makes an unsupported claim with no retrospective phrase for a text heuristic to catch, and the existing correction path's exhausted-retry text ("I have not logged that yet") is written for a different claim type entirely (`lib/server/coach-turn.ts:758`). |
| 3 | FIX | §1, §Tightening — `last_message_preview` maintenance moves from an app-code write in `persist()` to an `after insert on coach_messages` trigger, so it also covers `writeWeeklyReview()`'s separate insert path. | Confirmed: `writeWeeklyReview()` (`lib/server/coach.ts:123-133`) inserts a message and updates only `last_message_at`, never `last_message_preview` — a weekly review would show a blank preview forever under the prior, `persist()`-only design. |
| 4 | FIX | §1, §Tightening — Phase 11 adds its own restrictive RLS and `resolveThread()` block for `kind = 'weekly_review'`, mirroring the shape Phase 10 gives `kind = 'onboarding'`, since Phase 10's spec does not cover this kind and Phase 11 is the spec that owns the concept of a pinned, non-chat thread. | Confirmed: the existing `DELETE` route filters only by owner and id, not kind, under RLS that still permits owner `UPDATE`/`DELETE` for any kind — a direct call could soft-delete the weekly-review thread, after which `writeWeeklyReview()` would create a second active one and the `kind = 'chat'`-scoped purge would never clean up the orphaned first. |
| 5 | FIX | §3 — recall results are labeled historical in their rendered envelope; the prompt gets one line that a recalled number is not current, and that a failed current-context read means "cannot confirm," not a fallback to the recalled number. | Confirmed: `recall_conversations` returns raw historical message text that can include a superseded target, the current authoritative number's read (`lib/server/day-context.ts:179-204`) is allowed to fail and is silently omitted when it does (`lib/server/coach-turn.ts:491-503`), and nothing in the prior draft told the model which number should win. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code.

## Resolution of audit round 8

Source: `docs/audit/specs/2026-09-22-phase-11-r8-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 4 BLOCK, 2 FIX). All four BLOCKs landed inside coach-driven recall
(`recall_conversations`, its Jev verifier, and the historical-target guarantee riding on it).
Decision (Devin accepted the cut): move that whole mechanism to "Later," the same treatment round 6
gave account memory, rather than attempt a fourth design under the same three-round pattern. The
two FIXes are general conversations-list correctness bugs, unrelated to recall, and are fixed in
place. None rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §3 — moot: `recall_conversations` and its Jev-unavailable fallback are cut to "Later" as a whole. The "verify retrieval independent of tool-call observation" requirement is carried forward as a design lesson. | Confirmed: the turn schema (`lib/coach/turn.ts:110`) allows a final reply with no tool call at all, so the round-7 fallback — gated on "was `recall_conversations` called" — never triggered when the model simply skipped the tool and answered from a guess. |
| 2 | BLOCK | §3 — moot: the whole failed-verification-fallback mechanism is cut. The "discard the WHOLE turn's dependent output, not just swap the text" requirement is carried forward as a design lesson. | Confirmed: `lib/server/coach-turn.ts:774` carries `actions` separately from the reply text, and `CoachShell.tsx:150` applies received actions automatically — the round-7 design replaced only the TEXT on a failed verification, so a guessed action could still apply under a "I can't check" reply. |
| 3 | BLOCK | §1 — NOT cut; a general conversations-list bug, fixed directly: the attachment turn's own separate `replay()` function (`lib/server/coach-attachments.ts:93-113`) gets the same `deleted_at` check `storedTurn()` already has. | Confirmed: `runTurn()` branches to attachment turns before it ever reaches `storedTurn()` (`lib/server/coach-turn.ts:228`), and `replay()` reads `coach_messages` back with no thread-status check of any kind. |
| 4 | BLOCK | §3 — moot: the historical-target guarantee is cut along with recall, since it existed only to qualify a recalled number. The "enforce outside model prose, matching `reply-check.ts`'s existing pattern" requirement is carried forward as a design lesson. | Confirmed: round 7's fix was a label plus a prompt line, with nothing deterministic behind it — `reply-check.ts:36` validates foods this way already, numbers had no equivalent. |
| 5 | FIX | §1, §Tightening — the deleted-thread-lock trigger now fires on `insert or update of thread_id`, not `insert` alone. | Confirmed: deployed RLS permits an owner's `UPDATE` of an existing message (`20261103090100_same_owner_references.sql:393`), and the trigger's own ownership check does not look at `deleted_at` (line 140) — an insert-only trigger missed a message re-pointed at a deleted thread via `UPDATE`. |
| 6 | FIX | §1, §Tightening — a new `removeCache(h, threadId)` function, called from the client's delete handler right after a successful `DELETE`. | Confirmed: PR #248's cache API (`coach-client.ts:85,111`) has `readCache`/`writeCache` but no eviction function — a server-side delete left the transcript fully readable from `localStorage`. |

**Rejected: none.** Findings 1, 2 and 4 are not "partially rejected" for being resolved by cutting
the feature they describe — their underlying claims are accepted in full, carried forward as
design lessons in §3, exactly matching how round 6 treated account memory's findings.

## Resolution of audit round 9

Source: `docs/audit/specs/2026-09-22-phase-11-r9-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 2 BLOCK, 3 FIX). Small and concrete, entirely inside the shipped
conversations core — no cut needed this round. Every finding was checked against the current code
and fixed in place. None rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §1 — the `kind = 'weekly_review'` restrictive RLS also refuses `authenticated` `INSERT`, not only `UPDATE`/`DELETE`; the service-role writer (`writeWeeklyReview()`) is unaffected. | Confirmed: owner RLS pattern-1 permits `authenticated` `INSERT` (`supabase/migrations/20260911000500_rls.sql:17`), and the round-7 fix only named `UPDATE`/`DELETE` — a direct call could create a duplicate pinned thread the cron's find-existing-or-create logic (`lib/server/coach.ts:105`) would never notice. |
| 2 | BLOCK | §Tightening — the search RPC's `where` clause adds `coach_threads.deleted_at is null`, covering both a title match and a message-content match (via the message's parent thread). | Confirmed: owner RLS does not filter `deleted_at` (it is a `for all` grant with no such clause), and the list route's own equivalent filter (`app/api/coach/threads/route.ts:23-31`) was never carried into the RPC as specified. |
| 3 | FIX | §1 — the same backfill migration that populates `last_message_preview` also backfills `last_message_at` from each thread's latest message, for any row where it is still null. | Confirmed: Phase 7 added `last_message_at` as a bare nullable column with no backfill (`supabase/migrations/20261001000000_phase7_coach.sql:11`), and §1's own "latest first" / relative-time promise had nothing to guarantee it for a pre-Phase-7 thread. |
| 4 | FIX | §1 — `GET /api/coach/threads` (and its `?q=` search branch) gets cursor pagination (`?before=`/`limit`/`nextCursor`), matching the paging shape `GET /api/coach/threads/[id]` already uses. | Confirmed: the list route is unpaged, and `supabase/config.toml:10` caps any single PostgREST response at 1,000 rows with silent truncation, not an error — breaking the "find any conversation" promise for a long-lived account with no warning. |
| 5 | FIX | §1 — the `removeCache()` guarantee is narrowed to the deleting device only; another signed-in device is specified to evict its own cached copy on its next list fetch, not immediately. | Confirmed: `removeCache()` can only clear the calling device's own `localStorage` — it has no reach to a second device's independent cache, so the original unqualified claim ("cannot be read back locally") was true only for one device. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code.

## Resolution of audit round 10

Source: `docs/audit/specs/2026-09-22-phase-11-r10-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 3 BLOCK, 3 FIX). Every BLOCK was a real gap in round 9's OWN fixes,
caught on the very next pass — the coordinator's steer this round was simplest cuts over more
machinery, applied to each. None rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §1 — an irreversible-tombstone trigger refuses `authenticated` clearing `deleted_at` back to null on `coach_threads`; `revoke delete on coach_threads from authenticated` reserves hard deletion for `service_role` (the purge job). | Confirmed: the shared pattern-1 RLS grant gives `authenticated` direct `UPDATE`/`DELETE` on `coach_threads` (`supabase/migrations/20260911000500_rls.sql:17`), and round 7/9's restrictions only ever named the two PINNED kinds — an ordinary `chat` tombstone had no guard at all. |
| 2 | BLOCK | §Tightening — search is NOT paginated; it returns the top 50 distinct matching threads by `ts_rank`, stated as a limit, with no `nextCursor`. | Confirmed: round 9's list-pagination cursor (`coalesce(last_message_at, created_at), id`, a recency order) cannot correctly page a `ts_rank`-ordered result set (a relevance order) — a high-ranked old hit could cause a newer, lower-ranked one to be skipped, and a thread matched by two messages could repeat. |
| 3 | BLOCK | §1 — cache eviction for a device OTHER than the one that deleted a thread moves from "diff a list page" to "evict on open": `getThread()`/`fetchOlder()`'s existing 404 for a deleted thread now also triggers `removeCache()` and clears an open transcript. | Confirmed: round 9's fix evicted any cached thread id absent from a FETCHED PAGE of the list — but §1's own pagination (round 9 finding 4) means an active thread can simply be on a page the device has not fetched, and would have been wrongly evicted as if deleted. |
| 4 | FIX | §1 — `coalesce(last_message_at, created_at)` is the one ordering/cursor/displayed-time value, used consistently, so an empty (never-messaged) thread has a real, non-null value to sort and page by. | Confirmed: `last_message_at` is nullable and the create route can leave it null (`app/api/coach/threads/route.ts:37-46`); the round-9 backfill only reaches rows that already have a message, not a thread with none. |
| 5 | FIX | §1 — `listThreads()`'s return type widens to `{ threads, nextCursor }`; `CoachScreen.tsx:61`'s resume `.find()` updates to `(await listThreads()).threads.find(...)`, in the same slice as the route change. | Confirmed: `listThreads()` currently returns a bare `ThreadSummary[]` (`lib/coach-client.ts:258-260`) and the resume path calls `.find()` on it directly (`app/coach/CoachScreen.tsx:61`) — pagination changes the shape out from under that caller if not updated together. |
| 6 | FIX | §1 — `removeCache()` gets the same `if (h === null) return;` guard `writeCache()` already uses, before calling `cacheKey()`. | Confirmed: `cacheKey(h: AccountHandle, ...)` requires a non-null handle (`.claude/worktrees/agent-af9e42fc3664b612b/lib/coach-client.ts:85`), but the specified `removeCache(h: AccountHandle | null, ...)` called it directly — a type error the null branch never handled. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code — three of
them (1, 2, 3) in fixes this same run applied only one or two rounds ago, confirming the value of
re-auditing each fix rather than treating a prior round's resolution as final.

## Resolution of audit round 11

Source: `docs/audit/specs/2026-09-22-phase-11-r11-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 1 BLOCK, 3 FIX, 1 NIT). Nearly clear, per the coordinator's own
read. None rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §1 — `deleted_at` becomes a column `authenticated` cannot write at all: `INSERT` normalizes it to null regardless of client input, `UPDATE` refuses ANY change to it. Soft delete moves to a `security definer` RPC, `soft_delete_thread()`, that stamps `now()` itself and is idempotent on retry. | Confirmed: round 10's trigger only blocked the non-null→null transition — a direct `INSERT`/`UPDATE` could still set or move `deleted_at` to an arbitrary VALUE, backdating a new thread to immediate purge eligibility or postponing an existing tombstone indefinitely. |
| 2 | FIX | §1 — resume uses a SEPARATE, dedicated, unpaged query (`kind = 'chat' and last_message_at is not null`, one row) instead of reading the general paginated list. | Confirmed: page one is ordered by `coalesce(last_message_at, created_at)`, so enough recently-CREATED empty chats can outrank an older but actually-messaged one and push it to page two, where the resume consumer would never see it. |
| 3 | FIX | §1 — the delete handler treats a 404 on its OWN delete call as confirmation, not just failure, and evicts the cache (and clears an open transcript) on that outcome too, not only on a 2xx. | Confirmed: the route only updates an active thread, so a retried delete after a lost response 404s — and the original handler only cleared the cache on a 2xx, leaving a genuinely-deleted thread's cache stale after exactly the retry sequence most likely to happen. |
| 4 | FIX | §1 — the preview/time-maintenance trigger fires on `insert or update or delete` of `coach_messages`, not `insert` alone, and RECOMPUTES from whichever message is now actually latest rather than copying the triggering row's own value. | Confirmed: `coach_messages` RLS is a `for all` grant (`supabase/migrations/20260911000500_rls.sql:55-58`) — an owner can directly edit or delete their own latest message, which an insert-only trigger has no way to notice. |
| 5 | NIT | §1 — corrected: `CACHE_LIMIT` trims the message list WITHIN one cached thread to its last 50 messages; it does not evict thread cache keys. An unopened stale entry persists until opened or until site storage is cleared. | Confirmed: `CACHE_LIMIT` (`lib/coach-client.ts:22,104`) is applied to `cached.messages.slice(-CACHE_LIMIT)` inside `writeCache()`, with no code path that removes a whole thread's key. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code.

## Resolution of audit round 12

Source: `docs/audit/specs/2026-09-22-phase-11-r12-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict DO NOT SHIP, 1 BLOCK, 4 FIX, 0 NIT). Every finding was a gap in a fix from round
10 or 11, caught on the next pass — the same pattern rounds 10 and 11 already showed. None
rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | BLOCK | §1 — `soft_delete_thread()` also requires `kind = 'chat'`, refusing (404) a call against the onboarding or weekly-review thread even though the function runs with elevated privilege. | Confirmed: a `security definer` function bypasses RLS entirely — Phase 10's protection for onboarding and §1's own `kind = 'weekly_review'` restriction both apply to RLS, which this RPC never consults, so its own ownership check needed to be the kind check too. |
| 2 | FIX | §1 — the preview/time-maintenance function is called for BOTH `old.thread_id` and `new.thread_id` when an `UPDATE` changes a message's `thread_id`, not only the new one. | Confirmed: the deployed ownership rule allows an owner to move their own message between their own threads — recomputing only the destination left the origin thread's preview and time stale. |
| 3 | FIX | §1 — the dedicated resume query checks `exists (select 1 from coach_messages where thread_id = t.id)` directly, using `last_message_at` only for `order by`, not as proof of having a message. | Confirmed: round 11's own fix (falling back to `created_at` for an emptied thread) made `last_message_at is not null` true for a thread with zero messages, exactly the condition the resume query was using as its "has a message" test. |
| 4 | FIX | §1 — the delete route's cache-eviction and its test both move to the RPC's actual contract: 2xx (including a retry) for an owned thread, 404 for unknown/foreign/wrong-kind; `removeCache()` fires on 2xx, never on 404. | Confirmed: round 11's cache fix assumed a retry 404s, but round 11's OWN RPC (finding 1 of that round) is idempotent and returns success on a repeat call — the two specs, written one after the other in the same round, had already drifted apart. |
| 5 | FIX | §1 — `persist()` and `writeWeeklyReview()` both drop their manual `last_message_at` write; the trigger is the only writer of that column, for every path named. | Confirmed directly: `persist()` (`lib/server/coach-threads.ts:173`) and `writeWeeklyReview()` (`lib/server/coach.ts:132-133`) each patch `last_message_at` with their own `new Date().toISOString()` AFTER the message insert that already fires the trigger — silently overwriting it every turn, contradicting the "the trigger owns it" claim two rounds had already made. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code.

## Resolution of audit round 13

Source: `docs/audit/specs/2026-09-22-phase-11-r13-gpt6-sol.md` (GPT-6 Sol, codex exec, xhigh,
read-only; verdict SHIP WITH FIXES, 0 BLOCK, 4 FIX, 0 NIT — the first non-blocking verdict). Every
finding was again a gap in a round-12 (or earlier) fix, or stale prose the last few rounds' fixes
left behind. None rejected.

| # | Severity | Change (section) | Evidence |
|---|----------|-------------------|----------|
| 1 | FIX | §1 — the `deleted_at`-guard trigger on `coach_threads` also forces `last_message_preview`/`last_message_at` to null on `INSERT` and refuses any authenticated `UPDATE` of either, except from the maintenance function's own privileged role; `refresh_thread_preview()` becomes `security definer`, execute revoked from `authenticated`. | Confirmed: the shared pattern-1 grant (`supabase/migrations/20260911000500_rls.sql:17`) permits authenticated `INSERT`/`UPDATE` on the whole `coach_threads` table, and the existing guard trigger named these two columns as untouched by design — a direct PostgREST call could set either to any value. |
| 2 | FIX | §1 — the backfill recomputes `last_message_at` for EVERY thread with a message, unconditionally, not only where it is null. | Confirmed: `persist()` (`lib/server/coach-threads.ts:173`) and `writeWeeklyReview()` (`lib/server/coach.ts:132`) wrote a later, wrong application timestamp every turn until round 12 removed those writes going forward — the old `... is null` backfill left every already-wrong, non-null historical value uncorrected. |
| 3 | FIX | Success criteria — the in-flight/cross-device guarantee is restated as a commit-order guarantee (no second message or resume once a delete commits), not "no device can continue a deleted conversation," with the residual case named: a turn whose insert wins the lock race still delivers and auto-applies its one reply on the originating device. | Confirmed: `lib/server/coach-turn.ts:799` and `components/coach/CoachShell.tsx:150,238` dispatch and auto-apply a turn's actions on the client once the server responds, independent of a deletion that commits moments later on another device. |
| 4 | FIX | §1 (three spots) — the citation-clearing bullet now says the `DELETE` handler calls `soft_delete_thread()`, not a plain `.update()`; the onboarding/weekly-review protection bullet now credits the RPC's own `kind = 'chat'` check for the app's delete route, and Phase 10's/§1's RLS for a direct, non-app write, rather than naming RLS "primary" for both; the maintenance summary now says `after insert or update or delete`, not `after insert`. | Confirmed by reading the cited spans directly: all three described the pre-round-11/pre-round-12 design and were never updated when those rounds replaced the mechanisms. |

**Rejected: none.** Every finding pointed at a real gap once checked against the code.

## Open for Devin

Updated after round 13 — the first non-blocking verdict (SHIP WITH FIXES, 0 BLOCK). Rounds 10
through 13 in a row found their BLOCK/FIX findings entirely inside fixes made one or two rounds
earlier (or, this round, stale prose those fixes left behind), not new territory. That pattern is
itself the most useful signal left in this audit history: a fix specified correctly in isolation can
still drift out of sync with a SIBLING fix specified in the same or an adjacent round, or leave
behind a prose description of the mechanism it just replaced.

**Cut to "Later" (rounds 6 and 8, unchanged this round):**
- Account memory, entirely (round 6). §2 carries forward the concrete lessons.
- Coach-driven recall, entirely (round 8). §3 carries forward the concrete lessons. The
  user-facing search box (§1) is UNAFFECTED by that cut.

**Resolved this round, not yet independently re-audited:**
- Authenticated direct writes could forge the list's preview or timestamp — both columns are now
  guarded the same way `deleted_at` already was, with the maintenance function's own privileged
  role as the one exception.
- The backfill left pre-round-12 wrong timestamps in place — now recomputed unconditionally from
  each thread's actual latest message.
- The Success Criteria overstated the row lock's guarantee — narrowed to commit-order, with the
  one-reply residual case named explicitly.
- Three prose passages still described mechanisms rounds 11-12 already replaced — corrected.

**Still open:** none. This spec has cleared 0-BLOCK; the four FIXes above are resolved but, like
every prior round's fixes, not yet independently re-audited — see "Next audit."

## Next audit

This spec has now had thirteen audit rounds: three of them (4-6) converged on cutting account
memory, and a further three (6, 7, 8) converged on cutting recall too — the same pattern, twice, on
two different features. Rounds 9-13, run against what was left after both cuts, found only small,
concrete gaps, each round about as small as the last (2, 3, 1, 4, then 0 BLOCK) — and rounds 10
through 13's BLOCK/FIX findings were entirely gaps IN THE PRIOR ROUND's OWN FIXES, or stale prose
those fixes left behind, not new territory. Round 13 is the first non-blocking verdict (SHIP WITH
FIXES, 0 BLOCK). That is worth naming plainly for whoever plans next: a fix applied in one round has
repeatedly needed a further pass to hold up (round 4's confirm-card fix needed round 5's rework;
round 7's recall fixes needed round 8's cut; round 9's pagination and cache fixes needed round 10's
correction; round 10's tombstone fix needed round 11's; round 11's RPC, trigger, and resume fixes
each needed a further correction in round 12; round 12's trigger-ownership, backfill, and delete-path
fixes each needed a further correction in round 13) — the plan should budget its OWN review pass per
slice, not assume a spec fix ships correct on the first implementation attempt merely because it
read correctly on the page — and should specifically re-verify that two fixes written close
together (like round 12's finding 4, where the cache fix and the RPC contract disagreed) actually
agree with each other, not just each with the code they were reacting to, and should re-check any
prose describing a mechanism a LATER round's fix replaced (round 13's finding 4). No round-13 FIX
has been independently re-audited yet — a round 14 pass targeted at just these four changes would
close that gap, but is not required before treating the spec as ready; a round 14 finding here, if
any, would very likely be another instance of this same pattern. What is fixed, per the
overnight run's own contract (`docs/plans/2026-09-22-multi-user-overnight-run.md`,
step 6's pattern for Phase 9's plan): the Phase 11 IMPLEMENTATION PLAN, once
`superpowers:writing-plans` turns this spec into PR-sized slices with tests, MUST itself be audited
before any Phase 11 code is written — a spec audit is not a substitute for a plan audit. The plan
author should read "Open for Devin" above first: it should plan the smallest safe core this spec now
scopes (conversations only) and treat account memory AND recall as genuinely out of scope, not
stretch goals to sneak back in — future specs, written fresh from §2's and §3's carried-forward
lessons rather than iterated on again, are the right vehicle for each. The plan should also
re-verify, at implementation time, that PR #248 and the Phase 9 plan's own migrations
(`20261104`–`20261107`) and Phase 10's onboarding-thread RLS
have actually landed in the shape this spec assumed, since all were still unmerged, moving targets
when this revision was written.
