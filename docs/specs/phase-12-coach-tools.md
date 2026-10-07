# Phase 12 — Coach tools

**DRAFT — written by the overnight run; choices marked DECIDED (run).**
**Audited by GPT-6 Sol through round 26; last round 3 BLOCK resolved in spec, not re-audited.**
Revision 27 (2026-09-23). Audit history, all by GPT-6 Sol: rounds 1–26
(`docs/audit/specs/2026-09-22-phase-12-r1-gpt6-sol.md` … `-r26-gpt6-sol.md`), each DO NOT SHIP; round
21 had 6 BLOCK and 2 FIX; round 22, 3 BLOCK and 1 FIX; round 23, 3 BLOCK and 2 FIX; round 24, 3 BLOCK; round 25, 4 BLOCK and 1 FIX; round 26, 3 BLOCK and 2 FIX.

Devin approved extra audit rounds and accepted every **DECIDED (run)** choice and scope cut
(2026-09-23). Each round added writers, so revision 22 **strips Phase 12 to its core** (coordinator
decision): one checked target writer in the database, and units from chat. Everything else —
including the combined weigh-in RPC, the Undo RPCs, the direct profile RPC, the Health-driven
warning and the contract migration — is in "Later" with its lessons.

## Next audit

The Phase 12 implementation plan must be audited by GPT-6 Sol before any Phase 12 code is written.
That audit must also re-check revision 27 of this spec.

## What Phase 12 ships

1. **A checked target writer in the database** — `write_target_revision_checked(p_user_id uuid,
   p_row jsonb, p_predecessor jsonb default null) returns jsonb`, service role only. It computes the
   calorie, fat and protein minima itself, from the locked stored profile and weight, by PR #241's
   rule, and refuses a revision below them with a clear message. Used by `/api/targets` (Settings
   targets, coach `set_targets` and `update_profile`, the retarget a weigh-in already sends, restore)
   and by Phase 10's `complete_onboarding`.
2. **Weight and height units from chat** (`update_setting`: `weightUnit`, `heightUnit`), apply with
   undo, written one key at a time, offered only to a build that can apply it.

Everything else from Devin's request (2026-09-22) is in "Later". Rewards and discounts are out of the
program (Devin, 2026-09-22).

Part 4 of 4 in the multi-user program. It depends on PR #241 (merged first), Phase 9 (the shared rate
limiter of Phase 9 §1.3, the `x-smc-client` header) and PR #248 (`x-smc-account`). Its migration ships
**before** Phase 10's, which calls the writer. It does not depend on Phase 11.

## Facts this spec rests on (read 2026-09-23)

- The coach's target, profile and weight actions reach the server through `/api/targets`:
  `applySetTargets` and `applyUpdateProfile` call `persistTargets` (`lib/coach/apply-profile.ts:66-90`,
  `:126-178`); `log_weight` saves the weigh-in and then retargets the same way
  (`lib/coach/apply-body.ts:59-90`, `lib/today/water-and-weight.ts:228-279`); all post to
  `/api/targets` (`lib/targets/client.ts:101-106`). The Settings screens use the same route.
- The route calls `writeDerivedTargets`, `writeTargetRevisionSet`, `authorTargets` and
  `restoreTargetRevision` (`app/api/targets/route.ts:119-136`; `lib/server/targets.ts:112-190`,
  `:232-260`), which call `write_target_revision` / `write_target_revision_pair` with the caller's
  client (`targets.ts:89`, `:154`). Those RPCs take the caller's macros and floors with no floor check
  (`supabase/migrations/20261023091000_target_revision_transactions.sql:3-87`) and are granted to
  `authenticated`.
- `authorTargets` raises a below-floor request to the floor and saves it (`targets.ts:249-256`).
- `lib/coach/floors.ts:18-20` holds one account's constants; `violatesFloors` has no runtime caller.
- `syncProfileSettings` queues the whole profile (`apply-profile.ts:32-48`,
  `lib/sync/user-settings.ts:97-119`); the settings intent path records every value that differs from
  its mirror as an edit (`lib/sync/settings-intents.ts:145-155`); `mutateUserSettings` is the atomic
  read-modify-write (`lib/sync/outbox.ts:103`).
- An unknown action kind falls to `applySlot` on the phone (`lib/coach/apply-client.ts:87-104`);
  cards call it "Updated your plan" (`components/CoachActionCard.tsx:50-58`); the history line has no
  case for it (`lib/coach/history.ts:51-60`).

## 1. The checked target writer

Revision 22 strips Phase 12 to its core (coordinator decision; Devin accepted the cuts). There is
**one** new database writer. The coach and Settings target paths and Phase 10's
`complete_onboarding` use it. Weigh-in, Undo, proposal approval and every other existing path stay
**exactly as on `main`**, except that a target write or restore that reaches the new writer below a
floor is refused with a clear message. Everything removed is in "Later" with its lessons.

### 1.1 The one signature

```sql
write_target_revision_checked(
  p_user_id     uuid,
  p_row         jsonb,
  p_predecessor jsonb default null
) returns jsonb
```

- `security definer`, `set search_path = public, pg_temp`.
- `p_row` and `p_predecessor` have the same shape as the existing `write_target_revision` payload
  (`supabase/migrations/20261023091000_target_revision_transactions.sql:3-60`); the function ignores
  any `kcal_min`, `fat_g_min` or `protein_g_min` in them and stores its own.
- **Return shape** (round 22 finding 1), exactly as the existing writers:
  - with `p_predecessor` null: the written `target_profiles` row, `return to_jsonb(v_profile);`
    (`20261023091000_target_revision_transactions.sql:66`), or on a replay the stored
    `change_log.current` for that `request_id` (`:21`, `if found then return v_existing; end if;`);
  - with `p_predecessor`: `return jsonb_build_object('predecessor', v_predecessor, 'revision',
    v_revision);` (`:80`), each half being such a row.
  So the server's existing parsing (`lib/server/targets.ts:89-110`, `:154-165`) is reused unchanged.
- **Privileges.** `revoke all on function write_target_revision_checked(uuid, jsonb, jsonb) from
  public, anon, authenticated; grant execute … to service_role;` (PostgreSQL grants `execute` to
  `PUBLIC` by default; existing migrations revoke it explicitly, `20260911000600_rpc.sql:19`).
  `/api/targets` calls it through the admin client with `p_user_id` from `requireUser` (the route
  joins the Phase 9 service-role list and the cross-user suite). Phase 10's `complete_onboarding`
  (`security definer`, same owner) calls it by this exact signature inside its own transaction.
- **No floor from the caller.** There is no floor or raise parameter; the function computes the
  floors itself every time.

### 1.2 What it does, in one transaction

1. Takes the `user_settings` lock that `apply_sync_op` takes,
   `pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':user_settings:settings', 0))`
   (`20260919090300_phase3_sync_entities.sql:436`), then the per-user target lock
   `pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0))`
   (`20261023091000_target_revision_transactions.sql:19`) — the same order as Phase 10's
   `complete_onboarding` (Phase 10 "The stage-9 build", step 1), so they cannot deadlock.
2. **Idempotency first** (round 22 finding 2): if `p_row.request_id` is already in `change_log`
   (entity `target_profiles`), returns the stored result — for a pair, both stored rows in the pair
   shape — **before** any profile or floor check, so a retry of a write that committed returns its
   result even if the profile or weight has changed since. Only then:
3. If the account has no `user_settings` row, or the row lacks a field the floor needs (sex, birth
   year, height, goal, and a weight from the row or a sample), raises `profile_required`:
   `raise exception 'profile_required' using errcode = 'SF002';`
4. **One weight selection** (round 24, decision c): calls `account_body_mass_kg(p_user_id)` once
   (1.3); it returns `(kg, sample_id)` (`sample_id` null when the profile weight is used). There is **no
   input-weight check and no `build_stale`** (round 25 decision): the writer does not compare the
   revision's input weight with the current one. Safety holds because every floor is computed from the
   weight selected here, under the lock. Accepted residual (Open for Devin 4): a revision derived from a
   weight a few minutes older, still above every floor, is stored. Then computes the floors with
   `account_floor(p_user_id, v_weight_kg)`, passing that same selected weight; `account_floor` reads
   sex, height and goal from the locked row and never selects a weight itself.
5. **Pins** (round 26 finding 1): if `p_row.pin_training_kcal` or `pin_rest_kcal` (the payload's pin
   fields, `lib/server/targets.ts:65-67`) is set and below the calorie minimum, raises `below_floor`
   for that pin, even when the resolved day was clamped above it (`adjustCalories`); likewise
   `pin_protein_g` below the protein minimum. Then, for each day of `p_row` (not `p_predecessor`; see the predecessor rule in 1.4), first raises `kcal_mismatch` (`SF004`) if
   `kcal` differs from 4·protein + 4·carbs + 9·fat by more than 9 kcal (1.4); then raises `below_floor` if kcal, fat or
   protein is below its minimum, for the first failing value only:
   `raise exception 'below_floor' using errcode = 'SF001', detail = jsonb_build_object('floor',
   'protein', 'dayType', 'training', 'minimum', 180)::text;` (values are examples).
6. Writes the revision(s) as `write_target_revision` does, with `kcal_min`, `fat_g_min` and
   `protein_g_min` set to the floors it used and `kcal_min_source = 'macro_minimum'` (round 23
   finding 4: PR #241's writer defaults an omitted source to `legacy_default`,
   `supabase/migrations/20261029090000_rate_goals.sql:68-98` and `lib/targets/revision.ts:56-62` on the
   branch).

### 1.3 The floors (PR #241's rule, computed in SQL)

- Protein minimum = round(`proteinBasisKg(weight, height)` × 2.0 for `lose_fat`/`recomp`, else 1.8)
  (`lib/profile/energy.ts:177-178`, `lib/profile/rate-goal.ts:33` on `feat/tdee-rate-goals`; TDEE plan
  step D, `docs/plans/2026-09-22-tdee-engine-plan.md:54`). Calorie minimum = `macroMinimumKcal` =
  4·protein + 9·50 + 4·100 (`rate-goal.ts:37`, branch). Fat minimum = 50 g. Carbohydrate: not checked.
- Weight (`account_body_mass_kg(p_user_id uuid, p_effective_date date default null) returns table(kg
  numeric, sample_id uuid)`; a null date means the user's local today from `user_settings.time_zone`): per local date a device sample wins
  over a manual one and the last of the day is used (`lib/health/daily.ts:160-176`); converted to kg
  whatever its stored unit (`daily.ts:173-175`); only dates on or before the effective date; the
  latest wins (`lib/today/water-and-weight.ts:146-165`); with no sample, `user_settings.weight_kg`
  (`lib/profile/energy.ts:187-192`).
- **Privileges** (round 24, decision b): both functions `revoke all … from public, anon, authenticated`.
  `account_floor(uuid, numeric)` gets no grant (used only inside the writer).
  `account_body_mass_kg(uuid, date)` gets `grant execute … to service_role`, so a route (Phase 10's build)
  can read the same weight the writer will use, with the service role.
- **Parity** (**DECIDED (run)**): the rule exists in SQL and in PR #241's TypeScript. A CI test runs
  both on the TDEE plan's reference personas, random profiles and weigh-in fixtures (future-dated
  sample ignored, legacy `lb` row converted, device beats manual on one day, no sample → profile
  weight) for all three minima and must match exactly.
- **PR #241 must be merged first.**

### 1.4 Callers that change

| Caller | Today | Phase 12 |
|---|---|---|
| `/api/targets` `derive` (single and pair) | `writeDerivedTargets` / `writeTargetRevisionSet` call the old writers with the caller's client (`lib/server/targets.ts:89`, `:112-117`, `:140-165`) | call `write_target_revision_checked` through the admin client |
| `/api/targets` authored grams / percent | `authorTargets` validates the percent split against the **previous** revision's floors, then raises grams and calories to those floors before writing (`targets.ts:235-256`) | `authorTargets` **keeps** `validatePercentProfile` on the percent path (round 25 finding 1: its 100 % sum check, `lib/targets/percent.ts:63`; its floor branches still use the previous revision's floors and may refuse first, which is conservative); it drops only `applyFloors` and the `Math.max` raise, builds the row from the request (percent converted to grams, rest carbs from `kcalRest` as today, `percent.ts:88-90`) and calls the checked writer. **No negative macros** (round 26 finding 2): if the conversion gives any day a negative protein, carbohydrate or fat value (for example rest carbs from a low `kcalRest`, `percent.ts:88-90`), `authorTargets` refuses with `422 invalid_macros` "Rest-day calories are too low for this protein and fat. Raise them or lower protein or fat." and writes nothing; the writer also refuses any negative macro (`SF004`). **Calories are never replaced** (round 25 finding 2): for each day the writer compares the row's `kcal` with `4·protein + 4·carbs + 9·fat` (the Atwater factors of `macroKcal`, `lib/scaling.ts:11-13`, `:20-26`); if they differ by more than **9 kcal** — the most that rounding each macro to a whole gram can cause, ½·(4 + 4 + 9) = 8.5 — it raises `kcal_mismatch` (`SF004`, detail `{ dayType, kcal, macroKcal }`), mapped to `422 kcal_mismatch` "Your calories and macros don't add up: they make N kcal. Change one of them." and writes nothing. Example: 2,000 kcal with 150 g protein, 200 g carbs and 80 g fat (2,120 kcal) → refused. Within 9 kcal the row is stored as sent. Below the minima → 422 `below_floor` |
| `/api/targets` `restore` (used by Undo) | `restoreTargetRevision` (`targets.ts:172-190`) | calls the checked writer; the row being restored is checked against today's floor and refused if below (round 26 finding 3). **Predecessor rule:** in a pair write the floor check applies to `p_row` only; `p_predecessor` (the row an Undo would later restore) is stored without a floor check, and is checked only if and when it is restored. So a first retarget with no active revision (the weigh-in path builds its predecessor before saving the weigh-in, `lib/coach/apply-body.ts:67`) is allowed when `p_row` is above the floor |
| Phase 10 `complete_onboarding` | — | calls the checked writer; on `below_floor` (`SF001`) the whole completion rolls back and Phase 10 shows the refusal with no automatic retry (Phase 10 "The stage-9 build") |

**Release with Phase 10** (round 23 finding 1). The current onboarding form calls
`saveOnboardingSettings`, which posts the target to `/api/targets` (`derive`) **before** it queues the
profile (`lib/profile/onboarding-client.ts:78-92`), so a checked writer that requires a stored profile
would refuse it. Therefore: the migration (1.6) ships before Phase 10's migrations, but the
`/api/targets` switch to the checked writer ships **in the same release as Phase 10**, whose form
fallback calls `complete_onboarding` instead of `saveOnboardingSettings`. Older builds that still
run the old form are invited (`default`) accounts, which Phase 9's minimum-client gate stops with
426; manual accounts are already onboarded. Test: on the release build the form completes
onboarding; an old-form request with no stored profile gets `409 profile_required`.

These cover Settings targets, coach `set_targets` and `update_profile`, and the retarget that a
weigh-in already sends to `/api/targets` today. Nothing else changes: the weigh-in POST, the weigh-in
and target queues, Undo tokens and their order, proposal approval, the old writers and the table
grants stay as on `main`.

### 1.5 The refusal and its message

```ts
export class TargetBelowFloorError extends HttpError {
  constructor(
    public readonly floor: "kcal" | "fat" | "protein",
    public readonly dayType: "training" | "rest",
    public readonly minimum: number,
  ) {
    super(422, "below_floor", floor === "kcal"
      ? `That is below your minimum of ${minimum} kcal a day. Choose ${minimum} or more.`
      : floor === "fat"
        ? `That leaves less than ${minimum} g of fat a day. Choose a higher amount.`
        : `That is less than your minimum of ${minimum} g of protein a day. Choose ${minimum} g or more.`);
  }
}
```

- **From SQL to HTTP** (round 22 finding 4). supabase-js returns a failed RPC as an error object with
  `code` (the SQLSTATE) and `details` (the `detail` text). `lib/server/targets.ts` maps, in one
  function `mapTargetWriteError(error)`: `code === "SF001"` → parse `details` as JSON with a zod schema
  `{ floor: "kcal" | "fat" | "protein", dayType: "training" | "rest", minimum: number }` → throw
  `TargetBelowFloorError(floor, dayType, minimum)`; `code === "SF002"` → throw
  `HttpError(409, "profile_required", "Finish your profile first.")`; `code === "SF004"` → throw
  `HttpError(422, "kcal_mismatch", <message from detail>)` (1.4); a `SF001` whose `details` does not
  parse → log it and throw a 500 (never a wrong message); any other code → rethrown as today. Test: each
  case, including malformed `details`.
- Beside the unchanged `FloorViolationError` (`targets.ts:23-29`). `profile_required` maps to
  `HttpError(409, "profile_required", "Finish your profile first.")`. The route returns
  `422 { error: "below_floor", message, floor, dayType, minimum }` (`jsonError` returns only `error`
  and `message`, `lib/server/http.ts:16-17`).
- Client: `postRevisionSet` and `postTargets` throw a typed `TargetFloorError` for `below_floor`;
  `persistDerivedTargetRevisionSet` rethrows it and **does not queue** it
  (`lib/targets/client.ts:176-199` queues every failure today); the drain removes an existing queued
  entry that gets `below_floor` (`targets/client.ts:202-218`) and keeps every other answer as today.
- Where it shows: Settings shows the server `message` in place of the generic connection error in
  **both** handlers — `saveTargets` (`components/settings/use-settings-controller.ts:224-229`) and
  `writePin`, used by the training- and rest-day calorie controls (`use-settings-controller.ts:201`)
  (round 26 finding 5); a coach target action fails with it as
  the reason; a weigh-in whose retarget is refused keeps its weight and shows "Weight saved. Your
  targets were not changed: <message>" instead of "targets will refresh on the next sync"
  (`lib/today/water-and-weight.ts:257-279`); an Undo whose restore is refused shows the message.
  These are message changes only; the flows are unchanged.

- **Grams editor** (round 26 finding 4). `TargetModeSheet` sends unchanged calories while its steppers
  change grams in 5 g steps (`components/TargetModeSheet.tsx:53`, `:99`), which would now hit
  `kcal_mismatch`. In grams mode it recomputes each day's calories as `macroKcal` of the grams on every
  step and shows and sends that value. Test: +5 g protein → shown and sent kcal rise by 20; the save
  succeeds.

### 1.6 Migration

One migration, `20261108090000_phase12_target_floor.sql`: adds `account_body_mass_kg`,
`account_floor` and `write_target_revision_checked` with the privileges above. It changes no existing
function or grant. It sorts after PR #241's `20261029090000`, the applied `20261103090000` and
`20261103090100`, Phase 9 `20261104090000`–`20261107090000`, and **before** every Phase 10 migration
(`20261110…` or `20261122…`), because `complete_onboarding` calls the writer. Down file: drops the
three functions. The old write paths (the old writers callable by `authenticated`, direct table
writes, proposal approval) stay open exactly as on `main`; closing them is Later 1.

### 1.7 Tests

Database and route (local Supabase, PR #241 merged): a kcal, fat or protein value below its minimum →
`below_floor` with the right `floor`, no row; at the minima → saved with the three `*_min` stored;
the parity test; `p_row` carrying its own low `kcal_min` → ignored; no stored profile →
`profile_required`; authored grams and percent below the floor → 422, not raised; restore below
today's floor → 422; an authenticated direct call to `write_target_revision_checked`,
`account_floor` or `account_body_mass_kg` → permission denied; `complete_onboarding` (Phase 10) calls
the writer by its exact signature; a queued target entry that gets `below_floor` is removed; the
weigh-in and Undo messages above.

## 2. Weight and height units from chat

| Keys | Policy |
|---|---|
| `weightUnit`, `heightUnit` | apply with undo |

- **Writer.** `applyUnitSetting(key, value)` calls `mutateUserSettings` with a function that takes the
  **current mirror row** and changes only `weight_unit` or `height_unit`; the op payload is that row
  with only the one key changed, so `foldEdit` records one intent for one key. It does not use
  `syncProfileSettings`, which queues the whole profile. The local store gets the same single field.
  Undo is the same call with the previous value of that key only.
- **Tool-proposed write.** `update_setting` is a registry tool with `effect: "propose"`. Its executor
  validates the key and value and pushes a grounded `{ kind: "update_setting", key, value, actionId }`
  onto a turn-local `proposals` list. At the final step the server merges the model's grounded final actions
  **first** and then the unit proposals, under the 3-action cap on the merged list
  (`lib/coach/turn.ts:98`) (round 22 finding 3). The model's final actions (at most 3 by schema) are
  never dropped for a proposal. A proposal that does not fit is dropped and not charged. **When any
  proposal is dropped** (round 23 finding 3), the model's reply text is not used — it may claim the
  dropped change — and is replaced by the fixed text "I couldn't do all of that — ask me again for the
  rest."; the thread `memory` summary is not updated in that turn. The kept actions show on their
  cards. The list is persisted in `coach_messages.tool_calls.actions`; replay re-validates them and never re-runs the executor. The
  kind joins the grounded union only, not the provider schema.
- **Consumers of the new kind.** A `runApply` case that calls `applyUnitSetting`; a `performUndo` case
  and an `UndoToken` variant `{ kind: "update_setting", key, previous }`; card copy "Weight unit: kg" /
  "Height unit: cm" (and the undone form); an `actionLine` case
  `[action: update_setting weightUnit → kg]`.
- **Refresh the weigh-in control** (round 23 finding 5). `CoachChat` reads `weightUnit` once at mount
  (`components/CoachChat.tsx:159`) and the weigh-in field labels and sends in that unit
  (`components/coach/ComposerToolbar.tsx:64`). `applyUnitSetting` and its Undo dispatch
  `meal-companion:settings-changed`; `CoachChat` listens, re-reads `weightUnit` from the store and
  passes it down. Test: switch to kg from chat; the weigh-in field shows "kg" without a reload and
  sends kg.
- **Old clients.** `update_setting` is in the registry only when the request's `x-smc-client` is at
  least `PHASE12_MIN_CLIENT_BUILD`; the server drops any `update_setting` action from a response, new
  or replayed, to an older build (an old build would send the unknown kind to `applySlot`).
- **Neutral text for older builds** (round 13 finding 5). Replay returns stored assistant content
  separately from actions (`lib/server/coach-threads.ts:73-85`), and thread history returns it too
  (`app/api/coach/threads/[id]/route.ts:41-49`). So when the server drops an `update_setting` action
  for an older build — in a new turn, in replay, or in thread history — it also replaces that
  message's content with "I can change units from chat after you update the app. You can change them
  in Settings now." Test: an old-build client replays and reloads a thread whose stored reply says
  "Switched you to kilograms"; it receives the neutral line and no action.
- **Usage limit** (round 11 finding 5), defined here: 30 kept `update_setting` actions a day per user, counted with
  `enforceSharedRateLimit("coach:update_setting:<userId>", 30, 86400)` (the function Phase 9 §1.3 adds). 
- **Per-turn cap and charge, in code** (round 12 finding 5). The turn loop runs validated calls with no
  per-tool count (`lib/server/coach-turn.ts:668`), and `buildToolSpec` does not send
  `maxCallsPerTurn` to the model (`lib/coach/prompt.ts:266`). So the `update_setting` executor keeps a
  turn-local count and refuses a 4th call in the turn with a tool error ("Only 3 setting changes per
  message"). The daily counter is **not** charged in the executor: at the final step, after the merge
  and the 3-action cap, the server calls `enforceSharedRateLimit` once for each `update_setting` action
  that is kept in the returned actions; an action it cannot charge (over the daily limit) is removed
  and the reply says "Try again tomorrow". Replay never charges. Tests: 4 calls in one turn → 3
  proposals; a proposal dropped by the 3-action cap is not charged; the 31st kept action in a day is
  removed.
- Every other setting is refused with where to change it.
- Tests: apply, sync, reload on a second device and Undo for both keys; phone B edits weight, phone A
  (stale) switches to kilograms, and after both sync B's weight is kept and only the unit changed; a
  follow-up turn ("and height too") sees the history line; the 31st accepted proposal in a day is
  refused and a replay does not count.

## 3. Tenancy

- `write_target_revision_checked` is service-role only; `/api/targets` passes `p_user_id` from the
  verified session only, and the route joins the Phase 9 service-role list and the cross-user suite.
- `update_setting` writes only the caller's settings mirror through the caller's session; its
  executor takes `userId` from the session closure.
- Cross-user tests: A's `/api/targets` write never names B; A's `update_setting` touches only A's
  settings; A cannot restore B's revision (existing 404, `targets.ts:176-178`).

## 4. Testing

The tests in §1.7 and §2, plus:
- Eval (branch, live model): 20 settings requests (units applied; every other key refused); 10 target
  requests below a floor (each card shows the floor message; no revision written).

Preview steps for Devin and Sasha:
1. Settings → Targets: set training-day calories below the minimum → the floor message; nothing saved.
2. Chat: "set my protein to 60 g" → the action card fails with the protein message.
3. Chat: "set my training day calories to 2,000" → applies as today, with Undo.
4. "Switch me to kilograms" → applies with Undo; a second phone shows kilograms after sync.

## 5. Slices (PR-sized, in order)

0. Prerequisites: PR #241 merged, Phase 9 (shared limiter), PR #248.
1. The checked writer (§1): migration and parity test — the migration ships before Phase 10's
   migrations; then `/api/targets` on the admin client, the error mapping, the client and message
   changes — these ship in the same release as Phase 10 (§1.4 "Release with Phase 10").
2. `update_setting` (§2).

Each slice: TDD, targeted local tests only, CI as the gate, Preview steps in the PR body.

## 6. Migrations and release order

One migration, `20261108090000_phase12_target_floor.sql` (§1.6): after PR #241's `20261029090000`,
the applied `20261103090000` and `20261103090100`, and Phase 9 `20261104090000`–`20261107090000`;
before every Phase 10 migration. No contract migration in this phase.

## Success criteria

- No revision written through `write_target_revision_checked` has a day below the calorie, fat or
  protein minimum computed in the database from the locked stored profile and weight.
- `/api/targets` (every operation) and Phase 10's `complete_onboarding` write only through it.
- Settings from chat change only the two unit keys, one key per write, each with Undo, only on a
  capable build, within 30 kept actions a day.
- Everything else behaves exactly as on `main`, apart from the refusal messages in §1.5.

## Later (cut from this phase, with the constraints found in audit)

1. **Close the other target and input write paths** (removed in revision 22; rounds 13–21). Lessons:
   - Old writers `write_target_revision(uuid, jsonb)` and `write_target_revision_pair(uuid, jsonb,
     jsonb)` are granted to `authenticated`, and `authenticated` has `insert, update, delete` on
     `target_profiles`, `user_settings` and `health_samples` (`rls.sql:8-22`); closing them needs an
     expand/contract pair and a readiness check that also counts headerless clients (r15 f2, r16 f1,
     r17 f3). The contract migration must sort after every Phase 10 migration (r20 f1).
   - Proposal approval must compute the floor at approval time (r14 f4).
   - Every writer of `user_settings`, body-mass samples and targets must share one lock order with
     `complete_onboarding` (settings lock, then per-user lock) (r14 f5, r15).
   - A profile change can raise the floor after its target was checked against the old profile
     (`apply-profile.ts:125-142` writes targets before the settings op); fix by one transaction for
     profile and target, but a direct profile RPC must respect the outbox baseline and pending
     intents (r20 f2, r21 f5).
   - A weigh-in retarget must depend on an acknowledged weigh-in; a combined RPC needs idempotency
     before its first mutation, and existing split queue records must be migrated (r20 f3, r21 f3,
     r21 f4).
   - Undo must be one conditional, atomic write bound to server-held prior state — never a
     client-supplied prior sample — and must restore the exact prior row (r19 f2, r20 f4, r21 f2,
     r21 f6, r21 f7).
   - A Health-driven "targets below minimum" warning needs a real read path on Today (r21 f8).
   - A queued target entry removed after `below_floor` should leave a visible notice (r13 f4).
   - Carbohydrate floors, and floors carried between revisions, need reconciling with the scaling
     floors (`lib/types.ts:276-281`, `derive.ts:13`) (r3 f3, r4 f4); a protein-lock rule for coach
     writes (r2 f12).
2. **Retiring or confirming coach target, weight and planned-meal writes.** Tried in revisions 5–11
   and dropped. Lessons: a phone keeps cached actions, Retry and Undo (r8 f1, r10 f2); older builds
   and writes queued before an upgrade look the same as manual writes to the server (r10 f1); a
   quarantine must also hold dependent new writes and undo optimistic local effects (r11 f1, r11 f2);
   a reply check must be action-kind-aware and fail closed (r11 f3); the Jev fast path is a second
   action source (r10 f4); replayed text needs the same filter as replayed actions (r10 f5); every
   prompt example that teaches a write must change (r10 f6); a confirm flag must be server-owned
   (r4 f5); there is no manual weigh-in screen outside chat (r10 f3).
3. **Calendar tools (`get_calendar`, `plan_range`)** — safest rule (Devin, 2026-09-23): a range
   write must not replace another device's unsynced edit (r4 f9); op binding (r4 f10); advisory locks
   (r3 f5); reads that include pending plan edits (r5 f5, r6 f3, r7 f5).
4. **Planned meals over a range and the 4-week plan** — apply-time rules recheck (r5 f2), a
   transactional multi-date write, one bundled proposal.
5. **Meal-entry edits (`edit_entry`)** and **recipe edits (`edit_recipe`)**.
6. **Insights and placements** with typed facts and a number check.
7. **Plateau adjustment (7 %)** — shared `clampFactor` (export it, `lib/proposal.ts:71`), final-gram
   floors, weekday-weighted percent, `base_revision_id` checked after the advisory lock.
8. **Sleep-driven carbohydrate timing**, **re-engagement**.
9. **Stored files, PDF, push notifications, the action audit log.**
10. **Exports from chat** — the 1,000-row PostgREST cap (`supabase/config.toml:10`), progress rows,
    chunked name lookups, and a truncation check in every consumer including `ExportCard` (r7 f3,
    r8 f3, r8 f4, r9 f4).
11. **Meal times and display name from chat** (r6 f2).
12. **Web research** — see "Design lessons from web research" below.

### Design lessons from web research (rounds 1–9)

- **Mode first.** Decide research before any model step; render the reply only from checked claims
  or a fixed abstention (r5 f4, r7 f4).
- **Evidence.** A tier 1 source or two tier 2 sources on different domains; no claim when the checker
  is unavailable (r1 f12, r2 f8).
- **Isolation.** A research turn returns no actions, drafts or write-capable cards (r6 f1); both
  messages are excluded from later history, summaries, recall and memory (r8 f2).
- **Title leak.** A research-first thread takes its title from the question
  (`lib/server/coach-threads.ts:159`); give it a neutral title or exclude it from recall (r9 f2).
- **Server-owned provenance.** `coach_messages` rows are owner-updatable
  (`supabase/migrations/20260911000500_rls.sql:55-64`); keep provenance where the client cannot write
  (r9 f3).
- **Filter before the limit.** Select the latest 12 non-research rows in the query, not after it
  (`coach-threads.ts:120-130`) (r9 f6).
- **Fetcher.** Pin the vetted IP, keep TLS hostname checks, manual redirects, normalize IP forms
  (r1 f7); persist a validated source snapshot (r2 f7, r3 f10); only with the health gate open
  (r5 f3); budget under the phone's 40 s (r1 f13).

## Open for Devin (human-only)

Open BLOCK (round 26, resolved in spec by the run, not re-audited): a low calorie or protein pin could
save while the resolved day was clamped above it — the writer now checks the pins themselves.
Open BLOCK (round 26, resolved in spec by the run, not re-audited): the authored conversion could store
negative rest-day carbs — any negative macro is now refused.
Open BLOCK (round 26, resolved in spec by the run, not re-audited): checking the Undo predecessor could
block a safe first retarget — only the written or restored row is checked.

Rounds 3–21 BLOCKs are resolved by the run, most by removal (see the tables); revision 22 is not yet
re-audited.

1. Apply `20261108090000_phase12_target_floor.sql` to production before Phase 10's migrations, and
   release the `/api/targets` switch together with Phase 10 (production changes; the run never
   applies them).
2. Phase 10 spec lines to keep in step (Phase 10 is edited by its own run): `complete_onboarding`
   step 8 calls exactly `write_target_revision_checked(p_user_id uuid, p_row jsonb, p_predecessor
   jsonb default null)`; on `below_floor` (`SF001`) completion rolls back with no
   automatic retry; **there is no `build_stale` / `SF003`** — Phase 10's SF003 retry branch and its
   `input_weight_sample_id` payload key are removed; its migration asserts the function exists and
   sorts after `20261108090000`.
3. Confirm the minima that now bind every target written through the checked writer: PR #241's protein
   minimum (2.0 g/kg of protein basis for lose/recomp, 1.8 otherwise) — which refuses a manual
   protein pin below it — and the calorie minimum `macroMinimumKcal` (4·protein + 9·50 + 4·100). Today
   authored grams/percent requests below it are raised silently; after Phase 12 they are refused.
4. Accepted until Later 1: the old writers and direct table writes stay open exactly as on `main`;
   proposal approval is not floor-checked; a profile change can be checked against the old profile.
   Also accepted (round 25 decision): a revision derived from a weight a few minutes older than the one
   the writer selects is stored if it is above every floor computed from the current weight.
5. Choose `PHASE12_MIN_CLIENT_BUILD` at release (the first build that contains slice 2).
6. Pre-existing gaps, not added by Phase 12: the closed-gate health context (`route.ts:89-94`,
   `coach-turn.ts:504`); the Settings `ExportCard` partial CSV (`components/ExportCard.tsx:58`).
7. Choose which "Later" items come next.

## Resolution of audit round 1

Audit: `docs/audit/specs/2026-09-22-phase-12-r1-gpt6-sol.md` (12 BLOCK, 5 FIX). All 17 held; none
rejected. Rows marked *superseded* were replaced by round 2 scope cuts.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Confirm policy for every kind, fails closed (§1); `log_weight` now confirm (round 2) | `actions.ts:126-137`; `apply-body.ts:59-90` |
| 2 | BLOCK | Server-held proposal queue (§1) | `coach-turn.ts:611-614`; `coach-threads.ts:28-36` |
| 3 | BLOCK | `apply_plan_op` CAS, expiry, `stale` (§4) | revision 1 had no apply-time check |
| 4 | BLOCK | Sync-first Confirm/Undo; precedence corrected in round 2 (§4) | `plan-days.ts:58-61`; `outbox.ts:182-190` |
| 5 | BLOCK | *Superseded:* `edit_entry` moved to Later (Later 1) | `merge.ts:95-105` |
| 6 | BLOCK | Shared usage counter; server vs device statuses (§1) | Phase 9 §1.3 |
| 7 | BLOCK | Fetcher pins vetted IP, manual redirects (§6) | revision 1 checked DNS only |
| 8 | BLOCK | Research turns cannot write or remember; fenced history; deterministic rule (§6) | Phase 11 `remember` |
| 9 | BLOCK | *Superseded:* plateau moved to Later with the fix noted (Later 4) | `single_pending_proposal.sql:17-22` |
| 10 | BLOCK | *Superseded:* plateau math constraints recorded (Later 4) | `proposal.ts:21-23`, `:62-75` |
| 11 | BLOCK | *Superseded:* sleep nudge moved to Later (Later 5) | `apply-slot.ts:20-40` |
| 12 | BLOCK | Jev `null` → no claims (§6) | `typesafe.ts:240-280` |
| 13 | FIX | 34 s research budget (§6) | `fetch-with-deadline.ts:25-31` |
| 14 | FIX | Migration table (§11) | — |
| 15 | FIX | *Superseded:* re-engagement moved to Later (Later 6) | — |
| 16 | FIX | *Superseded:* no cron in this phase | — |
| 17 | FIX | *Superseded:* number check moved to Later (Later 3; §8) | — |

## Resolution of audit round 2

Audit: `docs/audit/specs/2026-09-22-phase-12-r2-gpt6-sol.md` (10 BLOCK, 5 FIX). Each finding was
checked against the code; all 15 hold. None rejected. Seven are resolved by moving the tool or
behavior to "Later".

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Precedence defined: later real-time write wins field by field (existing rule); r1 claim removed; sequence test added (§4) | `merge.ts:26-32`, `:118-126` |
| 2 | BLOCK | `log_weight` from the coach needs Confirm (§1 table) | `apply-body.ts:59-90` |
| 3 | BLOCK | Sleep nudge cut to Later; must be informational or one paired atomic action (Later 5) | `apply-slot.ts:20-40` |
| 4 | BLOCK | `edit_entry` cut to Later with the id, revision and outbox needs listed (Later 1) | `day-context.ts:250-262` |
| 5 | BLOCK | Entry replace cut with `edit_entry` (Later 1) | `delete-entry.ts:34`; `log-commit-client.ts:140` |
| 6 | BLOCK | `edit_recipe` cut to Later; undo as a conditional new revision; ids needed (Later 2) | `recipes-client.ts:48`; `coach-context.ts:165-175` |
| 7 | BLOCK | Source snapshot persisted in `tool_calls.sources`, restored by `toMessageView`, replay and reload tests (§6) | `message-view.ts:49-60`; `rls.sql:55-58` |
| 8 | BLOCK | Evidence rule: tier 1, or two tier 2 on different domains, plus attribution ≥ 0.85; else not stated (§6) | revision 2 allowed tier 3 claims |
| 9 | BLOCK | Plateau cut to Later; lock-before-read requirement recorded (Later 4) | `approve_proposal_via_revision.sql:25`; `target_revision_transactions.sql:19` |
| 10 | BLOCK | Deterministic rule: research in history → every write needs Confirm; no Jev dependency (§6) | `verify.ts:14-17`, `:55` |
| 11 | FIX | Re-engagement cut to Later; atomic stamp + event requirement recorded (Later 6) | revision 2 §9.4 |
| 12 | FIX | Protein lock enforced in the confirm policy and the server target write for every coach path (§1) | `apply-profile.ts:146-178`; `body_profile.sql:129-137` |
| 13 | FIX | Composed-card origin in the audit log, device-minted id tied to an owned message, own label (§1) | `CoachComposedCard.tsx:41-49`; `chat-state.ts:180-188` |
| 14 | FIX | Plateau cut; the fixture error and the `clampFactor` export need recorded (Later 4) | `proposal.ts:71` |
| 15 | FIX | 4-week plan scoped to a user request in this phase; automatic trigger in Later 7 (§4) | revision 2 §9.1 |

## Resolution of audit round 3

Audit: `docs/audit/specs/2026-09-22-phase-12-r3-gpt6-sol.md` (9 BLOCK, 4 FIX), the last allowed spec
round. Each finding was checked against the code; all 13 hold. None rejected. Where a finding needed
new machinery, the run cut or deferred the tool instead. No audit re-checked these changes; see "Next
audit".

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Server-set `requiresConfirm` in the persisted and replay schemas, missing = true; turn and restore start such actions in `needs_confirm`; retry and reload tests (§1) | `actions.ts:498-501`; `chat-state.ts:113-120` |
| 2 | BLOCK | `plan_range` carries no meal content; planned meals over a range to Later 7 (§2) | `ground.ts:131-133`; `apply-slot.ts:60-70` |
| 3 | BLOCK | Server write checks final kcal, protein, fat and carbohydrate grams per day against active floors; new floors are the stricter of active and derived (§1 Target safety) | `lib/types.ts:276-281`; `lib/profile/derive.ts:125-131` |
| 4 | BLOCK | Survival claim removed; whole-row precedence stated and tested; sync-first and edited-date listing kept; field-level intent to Later 8; open for Devin (§4) | `plan-day-client.ts:105-112`; `merge.ts:26-32`; `outbox.ts:182-190` |
| 5 | BLOCK | Apply and undo RPCs take the sync writer's per-date advisory locks in date order before any check; empty-date race test (§4) | `phase3_sync_entities.sql:425-437` |
| 6 | BLOCK | 4-week plan cut to Later 7 (Scope, §4) | `plan_range` 1/turn; one meal per op |
| 7 | BLOCK | While a research message is in the history window, all `remember` candidates are dropped and the summary is frozen; eval covers three turns (§6) | Phase 11 memory judge has no provenance check |
| 8 | BLOCK | No stored files: exports generated per tap on the user's session; no bucket, table or signer; new tables select-only (§5, §7) | `rls.sql:15-19` |
| 9 | BLOCK | `set_slot_meal` limited to 7 dates, apply with undo; multi-date transactional write to Later 7 (§1 table) | `apply-slot.ts:60-70` |
| 10 | FIX | `storedTurn` builds replayed messages through `toMessageView`, returning `sources` and `requiresConfirm`; retry test (§6) | `coach-threads.ts:66-76` |
| 11 | FIX | No stored files, so no sweep; the stored-file sweep need is recorded in Later 9 | `media-sweep/route.ts:24`, `:43` |
| 12 | FIX | Lock defined as protecting the explicit protein pin; rederived protein shown on the confirm card; tests for both (§1) | `lib/profile/energy.ts:125-128` |
| 13 | FIX | `create_file` and `show_file` removed; `show_export` is a read-only block with no id to complete; stored files in Later 9 (§2, §5) | revision 3 §2 |

Note on rounds 1–3: rows that name the confirm card, `plan_ops`, target checks or the audit log are
superseded by revision 5, which removes those parts (see "Later").

## Resolution of audit round 4

Audit: `docs/audit/specs/2026-09-22-phase-12-r4-gpt6-sol.md` (9 BLOCK, 2 FIX). Each finding was
checked against the code; all 11 hold. None rejected. Per Devin's instruction, the run cut tools
instead of adding machinery.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Server refuses `set_slot_meal` when any grounded item is blocked, right before the response (§3) | `ground.ts:131-133`; `apply-slot.ts:60-70` |
| 2 | BLOCK | `set_slot_meal` limited to one date: one write, no partial apply (§3) | `apply-slot.ts:60-70` |
| 3 | BLOCK | Coach target writes removed (`set_targets`, `update_profile`, `log_weight`); database-writer enforcement moved to Later 1 (§1) | `target_revision_transactions.sql:14`; `target_authority.sql:85` |
| 4 | BLOCK | No floor carry-over ships; weight-derived protein floor rule recorded in Later 1 (§1) | `energy.ts:125-128`; `derive.ts:125-131` |
| 5 | BLOCK | No `requiresConfirm` flag ships (no confirm-needing action remains); server-only persistence recorded in Later 1 (§2) | `rls.sql:55-64`; migration `20261103090100` keeps a `for all` policy |
| 6 | BLOCK | `update_setting` offered only to builds ≥ `PHASE12_MIN_CLIENT_BUILD` for every account; its actions dropped for older builds (§2) | `chat-state.ts:113-120`; `apply-client.ts:87-104` |
| 7 | BLOCK | Restore of confirm state not needed (no confirm ships); requirement recorded in Later 1 | `CoachShell.tsx:150-165`; `chat-state.ts:150-158` |
| 8 | BLOCK | Research turns return no actions (including `remember_fact`); research messages excluded from later history; `remember_fact` route refuses research messages (§6) | Phase 11 §2 `remember_fact`; `history.ts:8`, `:32` | *(Phase 11 later replaced `remember_fact` with the `propose_memory` draft; see round 6.)*
| 9 | BLOCK | `plan_range` cut; safest rule recorded (refuse while any device has unsynced edits to those dates, or field-level intent) (Later 2) | `plan-day-client.ts:105-112`; `outbox.ts:182-190` |
| 10 | FIX | `plan_range` cut; op-id binding recorded in Later 2 | revision 4 §4 |
| 11 | FIX | No migration ships; release order names `20261103090000`/`090100`, Phase 9 `20261104`–`20261107`, Phase 10, Phase 11; any new one starts at `20261120090000` (§10) | Phase 9 plan README |

## Resolution of audit round 5

Audit: `docs/audit/specs/2026-09-22-phase-12-r5-gpt6-sol.md` (3 BLOCK, 4 FIX). Each finding was
checked against the code; all 7 hold. None rejected. The run cut tools before it added machinery.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | `storedTurn` returns actions only through a replay allowlist; retired kinds dropped from POST replay, kept for display in thread history; retry-after-upgrade test (§1) | `coach-turn.ts:233-235`; `coach-threads.ts:77`; `chat-state.ts:113-120` |
| 2 | BLOCK | Coach `set_slot_meal` retired; apply-time recheck requirement recorded (§1, Later 3) | `coach-turn.ts:263`; `apply-slot.ts:54-70` |
| 3 | BLOCK | Research tools exist only with the health gate open; no query scrubbing claimed; pre-existing ordinary-turn gap listed for Devin (§5, Open for Devin 3) | `route.ts:48-56`, `:89-94`; `coach-turn.ts:504`; `deflect.ts:16` |
| 4 | FIX | Research reply rendered only from checked claims plus fixed copy; model `text` discarded; test (§5) | `coach-turn.ts:758`; `reply-check.ts:63` |
| 5 | FIX | `get_calendar`, grocery and ICS exports cut (Later 2, 11); CSV export card warns when this phone's outbox is not empty and offers Sync now (§3, §4) | `plan-day-client.ts:127`; `lib/coach/types.ts:29` |
| 6 | FIX | Complete file or none: a response with the truncation notice is refused with "choose a shorter range"; full-range assembly in Later 12 (§4) | `export/route.ts:27`, `:75-80` |
| 7 | FIX | Print route removed; the file is fetched under the account header and printed from the share sheet; print view in Later 11 (§4) | revision 5 §5 |

## Resolution of audit round 6

Audit: `docs/audit/specs/2026-09-22-phase-12-r6-gpt6-sol.md` (2 BLOCK, 3 FIX). Each finding was
checked against the code; all 5 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Research turns hold only read tools and `show_source`; every draft and propose tool (incl. `propose_memory`, `draft_log_entry`) refused; no draft, composed card or `log_draft` in the response; memory save refuses a research-origin draft; tests (§5) | `coach-turn.ts:735-755`; Phase 11 `propose_memory` |
| 2 | BLOCK | Allowlist cut to `weightUnit`, `heightUnit`, which `syncProfileSettings` queues; writer and Undo specified; `slotTimes`, `shiftMinutes`, `displayName` to Later 13; apply/sync/second-device/Undo tests (§2) | `apply-profile.ts:27-48`; `user-settings.ts:97-119` |
| 3 | FIX | Coach request gains `pendingPlanDates`; `get_plan` and today's context label those dates as unsynced (§3) | `coach-ports.ts:245-249`; `types.ts:29-40`; `plan-day-client.ts:103-141` |
| 4 | FIX | Tenancy lists the existing admin-client ports, requires session-closure `userId` filtering and cross-user tests for each (§6) | `coach-ports.ts:28-253`; `day-context.ts:176-185` |
| 5 | FIX | The limit is 5,000 log entries; tests for >5,000 entries (refused) and >5,000 item rows in a complete export (§4, §7) | `export.ts:175-205` |

## Resolution of audit round 7

Audit: `docs/audit/specs/2026-09-22-phase-12-r7-gpt6-sol.md` (4 BLOCK, 1 FIX). Each finding was
checked against the code; all 5 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | `add_slot_item`, `remove_slot_item`, `set_slot_item` also retired (new and replay); composed cards sent with no target slot, so "Put it in …" never shows on any build; Later 3 extended (§1) | `actions.ts:53-59`; `apply-slot.ts:20-40`; `CoachComposedCard.tsx:45-69` |
| 2 | BLOCK | Unit writer no longer uses `syncProfileSettings`; `applyUnitSetting` queues one key from the current mirror through `mutateUserSettings`; key-only Undo; stale-phone test (§2) | `apply-profile.ts:32-48`; `settings-intents.ts:145-155`; `outbox.ts:103` |
| 3 | BLOCK | Route `MAX_LIMIT` lowered to 999 so `limit + 1` fits `max_rows = 1000`; constant and unit test; hosted cap confirmed in the plan; PostgREST tests above 1,000 rows (§4) | `config.toml:10`; `export.ts:165-205`, `:230-236`; `export/route.ts:27` |
| 4 | BLOCK | Research is a user-picked mode decided before any model step; no research tools in the model registry; a fixed pipeline renders only checked claims or the fixed abstention, even with no sources (§5) | `coach-turn.ts:611-614`; `reply-check.ts:63` |
| 5 | FIX | `pendingPlanOverflow` flag labels every read as unsynced when more than 31 dates are pending (§3) | `coach-ports.ts:245-249` |

## Resolution of audit round 8

Audit: `docs/audit/specs/2026-09-22-phase-12-r8-gpt6-sol.md` (3 BLOCK, 1 FIX). Each finding was
checked against the code; all 4 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Client `RETIRED_ACTION_KINDS`: apply returns `failed`, no Retry on turn, restore or retry, and no "Put it in …" on any card, historical or cached; upgrade test (§1) | `CoachShell.tsx:110-115`; `chat-state.ts:150-158`, `:174-178`; `apply-client.ts:87-103`; `threads/[id]/route.ts:41-48` |
| 2 | BLOCK | Both messages of a research turn carry `provenance = "research"`; the history reader and Phase 11 recall skip them; recall test (§5) | `coach-threads.ts:120-130`; Phase 11 `recall_conversations` |
| 3 | BLOCK | Progress export cut to Later 14; `show_export` is meals only (§4) | `export.ts:333-345`, `:265-283`; `codes.ts:7-11` |
| 4 | FIX | Name and catalog lookups chunked at 200 ids; a missing name fails the export instead of writing "(unknown food)"; test above 1,000 distinct refs (§4) | `export.ts:135-140`, `:183-196` |

Note on rounds 1–8: rows that describe research, exports, `get_plan` labels or confirm cards are
superseded by revision 10, which moves those parts to "Later".

## Resolution of audit round 9

Audit: `docs/audit/specs/2026-09-22-phase-12-r9-gpt6-sol.md` (4 BLOCK, 2 FIX). Each finding was
checked against the code; all 6 hold. None rejected. Decision (run, Devin accepted cuts): web
research and exports move to "Later".

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Server gate: the `x-smc-client` 426 check covers every account (manual included) on `/api/targets`, `/api/health/weigh-in`, `/api/sync/ops`, `/api/coach`; switched on only after the release gate (§1, Open for Devin 1) | `apply-profile.ts:66`; `lib/targets/client.ts:102`; `lib/health/weigh-in-client.ts:48`; `lib/sync/client.ts:199`; Phase 9 manual exemption |
| 2 | BLOCK | Web research moved to Later 13; title-leak lesson recorded | `coach-threads.ts:159`; Phase 11 recall searches titles |
| 3 | BLOCK | Web research moved to Later 13; server-owned provenance lesson recorded | `rls.sql:55-64` |
| 4 | BLOCK | Exports moved to Later 11; `ExportCard` untouched; its pre-existing partial-file gap listed for Devin | `ExportCard.tsx:58`; `export/route.ts:27`, `:80`; `config.toml:10` |
| 5 | FIX | Dependency on Phase 11's `propose_memory` removed; the memory provenance rule kept in the research lessons | Phase 11 moves account memory to Later |
| 6 | FIX | Web research moved to Later 13; filter-before-limit lesson recorded | `coach-threads.ts:120-130` |

## Resolution of audit round 10

Audit: `docs/audit/specs/2026-09-22-phase-12-r10-gpt6-sol.md` (4 BLOCK, 3 FIX). Each finding was
checked against the code; all 7 hold. None rejected. One requested mechanism was changed, with
evidence (row 1).

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Queues stamp `queuedBuild`; pre-upgrade entries wait for the user's Send or Discard before any automatic sync. Server refusal "by kind" is not possible: coach and manual writes send the same payload to the same routes, and a pre-upgrade record has no origin (§1) | `outbox.ts:363`; `weigh-in-client.ts:245`; `targets/client.ts:101-106`, `:202`; `apply-profile.ts:66-90` |
| 2 | BLOCK | Retired kinds show no Undo; `undoCoachAction` refuses with a clear message; test with a cached applied action (§1) | `coach-client.ts:25`; `CoachActionCard.tsx:192`; `apply-client.ts:160-176` |
| 3 | BLOCK | The toolbar Weigh in field saves directly through `saveMorningWeight`, sends no chat message, and is the named destination; Preview test (§1) | `WeighInField.tsx:17-31`; `ComposerToolbar.tsx:59-61`; `water-and-weight.ts:228`; `app/settings/page.tsx:65` |
| 4 | BLOCK | `log_weight` removed from `MECHANICAL_INTENTS` and the fast-path builder; retired-kind drop on the fast-path candidate; test (§1) | `intent.ts:16`; `coach-turn.ts:148-158`, `:437` |
| 5 | FIX | A replay that removes an action returns a fixed "not made" line instead of the stored text; test (§1) | `coach-threads.ts:75`; `prompt.ts:233` |
| 6 | FIX | Every retired-write instruction and example removed or rewritten; eval for retired-change claims (§1) | `prompt.ts:107`, `:162-163`, `:192`, `:229-234` |
| 7 | FIX | `update_setting` gets a `runApply` case, Undo token and case, card copy and a history line; follow-up-turn test (§2) | `apply-client.ts:87-104`; `CoachActionCard.tsx:50-58`; `history.ts:51-60` |

Note on rounds 1–10: rows that describe retired actions, the 426 gate for manual accounts, queue
stamps, the direct Weigh in save, research or exports are superseded by revision 12 (see "Later").

## Resolution of audit round 11

Audit: `docs/audit/specs/2026-09-22-phase-12-r11-gpt6-sol.md` (3 BLOCK, 2 FIX). Each finding was
checked against the code; all 5 hold. None rejected. Decision (run, Devin accepted cuts): drop the
retirement of the seven coach actions; they stay as on `main`. Phase 12 now ships server-side calorie
and fat floors on `/api/targets` and unit settings from chat.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Retirement dropped: no queue quarantine, so no dependent-write leak; lesson in Later 2 | `plan-day-client.ts:104`; `settings-intents.ts:275` |
| 2 | BLOCK | Retirement dropped: no Discard, so no optimistic effects to undo; lesson in Later 2 | `water-and-weight.ts:169`, `:238`; `plan-day-client.ts:127` |
| 3 | BLOCK | Retirement dropped: no retired-write claims to check; the target write itself is refused below a floor, so a target below a floor cannot be stored whatever the reply says; lesson in Later 2 | `verify.ts:14`; `reply-check.ts:63` |
| 4 | FIX | The direct Weigh in save is dropped with the retirement (the Weigh in field keeps sending a chat message, as on `main`), so no kg/lb conversion is added | `WeighInField.tsx:6`, `:29`; `weigh-in/route.ts:60` |
| 5 | FIX | Phase 12 defines its own `enforceSharedRateLimit` call: 30 accepted proposals a day, counted on accept only, never on refusal or replay (§2) | Phase 9 §1.3 uses the limiter only for invites |

## Resolution of audit round 12

Audit: `docs/audit/specs/2026-09-22-phase-12-r12-gpt6-sol.md` (4 BLOCK, 2 FIX). Each finding was
checked against the code and PR #241's branch; all 6 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | PR #241 is a hard prerequisite; the floor is its `macroMinimumKcal` through the revision floors; Phase 12 defines no floor constants; examples use the macro minimum (§1) | branch `lib/profile/rate-goal.ts:37`, `energy.ts:179-180`, `derive.ts:124-130`; TDEE plan `:57` |
| 2 | BLOCK | Check floors are computed from the stored `user_settings` row and server weigh-ins; a same-request profile change can only raise them (stricter of both); forged-profile test (§1) | `app/api/targets/route.ts:32-44`, `:73`; `derive.ts:129` |
| 3 | BLOCK | `authorTargets` (grams and percent) refuses a below-floor request instead of raising it; table of all four write branches (§1) | `targets.ts:232-260`; `use-settings-controller.ts:224-229` |
| 4 | BLOCK | Weigh-in returns `partial: "targets_refused"` with the server message, keeps the weight and its Undo, never queues; a queued entry refused on drain is removed and announced once (§1) | `water-and-weight.ts:257-279`; `apply-body.ts:83-86`; `targets/client.ts:176-202` |
| 5 | FIX | Per-turn cap enforced by the executor's turn-local count; the daily counter charged at the final step only for kept actions; tests (§2) | `coach-turn.ts:668`; `prompt.ts:266` |
| 6 | FIX | New `TargetBelowFloorError` with an explicit signature and route payload; existing `FloorViolationError` unchanged; typed client error (§1) | `targets.ts:23-29`; `lib/server/http.ts:16-17` |

## Resolution of audit round 13

Audit: `docs/audit/specs/2026-09-22-phase-12-r13-gpt6-sol.md` (3 BLOCK, 2 FIX). Each finding was
checked against the code; all 5 hold. None rejected. One requested detail was changed, with the
reason (row 1).

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The check is in the target-write transaction (migration `20261120090000`); the checked floor is the stored floor; the floor comes only from stored inputs, also for the authored path and restore. The floor **value** is computed in TypeScript with `macroMinimumKcal` and verified in the database by a profile-version check, not recomputed in SQL, so there is one floor implementation (§1) | branch `derive.ts:124-130`, `targets.ts:116-120`, `:238-242` |
| 2 | BLOCK | The writer locks the `user_settings` row `for update` and refuses on a changed `rev` or weigh-in (`stale_profile`); writers are service-role only, so no phone supplies a floor (§1) | `target_revision_transactions.sql:3`, `:19`, `:71`; `phase3_sync_entities.sql:436` |
| 3 | BLOCK | A refused weigh-in target returns `previousTargetRevisionId: null`; Undo reverts only the weight; test with a prior revision below the floor (§1) | `apply-body.ts:77-84`, `:89-132` |
| 4 | FIX | Minimal consumer: account-bound stored notice, a `meal-companion:target-notice` event, and a `TargetNotice` line on Today that clears after dismissal (§1) | `outbox.ts:65-68`; `SyncBootstrap.tsx:72-83` |
| 5 | FIX | When `update_setting` is dropped for an older build, the message content becomes a neutral line in new turns, replay and thread history; old-build test (§2) | `coach-threads.ts:73-85`; `threads/[id]/route.ts:41-49` |

## Resolution of audit round 14

Audit: `docs/audit/specs/2026-09-22-phase-12-r14-gpt6-sol.md` (5 BLOCK). Each finding was checked
against the code; all 5 hold. None rejected. The fix closes write paths in the one Phase 12 migration.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The check floor is the stricter of the stored-input floor and the request floor, so a target written before its profile op syncs is still checked against the new profile; offline ordering stated (§1, part 4) | `apply-profile.ts:135-142`; `use-settings-controller.ts:53-75`; `lib/sync/settings.ts:49-70` |
| 2 | BLOCK | Revoke `insert, update, delete` on `target_profiles`, `user_settings`, `health_samples` from `authenticated`; the writer compares the stored input **values**, not `rev` (§1, parts 1 and 3) | `rls.sql:8-22` |
| 3 | BLOCK | Old signatures `write_target_revision(uuid, jsonb)` and `write_target_revision_pair(uuid, jsonb, jsonb)` are dropped; new checked writers are service-role only; direct-call tests (§1, part 1) | `target_revision_transactions.sql:3`, `:71-87` |
| 4 | BLOCK | Approval recomputes the floor from current stored inputs in the decide route and checks it through the same writer; changed-weight test (§1, part 5) | `approve_proposal_via_revision.sql:25-30`, `:60-70` |
| 5 | BLOCK | Every writer of targets, `user_settings` and body-mass samples takes the per-user lock first (`apply_sync_op` for settings, `health_weigh_in`, `health_ingest_apply`, a new `health_weigh_in_delete` RPC); if the inventory finds one that cannot, the smallest safe cut is listed as Open BLOCK 1b (§1, part 2) | `manual_weigh_in.sql:40`, `:96-104`; `phase5_health_ingest.sql:69`, `:103-115`; `weigh-in/route.ts:87` |

## Resolution of audit round 15

Audit: `docs/audit/specs/2026-09-22-phase-12-r15-gpt6-sol.md` (3 BLOCK). Each finding was checked
against the code; all 3 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The writer requires a stored profile (`profile_required` otherwise); a new account's first profile and target are written together by Phase 10's `complete_onboarding` in one transaction through the checked writer; Phase 12 depends on Phase 10; lock order aligned with `complete_onboarding` (settings lock, then per-user lock) (§1 parts 2–3) | `onboarding-client.ts:82-92`; Phase 10 "The stage-9 build" step 1 |
| 2 | BLOCK | Expand (M-a) and contract (M-b) migrations with a runbook: new functions beside the old, server switch and verification, contract only after 24 h of no old-writer calls and 7 days with no old client build, rollback steps (§1 runbook, §6) | `targets.ts:89`, `:154`; `proposals.ts:61` |
| 3 | BLOCK | The predecessor (sent only when there is no active revision) is checked against the stored-profile floor, not the stricter new floor; if it fails, it is dropped and Undo restores the profile only, with a clear card line; test (§1 part 3) | `apply-profile.ts:95`; `targets.ts:145` |

## Resolution of audit round 16

Audit: `docs/audit/specs/2026-09-22-phase-12-r16-gpt6-sol.md` (3 BLOCK). Each finding was checked
against the code and Phase 10; all 3 hold. None rejected. Decisions from the coordinator (Devin
accepted the run's choices).

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The expand window is stated as the accepted, pre-existing `main` state (no new path, no new risk), time-boxed by a `client_builds` check query; the contract trigger is in Open for Devin 1a; tests for the M-a and M-b states (§1 runbook) | `target_revision_transactions.sql:14`, `:28`; `rls.sql:17` |
| 2 | BLOCK | M-a replaces Phase 10's `complete_onboarding` so step 8 calls the checked writer with the snapshot read after step 7; order with Phase 10 stated; the Phase 10 line to change is listed in Open for Devin 1c; new-account test after M-b (§1 runbook) | Phase 10 "The stage-9 build" steps 7–8 |
| 3 | BLOCK | The revision Undo would restore (active prior or client predecessor) is checked against the **new** floor at write time; below it, no predecessor is written and Undo is unavailable with a clear message; tests for both cases (§1 part 3) | `apply-profile.ts:95`, `:180`; `targets.ts:145` |

## Resolution of audit round 17

Audit: `docs/audit/specs/2026-09-22-phase-12-r17-gpt6-sol.md` (2 BLOCK, 2 FIX). Each finding was
checked against the code and Phase 9/10; all 4 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The writer computes the floor itself in the database (`account_floor`) from the locked current profile and latest weigh-in; callers can only raise it; onboarding returns `build_stale` when a new weigh-in raises the floor, and the chat rebuilds; parity test against PR #241's TypeScript; Phase 10 change in Open for Devin 1c (§1 part 3) | Phase 10 steps 7–8; branch `rate-goal.ts:37` |
| 2 | BLOCK | The write returns `restoreRevisionId` and `writtenRevisionId`; the Undo token stores those; restore refuses when the active revision changed or the restore target is below the floor; two-device test (§1 part 3) | `apply-profile.ts:66-86`, `:180-189` |
| 3 | FIX | Headerless or invalid-header requests are recorded as build `0`, which the M-b query counts (§1 runbook) | Phase 9 manual-account header rule |
| 4 | FIX | No `stale_profile` refusal exists any more; the drain retries only network errors and 5xx and removes any 4xx entry with the Today notice (§1) | `water-and-weight.ts:257-267`; `targets/client.ts:190-218` |

## Resolution of audit round 18

Audit: `docs/audit/specs/2026-09-22-phase-12-r18-gpt6-sol.md` (4 BLOCK, 1 FIX). Each finding was
checked against the code; all 5 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Explicit `revoke all on function … from public, anon, authenticated` for the internal writer and floor helpers (no grant) and for the service-role functions (then `grant execute … to service_role`); direct-call tests (§1 runbook) | `20260911000600_rpc.sql:19` |
| 2 | BLOCK | `account_body_mass_kg` ports the weight selection: device over manual per day, last of the day, unit converted to kg, effective-date cutoff, profile weight fallback; parity fixtures for a future-dated sample and a legacy `lb` row (§1 part 3) | `water-and-weight.ts:146-165`; `daily.ts:160-176`; `energy.ts:187-192` |
| 3 | BLOCK | The drain removes only on definitive typed refusals (`422 below_floor`, `409 profile_required`, `409 undo_unavailable`, `409 conflict`); `401`, `426`, `429`, `5xx`, network and other statuses stay queued; recovery tests (§1) | `water-and-weight.ts:257`; Phase 9 manual-account rule |
| 4 | BLOCK | Weigh-in Undo uses the server-returned revision pair; target restore runs first and the weight is reverted only if it succeeds; no partial undo; second-device test (§1) | `water-and-weight.ts:248`; `apply-body.ts:89-132` |
| 5 | FIX | M-a's inventory lists `account_body_mass_kg`, `account_floor` and `get_account_floor` with privileges and down-file handling (§1 runbook) | revision 18 §1 part 3 |

## Resolution of audit round 19

Audit: `docs/audit/specs/2026-09-22-phase-12-r19-gpt6-sol.md` (2 BLOCK). Each finding was checked
against the code and Phase 10; both hold. None rejected. Coordinator decisions applied, plus one
addition (the protein floor).

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Release order fixed: M-a (`20261108090000`) ships before Phase 10 (`20261110…`); Phase 10's `complete_onboarding` calls the checked writer directly and its migration asserts the writer exists; M-a no longer replaces it; Phase 10 lines in Open for Devin 1c (§1 runbook, §6) | Phase 10 spec step 8; revision 19 order |
| 2 | BLOCK | Weigh-in Undo is one database function, `undo_weigh_in_retarget`, that reverts the weight and restores the target in one transaction under locks 2 and 3; online only; failure test (§1) | `weigh-in-client.ts:245`; `water-and-weight.ts:285` |
| — | addition | The checked writer also enforces a protein floor: PR #241's rule (protein basis × 2.0 for lose/recomp, else 1.8), stored as `protein_g_min`; in the parity tests; manual protein pins below it are refused (Open for Devin 2) | branch `energy.ts:177-178`, `rate-goal.ts:33`; TDEE plan `:54` |

## Resolution of audit round 20

Audit: `docs/audit/specs/2026-09-22-phase-12-r20-gpt6-sol.md` (4 BLOCK, 1 FIX). Each finding was
checked against the code and Phase 10; all 5 hold. None rejected. §1 was rewritten as one section
(1.1–1.9) so the rules no longer depend on earlier revisions' text.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | M-a `20261108090000` (before any Phase 10 migration, `20261110…` or `20261122…`), M-b `20261130090000` (after all Phase 10 and Phase 11 migrations), applied only after the readiness query; Phase 10 lines in Open for Devin 1c (§1.8, §6) | Phase 10 facts section; Phase 10 revision 19 table |
| 2 | BLOCK | No floor or raise flag from any request; `account_floor` computes kcal, fat and protein minima from the locked row every time; online profile changes use `profile_and_targets` (one transaction, refused as a whole if the target is below the new floor); queued settings ops that would leave the active targets below the new floor are parked with a notice (§1.1, §1.4) | `apply-profile.ts:125-142`; `use-settings-controller.ts:53-75` |
| 3 | BLOCK | `weigh_in_and_retarget` writes the weigh-in and then the target in one transaction; offline, weigh-in and retarget are one queue entry (§1.5) | `weigh-in-client.ts:243-250`; `water-and-weight.ts:241`, `:257` |
| 4 | BLOCK | The forward call returns the prior and written samples (id, value, unit, `received_at`); Undo refuses if the written sample moved or the active revision changed, puts the prior sample back exactly, all in one transaction; tests (§1.5) | `apply-body.ts:67`; `20260911000400_privileged.sql:17-22` |
| 5 | FIX | `TargetBelowFloorError` covers `"protein"` with its message; `get_account_floor` returns all three minima; client and Settings handle the protein field (§1.6) | revision 20 §1 |

Note on rounds 12–20: rows that describe `stale_profile`, `p_inputs`, `p_raise_floor`,
`profile_and_targets`, `weigh_in_and_retarget`, `undo_weigh_in_retarget`, `client_builds`, the
contract migration or the Today notice are superseded by revision 22 (see Later 1).

## Resolution of audit round 21

Audit: `docs/audit/specs/2026-09-22-phase-12-r21-gpt6-sol.md` (6 BLOCK, 2 FIX). Each finding was
checked; all 8 hold. None rejected. Decision (coordinator; Devin accepted cuts): strip Phase 12 to the
checked writer and units from chat. Every finding is resolved by removing the part it concerns; the
lessons are in Later 1.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | One exact signature, `write_target_revision_checked(p_user_id uuid, p_row jsonb, p_predecessor jsonb default null) returns jsonb`; Phase 10 calls it; no raise flag (§1.1, Open for Devin 2) | Phase 12 r21 `:103`; Phase 10 step 8 |
| 2 | BLOCK | Undo RPC removed; Undo stays as on `main`, and a restore below the floor is refused by the writer (§1.4, Later 1) | r21 §1.5 |
| 3 | BLOCK | Combined weigh-in RPC removed; weigh-in stays as on `main` (Later 1) | `weigh-in-client.ts:194` |
| 4 | BLOCK | No queue changes except removing a `below_floor` target entry; the split queues stay as on `main` (§1.5, Later 1) | r21 §1.5 |
| 5 | BLOCK | Direct profile RPC removed; profile changes stay on the outbox as on `main` (Later 1) | r21 §1.4 |
| 6 | BLOCK | Undo stays as on `main`; the only change is that its restore goes through the checked writer (§1.4) | r21 §1.7 |
| 7 | FIX | Prior-sample snapshot removed with the Undo RPC (Later 1) | r21 §1.5 |
| 8 | FIX | Health-driven warning removed (Later 1) | r21 §1.4 |

## Resolution of audit round 22

Audit: `docs/audit/specs/2026-09-22-phase-12-r22-gpt6-sol.md` (3 BLOCK, 1 FIX). Each finding was
checked against the code; all 4 hold. None rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | Return shape quoted exactly: a raw `target_profiles` row (`to_jsonb(v_profile)`, or the stored `change_log.current` on replay) without a predecessor; `jsonb_build_object('predecessor', …, 'revision', …)` with one (§1.1) | `target_revision_transactions.sql:21`, `:66`, `:80` |
| 2 | BLOCK | The `request_id` lookup runs right after the locks and before the profile and floor checks, returning the stored result (§1.2 step 2) | `target_revision_transactions.sql:18-22` |
| 3 | BLOCK | The model's final actions go first and are never dropped; unit proposals fill the rest of the 3-action cap; a dropped proposal is not charged and the reply names it (§2) | `lib/coach/turn.ts:98` |
| 4 | FIX | `SF001` (`below_floor`, JSON `detail`) and `SF002` (`profile_required`) map in `mapTargetWriteError` to `TargetBelowFloorError` and a 409; malformed detail → logged 500 (§1.2, §1.5) | revision 22 §1.5 |

## Resolution of audit round 23

Audit: `docs/audit/specs/2026-09-22-phase-12-r23-gpt6-sol.md` (3 BLOCK, 2 FIX), plus one requirement
from Phase 10 round 22. Each finding was checked against the code and PR #241's branch; all hold. None
rejected.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The migration ships before Phase 10's; the `/api/targets` switch ships in the same release as Phase 10, whose form calls `complete_onboarding`; old-form builds of invited accounts are stopped by Phase 9's 426 (§1.4, slices, Open for Devin 1) | `onboarding-client.ts:78-92` |
| 2 | BLOCK | `authorTargets` drops `floorsFor`, `validatePercentProfile`, `applyFloors` and the raise; the checked writer answers 422 (§1.4 table) | `targets.ts:235-256` |
| 3 | BLOCK | When any unit proposal is dropped, the reply text is replaced by "I couldn't do all of that — ask me again for the rest." and the memory summary is not updated (§2) | `coach-turn.ts:648` |
| 4 | FIX | The writer sets `kcal_min_source = 'macro_minimum'` (§1.2 step 6) | branch `20261029090000_rate_goals.sql:68-98`, `lib/targets/revision.ts:56-62` |
| 5 | FIX | `applyUnitSetting` and its Undo dispatch `meal-companion:settings-changed`; `CoachChat` re-reads the unit (§2) | `CoachChat.tsx:159`; `ComposerToolbar.tsx:64` |
| P10 r22 | requirement | The writer compares `p_row`'s `input_weight_kg` and new `input_weight_sample_id` with the weight it selects under lock and raises `build_stale` (`SF003` → 409) on a difference; the client re-derives and retries once (§1.2 step 4, §1.5) | `lib/server/targets.ts:68-69` |

## Resolution of audit round 24

Audit: `docs/audit/specs/2026-09-22-phase-12-r24-gpt6-sol.md` (3 BLOCK). Each finding was checked
against the code and Phase 10; all 3 hold. None rejected. The coordinator's shared decisions (a)–(d)
apply to both specs.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The writer recomputes each day's kcal from the grams with the Atwater factors of `macroKcal` (4/4/9), stores it, and checks the floors against it; a sent kcal is never trusted; parity test (§1.4 table; decision d) | `lib/scaling.ts:20-26` |
| 2 | BLOCK | `account_body_mass_kg(uuid, date default null)` is granted to `service_role` (still revoked from `public`, `anon`, `authenticated`), so Phase 10's route can fill the input weight with the same function (§1.3; decision b) | Phase 10 build step |
| 3 | BLOCK | `build_stale` with SQLSTATE `SF003` is the only weight-change refusal; the writer selects the weight once and uses that result for the equality check and all floors; `account_floor` takes the weight as a parameter (§1.2 step 4; decisions a and c) | Phase 10 writer section |

## Resolution of audit round 25

Audit: `docs/audit/specs/2026-09-22-phase-12-r25-gpt6-sol.md` (4 BLOCK, 1 FIX). Each finding was
checked against the code and Phase 10; all 5 hold. None rejected. Decision (run): the input-weight
check and `build_stale` are removed from the writer.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | `validatePercentProfile` stays on the percent path (100 % sum check) (§1.4 table) | `app/api/targets/route.ts:18-29`; `lib/targets/percent.ts:55-70` |
| 2 | BLOCK | Submitted kcal is never replaced; a difference over 9 kcal from 4/4/9-from-grams raises `kcal_mismatch` (`SF004` → 422) (§1.4 table, §1.5) | `lib/targets/percent.ts:88-90`; `lib/scaling.ts:11-26` |
| 3 | BLOCK | Input-weight check and `build_stale` removed; floors use the weight selected under lock; the stale-weight residual is accepted in Open for Devin 4 (§1.2 step 4) | `lib/server/targets.ts:54-81`, `:258-273` |
| 4 | BLOCK | With no `build_stale`, no queued entry can loop on it; `below_floor` settlement is unchanged (§1.5) | `lib/targets/client.ts:202-218` |
| 5 | FIX | Caller table: Phase 10 rolls back on `SF001` with no automatic retry; Phase 10 lines in Open for Devin 2 drop the SF003 branch (§1.4, Open for Devin 2) | Phase 10 `:894-902` |

## Resolution of audit round 26

Audit: `docs/audit/specs/2026-09-22-phase-12-r26-gpt6-sol.md` (3 BLOCK, 2 FIX), the final round of the
night. Each finding was checked against the code; all 5 hold. None rejected. Not re-audited.

| # | Severity | Change | Evidence |
|---|---|---|---|
| 1 | BLOCK | The writer checks `pin_training_kcal`, `pin_rest_kcal` and `pin_protein_g` against the minima, not only the clamped day (§1.2 step 5) | `derive.ts:77`; `scaling.ts:54`; `targets.ts:65-67` |
| 2 | BLOCK | Any negative macro from the authored conversion is refused (`422 invalid_macros`; the writer also refuses) (§1.4) | `percent.ts:78-90` |
| 3 | BLOCK | Only `p_row` (or the row being restored) is floor-checked; the predecessor is checked only when restored, so a first retarget with no active revision is allowed if above the floor (§1.4) | `apply-body.ts:67` |
| 4 | FIX | The grams editor recomputes calories with `macroKcal` on each step and sends them (§1.5) | `TargetModeSheet.tsx:53`, `:99` |
| 5 | FIX | `writePin` and `saveTargets` both show the server's floor message (§1.5) | `use-settings-controller.ts:201`, `:224-229` |
