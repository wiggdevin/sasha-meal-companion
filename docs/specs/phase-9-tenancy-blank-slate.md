# Phase 9 — Tenancy and a blank slate for every new account

**Superseded in part (owner decision, 2026-10-08).**
- **§1, the invite-code system (`invite_codes`, `invite_claims`, `account_claims`) is retired,
  not built.** Self-serve sign-up shipped instead (`docs/decisions/2026-09-25-self-serve-signup.md`):
  `/sign-in` has a "Create an account" mode with no invite required. No `account_claims`,
  `invite_codes` or `invite_claims` migration or code exists in this repo. Do not resurrect §1
  unless a new abuse/spam reason appears.
- **§2, per-user day templates, is Later — not implemented.** No `day_templates`,
  `template_slots` or `template_key_validation` migration exists; nothing in `lib/` or `app/`
  reads or writes them. `docs/plans/2026-09-22-phase-9-tenancy/README.md:53` already called this
  out as parked for Devin; this is the formal mark in the phase spec itself.

Revision 4 (2026-09-22). Audit history, all by GPT-6 Sol:
- Round 1 (`docs/audit/specs/2026-09-22-phase-9-gpt6-sol.md`): DO NOT SHIP, 11 BLOCK, 4 FIX, 1 NIT.
- Round 2 (`docs/audit/specs/2026-09-22-phase-9-r2-gpt6-sol.md`): DO NOT SHIP, 12 BLOCK, 3 FIX.
- Round 3, the last allowed (`docs/audit/specs/2026-09-22-phase-9-r3-gpt6-sol.md`): DO NOT SHIP,
  5 BLOCK, 3 FIX. Revision 4 applies every round 3 finding with the most conservative cut. No
  auditor re-checks revision 4, so the five round 3 BLOCKs are also listed under "Open for Devin".

Revision 3 applied every round 2 finding. To keep the design small, it cuts scope: in Phase 9
templates are **server-written and read-only for the client** (no client edits, no archive, no
template sync through the outbox or the change feed). Offline template editing moves to "Later".
The mappings are in "Resolution of audit round 1" and "Resolution of audit round 2" near the end.

Design approved in chat by Devin, 2026-09-22: approach A (per-user day templates), invite codes for
sign-up, and the tenancy audit below. This is part 1 of 4 in the multi-user program; parts 2–4
(conversational onboarding, conversations and memory, coach tools) get their own specs and depend on
this one. Program contract: `docs/plans/2026-09-22-multi-user-overnight-run.md`.

Decisions this revision made without Devin are marked **DECIDED (run)** with a one-line reason, so
he can override any of them.

## Goal

Every account is its own. A new user signs up with an invite code, sees a blank slate, and never
sees anything from Sasha's build: no ritual slots, no pouches, no hot chocolate, no fasted
Wednesday, no allergens or conditions. Sasha's own account keeps exactly what it has today: the
same resolved days, the same meals, the same keys. No account can read or change another account's
data — on the server and on a shared phone — and CI proves it with tests that fail when a guard is
weakened.

## Facts this spec rests on (read 2026-09-22 at `1c8b084`, plus PR #241 at `f743cfb`)

Device state:
- One IndexedDB database for every account: `DB_NAME = "smc"` (`lib/sync/idb.ts:12`), opened once
  per page and cached in a module global (`lib/sync/idb.ts:39-63`). It holds every entity mirror,
  the `outbox`, the `meta` store with the change cursor, and `catalog_revisions`.
- Entity keys carry no user id (`lib/sync/keys.ts:30-37`): `plan_days` is keyed by date only,
  `user_settings` by the literal `"settings"`. So one mirror store can hold rows of two accounts,
  and a key does not say whose row it is.
- An outbox op carries no user id (`lib/sync/types.ts:29-33`). `POST /api/sync/ops` takes the user
  from the JWT (`app/api/sync/ops/route.ts:79`) and applies every op in the body to that user
  (`route.ts:84-93`). An op queued by account A and sent after account B signs in is applied to B.
- (Before this phase) On sign-out or account change, `AuthGate` forgets the disposition cache and calls
  `clearFoodProjection()` only (`components/AuthGate.tsx:254-261`, `lib/store.ts:322-325`).
- `lib/store.ts` keeps the whole store in a module global `cached` (`lib/store.ts:128`) that
  `currentStore()` returns (`store.ts:194-196`) and every day writer updates.
- Other module-global client state keyed without an account: `refCache` (`lib/log-client.ts:89`),
  `pendingDates` (`lib/sync/plan-day-queue.ts:1`), `inFlight` sync pass (`lib/sync/client.ts:248`),
  `applying`/`undoing` (`lib/coach/apply-client.ts:33-34`), `live`/`deletedWhileLive`
  (`lib/log/live-commits.ts:24,99`), `saves` (`lib/log-note-client.ts:8`), `inFlight`
  (`lib/health/weigh-in-client.ts:271`), `membershipRevisions`/`inFlight`/`failedIds`
  (`lib/foods/prefs-client.ts:99,427,435`; `stateOwner` at `:438` already tracks an owner),
  `sessionValue`/`inFlight` (`lib/health/capability.ts:15-16`).
- Delayed writers settle into IndexedDB after an `await`, for example `rollbackMirror` reads and
  writes `log_entries` after a server answer (`lib/log-commit-settle.ts:101-110`). Modules that call
  the IDB primitives (`getRow`, `putRow`, `deleteRow`, `allRows`, `appendOp*`): 24 files outside
  `lib/sync/idb.ts` (`grep` list in section 0).
- `SyncBootstrap` is mounted outside `AuthGate` (`app/layout.tsx:47-49`). It starts a sync pass at
  mount (`components/SyncBootstrap.tsx:64`) and on visibility and online events; its auth listener
  restores cached plan days but does not start or restart sync (`SyncBootstrap.tsx:49-62`).
- User data in `localStorage` without an account key: `smc:coach:<threadId>`
  (`lib/coach-client.ts:5,21`), `smc:draft:*` (`lib/capture/drafts.ts:12`), `smc:coach-action:*`
  (`lib/coach/apply-client.ts:30`), `smc:health_daily` (`lib/health-client.ts:54`),
  `smc:expenditure`, `smc:proposals` (`lib/estimator-client.ts:17-18`), `smc:pending_scans`
  (`lib/barcode/scan-cache.ts:9`), `meal-companion:store:v1` (`lib/store.ts:13`),
  `meal-companion:food-refs` (`lib/log-client.ts:88`),
  `meal-companion:onboardingInviteDismissedAt` (`lib/profile/onboarding-state.ts:19-20`). Already
  per account: `smc:coach:current:<userId>` (`app/coach/CoachScreen.tsx:17`),
  `meal-companion:food-pref-refs` (`lib/foods/prefs-client.ts:54,166`), the disposition cache
  (`components/AuthGate.tsx:116`). Device-level: `smc:body_capability`, `smc:coach:return`
  (`sessionStorage`), the install-prompt flag.
- The service worker caches navigation HTML network-first (`public/sw.js:22-23,84`).
- The outbox never deletes an op the server answers with `error`: it retries, then parks it
  (`lib/sync/outbox.ts:198-208,309-311`). It drops an op on `unsupported` and on any unknown status
  (`outbox.ts:305-308,320`).
- Pulled mirror rows carry `user_id`, because `_sync_current` returns `to_jsonb(t)`
  (`supabase/migrations/20260919090300_phase3_sync_entities.sql:55-56`). Outbox ops carry nothing
  that proves their account.
- The pull loop skips an entity it does not know but still advances and saves the cursor
  (`lib/sync/client.ts:129,165-167`).

Sign-up:
- Sign-up is open today: `app/sign-in/page.tsx:76` sends `signInWithOtp` with
  `shouldCreateUser: true` (PR #237). `supabase/config.toml:32,37` enables sign-up for local runs
  and branches; `config.toml:1-2` says production auth is managed in the dashboard.
- The password UI is sign-in only (`components/PasswordSignInForm.tsx:23-26`); the Auth API
  `/signup` endpoint still accepts a password sign-up while sign-up is enabled.
- Supabase Auth calls the before-user-created hook for OTP, password sign-up, OAuth and anonymous
  sign-up, not for `auth.admin.createUser`, and calls it before its own insert transaction (round 1
  findings 2–3).
- Admin-API user creation in the repo: `scripts/readiness/new-user-walk.mjs:95`,
  `scripts/t6-coach-proof.ts:43`, `scripts/t7-transcribe-proof.ts:51`,
  `scripts/coach-live-check.ts:158`, `scripts/food-membership-audit.ts:106`,
  `scripts/eval/coach-streak-harness.ts:147`, `tests/helpers/supabase.ts:87`,
  `tests/rls/new-user-isolation.test.ts:45`, `tests/integration/profile-sync.test.ts:32`,
  `tests/mcp/token.test.ts:32-33`, `tests/coach/suggest-new-account.test.ts:124`,
  `tests/sync/two-client.test.ts:51`; `app/api/dev/sign-in/route.ts:29` (`generateLink`, dev only,
  `lib/server/dev-sign-in.ts:1-5`).
- The rate limiter is one in-memory `Map` per serverless instance (`lib/server/ratelimit.ts:1-11,17`).

Day structure:
- `DayType`/`SlotId` are fixed unions (`lib/types.ts:12-22`). `dayTypeFor` gives `rest` unless the
  weekday is a training weekday, then `training-7-fasted` on Wednesday, else `training-10`
  (`lib/plan.ts:27-38`).
- `SLOT_ORDER` (`lib/plan.ts:43-47`) and `BASE_SLOT_TIMES` (`lib/plan.ts:62-84`) fix her slots and
  times; `settings.slotTimes` overrides a time by slot id for every day type (`lib/plan.ts:123`).
  With no targets, `resolveDay` still returns her slot list and labels, only without meals
  (`lib/resolve.ts:175-217`).
- `categoryFor` is `rest` only for the literal key `rest` (`lib/targets.ts:5-7`); consumers:
  `lib/targets.ts:24`, `lib/water.ts:57-64`, `lib/server/export.ts:227`,
  `lib/server/export-water.ts:55`, `lib/water-client.ts:78`.
- `resolveTargets` returns `null` without an active server revision (`lib/targets.ts:16-21`); the
  API answers `needs_profile` then (`app/api/targets/route.ts:109`).
- `SLOT_TARGETS` is the first option's macros per slot (`lib/meals.ts:949-960`); sizing math:
  `lib/resolve.ts:62-107`; `composeMeal` rounds to servings (`lib/foods.ts:144-168`).
- Ritual options rotate by date with a per-slot phase (`lib/rotation.ts:57-78,203-211`);
  meal-1/2/3 compose from Eats (`rotation.ts:171-201`); de-duplication walks `SLOT_ORDER`
  (`rotation.ts:152`). Meal ids are `<slot>--<slug>` (`lib/meals.ts:79-113`); 4 of 68 ids repeat
  across day types, 3 with different content (probe, 2026-09-22).
- Floor Day meals are keyed by slot (`lib/meals.ts:882-913`, `lib/resolve.ts:173`); the Avoid check
  looks up slugs such as `"eggs"` in a store keyed by `user_foods.id` UUIDs
  (`lib/meals.ts:921-925`, `lib/resolve.ts:155-159`, `lib/store.ts:291`), so it never fires today.
  When a floor meal is not safe, the slot keeps its rotation meal (`resolve.ts:182-184`).
  `evaluatePolicy` checks a food against the account's constraint profile
  (`lib/policy/constraints.ts:99`).
- `isMealSlot` knows only meal-1/2/3 (`lib/meals.ts:938-942`). Callers: `app/page.tsx:543,579,
  592,615`, `lib/rotation.ts:22,171`, `lib/server/coach-ports.ts:110,140,152` (coach meal sizing
  divides the remainder by the count of pending meal slots, `coach-ports.ts:99-111`).
- `applyShiftSchedule` derives slot times from `dayTypeFor` and `resolveSlotTimes`
  (`lib/coach/apply-schedule.ts:18-40`).
- Adherence counts meal-1/2/3 (`lib/summary.ts:25`); completion skips `hot-chocolate`
  (`components/TodayDayStrip.tsx:34`, `components/week/WeekGrid.tsx:9`); Today shows coffee and
  hot chocolate compact (`app/page.tsx:97,547`).
- The calendar feed hardcodes her weekdays for every account (`lib/ics.ts:38-117`).
- `plan_days.day_type_override` has a check on the three keys (`user_schema.sql:80`);
  `plan_day_eaten_slots_valid()` checks the seven fixed slot ids
  (`20261026090000_plan_days_eaten_slots.sql:5-31`). `snack` is the extras pseudo-slot
  (`lib/coach/actions.ts:61-62`).
- `_sync_tombstone` has no template branch and `apply_sync_op` reads `deleted_at`
  (`phase3_sync_entities.sql:95-131,460-470`). PR #241 patches `_sync_upsert` by anchored text
  replacement (`origin/feat/tdee-rate-goals:…/20261029090000_rate_goals.sql:31-66`) and owns
  `20261029090000` and every earlier timestamp.

RLS today is not uniform: `health_samples` and `ingest_events` are select-only for
`authenticated` (`20260925000000_phase5_health_ingest.sql:16-21`); `coach_intent_events` has no
`authenticated` grant at all (`20261022090100_coach_intent_telemetry.sql:26-29`).

Existing tests this spec extends: `tests/rls/{cross-user,new-user-isolation,apply-sync-op,
security-invoker}.test.ts`, `tests/sync/cross-user-http.test.ts`, `tests/log/cross-user.test.ts`,
`tests/export/cross-user.test.ts`, `tests/search/cross-user.test.ts`,
`tests/tenancy/no-personal-defaults.test.ts`.

## Scope

In:
0. Device-state isolation on a shared phone (a live production bug; slice 1, ships alone).
1. Invite-code sign-up with an atomic, nonce-bound account claim and a shared rate limit.
2. Per-user day templates (approach A), **written only by the server** in Phase 9: the default
   template at claim time, and Sasha's templates by a human-run seed. The client reads them.
3. Removal of her plan from shared runtime code, with no fallback to it.
4. Tenancy checks in CI that are behavioral and mutation-tested.
5. One-time read-only production checks, and a list of production steps for Devin.

Out (later specs or "Later" below): template editing of any kind (client or coach), template
archive and versioning, template sync through the outbox and change feed, conversational onboarding
(part 2), memory (part 3), coach tools (part 4), an invite admin screen, a native iOS app.

## 0. Device-state isolation (slice 1)

(Section 0 updated 2026-09-23: header required (401), legacy `smc` never deleted, caches and
shell kept. The reload boundary replaces PR #248's in-place switch: a page binds one account once,
and an account change or sign-out reloads the page after the departing account is durable (0.3,
0.7).)

Rule: nothing on the phone is read, written or sent unless it is bound to the user id of the
current verified session, and no work that started under one account settles under another.

### 0.1 Account handle and epoch

`lib/device/account.ts` owns the binding:
- `bindAccount(userId)` and `unbindAccount()`; each call increments a module `epoch`.
- `accountHandle()` returns `{ userId, epoch }` for the bound account, or throws `AccountNotBound`.
- `assertCurrent(handle)` throws `AccountChanged` when `handle.epoch` is not the current epoch.
- `onAccountReady(listener)` fires after a bind **and** after legacy adoption (0.6) has finished;
  `onAccountGone(listener)` fires on unbind.

`AuthGate.applySession` binds after `sessionUserId(session)` gives a user id
(`components/AuthGate.tsx:273-285`); `forget()` unbinds before it purges.

### 0.2 Primitives require a handle

- IndexedDB: one database per account, `smc-u-<userId>`, version 1, created by the existing
  upgrade loop over `ENTITIES` (`lib/sync/idb.ts:43-57`). `openSmcDb()` becomes
  `openAccountDb(handle)`; the handle map is keyed by user id.
- Every primitive takes the handle as its first parameter: `getRow(h, …)`, `putRow(h, …)`,
  `deleteRow(h, …)`, `allRows(h, …)`, `appendOp(h, …)`, `appendOpWithRow(h, …)`, the outbox and
  cursor functions. Each write calls `assertCurrent(h)` inside its transaction before it writes.
  A read with a stale handle also throws.
- Storage: `accountKey(h, name)` → `smc:u:<userId>:<name>`; the storage helpers take the handle.
- Because the handle is a required parameter, TypeScript finds every caller. The slice changes all
  24 calling files (`lib/recipes-client.ts`, `lib/activity/prompt-client.ts`,
  `lib/plan-day-client.ts`, `lib/favorites-client.ts`, `lib/body-profile-client.ts`,
  `lib/coach/apply-log.ts`, `lib/coach/apply-entries.ts`, `lib/coach/role-advice.ts`,
  `lib/coach/apply-prefs.ts`, `lib/profile/onboarding-client.ts`, `lib/log-commit-client.ts`,
  `lib/log-commit-settle.ts`, `lib/log/reconcile.ts`, `lib/log/retry-unsaved.ts`,
  `lib/log/delete-entry.ts`, `lib/foods/adopt-client.ts`, `lib/foods/prefs-client.ts`,
  `lib/water-client.ts`, `lib/sync/outbox.ts`, `lib/sync/settings.ts`, `lib/sync/client.ts`,
  `lib/sync/log-entry-ops.ts`, `lib/log-note-client.ts`, `components/LoggedExtras.tsx`,
  `components/add-food/catalog-food.ts`) plus the `localStorage` users in Facts.
- Delayed writers keep the handle they started with. Example: `rollbackMirror` and every settle
  path in `lib/log-commit-settle.ts` take the handle captured when the commit started; after an
  account change their write throws `AccountChanged`, and the settle drops the result without
  writing (the server copy is correct for the account that made it, and the next pull of that
  account brings it back).

### 0.3 Module memory

Reload boundary (2026-09-23): a page binds one account, once, and an account change or sign-out
reloads the page (0.7). A new document starts with empty module memory, so no module-global can
carry one account's data to another, and there is no switch-time purge or module-state scan. The
reset functions (`resetStoreCache()` and the others) stay as test seams only. Within a page,
work that outlives the account's freeze still hits `assertCurrent` and stops.

### 0.4 Sync starts only for a ready account

- `SyncBootstrap` moves inside `AuthGate` (`app/layout.tsx:47-49`). It does nothing until
  `onAccountReady`. Then it restores cached plan days for that handle, runs a sync pass, and
  subscribes visibility, online and timer triggers for that handle.
- On `onAccountGone` it cancels its timers and listeners; a new `onAccountReady` starts them again
  for the new handle.
- A pass (`syncOnce`, `pullChanges`, `pushOutbox`) takes the handle; every IDB write in it asserts
  the epoch; a pass that throws `AccountChanged` ends quietly and does not save a cursor.

### 0.5 Outbox ops carry the user id; the server refuses a mismatch

- `SyncOp` gets `user_id` (UUID). `appendOp*` stamps it from the handle; `wireOp` keeps it.
- `app/api/sync/ops/route.ts` checks each op before `applyOp` (`route.ts:89`): missing →
  `{ status: "error", message: "account_unbound" }`; not the JWT subject →
  `{ status: "error", message: "account_mismatch" }`; neither writes. `SyncOpSchema`
  (`lib/sync/types.ts:54-62`) accepts `user_id` as an optional UUID, so the answer is per op.
- **DECIDED (run):** `error`, not a new status. Reason: an older build parks an `error` op and
  keeps it (`outbox.ts:309-311`) but drops an unknown status (`outbox.ts:320`).
- No migration: `apply_sync_op` already refuses a `p_user_id` that is not `auth.uid()`
  (`20260911000600_rpc.sql:8-19`).

### 0.5a Direct requests carry the account too

Some writes do not use the outbox. Example: a log commit writes the local record, then POSTs
`/api/log/commit` (`lib/log-commit-client.ts:245-276`); the body has no account id
(`lib/log/contract.ts:41-46`) and the route writes under whatever JWT arrives
(`app/api/log/commit/route.ts:37-42`). If the session changes from A to B between the local write
and the POST, A's meal is sent as B.
- One client wrapper, `accountFetch(handle, url, init)` in `lib/device/account.ts`, is the only way
  client code calls an app `/api/` route. It calls `assertCurrent(handle)` before it sends and adds
  the header `x-smc-account: <handle.userId>`. Every client module that calls an app route moves to
  it (today: `lib/barcode/client.ts`, `lib/capture-client.ts`, `lib/coach-client.ts`,
  `lib/coach-transcribe-client.ts`, `lib/constraints-client.ts`, `lib/estimator-client.ts`,
  `lib/health-client.ts`, `lib/health/weigh-in-client.ts`, `lib/log-commit-client.ts`,
  `lib/profile/prefs-client.ts`, `lib/sync/client.ts`, `lib/targets/client.ts`,
  `lib/today/water-and-weight.ts`, `lib/timing.ts`; the plan re-runs the `grep` for `fetch(` and
  `fetchWithDeadline(` on `/api/`). A direct call that started under one handle and runs after a
  switch throws `AccountChanged` and sends nothing; the caller keeps its local copy for its own
  account.
- `requireUser` (`lib/server/auth.ts:22`) compares the header with the JWT subject. A mismatch
  answers `409 account_mismatch` and the route writes nothing. This one check covers every route
  that calls `requireUser`.
- **DECIDED (PR #248 review r3):** the header is **required in slice 1**. A request with no header
  is an old tab that may show A while the cookie is B's, so `requireUser` answers
  `401 account_header_required` ("This app was updated. Reload to continue.") and the route reads
  and writes nothing. 401 on purpose: the old build reads it as a lapsed session and keeps its
  writes queued; the service worker v3 reload then moves the tab to the new build.
  Cookie-authenticated routes only (cron, bearer-token, MCP and the Oura callback redirect do not
  use `requireUser`). `tests/device/account-fetch.test.ts` fails on any client `/api/` call that
  does not use `accountFetch`, so the new build always sends it.

### 0.6 Legacy adoption (first boot of the new build)

The legacy `smc` database can hold rows and ops of more than one account, and an op carries no
proof of its account. So adoption is per row and never guesses:
- **Mirror rows** (caches of server rows): a row whose `user_id` is the current account is copied
  into `smc-u-<current>`. Any other row is not copied. Rows are not deleted from `smc`.
- **Cursor**: not copied; the new database starts at cursor 0 and pulls again.
- Mirror rows without a `user_id` (rows written only on the phone, for example a queued water
  change, `lib/water-client.ts:41-51`) are not copied.
- **Outbox ops are held, opaque, and never sent.** A legacy op carries no proof of its account, and
  its mirror row may not either (`lib/water-client.ts:48-51`). So the new build never stamps, sends,
  shows or exports a legacy op for any account. The ops stay in `smc` untouched. The sync status
  shows one line with a count only: "N changes from before the update are held on this phone."
  No action is offered in slice 1; recovery is a later, owner-proved tool (see "Later").
- **`smc` is never deleted (or created) in slice 1** (PR #248 review r5): an old tab can still write
  into it after any count. Its existence is read from `indexedDB.databases()`; a browser without
  that API, or a check that fails, skips adoption and records nothing as done. Deleting `smc` is a
  later, separately reviewed step (see "Later").
- Owner-stamped pending records merge into the account's queues under the same lock their own
  writers hold, in one IndexedDB transaction (review r6).
- Legacy unprefixed `localStorage` keys: re-fetchable caches are deleted; drafts, pending scans,
  the store blob, coach transcripts and coach-action marks carry no owner, so they move under
  `smc:legacy:` and are held (not shown, not sent, never given to an account — review r1/r2).
- To keep this set empty for Sasha, Devin asks her to open the app online once before slice 1
  deploys, so her outbox drains under the old build (Open for Devin).

### 0.7 Sign-out and account change: the reload boundary

(Revised 2026-09-23: PR #248's in-place switch did not converge in seven review rounds; this is the
GPT-6 Sol re-plan, implemented in the follow-up PR.)

A page binds at most one account, once, at cold start (`lib/device/boot.ts`): session → bind →
claim the account's writer lock → legacy adoption → ready. Nothing of an account renders, syncs or
writes before ready. A page never switches accounts in place. On sign-out, or when the session
changes under the page (another tab signed in or out, or a request answers `409 account_mismatch`),
`lib/device/departure.ts`:

1. **Freezes** synchronously, before any await: it takes the account's in-memory-only store edit
   (a save localStorage refused), then unbinds. Every handle of the account is stale from then on,
   so no write of it can start; the gone listeners stop sync and close the gate in the same tick.
2. Makes the account's state **durable under its own keys**: the store edit is written (retried
   once), and one readwrite barrier transaction over the account's database commits after every
   transaction the page started on it.
3. Only then **signs out** (app-initiated sign-out only) and replaces the page
   (`location.replace`). The next page binds whatever account the session holds.

If step 2 or the sign-out fails, nothing else changes: no auth change, no reload. The gate shows
"Changes on this phone could not be saved yet." with Retry and shows neither account's data.
There is no second copy of the store in IndexedDB and no `held:*` format.

Nothing of an account is deleted by sign-out or an account change (plan decision P9): its database,
store, drafts, scans, caches, coach transcripts and marks, saved food refs, and the service
worker's shell cache all stay. They are keyed by account, and a new page binds only one. No account
DB is deleted and there is no cap. An explicit "Sign out" (Settings → Data & account, or the gate's
blocked screen) with unsent work first shows "N changes are not synced yet. They stay on this phone
and send when you sign in again."; a second tap signs out. A departing page also tells the
account's other tabs (BroadcastChannel, with a `storage` event fallback) to leave too.

**Same-account tabs.** The store is one localStorage blob per account and every save writes all of
it, so two tabs of one account would overwrite each other. Only the tab holding the Web Lock
`smc:writer:<userId>` becomes ready; another tab of that account shows "Meal Companion is open in
another tab." with "Use here", which asks the writer to save and reload, then takes the lock. A
browser without Web Locks (older than iOS 15.4) uses a localStorage lease instead, checked on every
store save; a page that loses it, or returns from the back-forward cache, writes nothing and leaves.

**Closing before freezing.** Step 1 above is preceded by a close: the gate and sync stop and no new
work may start, but work already running finishes (bounded to 3 s of quiet); the durability barrier
is bounded to 5 s and blocks with Retry. A server `409 account_mismatch` starts the departure at
once. The reload goes to the same page when the service worker has its document cached, else "/".

**Service worker (v3).** Install needs a non-redirected "/" and every build chunk it loads. The
worker never drives open tabs: no skip-waiting, no claim, no navigation, reload or message to a
window (reload review r5; decision 2026-09-23). A new worker activates once the old build's tabs
are closed. Accepted residual: an old-build tab keeps running the old build until its next natural
load or launch, as production behaves today; the server refuses its ownerless ops (0.5).

**Known residuals (reload review r4, declined with reasons in the PR):** a lease-mode tab that has
lost its lease while holding a storage-refused edit drops that edit rather than overwrite the new
writer; a local write pipeline still stalled after the 3 s quiet budget can leave a queued plan
edit that Today shows only after the next online sync.

### 0.8 Tests (slice 1)

- `tests/sync/account-isolation.test.ts` (vitest, `fake-indexeddb`): A queues a `plan_days` op and
  a coach transcript offline; B signs in; B's pushes carry zero A ops; B's mirrors, storage
  namespace and store cache hold nothing of A's; A signs in again and A's op sends with `user_id`
  A.
- Delayed writer: a log commit starts as A; the account switches to B before the server answers;
  the settle writes nothing into either database.
- Sync gating: no pass starts before `onAccountReady`; a pass in progress during a switch saves no
  cursor; the new account's pass starts after the switch.
- Direct request: a log commit writes locally as A; the session switches to B before the POST;
  nothing is sent (`AccountChanged`). A POST with `x-smc-account: A` and B's JWT answers
  `409 account_mismatch` and writes nothing (route test on `/api/log/commit` and one other
  mutating route).
- Legacy adoption: mixed-owner mirrors (only rows whose `user_id` is the current account are
  copied); an A water op with no owner-stamped mirror is held, not shown, not sent, under both A
  and B; `smc` is never deleted, and a late op from an old tab is kept; the held count shows.
- Purge and the 3-DB cap. `tests/sync/cross-user-http.test.ts` (extend): `account_mismatch` and
  `account_unbound` write nothing. `tests/device/storage-keys.test.ts`: every storage key literal is
  built with `accountKey` or is in the device-level allow-list. `tests/device/module-state.test.ts`
  (0.3). `tests/device/account-fetch.test.ts` (0.5a).

## 1. Invite codes and the account claim

### 1.1 What the gate guarantees

- Every **public** creation path is refused by the database hook unless a live reservation exists
  for that email **and** that sign-up's nonce. There is no email-only mode.
- The **admin** path bypasses the hook. It needs the service-role key, which already has full
  database power. It is a named trusted path with three controls: repo scripts and tests create
  users only through the gated helper (1.6); an account without a claim gets no templates and sees
  "Finish setting up with an invite code"; the read-only production check lists every `auth.users`
  row without an `account_claims` row.
- **DECIDED (run):** no trigger on `auth.users`. Reason: `auth` is Supabase-owned, and a trigger
  cannot stop a service-role insert that can disable it.

### 1.2 Tables (`account_claims` in `20261104090000_day_templates.sql`, slice 4; the invite tables in `20261105090100_invites.sql`, slice 5)

- `invite_codes` — `id uuid pk`, `code_hash text unique not null`, `label text`, `max_uses int not
  null default 1 check (max_uses > 0)`, `used_count int not null default 0 check (used_count <=
  max_uses)`, `expires_at timestamptz not null`, `revoked_at timestamptz`, `created_at`. RLS on, no
  policies.
- `invite_claims` — `id uuid pk`, `invite_id uuid not null references invite_codes`,
  `email_normalized text not null`, `nonce_hash text not null unique`, `state text not null check
  (state in ('reserved','hooked','consumed','cancelled'))`, `expires_at timestamptz not null`,
  `user_id uuid references auth.users on delete set null`, `hook_user_id uuid`, `hooked_at`,
  `created_at`, `consumed_at` (deleting a user keeps the claim and its hook evidence and clears
  `user_id`; (Updated 2026-09-23 by the overnight run to match plan round 13.)). One active row per email (unique partial index where
  `state in ('reserved','hooked')`). RLS on, no policies.
- `account_claims` (created in slice 4 with the templates, because the seed guards read it; slice 5
  adds the foreign key from `invite_id` to `invite_codes`) — `user_id uuid pk references auth.users
  on delete cascade`, `invite_id uuid`
  (null before the gate), `seed_policy text not null check (seed_policy in ('default','manual'))`,
  `claimed_at`. RLS: owner select only; no write policy.
- The migration inserts `account_claims (user_id, null, 'manual')` for every existing `auth.users`
  row. `manual` = templates come from a human-run seed or backfill, never from `claim_account`.

### 1.3 Shared rate limit (migration `20261105090000_shared_rate_limit.sql`, slice 5)

- `rate_limit_counters (key text, window_start timestamptz, count int not null, primary key (key,
  window_start))`, RLS on, no policies; `rate_limit_hit(p_key, p_limit, p_window_seconds) returns
  boolean`, `security definer`, service role only: one upsert that increments and returns the
  count, then a bounded cleanup (at most 100 rows older than one day).
- `enforceSharedRateLimit()` in `lib/server/ratelimit.ts` calls it. Phase 9 uses it on the one
  invite route (1.4); other routes keep the in-memory limiter (follow-up in "Later").
- Limits: per IP `invite:ip:<sha256(ip)>` 10/hour, per email `invite:email:<sha256(email)>`
  5/hour, global `invite:all` 100/hour. No raw IP or email is stored.

### 1.4 Flow

1. "New here?" on the sign-in page asks for email and invite code. It renders only when
   `NEXT_PUBLIC_INVITE_SIGNUP=1`.
2. `POST /api/auth/invite/claim` is the **only** entry that accepts a plain code. It applies the
   three shared limits, normalizes code and email, generates the nonce (32 random bytes, base64url)
   and calls `claim_invite(p_code_hash, p_email, p_nonce_hash)` (`security definer`, service role
   only). In one transaction the function:
   - locks the code row `for update`, and takes a per-email lock;
   - if the email has a `hooked` claim, refuses with the generic answer and changes nothing;
   - checks the new code first: not revoked, not expired, and `used_count + (active reservations
     of other emails) < max_uses`; on failure it refuses and changes nothing, so a wrong code never
     cancels a working reservation;
   - only then cancels every `reserved` claim of the same email, on any code, and inserts a
     `reserved` claim that expires in 30 minutes. (Updated 2026-09-23 by the overnight run to match plan round 9.)
   Every failure gets the same generic answer. The nonce goes back to the browser only on success
   and is kept in `sessionStorage` (device-level; no account exists yet).
3. The client calls `signInWithOtp` with `shouldCreateUser: true` and
   `options.data = { invite_nonce: <nonce> }`.
4. The hook `public.hook_before_user_created(event jsonb)` (`security definer`; execute for
   `supabase_auth_admin` only) requires a claim with `nonce_hash =
   sha256(event.user.user_metadata.invite_nonce)`, the same normalized email, state `reserved`,
   not expired, and a UUID in `event.user.id`. It sets `hooked`, `hook_user_id = event.user.id`,
   `hooked_at = now()` and `expires_at = now() + 24 hours` (`hook_user_id` and `hooked_at` are never
   cleared), and does not touch `used_count`. Anything else returns `{ "error": { "http_code": 403, "message":
   "invite_required" } }`.
5. After the code is verified, the client calls `claim_account(p_nonce text default null)`
   (`security definer`, execute for `authenticated`). It never accepts a code. Identity is
   `auth.uid()`. In one transaction: an existing `account_claims` row makes it idempotent (and, for
   `seed_policy = 'default'` with no templates, it creates the default template); else it locks the
   unexpired `hooked` claim whose `hook_user_id = auth.uid()` (and whose `nonce_hash` matches when a
   nonce is given) — never a `reserved` claim — and its code row,
   requires `used_count < max_uses`, sets `used_count += 1`, claim `consumed` with `user_id`,
   inserts `account_claims (…, 'default')`, and creates the default template (2.6). Any failure
   rolls back all of it.
6. A signed-in account without a claim (the link opened on another device, so the nonce is not
   there) calls `claim_account()` with no nonce: the hook's binding to its user id is the proof; no
   code is asked. If that fails, it shows "This account is not set up yet. Please contact the
   person who invited you, so they can finish it." with Retry (Updated 2026-09-23 by the overnight run to match plan round 13.)
   (Updated 2026-09-23 by the overnight run to match plan round 9.)
7. `used_count` moves only in step 5. A `hooked` claim that is never finalized expires in 24 hours.
8. The Sign in path switches to `shouldCreateUser: false` (`app/sign-in/page.tsx:76`).
   `app/api/dev/sign-in` stays refused outside development; add `tests/sign-in/dev-route.test.ts`.

Tests: repeated claim for the same email with `max_uses = 1` succeeds and cancels the first;
wrong-email nonce refused; expired reservation refused; two concurrent `claim_account` calls on a
one-use code consume one use; `claim_account` without a matching nonce refused.

### 1.5 Activation gate

- `supabase/config.toml` gets `[auth.hook.before_user_created]` (`enabled = true`, `uri =
  "pg-functions://postgres/public/hook_before_user_created"`) for local runs, CI and `p9-tenancy`.
- `scripts/invite-probe.ts --target <url>`: (1) password `signUp` without a nonce → refused;
  (2) OTP sign-up without a claim → refused; (3) claim, sign-up with the nonce → created, then
  `claim_account` → `used_count` +1; (4) a nonce of another email's claim → refused; (5) the
  created user's hook event carried `user_metadata.invite_nonce` (read back from the claim's
  `hooked` state). It deletes the users it made. It refuses a production URL unless run with
  `--i-am-devin-on-production`.
- If probe 5 fails (the hook payload does not carry the metadata), the gate fails: the invite UI
  stays off and the item goes to "Open for Devin" as an open BLOCK. No email-only fallback exists.
- The run probes `p9-tenancy` only. Production activation, the production probe and the flag are
  Devin's steps, in the rollout order (the flag is the last step of all).

### 1.5a Hosted public sign-up is off until the probe passes (required gate)

Changing the app's `shouldCreateUser` does not close the Auth API `/signup` endpoint. So Devin turns
off "Allow new users to sign up" in the production dashboard **before slice 2 deploys**, and checks
it: probes 1 and 2 against production answer "signups not allowed". Sign-up stays off until the
activation step (rollout step 6): Devin activates the hook, turns sign-up on, runs probes 1–5 at
once, and turns sign-up off again if any probe fails.

### 1.5b Minimum-client gate for invited accounts

The flag hides the invite UI, but it does not stop an old build in an open tab, or an old offline
shell (`public/sw.js:61-70`), from rendering her slot labels for any account (`lib/resolve.ts:175`).
So the server enforces a minimum client:
- The new build sends `x-smc-client: <build number>` on every `accountFetch` call (0.5a).
  `MIN_CLIENT_BUILD` is a server env value.
- `requireUser` looks up `account_claims.seed_policy` for the JWT subject (one indexed read; cached
  per request). For a `default` (invited) account, a request without `x-smc-client` or below
  `MIN_CLIENT_BUILD` answers `426 client_upgrade_required` and writes nothing. `manual` accounts
  (Sasha, the test account) are not affected, so their old tabs keep working.
- `GET /api/plan/templates` (2.8) applies the same rule, and the new resolver renders nothing
  without templates (2.6). An invited account therefore gets no templates, no sync and no writes in
  an old build.
- The new build answers a `426` by `location.reload()`; the service worker `CACHE_VERSION` is
  bumped in the same slice, and on `activate` it calls `navigate(client.url)` on every window it
  controls, so an open old tab reloads when the new worker takes over.
- Residual risk, stated: an old tab that never reaches the network can still draw her generic slot
  labels (not her data) from its own code for an invited account until it reloads. The cut: an old
  tab cannot create an invited account (its sign-in has no nonce, 1.4 step 4), and nothing it does
  reaches the server.
- Tests: a request as an invited account without the header → `426`, no write; with a low build →
  `426`; as a `manual` account without the header → allowed; an old-tab simulation that signs in as
  an invited account after activation gets `426` on its first sync and no templates.

### 1.6 One gate for scripts and tests

`createInvitedUser()` in `scripts/lib/gated-user.ts` and `tests/helpers/supabase.ts`: create a
one-use code with the service role, call `claim_invite`, password `signUp` with the nonce through
the anon client, sign in, call `claim_account`. Every admin caller in Facts moves to it.
`createTrustedAdminUser()` stays only for `tests/rls/admin-bypass.test.ts` (the bypassed user has no
claim, no templates, and `claim_account` refuses it). `tests/tenancy/no-admin-create.test.ts` fails
on `auth.admin.createUser(` or `generateLink(` outside those helpers and the dev route.
`scripts/readiness/new-user-walk.mjs` uses the helper and refuses a production URL.

### 1.7 Operations

`scripts/invite.ts create [--uses N] [--days N] [--label L]` prints the plain code once; `list`;
`revoke <id>`. 10 characters from an unambiguous alphabet, grouped (`K7QM-PX4R-9T`). On production
only Devin runs it.

## 2. Per-user day templates (approach A), server-written in Phase 9

### 2.1 Tables (migration `20261104090000_day_templates.sql`, which also creates `account_claims` from 1.2)

RLS on all four tables. `authenticated` gets **select only**: `day_templates` by `user_id =
auth.uid()`, children through the parent row (the `log_items` pattern). No insert, update or delete
policy. Only three `security definer` functions write (2.6, 2.7).

- `day_templates` — `id uuid pk`, `user_id uuid not null references auth.users on delete cascade`,
  `key text not null check (key ~ '^[a-z0-9-]{1,32}$')`, `label text not null`, `serves text[] not
  null` (subset of `{training,rest}`, not empty), `weekdays smallint[] not null default '{}'`
  (subset of 0–6), `sizing text not null check (sizing in ('reference','share'))`, `position int not
  null`, `created_at`, `unique (user_id, key)`.
- `template_slots` — `id uuid pk`, `template_id uuid not null references day_templates on delete
  cascade`, `slot_key text not null check (slot_key ~ '^[a-z0-9-]{1,32}$' and slot_key <>
  'snack')`, `label text not null`, `kind text not null check (kind in ('composed','options'))`,
  `time time not null`, `position int not null`, `rotation_phase smallint not null default 0`,
  `ref_protein_g`, `ref_carbs_g`, `ref_fat_g` (numeric, nullable, `>= 0`), `share_protein`,
  `share_carbs`, `share_fat` (numeric, nullable, 0–1), `counts_for_adherence`,
  `required_for_completion`, `compact` (bool not null), `unique (template_id, slot_key)`.
- `slot_meals` — `id uuid pk`, `template_slot_id uuid not null references template_slots on delete
  cascade`, `purpose text not null check (purpose in ('option','floor'))`, `meal_id text not null`,
  `name text not null`, `prep_minutes int not null default 0`, `tags text[] not null default '{}'`,
  `position int not null`, `unique (template_slot_id, purpose, meal_id)`.
- `slot_meal_components` — `slot_meal_id uuid not null references slot_meals on delete cascade`,
  `seq int not null`, `name`, `qty`, `unit`, `role` (`protein|carb|fat|free`), `protein_g`,
  `carbs_g`, `fat_g` (numeric not null), `food_ref_id uuid references food_refs`, `primary key
  (slot_meal_id, seq)`. Kcal is `macroKcal(protein, carbs, fat)`, as for every authored component
  (`lib/meals.ts:36-38`).
- `plan_days.category_override text check (category_override in ('training','rest'))`
  (`20261104090100_plan_days_category_override.sql`), with a `plan_days` patch of `_sync_current`
  and `_sync_upsert` by anchored replacement after `20261029090000` (PR #241 first).

Checks run inside the writer functions before commit (they are the only writers): sizing columns
match `sizing`; shares sum to 1 ± 0.001 per macro; `options` slots have at least one option and
`composed` slots none; per owner and category exactly one default (`weekdays = '{}'`) and no
weekday twice; every `food_ref_id` is a `catalog` ref or a `user` ref of the owner
(`20260911000200_user_schema.sql:13-19`).

**DECIDED (run):** templates are immutable after they are written in Phase 9 (no edit, no archive,
no delete except the `auth.users` cascade). Reason: every edit path (offline ops, tombstones,
archived content, days bound to an old version) was a source of round 2 BLOCKs (6, 7, 8), and no
Phase 9 screen edits templates. Part 2 designs editing (see "Later").

### 2.2 Which template and which category a date gets

`resolveDayPlan(date, stored, templates, trainingWeekdays)` in `lib/plan/templates.ts` replaces
`dayTypeFor` and `categoryFor`:
1. `category` = `stored.categoryOverride`; else the single category of the template named by
   `stored.dayTypeOverride` when it serves one only; else `training` when the weekday is in
   `trainingWeekdays` (source unchanged: `activeTargetProfile.inputs.trainingWeekdays ??
   settings.trainingWeekdays`, `resolve.ts:80-83`), else `rest`.
2. `template` = the template named by `stored.dayTypeOverride`; else the template that serves
   `category` and lists the weekday; else the default for `category`.
   When `stored.dayTypeOverride` names none of the account's templates, it selects
   no template. If it is `rest`, `training-10` or `training-7-fasted`, it still gives its category
   (rest or training); any other unknown value is ignored. The stored row is not changed.
   (Updated 2026-09-23 by the overnight run to match plan round 7 (finding 5).)

The weekday rule lives inside a category branch, so Wednesday is fasted only on a training day
(round 1 finding 12), and toggling a non-training Wednesday to training still gives the fasted
template, as `lib/plan-day.ts:37-40` does today. `ResolvedDay` carries `templateKey` and
`category`; targets, water goal, export and labels read `category` only. The day toggle writes
`category_override` and clears `day_type_override`. Her existing overrides stay valid.

Because templates are immutable in Phase 9, the day a stored edit was made for resolves to the same
template later, unless the account's training weekdays change — which is today's behavior too.

### 2.3 Slot sizing for all four macros

`slotReference(slot, dayTarget)`: `reference` → the three `ref_*`; `share` → share × day target per
macro, and none without a day target. kcal = `macroKcal(reference)` in both modes (every
`SLOT_TARGETS` kcal equals 4P + 4C + 9F). The existing math then runs unchanged
(`resolve.ts:62-107`, `foods.ts:144-168`); in `share` mode the ratios are exactly 1.

Sasha's `reference` rows equal `SLOT_TARGETS` (probe of `lib/meals.ts`, 2026-09-22):

| template | slot | kind | P / C / F (g) | kcal | time | phase |
|---|---|---|---|---|---|---|
| training-10 | coffee | options (1) | 3 / 17 / 5 | 125 | 08:00 | 0 |
| training-10 | pouches-pre | options (5) | 1 / 36 / 0 | 148 | 08:30 | 1 |
| training-10 | meal-1 | composed | 45 / 75 / 27 | 723 | 11:30 | 0 |
| training-10 | meal-2 | composed | 45 / 38 / 32 | 620 | 15:00 | 2 |
| training-10 | meal-3 | composed | 41 / 34 / 31 | 579 | 19:00 | 4 |
| training-7-fasted | coffee | options (1) | 0 / 0 / 0 | 0 | 06:15 | 0 |
| training-7-fasted | post-refuel | options (5) | 30 / 65 / 12 | 488 | 08:15 | 1 |
| training-7-fasted | meal-1 | composed | 40 / 55 / 28 | 632 | 11:00 | 0 |
| training-7-fasted | meal-2 | composed | 35 / 45 / 28 | 572 | 15:00 | 2 |
| training-7-fasted | meal-3 | composed | 30 / 35 / 27 | 503 | 19:00 | 4 |
| rest | coffee | options (1) | 3 / 17 / 5 | 125 | 08:00 | 0 |
| rest | meal-1 | composed | 44 / 12 / 27 | 467 | 11:00 | 0 |
| rest | meal-2 | composed | 43 / 22 / 27 | 503 | 15:00 | 2 |
| rest | meal-3 | composed | 42 / 37 / 20 | 496 | 19:00 | 4 |
| rest | hot-chocolate | options (1) | 3 / 22 / 6 | 154 | 20:00 | 0 |

Slot `position` = the `SLOT_ORDER` index, so de-duplication order is kept. The seed generates these
rows from the code at the base commit (2.7); nobody copies the table by hand.

### 2.4 Meal slots, rituals and Floor Day

- `kind = 'composed'` replaces `isMealSlot` everywhere (`lib/meals.ts:938-942` and its callers in
  Facts). For Sasha, composed = meal-1/2/3; for the default template, all four slots.
- Ritual slots (`options`) rotate their `purpose = 'option'` rows by `position` with the slot's
  `rotation_phase` (`rotation.ts:57-78`). Options are slot-scoped because meal ids repeat.
- Floor Day: `purpose = 'floor'` rows on composed slots; the seed copies her three floor meals onto
  meal-1/2/3 of each of her three templates (9 rows). A template without floor rows hides the Floor
  Day control.
- **Floor Day is unchanged in Phase 9.** Floor meals exist only in Sasha's migrated templates
  (`purpose = 'floor'` rows copied from `lib/meals.ts:882-913`, components with `food_ref_id` null)
  and the resolver uses them exactly as `main` does today (`resolve.ts:155-159,173-184`). New
  accounts get no floor meals. Today's Avoid check never fires (it looks up slugs in a store keyed
  by UUIDs; see Facts): this is a known pre-existing issue, not fixed in Phase 9. A server-decided
  Floor Day safety verdict is a separate later feature. (Updated 2026-09-23 by the overnight run to match plan round 10: Floor Day unchanged in Phase 9.)

### 2.5 plan_days validation (migration M2, `20261106090000_template_key_validation.sql`)

A trigger replaces the check on `day_type_override` (`user_schema.sql:80`) and the fixed list in
`plan_day_eaten_slots_valid` (`20261026090000_plan_days_eaten_slots.sql:10-13`, which becomes
shape-only). The trigger judges only what a write adds or changes:
`day_type_override` when it changes, and the keys of `eaten_slots`, `swaps`, `slot_notes`,
`item_overrides` whose value is new or different. Each must be a key of the owner's templates;
for a `manual` account the legacy day types and the seven legacy slot keys are also allowed.
Stored keys are never re-judged. (Updated 2026-09-23 by the overnight run to match plan round 7
(finding 5).) A late offline op that fails the trigger gets `error` and parks (never dropped). With
immutable, server-written templates, only a bad client or an older build writing her keys for
another account can fail it. M2 is needed before any invited account exists, because the current
check refuses `breakfast` in `eaten_slots`.

### 2.6 The default template for a new account

- Written only in `claim_account` (1.4 step 5), in the claim's transaction, never on a read.
  **DECIDED (run):** there, not on the first `user_settings` insert. Reason: that row comes from a
  client sync op; the claim is the one server-controlled step every invited account passes.
- Template `everyday`, label "Every day", `serves {training, rest}`, `weekdays {}`, `sizing
  'share'`; slots, all `composed`, adherence and completion on, not compact:

  | slot_key | label | time | share P / C / F | phase |
  |---|---|---|---|---|
  | breakfast | Breakfast | 08:00 | 0.25 / 0.25 / 0.25 | 0 |
  | lunch | Lunch | 12:30 | 0.35 / 0.35 / 0.35 | 2 |
  | snack-1 | Snack | 15:30 | 0.10 / 0.10 / 0.10 | 1 |
  | dinner | Dinner | 19:00 | 0.30 / 0.30 / 0.30 | 4 |

  No options, no floor meals, no allergens, no conditions.
- A fresh account has no target revision, so it has **no numeric target**: targets resolve to
  `needs_profile` (`lib/targets.ts:16-21`, `app/api/targets/route.ts:109`). This is a
  **resolver/API assertion only**: a fresh account has no `user_settings` row, so `AuthGate` gives
  it `force` and sends it to onboarding before Today renders (`lib/profile/onboarding-state.ts:
  107-108`, `components/AuthGate.tsx:167`). The **Preview UI path** is: sign up with an invite,
  finish the existing onboarding (it writes `user_settings` and the account's own target revision),
  then Today shows Breakfast, Lunch, Snack and Dinner with training or rest targets by weekday.
- No fallback: runtime code never reads her constants. With no templates, Today, Week and the coach
  show "Setting up your plan" (Retry calls `claim_account`, which does nothing for a `manual`
  account), and `serverStoreFor` throws `TemplatesMissing`, which the coach and MCP report as "no
  plan yet".

### 2.7 Sasha's migration

- A generator at the base commit writes `scripts/fixtures/sasha-plan.json` from `lib/meals.ts`,
  `lib/plan.ts` and `lib/rotation.ts` (templates, slots, references, times, phases, positions,
  flags, options, floor meals; no floor ref mapping, round 10). Flags: coffee compact, required,
  not adherence; `pouches-pre`/`post-refuel` required, not adherence; hot-chocolate compact, not
  required, not adherence; meal-1/2/3 required and adherence. The file is test-and-seed only.
- `seed_templates_from_fixture(p_user_id, p_fixture)` — `security definer`, service role only, in
  M1 but never called by a migration. It refuses when the user has templates or the claim policy is
  not `manual`. It writes her three templates (`training-10 {training}`, `training-7-fasted
  {training}` with `weekdays {3}`, `rest {rest}`), slots, options, floor meals and refs.
- `backfill_default_templates(p_user_ids uuid[])` — same guards; the default template for the
  listed accounts only. It never runs over "all users".
- Her keys do not change, so her `plan_days` rows stay valid without a rewrite.

Proof on the `p9-tenancy` preview branch:
1. Devin dumps production (`scripts/backup.sh`) and restores into `p9-tenancy`
   (`scripts/restore-to-branch.sh <dump> --confirm <branch-ref>`). `scripts/p9/row-counts.sql`
   counts rows per owner per user table in source and branch; they must be equal.
2. Before snapshot, from a worktree at the base commit: `scripts/p9/resolve-snapshot.ts --user
   <id>` over every date from her `first_opened_at` to today + 60 and every date with a `plan_days`
   row, each with Floor Day off and on, and each stored swap; canonical `ResolvedDay` JSON.
3. In the plan's order (M2 before the resolver) (Updated 2026-09-23 by the overnight run to match plan round 13.):
   a. apply M1, run the seed with her id and the backfill with the test account id; snapshot with
      the **base** code → equal to the before snapshot (M1 changes no resolved day);
   b. apply M2; snapshot with the base code → equal;
   c. only then use the new resolver code (slice 6) and apply its `20261107090000`; snapshot with the
      new code → equal to the before snapshot, with no exceptions (Floor Day unchanged, round 10).
   Each snapshot resolves the complete day (plan slice 7): the `plan_days` row, logged entries
   (extras), water cups, gut state and weight, and compares every field of `main`'s `ResolvedDay`.
   Snapshots contain account data and are never committed: they are written to
   `~/Backups/supabase/p9-proof/` (mode 600, keep-last-3); only hashes and diff counts go into the
   repository and the PR.
4. Every `slot_meals` row rendered back to a `Meal` deep-equals the authored entry.
5. Row counts after: her existing tables unchanged; new rows exactly 3 templates, 15 slots, 14
   options, 9 floor meals and the fixture's component count.
6. Rollback drills, each on its own restore and each followed by a restore (the ledger stays
   consistent): M1 full (M1's down files; snapshot with the base code equals before); M1 refused
   after a `category_override` write; M2 (its down file; equal) and M2 refused after a new key.
   Code rollback is a revert of the merge commit.

### 2.8 How the client gets templates (no outbox, no change feed)

- `GET /api/plan/templates` (user JWT, RLS select) returns `{ templates, version }`, where
  `version` is a hash of the rows; no floor verdicts (Updated 2026-09-23 by the overnight run to match plan round 10: Floor Day unchanged in Phase 9.) The client stores the templates in the account
  database's existing `meta` store under key `templates` (no new store, so no IDB version change).
  (Updated 2026-09-23 by the overnight run to match plan round 9.)
- The client fetches it on every `onAccountReady` and at the start of every sync pass, before the
  resolver runs; with no network it resolves from the stored copy. With no stored copy it shows the
  pending state.
- **DECIDED (run):** no `day_templates` entity in the change feed and no outbox writes. Reason:
  an older build skips an unknown entity but still advances its cursor (`lib/sync/client.ts:129,
  165-167`), and `_sync_tombstone`/`apply_sync_op` have no template path (`phase3_sync_entities.sql:
  95-131,460-470`); a direct fetch avoids both. Templates change only by a server function in
  Phase 9, so a fetch per pass is enough.
- Server code (`lib/server/day-context.ts:176`, coach, MCP, export) reads templates directly.

### 2.9 Every consumer of the fixed day types and slots

Each reads the account's templates or the resolved day instead:

| Area | Files (line) | Change |
|---|---|---|
| Types | `lib/types.ts:12-22` | branded strings validated against templates |
| Resolution | `lib/plan.ts:27-130`, `lib/resolve.ts:7,62-219`, `lib/rotation.ts:14-229`, `lib/meals.ts` | resolve from templates (2.2–2.4); `lib/meals.ts` leaves runtime |
| Meal-slot test | `lib/meals.ts:938-942` and callers `app/page.tsx:543,579,592,615` | `kind = 'composed'` |
| Coach sizing | `lib/server/coach-ports.ts:99-152` | pending meal count from composed slots of the day's template |
| Coach schedule | `lib/coach/apply-schedule.ts:18-40` | slot times from the resolved day's slots, not `dayTypeFor`/`resolveSlotTimes` |
| Targets, water | `lib/targets.ts:5-24`, `lib/water.ts:11,57-64`, `lib/water-client.ts:78`, `lib/today/water-and-weight.ts` | `ResolvedDay.category` |
| Export | `lib/server/export.ts:216-229`, `lib/server/export-water.ts:55` | resolved category |
| Calendar | `lib/ics.ts:30-117,289`, `components/IcsSubscribe.tsx`, `components/settings/ScheduleSection.tsx:5,13-20` | events per weekday from templates and training weekdays |
| Day toggle and chip | `lib/plan-day.ts:25-60,140-155`, `lib/plan-day-client.ts`, `components/DayTypeChip.tsx:19-23,47`, `components/DayTypeSheet.tsx`, `components/DayTypeToggle.tsx` | style by category; notes from labels; toggle writes `category_override` |
| Today, Week | `app/page.tsx:12-13,97,543-615`, `components/TodayDayStrip.tsx:34`, `components/week/WeekGrid.tsx:9`, `lib/summary.ts:21-25` | slot flags |
| Settings times | `components/ShiftTimes.tsx:47-56,133`, `components/settings/use-settings-controller.ts` | union of slot keys with labels |
| Sheets, labels | `components/SwapSheet.tsx:5`, `components/BuildMealSheet.tsx:7`, `components/LoggedExtras.tsx:77-79`, `components/CoachComposedCard.tsx:18-25`, `components/CoachActionCard.tsx:10-11`, `lib/coach/apply-shared.ts:157-159`, `lib/coach/suggest-rank.ts:4,34` | template labels |
| Capture, log | `lib/capture/types.ts:18-23`, `lib/capture/presentation.ts`, `lib/capture-client.ts`, `lib/log/contract.ts:19-20`, `lib/log/reconcile.ts:89-92`, `lib/log-client.ts`, `components/CaptureSheet.tsx`, `components/CaptureConfirm.tsx`, `components/LogFoodSheet.tsx`, `components/ScanConfirmSheet.tsx`, `components/coach/editors/CaptureDraftEditor.tsx:32-35`, `components/coach/editors/BarcodeDraftEditor.tsx:28-33`, `components/coach/blocks/log_draft.tsx:27` | slot choices from the day's template plus `snack` |
| Coach | `lib/coach/types.ts:17`, `lib/coach/attachments.ts:8`, `lib/coach/actions.ts:36,54-109,148`, `lib/coach/apply-entries.ts:65-66`, `lib/coach/executors.ts`, `lib/coach/registry.ts:147`, `lib/coach/prompt.ts:159-160,241-242`, `lib/coach/intent.ts:110-115,243-248`, `lib/server/day-context.ts:176-200`, `components/coach/attachments/context.ts` | schemas per request from slot keys; prompt and intent get the slot list |
| Sync | `lib/sync/plan-days-schema.ts:4,28`, `lib/sync/plan-days.ts` | runtime validation; `category_override` |
| MCP | `lib/mcp/coach-tools.ts` (via `app/api/mcp/route.ts:20-24`) | resolved day from templates |
| Scripts | `scripts/readiness/new-user-walk.lib.mjs:210-230` | account templates |

Acceptance, `tests/plan/four-slot-account.test.ts`, for an account with only the default template:
Today, Week, completion, adherence, water goal (training and rest weekday), export row, calendar
events, capture slot choices, coach slot schema, coach meal sizing (a quarter-day suggestion is
sized against the pending composed slots, not the whole remainder), coach schedule shift (all four
slots move), and the MCP day report. With no revision it asserts `needs_profile` and no numbers;
then it creates the account's own revision and asserts training targets on a training weekday and
rest targets on a rest weekday. It asserts none of her slot keys, labels or meal names appear.

## 3. Tenancy checks

In the existing Quality and Integration jobs (`.github/workflows/ci.yml`).

1. **RLS lint**: every `public` table with `user_id`, and each allow-listed child with its parent,
   has RLS on and no `anon` policy.
2. **Behavioral matrix with declared operations.** A generator lists user tables from
   `pg_catalog`. `tests/tenancy/table-ops.json` declares, per table, the operations
   `authenticated` is meant to have on its own rows (for example `health_samples: [select]`,
   `coach_intent_events: []`, `account_claims: [select]`, `day_templates: [select]`,
   `plan_days: [select, insert, update]`). The generated list must equal the manifest's keys, so a
   new table fails until declared. For each table, as A with a real JWT: each declared operation
   succeeds on A's own row; each undeclared operation fails on A's own row; every operation on B's
   rows affects zero rows or fails.
3. **RPCs, views, Storage**: every `public` function `authenticated` may execute is in a manifest
   with a cross-user case; views keep `tests/rls/security-invoker.test.ts`; the `media` bucket
   policy (`20260920090100_phase4_media_bucket.sql:12-13`) is tested with A reading B's folder.
4. **Mutation test**: for each policy, one transaction replaces its `using`/`with check` with
   `true` and grants any undeclared operation, runs that table's probe as A (`set local role
   authenticated`, `request.jwt.claims`), requires the probe to report the leak, and rolls back.
5. **Admin-client entry points**: a generated list (importers of `@/lib/server/admin`, functions
   with an `admin: SupabaseClient` parameter, routes that reach them, including
   `app/api/mcp/route.ts` and `lib/server/catalog-writer.ts:21-27`) must equal
   `tests/tenancy/admin-entry-points.json`; each entry names its cross-user test; each test seeds B
   with canary strings and asserts no canary in A's response and no change to B's rows. Cron jobs:
   each write carries the user id of the row it read. The PR records one manual mutation per route
   family.
6. **Fresh-account test**: `createInvitedUser()`; zero rows except `account_claims` (1),
   `day_templates` (1), `template_slots` (4) and the account's own `invite_claims` row (1,
   `consumed`); targets `needs_profile`; coach context built; none of the fixture's strings appear.
   (Updated 2026-09-23 by the overnight run to match plan round 12.)
7. **Narrow authored-plan check** (`tests/tenancy/no-authored-plan.test.ts`): no meal id, option
   name or ritual slot key from the fixture in `app/`, `components/`, `lib/`. The existing
   `no-personal-defaults` test stays.
8. **Device isolation**: section 0.8.

One-time production checks (read-only SQL): the test account has no rows copied from Sasha's;
every user-table `user_id` exists in `auth.users`; every `auth.users` row has an `account_claims`
row (after the invite migration); every account created since PR #237 opened sign-up is listed for
Devin (Open for Devin 3).

## Rollout

The run makes no production change. Every production step is Devin's. The invite flag is last.

0. Sasha opens the app online once, so her old outbox drains before slice 1 (0.6). Devin turns off
   hosted public sign-up and checks it (1.5a). Both before step 1.
1. Slice 1 (device isolation) and slice 2 (Sign in `shouldCreateUser: false`): code only.
2. Working migration history: merge PRs #249 and #250 (already on production); apply PR #241's
   migrations with `scripts/apply-migrations.py`, then deploy #241; check the #249 guard.
   Templates M1 (slice 4): proof on `p9-tenancy` (2.7). On production after a fresh backup: M1,
   the seed with Sasha's id, the backfill with the test account id and with any account Devin keeps.
   Every migration is applied with `scripts/apply-migrations.py` (dry run first). (Updated 2026-09-23 by the overnight run to match plan round 12.)
3. Invite, rate-limit and claim migrations and code (slice 5), UI hidden behind the flag.
4. Proof tooling (slice 7), then M2 (slice 8, key validation), after every account has templates
   and before the resolver.
5. Resolver and consumer code (slice 6) deploys, with the minimum-client gate (1.5b) and
   `MIN_CLIENT_BUILD` set to this build. No code reads her constants, so it must not deploy before
   steps 2 and 4. (Updated 2026-09-23 by the overnight run to match plan round 9.)
6. Hook activation, then sign-up on, production probes 1–5 at once; sign-up off again on any
   failure (1.5a).
7. Only then `NEXT_PUBLIC_INVITE_SIGNUP=1`.

## Success criteria

- On a shared phone, no op, mirror row, cursor, store cache or cached value of account A is read,
  sent, shown or settled under account B; work started as A never writes after a switch; A's unsent
  work survives and sends as A; legacy ops without proof of owner are held and never sent or shown; a direct request
  that started as A is never sent as B; the
  server refuses an op whose `user_id` is not the JWT subject.
- Every public sign-up path without a live email-and-nonce reservation fails at the database; an
  abandoned sign-up spends no use; a repeated claim works; the plain code is accepted only by the
  rate-limited route; an admin-created user has no claim and no templates; all five probes pass on
  production before the flag.
- An existing account signs in with no change.
- The declared-operations matrix, RPC/view/Storage cases, admin entry-point tests and fresh-account
  test pass; the mutation test detects every weakened policy.
- Resolver/API: a fresh account resolves Breakfast, Lunch, Snack, Dinner with `needs_profile` and no
  numbers. Preview UI: after the existing onboarding, Today shows those four slots with training or
  rest targets by weekday, and nothing from her build.
- No client below the minimum build can use an invited account (1.5b), and hosted public sign-up is
  off from before slice 2 deploys until the production probe passes.
- Sasha's canonical resolved days across the whole proof range are identical before and after,
  exactly (no floor exceptions; round 10); both rollback drills restore the before snapshot.
- PR #241's migrations are merged first; this work's migrations are after `20261029090000`.

## Later (cut from Phase 9)

- Template editing (client, coach, onboarding), offline template edits through the outbox, a
  `day_templates` change-feed entity with an IDB version bump and hydrate-on-upgrade, archive and
  restore with a `_sync_tombstone` branch, and days bound to a template version so archived content
  is frozen.
- **Contract for Phase 10 (round 3 finding 7).** Phase 10 must not assume any of the items above.
  Its template writes use this Phase 9-compatible path until a later spec designs the rest:
  online only, one server RPC `replace_day_template(p_key, p_payload, p_base_version)` (`security
  definer`, `authenticated`, owner from `auth.uid()`), which checks `p_base_version` against the
  current `version` hash (2.8), refuses when it differs, runs the 2.1 checks, and writes in one
  transaction; no change-feed row and no outbox op. The client refreshes with
  `GET /api/plan/templates` right after the RPC and on every sync pass. A slot or key that a
  `plan_days` row uses cannot be removed (the RPC refuses). The Phase 10 spec
  (`docs/specs/phase-10-conversational-onboarding.md`, which today requires an `_sync_upsert`
  template branch and a template change row) must be reconciled to this contract; this run edits
  only the Phase 9 file.
- ~~Making `x-smc-account` required on every route (0.5a) after one release.~~ Done (verified
  2026-10-11, W055): `tests/tenancy/route-account-header.test.ts` runs every `app/api` handler with
  no header and with another account's header; each refuses before any query, or is a listed
  non-cookie route with its reason.
- ~~An owner-proved recovery tool for held legacy ops (0.6).~~ Done (W055):
  `lib/device/legacy-recovery.ts`, owner-run from the console (`smcHeldChanges.list()`, then
  `recover([op_id])`, a dry run until the owner types the confirmation); `smc` is never written.
- The shared rate limiter for routes other than the invite route.
- An invite admin screen.

## Open for Devin

Only Devin can do these. Batched:

1. Merge PR #241 and apply its migrations on production.
2. **Required before slice 2 deploys:** turn off "Allow new users to sign up" in the production
   dashboard and check it with probes 1 and 2 (1.5a). Today `shouldCreateUser: true`
   (`app/sign-in/page.tsx:76`) and the public `/signup` endpoint let anyone create an account.
3. **Before slice 1 deploys:** ask Sasha to open the app online once, so her old outbox drains; ops
   left in the old database after the upgrade are held and never sent (0.6).
4. Review the list of accounts created since PR #237 (the read-only check produces it): keep each
   (it gets `backfill_default_templates`) or delete it.
5. Dump production and restore it into `p9-tenancy` for the proof (it copies Sasha's health data).
6. (Superseded 2026-09-23, round 10: no floor mapping; Floor Day unchanged.) Confirm the floor-component ref mapping (2.4) and every floor meal the fail-closed rule makes
   unavailable for her.
7. Apply migrations on production in rollout order, with a backup first; run the seed and backfill;
   set `MIN_CLIENT_BUILD` (1.5b).
8. Activate the before-user-created hook, turn sign-up on, run probes 1–5 at once. If probe 5 fails,
   turn sign-up off again; the invite feature stays off: **Open BLOCK** (hook nonce) — smallest safe
   cut: no public sign-up; Devin creates accounts with `createTrustedAdminUser` plus a manual
   `account_claims` row and `backfill_default_templates`.
9. Set `NEXT_PUBLIC_INVITE_SIGNUP=1` on Production; create invite codes.
10. Merge the code PRs in slice order; Sasha checks her account on the preview and on production.
11. Reconcile the Phase 10 spec with the template contract in "Later".

Round 3 BLOCKs. Each is resolved in this spec by the run, and no auditor has re-checked the fix:

- **Open BLOCK (resolved in spec by the run, not re-audited):** legacy unowned outbox ops could be
  replayed as another account — smallest safe cut: hold them opaque in the old database, never
  stamp, show, export or send them; count only (0.6).
- **Open BLOCK (resolved in spec by the run, not re-audited):** direct (non-outbox) requests could
  send A's work under B's JWT — smallest safe cut: `accountFetch` asserts the epoch before send and
  sends `x-smc-account`; `requireUser` refuses a mismatch with `409` (0.5a).
- **Open BLOCK (resolved in spec by the run, not re-audited):** Floor Day safety could pass with
  missing evidence — smallest safe cut: the server alone decides, any missing input is unsafe, and
  the phone suppresses floor meals offline or without a fresh verdict (2.4).
- **Open BLOCK (resolved in spec by the run, not re-audited):** an old running client could render
  her slot labels for an invited account — smallest safe cut: server `426` for invited accounts
  below `MIN_CLIENT_BUILD`, no templates for them, and a service-worker forced reload; residual
  offline-label risk stated (1.5b).
- **Open BLOCK (resolved in spec by the run, not re-audited):** slice 4 could not pass its probe
  because the default template came later — smallest safe cut: templates M1 (with
  `account_claims`) is slice 4, invites and claim are slice 5, each slice has a runnable gate.

## Resolution of audit round 1

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Section 0, slice 1 (revised again in round 2) | `lib/sync/idb.ts:12,39-63`; `lib/sync/keys.ts:30-37`; `app/api/sync/ops/route.ts:79,84-93`; `components/AuthGate.tsx:254-261` |
| 2 | BLOCK | 1.1 per-path guarantee, admin path named and controlled; 1.6 gated helper and guard test | 12 admin callers in Facts |
| 3 | BLOCK | 1.4 nonce-bound claim; `used_count` moves only in `claim_account` | round 1 audit `signup.go` link |
| 4 | BLOCK | 1.5 activation gate; flag last in rollout | `supabase/config.toml:1-2,32,37` |
| 5 | BLOCK | 2.6 default in `claim_account`; no fallback; pending state | `lib/resolve.ts:168`; `lib/server/day-context.ts:176` |
| 6 | BLOCK | 2.2 category resolved once; 2.9 consumers | `lib/targets.ts:5-7`; `lib/water.ts:57-64`; `lib/server/export.ts:227` |
| 7 | BLOCK | 2.3 reference/share sizing, kcal derived, her table | `lib/meals.ts:949-960`; `lib/resolve.ts:62-107` |
| 8 | BLOCK | 2.1/2.4 slot-scoped options and floor meals, ref ownership check | `lib/meals.ts:79-113,882-925`; `lib/rotation.ts:57-78` |
| 9 | BLOCK | Superseded in round 2: no template sync entity; direct fetch (2.8) | `lib/sync/client.ts:129,165-167` |
| 10 | BLOCK | Superseded in round 2: templates immutable in Phase 9 (2.1), M2 validation (2.5) | `user_schema.sql:80`; `plan_days_eaten_slots.sql:5-31` |
| 11 | BLOCK | 2.9 inventory; four-slot acceptance test | `components/DayTypeChip.tsx:19-23`; `lib/ics.ts:38-117` |
| 12 | FIX | 2.2 weekday rule inside the training branch | `lib/plan.ts:33-37`; `lib/plan-day.ts:37-40` |
| 13 | FIX | Section 3 behavioral matrix, mutation test, admin entry manifest (revised in round 2) | `app/api/mcp/route.ts:20-24`; `lib/server/catalog-writer.ts:21-27` |
| 14 | FIX | 2.7 proof and rollback (revised in round 2) | `scripts/backup.sh`; `scripts/restore-to-branch.sh` |
| 15 | FIX | 1.3 shared DB rate limit | `lib/server/ratelimit.ts:1-11` |
| 16 | NIT | Accepted: broad scan replaced by the narrow authored-plan check; password path corrected | `components/PasswordSignInForm.tsx:23-26` |

## Resolution of audit round 2

All 15 findings were checked against the code and accepted. None was rejected.

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Rollout reordered: resolver, M1 seed/backfill and M2 before hook activation; flag is the last step; accounts created during the open-sign-up gap are listed for Devin and backfilled or deleted | `lib/resolve.ts:175-217`; `lib/plan.ts:43`; `app/sign-in/page.tsx:76` |
| 2 | BLOCK | 0.6: per-row adoption of mirrors by `user_id`; ops never auto-stamped, quarantined, (round 3 removed "Send as": ops are held opaque, 0.6); source `smc` kept while it holds ops | `lib/sync/idb.ts:12`; `lib/sync/keys.ts:30`; `lib/sync/types.ts:29`; `phase3_sync_entities.sql:55-56` |
| 3 | BLOCK | 0.1–0.3: handle + epoch required by every primitive (TypeScript finds all 24 callers); delayed settles assert the epoch; `purgeAccountMemory` resets the store cache and every module-global, with a scan test | `lib/store.ts:128,194`; `lib/log-commit-settle.ts:101-110`; module-globals in Facts |
| 4 | BLOCK | 0.4: `SyncBootstrap` inside `AuthGate`, starts only on `onAccountReady` (after adoption), restarts per account, stale pass saves no cursor | `app/layout.tsx:47-49`; `components/SyncBootstrap.tsx:49-64` |
| 5 | BLOCK | 1.1/1.5: no email-only mode; probe 5 checks the nonce reaches the hook; failure keeps invites off (open BLOCK with a cut in Open for Devin 7) | round 2 audit; 1.4 step 4 |
| 6 | BLOCK | Scope cut 2.8: no template change-feed entity; direct fetch into `meta`, no IDB version change; template entity with version bump deferred to "Later" | `lib/sync/idb.ts:43-57`; `lib/sync/client.ts:129,165-167` |
| 7 | BLOCK | Scope cut 2.1/2.8: no client template writes, no delete/restore path in Phase 9 | `phase3_sync_entities.sql:95-131,460-470` |
| 8 | BLOCK | Scope cut 2.1: templates immutable in Phase 9 (no archive), so stored edits keep their template; versioned binding deferred to "Later" | round 2 audit; 2.2 last paragraph |
| 9 | BLOCK | 2.4/2.9: `kind = 'composed'` replaces `isMealSlot`; coach sizing and `apply-schedule` added; four-slot sizing and shift tests | `lib/server/coach-ports.ts:99-152`; `lib/meals.ts:938-942`; `lib/coach/apply-schedule.ts:18-40` |
| 10 | BLOCK | 3.2: per-table declared operations manifest; undeclared operations must fail; mutation per applicable policy | `20260925000000_phase5_health_ingest.sql:16-21`; `20261022090100_coach_intent_telemetry.sql:26-29` |
| 11 | BLOCK | 2.6/2.9/3.6: fresh account asserts `needs_profile` and no numbers; category targets tested after its own revision | `lib/targets.ts:16-21`; `app/api/targets/route.ts:109` |
| 12 | BLOCK | 2.4: floor safety fails closed (every component needs a ref, no Avoid, `evaluatePolicy` allows); explicit reviewed mapping; four tests | `lib/resolve.ts:155-159,182-184`; `lib/policy/constraints.ts:99` |
| 13 | FIX | 1.4: `claim_account` takes a nonce only; the plain code goes only through the rate-limited route, including for `unclaimed` accounts | 1.3 limits |
| 14 | FIX | 1.4 step 2: cancel the same email's reservation under the code lock before the capacity check; repeated-claim test | round 2 audit |
| 15 | FIX | 2.7 step 6: drill A applies M2 and rolls back M2 then M1; drill B proves M1-only rollback | round 2 audit |

## Resolution of audit round 3

All 8 findings were checked against the code and accepted. None was rejected.

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | 0.6: legacy ops held opaque, never stamped, shown, exported or sent; rows without `user_id` not copied; A-water-op test; drain-before-upgrade step for Sasha | `lib/water-client.ts:41-51` |
| 2 | BLOCK | 0.5a: `accountFetch` (epoch check + `x-smc-account`) for every client `/api/` call; `requireUser` refuses a mismatch; switch-before-POST test; guard test for raw calls | `lib/log-commit-client.ts:245-276`; `lib/log/contract.ts:41-46`; `app/api/log/commit/route.ts:37-42`; `lib/server/auth.ts:22` |
| 3 | BLOCK | 2.4/2.8: server-only verdict with complete evidence (ref, profile, pref, category, allergen tags); phone suppresses offline or without a fresh verdict; missing-category and missing-allergen tests | `lib/policy/constraints.ts:99,140-150`; `lib/types.ts:230`; `lib/resolve.ts:168,182-184` |
| 4 | BLOCK | 1.5b: server minimum-client gate (`426`) for invited accounts, no templates for old builds, SW version bump with forced reload, old-tab test; residual risk stated | `lib/resolve.ts:175`; `public/sw.js:61-70` |
| 5 | BLOCK | Slices reordered: templates M1 with `account_claims` is slice 4, invites and claim slice 5; migrations renumbered; each slice has a runnable acceptance gate | 1.4 step 5; 2.6 |
| 6 | FIX | 1.5a and Open for Devin 2: hosted sign-up off and verified before slice 2; on again only for the probe | `app/sign-in/page.tsx:76`; `supabase/config.toml:1-2` |
| 7 | FIX | "Later": Phase 10 contract (online-only `replace_day_template` RPC with version check, refresh by fetch); Phase 10 reconcile listed for Devin and the coordinator | `docs/specs/phase-10-conversational-onboarding.md:112,373` |
| 8 | FIX | 2.6 and success criteria: the no-target assertion is resolver/API only; the Preview UI path runs through onboarding first | `lib/profile/onboarding-state.ts:107-108`; `components/AuthGate.tsx:167` |

## Slices (PR-sized, in order, each with its acceptance gate)

1. **Device-state isolation** — all of section 0: account handle and epoch (0.1); every IDB and
   storage primitive takes the handle (0.2); module memory reset (0.3); `SyncBootstrap` inside
   `AuthGate`, started only on `onAccountReady` (0.4); outbox ops stamped with `user_id` and
   refused by `/api/sync/ops` on mismatch (0.5); `accountFetch` with `x-smc-account` and the
   `requireUser` check (0.5a); legacy adoption with held, opaque ops (0.6); sign-out and switch purge
   (0.7). No migration. Gate: every test in 0.8 passes; typecheck proves every primitive caller
   passes a handle. Ships alone; fixes the live bug.
2. **Close open sign-up in the UI** — `shouldCreateUser: false` on Sign in; dev-route test. Gate:
   `tests/sign-in/*` pass. Deploys only after Open for Devin 2.
3. **Tenancy checks** — section 3 items 1–5 and 7 on the current schema. Gate: the matrix and the
   mutation test pass in CI.
Slices 4–8 below match the implementation plan `docs/plans/2026-09-22-phase-9-tenancy/` (Updated 2026-09-23 by the overnight run to match plan round 12.)
Merge and deploy order: **1, 2, 3, 4, 5, 7, 8, 6** (M2 before the resolver). Floor Day is unchanged
in Phase 9: no floor mapping, no verdicts, and the proof is exact.

4. **Templates M1** — migrations `20261104090000_day_templates.sql` (re-asserts the PR #249 sync
   guard; template tables with same-owner and fixed-parent triggers; `account_claims` with the
   `manual` backfill) and `20261104090100_plan_days_category_override.sql` (plus the `plan_days`
   sync patch after PR #241's `20261029090000`); `seed_templates_from_fixture`,
   `backfill_default_templates` and an internal `create_default_template(user_id)`; fixture
   generator and fixture; `GET /api/plan/templates` answering `{ templates, version }`. Gate: on the
   local stack, seed and backfill produce the expected rows; the endpoint returns them under RLS; a
   cross-user read returns nothing.
5. **Shared rate limit + invites + claim** — migrations `20261105090000_shared_rate_limit.sql`,
   `20261105090100_invites.sql`; claim route, hook (binds `hook_user_id`), `claim_account`
   (hook-bound, calls `create_default_template`), `config.toml` hook, `scripts/invite.ts`,
   `scripts/invite-probe.ts`, gated helpers and guard test, UI behind the flag. Gate: the 1.4 tests
   pass locally and probes 1–5 pass on `p9-tenancy`.
7. **Migration proof tooling** — `scripts/p9/*` (row counts with a read-only production mode, per-root
   snapshots with provenance, exact diff, ledger and guard checks); M1 proof and rollback drills on
   `p9-tenancy`. Gate: M1 changes no resolved day for the production code; option round-trip; drills
   behave; ledger check passes.
8. **Key validation M2** — `20261106090000`; judges only added or changed keys, with the legacy
   allowance for `manual` accounts. Applied after every account has templates and **before** slice 6
   deploys. Gate: invited-account `breakfast` accepted; an invited account's legacy key refused as an
   RPC error (the op parks as `error`); M2 proof and drill.
6. **Resolver and consumers** — 2.2–2.3, 2.8 client side, every row of 2.9, Floor Day as on `main`
   today, the minimum-client gate in the API and the database (`20261107090000_min_client_gate.sql`)
   and the SW reload (1.5b); `lib/meals.ts` out of runtime; pending state. Gate: four-slot acceptance
   test, fresh-account test (3.6), 1.5b tests, and the exact resolver proof (Sasha's days equal to
   `main`'s, no exceptions).
