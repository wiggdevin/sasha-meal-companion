# Phase 10 — Conversational onboarding

**Superseded by implementation (owner decision, 2026-10-08).** This draft was never built as
written: no `onboarding_drafts` table or live `coach_threads` reference exists, `kind =
'onboarding'` was never added to the `coach_threads` check constraint
(`supabase/migrations/20261126090000_coach_conversations.sql:5`), and the system that actually
shipped (`components/Onboarding/ConversationalOnboarding.tsx` plus the onb3 rework) uses its own
scope and schema. For what real accounts experience today, see
`docs/specs/onboarding-as-built.md` instead. Archive this file as historical context for the onb3
lanes that build on its ideas, not as a description of current behavior.

**DRAFT — decisions confirmed by Devin (DECIDED) and by the overnight run (DECIDED (run)).
Audited by GPT-6 Sol through round 25; last round 2 BLOCK resolved in spec, not re-audited.**
Devin accepted every DECIDED (run) choice on 2026-09-23 and approved audit rounds past round 3.

Revision 27 (2026-09-23). Audit history, all by GPT-6 Sol:
- Revision 1: not audited.
- Round 1 on revision 2 (`docs/audit/specs/2026-09-22-phase-10-r1-gpt6-sol.md`): DO NOT SHIP,
  10 BLOCK, 7 FIX. Revision 3 applied all 17.
- Round 2 on revision 3 (`docs/audit/specs/2026-09-22-phase-10-r2-gpt6-sol.md`): DO NOT SHIP,
  4 BLOCK, 6 FIX. Revision 4 applied all 10.
- Round 3 on revision 4 (`docs/audit/specs/2026-09-22-phase-10-r3-gpt6-sol.md`): DO NOT SHIP,
  5 BLOCK, 2 FIX. Revision 5 applied all 7.
- Round 4 on revision 5 (`docs/audit/specs/2026-09-22-phase-10-r4-gpt6-sol.md`): DO NOT SHIP,
  6 BLOCK, 3 FIX; it raised none of the round 3 findings again. Revision 6 applied all 9.
- Round 5 on revision 6 (`docs/audit/specs/2026-09-22-phase-10-r5-gpt6-sol.md`): DO NOT SHIP,
  4 BLOCK, 4 FIX; its finding 3 extends round 4 finding 2. Revision 7 applied all 8.
- Round 6 on revision 7 (`docs/audit/specs/2026-09-22-phase-10-r6-gpt6-sol.md`): DO NOT SHIP,
  2 BLOCK, 2 FIX. Revision 8 applied all 4.
- Round 7 on revision 8 (`docs/audit/specs/2026-09-22-phase-10-r7-gpt6-sol.md`): DO NOT SHIP,
  1 BLOCK, 1 FIX. Revision 9 applied both.
- Round 8 on revision 9 (`docs/audit/specs/2026-09-22-phase-10-r8-gpt6-sol.md`): DO NOT SHIP,
  2 BLOCK, 3 FIX. Revision 10 applied all 5.
- Round 9 on revision 10 (`docs/audit/specs/2026-09-22-phase-10-r9-gpt6-sol.md`): DO NOT SHIP,
  2 BLOCK, 2 FIX. Revision 11 applied all 4 (one writer for invited accounts).
- Round 10 on revision 11 (`docs/audit/specs/2026-09-22-phase-10-r10-gpt6-sol.md`): DO NOT SHIP,
  1 BLOCK, 1 FIX. Revision 12 applied both.
- Round 11 on revision 12 (`docs/audit/specs/2026-09-22-phase-10-r11-gpt6-sol.md`): DO NOT SHIP,
  2 BLOCK. Revision 13 fixed both structurally (invites open last, old builds refused, stale
  settings writes refused, never rewritten).
- Round 12 on revision 13 (`docs/audit/specs/2026-09-22-phase-10-r12-gpt6-sol.md`): DO NOT SHIP,
  1 BLOCK, 1 FIX. Revision 14 applied both.
- Round 13 on revision 14 (`docs/audit/specs/2026-09-22-phase-10-r13-gpt6-sol.md`): DO NOT SHIP,
  2 BLOCK, 1 FIX. Revision 15 applied all 3.
- Round 14 on revision 15 (`docs/audit/specs/2026-09-22-phase-10-r14-gpt6-sol.md`): DO NOT SHIP,
  3 BLOCK, 1 FIX. Revision 16 applied all 4.
- Round 15 on revision 16 (`docs/audit/specs/2026-09-22-phase-10-r15-gpt6-sol.md`): DO NOT SHIP,
  3 BLOCK, 2 FIX. Revision 17 applied all 5 (the persistent Today card is removed).
- Round 16 on revision 17 (`docs/audit/specs/2026-09-22-phase-10-r16-gpt6-sol.md`): DO NOT SHIP,
  4 BLOCK, 1 FIX. Revision 18 applied all 5.
- Round 17 on revision 18 (`docs/audit/specs/2026-09-22-phase-10-r17-gpt6-sol.md`): DO NOT SHIP,
  4 BLOCK. Revision 19 applied all 4 (release order fixed: Phase 12 M-a first).
- Round 18 on revision 19 (`docs/audit/specs/2026-09-22-phase-10-r18-gpt6-sol.md`): DO NOT SHIP,
  3 BLOCK. Revision 20 applied all 3.
- Round 19 on revision 20 (`docs/audit/specs/2026-09-22-phase-10-r19-gpt6-sol.md`): DO NOT SHIP,
  2 BLOCK, 2 FIX. Revision 21 applied all 4.
- Round 20 on revision 21 (`docs/audit/specs/2026-09-22-phase-10-r20-gpt6-sol.md`): DO NOT SHIP,
  3 BLOCK, 1 FIX. Revision 22 applied all 4 and removed the Preview reset.
- Round 21 on revision 22 (`docs/audit/specs/2026-09-22-phase-10-r21-gpt6-sol.md`): DO NOT SHIP,
  1 BLOCK, 1 FIX. Revision 23 applied both.
- Round 22 on revision 23 (`docs/audit/specs/2026-09-22-phase-10-r22-gpt6-sol.md`): DO NOT SHIP,
  1 BLOCK. Revision 24 applied it.
- Round 23 on revision 24 (`docs/audit/specs/2026-09-22-phase-10-r23-gpt6-sol.md`): DO NOT SHIP,
  3 BLOCK, 2 FIX. Revision 25 applied all 5.
- Round 24 on revision 25 (`docs/audit/specs/2026-09-22-phase-10-r24-gpt6-sol.md`): DO NOT SHIP,
  3 BLOCK, 1 FIX. Revision 26 (this file) removes the exact weight-match check and the
  `build_stale` retry (same decision as Phase 12), fixes the legacy form order, and records the
  residual.
- Round 25 on revision 26 (`docs/audit/specs/2026-09-22-phase-10-r25-gpt6-sol.md`): DO NOT SHIP,
  2 BLOCK, 1 FIX. Revision 27 (this file, final pass of the run) applies all 3; no auditor re-checks
  it. The mappings are in the twenty-five "Resolution of audit round N" sections near the end.

**Next audit:** no further spec audit tonight. The Phase 10 implementation plan must be audited
(GPT-6 Sol) before any Phase 10 code is written, and that audit re-checks the round 25
resolutions. Then the
Phase 10 implementation plan must be audited (GPT-6 Sol, same loop and bar as the program
contract) before any Phase 10 code is written.

This revision follows Phase 9 revision 4 (final). Templates are server-written and read-only for
the client (no client edits, no archive, no outbox, no change feed); the client reads them through
`GET /api/plan/templates`. Phase 9's "Later" gives Phase 10 one template-write contract:
`replace_day_template(p_key, p_payload, p_base_version)`, online only, version-checked, no
change row, no outbox op. `complete_onboarding` uses that function **once, before any day uses the
template**, in the same transaction as the rest of the build. To keep the design small, some parts
move to "Later".

Part 2 of 4 in the multi-user program. It depends on Phase 9 slices 1 (device isolation,
`accountFetch`), 4 (templates, `account_claims`, `GET /api/plan/templates`), 5 (invites,
`claim_account`) and 6 (resolver, minimum-client gate). Program contract:
`docs/plans/2026-09-22-multi-user-overnight-run.md`.

Devin's rulings are marked **DECIDED**. Decisions the run made without Devin are marked
**DECIDED (run)** with a one-line reason, so he can override any of them.

## Goal

A new user finishes setup by chatting with the coach, not by filling in a form. Apple Health fills
in what it can with a few taps and no typing. Every value the coach saves is one the user said, one
Health supplied, or one the user confirmed — never a silent guess. Setup takes under four minutes.
The user leaves with a day structure that fits their life, their own Eats and Avoids, and correct
targets when the six formula inputs are known (else the existing "finish your profile" state).

Devin's priorities, in order: onboarding that feels fluid and intuitive, accurate information,
and the coach as the way to do everything.

## Facts this spec rests on (read 2026-09-22 at `b1bd4fa`, plus PR #241 at `f743cfb`)

Onboarding today:
- Onboarding is a 5-step form: `STEPS = ["Body", "Activity", "Goal", "Dietary preferences", "Your
  plan"]` (`components/Onboarding/OnboardingFlow.tsx:26`). Before it navigates away, the form
  drains the outbox (`OnboardingFlow.tsx:132`, `flushOutboxNow`).
- The gate reads `user_settings.onboarded_at` from the server. `accountDisposition()`
  (`lib/profile/onboarding-state.ts:107-118`) returns `force` for a missing row, `none` for a
  valid timestamp, and `invite` for older accounts (`onboarding-state.ts:26`). `AuthGate` re-reads
  a `force` account on every navigation, which is how a finished onboarding opens the gate
  (`components/AuthGate.tsx:287-288`). `/onboarding` renders only in the `onboarding` gate state
  (`AuthGate.tsx:167-172`).
- Completion writes by three paths (`lib/profile/onboarding-client.ts:72-236`): `user_settings`
  through an outbox op (`:103-121`); a target revision through `POST /api/targets` (`:81-90`,
  `lib/targets/client.ts:236-241`); `constraint_profiles` through `PUT /api/constraints`, which is
  not outbox-synced (`lib/constraints-client.ts:1-7`).
- The form requires a **birth year**, not an age (`onboarding-state.ts:307-316`).
- `user_settings` columns written today (`lib/sync/user-settings.ts:97-120`) include no
  `display_name`. The coach profile read selects a fixed column list
  (`lib/server/coach-context.ts:89-93`).

Targets (PR #241 is merged first, per the program contract):
- `deriveTargetRevision` throws on an incomplete profile (`lib/profile/derive.ts:109-116`).
  Complete means sex (`female | male`), birth year, height, weight, activity level and goal
  (`lib/profile/energy.ts:163-170`).
- A fresh account with no revision resolves to `needs_profile` (Phase 9 §2.6;
  `lib/targets.ts:16-21`, `app/api/targets/route.ts:109`).
- `Goal = "lose_fat" | "recomp" | "maintain" | "gain_muscle"` (`lib/types.ts:38`). Rate presets
  are per goal: `lose_fat [-25,-50,-75]`, `recomp [0]`, `maintain [0]`, `gain_muscle [10,20,25]`
  (`f743cfb:lib/profile/rate-goal.ts:11-16`), checked by `validateRate` (`:33-35`). A null rate
  means "not confirmed" and derives at maintenance (`f743cfb:…/20261029090000_rate_goals.sql:10-14`).
  `rateTarget` clamps the adjustment to −20 % / +10 % of TDEE and to the macro minimum, and returns
  the `effectiveRatePctWeek` (`rate-goal.ts:57-71`).
- Katch-McArdle needs a measured source (`dexa`, `inbody`, …) **and** `body_fat_measured_on`
  within 180 days (`f743cfb:lib/profile/energy.ts:79-93`;
  `f743cfb:…/20261028090000_body_fat_provenance.sql:9-13`). A consumer scale value is not
  eligible.
- `activityLevelForSteps` maps steps to a level (`lib/activity/prompt.ts:19-25`); the existing
  prompt needs at least 14 days of steps (`prompt.ts:4`).

Models:
- Jev (`lib/ai/typesafe.ts`) answers `noul`, `choice` and `score` questions (`typesafe.ts:46-64,
  90-108`). It does not extract free values. `systemOne` fails soft to `null`
  (`typesafe.ts:240-303`). It already classifies diet preferences
  (`app/api/profile/prefs/route.ts:101-105`).
- The coach loop (`lib/server/coach-turn.ts`) is a JSON-structured tool loop (`coach-turn.ts:224`)
  on `gemini-3.6-flash` (`lib/ai/models.ts:19`). `coach_threads.kind` is checked `in
  ('chat','weekly_review')` (`20261001000000_phase7_coach.sql:8-9`). The turn path creates `chat`
  threads (`lib/server/coach-threads.ts:165`); the coach screen reopens only a `chat` thread
  (`app/coach/CoachScreen.tsx:63`). Message order uses `nextSeq`, which reads `max(seq) + 1`
  without a lock (`coach-threads.ts:134-138`). UI blocks include `quick_replies` and generic `ui`
  cards (`lib/coach/ui-blocks.ts:153-158,262`).
- The health-context gate: a coach turn that carries conditions or notes routes only when
  `HEALTH_CONTEXT_PROVIDER=gemini` and `GEMINI_BILLING_ATTESTED=1` (`lib/ai/route.ts:48-64,
  98-105`); else `503 nous_unconfirmed` (`coach-turn.ts:263-269`).

Foods:
- `set_food_membership(p_user, p_name_norm, p_status, p_note, p_rev)` records a name-level
  membership and upserts `user_food_prefs` for the **existing** user and catalog refs with that
  normalized name (up to 50). It creates no `user_foods` row
  (`20261023090400_food_membership_v2.sql:3-4,25-55,93-115`). It writes no `change_log` row; today
  the outbox op result tells the client (`app/api/sync/ops/route.ts:51-74`).
- `user_food_prefs` sync rows are keyed by `food_ref_id` (`lib/sync/keys.ts:10-12,34`).
- The phone builds meal foods from `user_foods` plus prefs, with role and per-100 g nutrients
  (`lib/store.ts:274-300`). A composed slot needs protein, carb and fat Eats by role
  (`lib/rotation.ts:171-194`).
- `write_target_revision` emits its own `target_profiles` change row
  (`20261023091000_target_revision_transactions.sql:64-67`).

Apple Health:
- The only phone path is `POST /api/health/ingest` with `Authorization: Bearer <token>`
  (`app/api/health/ingest/route.ts:18-21,28-40`). It answers 503 unless `HEALTH_INGEST_ENABLED`
  is set (`:25-27`) and limits 30 requests an hour per token hash and per IP (`:30,37`).
- `POST /api/health/tokens` issues one token per source and returns it once
  (`app/api/health/tokens/route.ts:14-34`); `DELETE /api/health/tokens/[id]` revokes one
  (`lib/health-client.ts:125-127`).
- Envelope rules (`lib/server/health-ingest.ts:40-88`): `source_kind` must match the token;
  `sent_at` within ten minutes. The 8-day freshness window applies only to Health Auto Export
  bodies (`health-ingest.ts:19-21,79-85`), so a Shortcut body is accepted at any sample age.
  Limits: 5,000 samples and 2 MB (`lib/health/contract.ts:20-22`).
- `applyIngest` records the event first (`health_ingest_event`) and applies samples in a second
  RPC (`health-ingest.ts:93-114`). A replay of the same payload hash is `duplicate`
  (`20260925000000_phase5_health_ingest.sql:55-60`). The hash covers the whole body
  (`payloadHash(body)`, `health-ingest.ts:97`), and the body carries `sent_at`, so a new Shortcut
  run is a new hash.
- `last_received_at` is the newest ingest event per source, not proof that samples were saved
  (`20261024093100_health_source_status.sql:3-7`). Health samples are owner-readable
  (`20260925000000_phase5_health_ingest.sql:16-17`).
- Ingest types and units have no height and no body fat (`contract.ts:14-16`); nor does
  `health_samples_type_ck` (`20260925000000_phase5_health_ingest.sql:5-7`).
- The documented Shortcut posts to one fixed ingest URL and keeps the token in a Text action
  (`docs/apple-health.md:12-18,37-39`). "Add Shortcut" renders only when
  `NEXT_PUBLIC_APPLE_HEALTH_SHORTCUT_URL` is set (`components/HealthSourcesSheet.tsx:94-99,189`).
  Shortcuts cannot read biological sex or date of birth.
- `health_weigh_in(p_local_date, p_tz, p_kg)` is the manual weigh-in writer, for `authenticated`
  (`20261019090000_manual_weigh_in.sql:40,106-107`).

Foods and policy (round 2):
- Food policy blocks an Avoid through `avoid_food_ref_ids` or a ref's Avoid pref
  (`lib/policy/constraints.ts:141-142`). No code outside the SQL function reads
  `food_membership_revisions`, so a name with no ref is not enforced anywhere. `set_food_membership`
  reports `truncated` when more than 50 catalog refs share the name
  (`20261023090400_food_membership_v2.sql:38-56,117-120`).
- The phone's food map loops over `user_foods` rows only (`lib/store.ts:274-300`); a pref on a
  catalog-only ref never reaches rotation.
- `rateTarget` can raise the target to the macro minimum, so `effectiveRatePctWeek` can be zero or
  of the opposite sign from the chosen goal (`f743cfb:lib/profile/rate-goal.ts:63-70`).

Operations and sync:
- The backup job copies a fixed table list (`app/api/jobs/backup/route.ts:36-47`) and orders each
  table by `id` unless `COMPOSITE_KEYS` names its key (`route.ts:55-74`).
  `food_membership_revisions` (key `user_id, name_norm`, `20261023090100_food_membership.sql:6`)
  is not in the list.
- `GET /api/sync/changes` returns the caller's cursor when no row follows it
  (`app/api/sync/changes/route.ts:40-44`); a device cannot see a deleted row through the feed.
- `GET /api/health/daily` rows carry steps, energy and body mass, no height or body fat
  (`lib/health/contract.ts:93-105`).

Phase 9 (revision 4, final) facts this spec builds on:
- Invite sign-up ends in `claim_account`, which calls the internal `create_default_template(user_id)`
  in the claim's transaction (Phase 9 §1.4, §2.6, slice 5). `account_claims` is created in slice 4
  (`20261030090000_day_templates.sql`). A new account has no `user_settings` row, so it is `force`.
- Every client `/api/` call goes through `accountFetch(handle, url, init)`, which sends
  `x-smc-account` and `x-smc-client`. `requireUser` answers `409 account_mismatch` on a wrong
  account, and `426 client_upgrade_required` for a `default` (invited) account on a missing or old
  build (§0.5a, §1.5b). The ingest route authenticates by token, not `requireUser`, so these checks
  do not apply to the Shortcut.
- Floor Day safety is decided only on the server; a template without floor rows hides the control
  (§2.4).
- Every admin-client entry point is listed in `tests/tenancy/admin-entry-points.json` with a
  second-user canary test (§3.5).
- The Phase 10 template contract (Phase 9 "Later"): `replace_day_template(p_key, p_payload,
  p_base_version)`, `security definer`, owner `auth.uid()`; refuses when `p_base_version` differs
  from the current `version` hash; runs the §2.1 checks; one transaction; no change row, no outbox
  op; refuses to remove a slot or key that a `plan_days` row uses; the client refreshes with `GET
  /api/plan/templates` after it.
- Default template: key `everyday`, `serves {training, rest}`, `weekdays {}`, `sizing = 'share'`;
  slots `breakfast` 08:00 (0.25), `lunch` 12:30 (0.35), `snack-1` 15:30 (0.10), `dinner` 19:00
  (0.30), one share for all three macros; all `composed`; phases 0/2/1/4 (§2.6).
- Templates are immutable once written; `authenticated` has select only; only `security definer`
  functions write, and they run the §2.1 checks before commit (shares sum to 1 ± 0.001 per macro,
  one default per category, and so on) (§2.1).
- The client reads templates through `GET /api/plan/templates` (`{ templates, version }`, `version`
  = a hash of the rows), stored in the account database's `meta` store, fetched on every
  `onAccountReady` and at the start of every sync pass (§2.8).
- Device state is per account (§0), with a purge on sign-out and account switch (§0.7).

Migration order and state on 2026-09-23 (round 4):
- Production already has `20261103090000` (sync internals revoke and guard, PR #249) and
  `20261103090100` (same-owner triggers; `coach_messages` RLS by `user_id = auth.uid()`; client
  delete on `plan_days` revoked, PR #250). The Phase 9 plan uses `20261104…` (slice 4),
  `20261105…` (slice 5), `20261106090000` (slice 8, M2) and `20261107090000` (slice 6)
  (`docs/plans/2026-09-22-phase-9-tenancy/README.md:23-37`). **Phase 12's one migration ships
  before Phase 10:** in Phase 12 revision 22 it is `20261108090000_phase12_target_floor.sql`
  (after Phase 9's `20261107090000`, before Phase 10), so timestamp order is apply order. It adds
  exactly one checked writer, `write_target_revision_checked(p_user_id uuid, p_row jsonb,
  p_predecessor jsonb default null) returns jsonb`, `security definer`, execute for
  `service_role` only, which computes the calorie, fat and protein minima itself from the locked
  stored profile and weight and refuses a revision below them (Phase 12 §1.1–1.2). Phase 12 no
  longer has a second (contract) migration or weigh-in and Undo changes. Phase 10 migrations are
  `20261110…`.
- PR #248: data routes answer 401 when `x-smc-account` is missing. PR #246: the sign-in screen is
  the same for a known and an unknown address. Onboarding routes are data routes and use
  `accountFetch`.
- `apply_sync_op` serializes one entity key with
  `pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_entity || ':' || v_key, 0))`
  (`20260919090300_phase3_sync_entities.sql:436`); the `user_settings` key is the literal
  `settings` (`lib/sync/settings-intents.ts:31`). A `plan_days` key is one date, so no lock covers
  all of a user's days.
- PR #241 fills `TargetInputs` with `effectiveDate`, `weightKg`, `weightSource`
  (`"onboarding"` or `"weigh-in"`), `trainingWeekdays`, `activity`, `goal`, `goalRateBpWeek`
  (`?? 0` for an unconfirmed rate) and `formulaName` (`f743cfb:lib/profile/derive.ts:91-100`).
- `health_weigh_in` needs a real IANA zone name (`pg_timezone_names`) and a local date not more
  than one day ahead (`20261019090000_manual_weigh_in.sql:40-73`).
- The nightly backup writes `user-table-export-v1` JSON read table by table,
  `consistency: "per-request"` (`app/api/jobs/backup/route.ts:119-126`); the restore tool accepts
  only a verified `pg_dump` SQL file from `scripts/backup.sh` (`scripts/lib/database_backup.py:
  203-214`).
- Template editing after first use stays in "Later" here too.

## Scope

In: the chat onboarding (stages 1–10), the server draft with serialized turns, the stage-9 build
with the one-time template replacement, the Health connect step with a Preview probe and fallbacks,
two new ingest types, the `onboarding` thread kind, `display_name`, the form fallback, Preview-only
test controls, and the tests below.

Out: see "Later".

## Who sees the chat

- Entry: the Phase 9 invite path. After `claim_account`, a new account is `force` and goes to
  `/onboarding`.
- The chat runs only when `account_claims.seed_policy = 'default'`. **DECIDED (run):** a `manual`
  account (Sasha, the test account) or an `invite` disposition gets the form. Reason: the build
  replaces the default template; a `manual` account's templates are her authored plan.
- **The legacy form path writes the profile first, then the target through the checked writer
  (round 24 finding 3, DECIDED (run)).** It is used only by a `manual` account or an `invite`
  disposition that has not finished onboarding (today Sasha and the test account are both
  finished, so no production account is expected to reach it). Today it posts the target before
  it saves the profile (`lib/profile/onboarding-client.ts:82-92`), and after Phase 12
  `/api/targets` refuses a first target without a stored profile (`profile_required`, Phase 12
  §1.2 step 3). Phase 10 reorders the legacy save into three steps, with the stamp **last**
  (round 25 finding 1): (1) queue the profile settings op **with `onboarded_at` left null** (the
  form's settings from `lib/profile/onboarding-state.ts:280-304` minus the stamp), drain it with
  `flushOutboxNow()` and require it applied; (2) post the target, which `/api/targets` writes
  through `write_target_revision_checked`, and save the constraints (`PUT /api/constraints`,
  `lib/profile/onboarding-client.ts:193-204`); (3) only when both succeeded, queue and drain a
  second settings op that sets `onboarded_at`. A failure at any step shows "Couldn't save your
  setup — try again" and leaves the account unstamped, so `AuthGate` keeps it in onboarding
  (`components/AuthGate.tsx:178-186`) and a retry repeats the steps (the target and constraint
  writes are idempotent by revision and `baseRev`). Reason: one checked writer for every target; keeping
  the old order would fail on the first write. Test `tests/onboarding/legacy-form.test.ts`: an
  `invite` account with an incomplete stored profile completes the form; the settings row is
  stored before the target; the target passes the checked writer; `onboarded_at` is set last. A
  target refusal, and a dropped target response followed by a reload, both leave the account
  unstamped and in onboarding, and a retry completes.
- An account with no template shows Phase 9's pending state before stage 1.
- "Prefer a form?" on stage 1 opens the existing form. The form also opens by itself when the model
  is unavailable (route refused, circuit open, three failed turns). The form keeps the default
  template.
- **One writer for every invited account (round 9 finding 1, replaces the round 8 mode switch).**
  For an account with `seed_policy = 'default'`, the form fallback no longer writes through its old
  paths (weigh-in, `POST /api/targets`, `PUT /api/constraints`, the settings outbox stamp,
  `lib/profile/onboarding-client.ts:72-236`). It completes **only** through the same
  `complete_onboarding` transaction as the chat:
  1. The form's "Your plan" step posts its answers **and its target edits** to `POST
     /api/onboarding/form` (through
     `accountFetch`). The route validates them, builds the same build shape with `buildFrom` (the
     form's answers are `source = user_said`, confirmed; the target from `deriveTargetRevision`;
     the flag mapping, time zone and local date as for the chat), and calls
     `onboarding_stage_form_build(p_user_id, p_build)` (`security definer`, service role only).
     **Form target edits are kept (round 14 finding 3).** The form lets the user set training
     calories, rest calories and protein (`components/Onboarding/OnboardingSteps.tsx:259`), which
     today become pins (`lib/profile/onboarding-state.ts:25,331-344`;
     `lib/profile/derive.ts:83-88`). The route puts the edited fields into the build as `pins`
     (`trainingKcal`, `restKcal`, `proteinG`, only those the user changed), derives the target
     revision with those pins applied through `applyTargetPins`. **Round 15 finding 3:** the pins
     are stored **as the user chose them**; the resolved numbers may differ because macro grams
     are rounded and kcal recomputed (`lib/scaling.ts:66-81`). **Round 16 finding 1:** Phase 10
     has no pin check of its own. The target revision is written through Phase 12's checked
     writer, `write_target_revision_checked(p_user_id, p_row, p_predecessor)` (Phase 12 §1,
     revision 22), which computes the calorie, fat and protein minima itself and refuses a
     revision whose training or rest day is below them, in the same transaction. Phase 10 does not
     ship without that writer (fail-fast check in the migration). A pin that resolves below any floor (for example
     protein 0 from the stepper, `components/Stepper.tsx:54`) makes that writer raise
     `below_floor`; `complete_onboarding` then writes nothing and the form shows "That is below the
     safe minimum of N" under the field the writer names. The summary shows the resolved training
     and rest targets next to the chosen numbers when they differ.
     `complete_onboarding` writes the pins to `training_kcal`, `rest_kcal` and `protein_g` in
     `user_settings` (the columns the next derivation reads as pins) and checks only that the
     revision's own `pins` (`lib/profile/derive.ts:96`) equal the build's pins, never the resolved
     numbers. Test: a +50 kcal step that resolves to 1,852 kcal completes, stores the pin as
     chosen, and the next derivation keeps it. The chat build has no pins.
  2. Under the per-user onboarding lock that function requires the same eligibility as every
     onboarding function (default seed policy, no `onboarded_at`, draft not completed), creates
     the mode record if none exists, sets `mode = 'form'`, inserts the immutable build, sets
     `confirmed_build_id` to it and bumps `rev` (the form's own review step is the approval).
  3. The client then calls `complete_onboarding(rev)` exactly as the chat does.
  4. **"Skip for now" uses the same writer (round 19 finding 1).** For a `default` account the
     form's Skip button (`components/Onboarding/OnboardingFlow.tsx:166`) no longer calls
     `persistSkippedOnboarding` (`lib/profile/onboarding-client.ts:223-236`, which queues a stamp
     that the stamp trigger would refuse). It posts `{ skip: true }` to `POST /api/onboarding/form`;
     the route builds a **skip build** — no profile fields, no pins, no rhythm (template kept),
     empty `constraint_profiles` arrays (today's skip also writes that row first), no Eats or
     Avoids, `time_zone` and `local_date` from the device — and stages and completes it as in
     steps 2–3. The account finishes in `needs_profile` with no target, as a skip-all chat run does.
     `manual` accounts and the `invite` disposition keep today's skip path. Test
     `tests/onboarding/form-skip.test.ts`: Skip from the form's first step completes through
     `complete_onboarding`, sets `onboarded_at`, writes an empty constraint row and no target, and
     queues no settings entry with a stamp.
  So there is one writer. Under the onboarding and settings locks, `complete_onboarding` requires
  `onboarded_at` null: whichever path completes first wins, and the other gets
  `already_onboarded` and writes nothing.
- **Mode record on first use (round 9 finding 2).** `onboarding_drafts` is created by the first
  onboarding function any path calls — `onboarding_commit_turn` (chat, `mode = 'chat'`, with the
  onboarding thread) or `onboarding_stage_form_build` (form, `mode = 'form'`, no thread) — always
  under the per-user onboarding lock, so there is no "no draft yet" gap. "Prefer a form?" before
  turn one, and a refused model route before turn one, need no chat draft: the form UI renders
  with no server call, and its first write is step 1 above. A chat draft switches to `mode =
  'form'` in step 2 (it clears any chat approval); after that the chat functions refuse with
  `form_chosen`. `thread_id` is nullable, with `check (mode = 'form' or thread_id is not null)`.
- **Old builds cannot write for invited accounts.** Invites open only after the Phase 10 build and
  its `MIN_CLIENT_BUILD` are live, and every write route answers `426` to an older build for a
  `default` account (see "Stale settings writes are refused"). `manual` accounts and the `invite`
  disposition keep today's form paths.
- Tests `tests/onboarding/form-vs-chat.test.ts`: (a) chat completion holds the locks, then the
  form's staging and completion → `already_onboarded`, no form write; (b) the form stages and
  completes first, then a chat turn → `form_chosen` and a chat completion → `already_onboarded`;
  (c) "Prefer a form?" before any chat turn completes with one draft row (`mode = 'form'`, no
  thread); (d) an old-build request for a `default` account gets `426` on every write route
  (`old-build-refused.test.ts`).
- Existing onboarded accounts (`none`) never see either.

## The conversation

Server-driven stages. The model writes the words and extracts values; the stage machine decides
what comes next. Each coach turn offers quick replies.

| # | Stage | Coach (tone example, not fixed copy) | Fills |
|---|---|---|---|
| 1 | Hello | "Hi, I'm your coach. What should I call you?" | `display_name` |
| 2 | Health | On iPhone with body data on: "Want to connect Apple Health? It's the fastest, most accurate way to set you up." Replies: Yes · Not now · Why? | Health source, backfill |
| 3 | Read-back | "You're averaging 8,400 steps and about 450 active kcal a day — nicely active." A card shows what Health saved, each with Edit. | weight, height, body fat, activity |
| 4 | Goal | "What can I help you with? For example: accountability, an actionable meal plan, losing weight — or we can talk it through." Then, when needed: "Which fits best?" Lose fat · Build muscle · Recomp · Maintain. | motivation, goal, rate |
| 5 | Body basics | Only what is still missing: birth year, sex (for the energy formula, with a plain reason), height and weight when Health gave none. | birth year, sex, height, weight |
| 6 | Food life | "Any foods that don't agree with you, or that you avoid?" then "What do you love eating?" | Avoids, allergens, conditions, Eats, diet flags |
| 7 | Rhythm | "When do you usually eat, and do you train on set days?" | the day's slots and times, training weekdays |
| 8 | Summary | "Here's what I heard" card: every field with its source (Health · You said · Confirmed · Default · Missing) and Edit. Button: Looks right. | confirms the build |
| 9 | Build | "Setting up your profile…" then targets with the one-line why, or "Targets need: …". | writes everything (one transaction) |
| 10 | Hand-off | Tour offer and first suggestions: log a meal, ask about a snack, snap a photo at dinner. | — |

Rules:
- Ask one thing at a time. Skip a stage whose fields are already known with high confidence.
- The user can answer several stages in one message ("I was born in 1991, I'm 5'6", I want to drop
  10 lb"); the machine skips ahead.
- **Age is not a birth year.** "I'm 34" gives two possible years. The coach asks one quick reply
  ("Born in 1991 or 1992?"); the answer is saved as confirmed. A skip keeps the value missing.
- "Skip" is always available. A skipped field shows as "Missing — tell me anytime" or "Default"
  in the summary. Skip rules for targets are in "Targets at stage 9".
- **DECIDED (Devin, 2026-09-22):** the coach has a neutral identity for every account ("I'm your
  coach"). No personal name in copy.

### Goal, motivation and rate

- Jev's `choice` returns a **motivation**: `lose_fat`, `gain_muscle`, `recomp`, `maintain`,
  `eat_better`, `accountability`, `manage_condition`, `unclear`. The motivation is kept in the
  draft and in the onboarding thread, not in `user_settings`.
- The stored `goal` is always one of the four `Goal` values and is always confirmed. Mapping:
  `lose_fat`, `gain_muscle`, `recomp`, `maintain` map one to one and are confirmed with one quick
  reply ("Lose fat — right?"). Every other motivation gets the four-option quick reply. A skip
  leaves `goal` missing. **DECIDED (run):** no guessed default goal. Reason: a wrong goal moves
  every target, and PR #241 treats an unconfirmed choice as not set.
- Rate: the quick reply offers only `RATE_PRESETS_BP[goal]`, checked with `validateRate`. A skip
  stores `goal_rate_bp_week = null` ("maintenance until you pick a rate", PR #241 behavior). The
  target derived from that profile carries `goalRateBpWeek = 0` (`derive.ts:98`), so the build
  check compares `coalesce(build.goal_rate_bp_week, 0)` with it; `user_settings` keeps `null`.
- Estimate date: only when the user named an amount ("drop 10 lb"), a rate is chosen, and
  `effectiveRatePctWeek` of `rateTarget` is non-zero **and moves toward the amount** (negative for a
  loss, positive for a gain). The date comes from that effective rate and the current weight, not
  from the preset, and the card labels it "about". Otherwise the card shows no date and says why,
  from `bound`: "Your minimum intake sets the pace, so I won't guess a date" (`kcal_min`) or "I
  capped the pace for safety" (`rate_cap`, date still shown when the direction holds). **DECIDED (run):** no `target_date` column; the estimate is shown
  once and not stored. Reason: PR #241 stores the rate; the clamp can change the real rate.

## Accuracy: how every value is decided

Each field in the draft carries `{ value, source, confidence, confirmed }`, with `source` in
`health | user_said | inferred | default`.

1. **Extraction (Gemini, structured output, behind the health gate in rule 7):** numbers, units,
   dates, food names, weekdays, times, and **candidate allergens and conditions**. Units are
   normalized in code (`ft/in`, `lb`, `st`), never by the model. The extraction schema returns
   health candidates (allergens, conditions) in their own fields, apart from the non-health fields.
2. **Allergens and conditions (round 13 finding 2). DECIDED (run):** they are **never** sent to
   Jev, and no second judge is used for them. Each candidate from Gemini is shown as an explicit
   confirm quick reply ("Add peanut allergy?"), and only a confirmed one is saved, whatever any
   score says (the rule since revision 1). When the gate in rule 7 is closed, no model sees the
   text and stage 6 uses the form-style picker. Reason: `routeFor` authorizes the Google model
   only (`lib/ai/route.ts:48-55`); `systemOne` posts its `state` to TypeSafe
   (`lib/ai/typesafe.ts:191-200,255-256`), a separate processor with no health-data approval.
3. **Classification (Jev) and its own health gate (round 14 finding 2). DECIDED (run):** no
   vocabulary filter. Jev is TypeSafe's hosted System One API (`POST
   https://api.typesafe.ai/v1/systemone`, `lib/ai/typesafe.ts:10`); `systemOne` sends the whole
   `state` it is given (`typesafe.ts:255-256`). Conditions are free text with no closed list
   (`components/AvoidRules.tsx:313`), so no denylist can prove a phrase is free of health data.
   A new env value, `JEV_HEALTH_ATTESTED`, is the attestation for TypeSafe, the same kind of
   manual statement as `GEMINI_BILLING_ATTESTED`; only the exact value `1` opens it, and it is
   read in one place, `jevRouteConfig()` next to `routeConfig()` in `lib/ai/route.ts`.
   - **Attested (`JEV_HEALTH_ATTESTED=1`):** every onboarding turn is health context, so Jev may
     receive the user's text (and the Gemini-extracted phrases) and answers:
     - `choice` — motivation (above);
     - `noul` per candidate flag — diet flags (the existing `PREF_QUESTIONS`), "user wants a
       structured meal plan", "user trains on fixed days";
     - `score` — "how clear is this answer" for a non-health value the model hedged on.
     Purpose key `onboarding-judge`. Jev still never judges allergens or conditions (rule 2).
   - **Not attested (the default):** Jev receives **no user text and no free-text phrase**. It
     may receive only closed values that Gemini already chose and the user confirmed (for example
     the motivation enum code and the goal enum), and in Phase 10 it is not called at all for
     onboarding. Every value Gemini extracts then needs a confirm quick reply (as rule 6 does when
     Jev is down).
   - Whether TypeSafe may receive health context is Devin's decision (Open for Devin 10). The
     existing form's `/api/profile/prefs` call is outside this rule and unchanged ("Later").
4. **Thresholds (DECIDED, Devin 2026-09-22), for Jev's answers when attested:** ≥ 0.85 accept
   ("You said"); 0.50–0.85 confirm with a quick reply; < 0.50 not recorded.
5. **Deterministic checks:** plausible ranges (the existing profile checks), height and weight
   consistency, `validateRate(goal, rate)`. Out of range → ask again.
6. When Jev is down (`systemOne` returns `null`), every extracted value needs a confirm.
7. **Health context applies to every onboarding turn.** **DECIDED (run):** the turn route calls
   `routeFor({ purpose: "coach", healthContext: true, ...routeConfig() })` before it sends the text
   to Gemini; Jev gets raw text only when `JEV_HEALTH_ATTESTED=1` (rule 3). Reason: a user can name a condition in any stage, and a
   per-stage gate would run only after the disclosure had left. When refused, no model call is
   made: the chat hands over to the form (stage 6 conditions use the form's picker). **DECIDED:**
   Devin confirmed the Gemini key is paid; Preview sets both variables in this phase.

## Targets at stage 9

- With all six inputs confirmed or from Health (sex, birth year, height, weight, activity level,
  goal), the route derives the revision with `deriveTargetRevision` (Mifflin-St Jeor, or
  Katch-McArdle when eligible) and the summary shows the one-line why.
- With any input missing, the build writes no target revision. The account finishes onboarding in
  `needs_profile` with no numbers (Phase 9 §2.6); the summary says "Targets need: birth year,
  activity" and Today shows the existing profile prompt. **DECIDED (run):** allow finishing without
  targets. Reason: Devin wants "Skip" always available, and `needs_profile` already exists as a
  safe, number-free state.
- Measured body fat: when the user names a DEXA or InBody scan, the coach asks the **full** scan
  date (year, month, day) and confirms it as one line ("12 March 2026 — right?"). Only a confirmed
  full date that is not in the future gives `body_fat_source` `dexa` or `inbody` with
  `body_fat_measured_on`. A partial or unconfirmed date → source `typed_unknown`, no date (Mifflin).
  A Health value is saved as `consumer_scale` with its sample date (Mifflin).

## Stage 7 Rhythm: the one-time template replacement

**DECIDED (run):** onboarding **replaces** the default template once, inside `complete_onboarding`,
before any day uses it; it never edits a template afterwards. Reason: Phase 9 makes templates
immutable and server-written; a replacement before first use has no stored day that could point at
the old slots, so none of Phase 9 round 2's edit problems (findings 6–8) apply.

The write uses the Phase 9 contract function, which Phase 10 creates:
`replace_day_template(p_key text, p_payload jsonb, p_base_version text)` — `security definer`,
owner `auth.uid()`; refuses when `p_base_version` differs from `templates_version(auth.uid())`;
refuses to remove a slot or key that a `plan_days` row uses; runs the Phase 9 §2.1 checks; writes
in one transaction; no change row, no outbox op. **DECIDED (run):** in Phase 10 its execute grant
is `service_role` only (no grant to `authenticated`); `complete_onboarding` (security definer)
calls it. Reason: no Phase 10 screen edits templates, so a client-callable edit path would only add
surface; the grant to `authenticated` arrives with the editing spec ("Later").
`templates_version(p_user_id)` is a SQL hash of the account's template rows, and `GET
/api/plan/templates` returns that same value as `version` (if Phase 9 slice 4 computes it in
TypeScript, Phase 10 slice 1 moves it into SQL and keeps the output format).

Extra conditions for onboarding (stricter than the contract; all checked under the draft lock in
`complete_onboarding`):
1. `account_claims.seed_policy = 'default'`.
2. `user_settings.onboarded_at` is null.
3. The account has **zero** `plan_days` rows. The gate blocks Today until `onboarded_at` is set, so
   this holds for a new account. **The check and the
   replacement are serialized with day writes** (round 4 finding 3): `replace_day_template` takes
   `pg_advisory_xact_lock(hashtextextended('templates:' || p_user_id::text, 0))` before the check,
   and the Phase 9 M2 key-validation trigger on `plan_days` (slice 8, `20261106090000`) is replaced
   in `20261110090100` by the same function plus, as its first statement,
   `pg_advisory_xact_lock_shared` on the same key. So a day write that starts first makes the
   replacement wait and then see the new row (`template_kept`); a day write that starts second
   waits and then validates its slot keys against the new template (a removed slot key parks as
   `error`, Phase 9 §2.5). Test `tests/onboarding/replace-vs-day.test.ts`: two connections, a day
   insert naming `breakfast` held open, then the replacement; and the reverse order.
4. The account has exactly one template, `everyday`, its content equals the output of
   `create_default_template` (compared by `templates_version`), and that version equals the
   `template_base_version` stored in the confirmed build.

If a condition fails, the build keeps the existing template, writes everything else, and records
`template: "kept"` in `result`. No error. **Round 21 finding 2:** the summary (stage 8) makes no
promise about the template, because a day write can win the lock after it. The **actual** outcome
is reported after completion: the stage-10 message (chat) and the form's last screen say "Your
meal times are set." for `replaced` and "Your meal times stay as they were. You can change them
later." for `kept`. Test: a day write takes the `templates:` lock between approval and completion
→ `template: "kept"` and stage 10 shows the "stay as they were" line.

Content (one template; **DECIDED (run):** no second template for training days — Reason: the
category already changes the day's targets, and a second template doubles the questions; later
template editing is in "Later"):
- Template `everyday`, label "Every day", `serves {training, rest}`, `weekdays {}`, `sizing =
  'share'`. Same key, so nothing that names the key changes.
- Slot vocabulary is closed: `breakfast`, `lunch`, `dinner`, `snack-1`, `snack-2`, `snack-3`. At
  least two main meals. A slot the user drops is not written (no archive is needed before first
  use).
- Times: as the user said, rounded to 5 minutes, inside 05:00–23:30; an unstated time keeps the
  default. `position` follows time order.
- Shares (the same for protein, carbs and fat; kcal derived by `macroKcal`): weights `breakfast
  2.5`, `lunch 3.5`, `dinner 3`, each snack `1`. Share = weight ÷ sum over the written slots,
  rounded to 3 decimals; the remainder goes to the largest share, so each column sums to exactly 1.
  The default four slots give 0.25 / 0.35 / 0.10 / 0.30, equal to Phase 9 §2.6. Example: no
  breakfast, lunch, one snack, dinner → 0.467 / 0.133 / 0.400.
- Other fields: `composed`, `counts_for_adherence`, `required_for_completion`, not `compact`;
  `rotation_phase` breakfast 0, lunch 2, snack-1 1, dinner 4, snack-2 3, snack-3 5.
- Training weekdays go to `user_settings.training_weekdays` and into the target revision's inputs.
  They do not change the template.

Mechanism: `replace_day_template('everyday', payload, base_version)` replaces the template's slot
rows under the same template row and runs the §2.1 checks. After commit the template is immutable,
as Phase 9 requires. No change row is written for it; the client gets the new `version` from `GET
/api/plan/templates` (below). The new template has no floor rows, so Floor Day stays hidden (Phase 9
§2.4).

Pure function: `lib/onboarding/rhythm.ts` — `rhythmToSlots(rhythm) → slots` (the default rhythm
gives the default slots). Unit tests: default in → default out; share sums; closed vocabulary;
time order; at least two main meals.

## Apple Health in a few taps

`HealthConnector` interface (`connect()`, `status()`, `backfill(days)`), with the Shortcut as the
first implementation. **DECIDED** (Devin, 2026-09-22): one-tap Shortcut now, native iOS later.

1. Stage 2 appears only on an iPhone (user agent plus standalone PWA check) **and** when body data
   is on (`/api/health/daily` answers 200, `lib/health/capability.ts`).
2. "Yes" calls `POST /api/onboarding/health/connect`. The route generates a token (the
   `issueSourceToken` format) and calls `onboarding_rotate_health_source(p_user_id, p_token_hash,
   p_time_zone)` — `security definer`, `service_role` only. In one transaction the function takes
   the per-user onboarding lock (below), revokes the current pending source if there is one,
   first checks the same eligibility as the turn commit (default seed policy, no `onboarded_at`,
   draft not completed, `mode = 'chat'`; else `already_onboarded` / `form_chosen`, no change) and
   revokes only a source that is the draft's `pending_health_source_id` **and** is of kind
   `apple_health_shortcut` **and** belongs to this user (round 8 finding 2). It never revokes any
   other source. Completion leaves the pending source active as the account's Health connection
   and sets `pending_health_source_id = null`, so no later call can rotate it. It then
   inserts the new `apple_health_shortcut` source, sets `pending_health_source_id`, **bumps the
   draft `rev` and clears `confirmed_build_id`**. So a turn that read the old source, or an
   approval made before the rotation, fails the revision check (412). The route returns the token
   once, with the `source_id` it created. The chat keeps the token in memory only and disables
   Connect while a call is in flight. **Before it opens the Shortcut** it calls `GET
   /api/onboarding/health/status`, which returns `pending_health_source_id`; it opens the Shortcut
   only when that equals the response's `source_id`, else it shows "Tap Connect again" (round 5
   finding 5: a late, older response from another tab or a slow network is never used). An older
   token answers 401 anyway. Test: two tabs, two Connect calls, responses delivered in reverse
   order → the tab holding the older token does not open the Shortcut.
3. Two published shortcuts, one per environment (Open for Devin):
   - **Production shortcut:** the ingest origin is fixed inside it (the production URL). Input is
     the token only.
   - **Preview shortcut:** input is `<origin>|<token>`. It saves the pair and refuses an origin that
     does not match `^https://meal-companion-[a-z0-9-]+-<team-slug>\.vercel\.app$`. **DECIDED
     (run):** a fixed pattern inside the shortcut. Reason: any web page can open an x-callback URL,
     so an open origin parameter would let a page send a user's Health data to any host.
   - `NEXT_PUBLIC_APPLE_HEALTH_SHORTCUT_URL` and `NEXT_PUBLIC_APPLE_HEALTH_SHORTCUT_NAME` point to
     the matching shortcut per environment.
4. **Connect** opens `shortcuts://x-callback-url/run-shortcut?name=<name>&input=text&text=<input>`.
   On first run the shortcut saves its input to a file in its Shortcuts folder, reads Health
   (Apple's permission sheet), sends a **30-day backfill**, and ends. Later runs (the daily
   automation) read the file. **DECIDED (run):** no `x-success`. Reason: iOS opens an `https`
   return URL in Safari, not in the home-screen PWA, which has separate storage.
5. Backfill content: steps and active energy grouped by day (≤ 31 samples each), body mass latest
   per day for 30 days, latest height, latest body fat % in 90 days, each with its date. Identity
   stays `shortcut:<type>:<Local Day>`.
6. **Advance on saved samples, not on a receipt.** The chat polls `GET
   /api/onboarding/health/status` every 3 s for up to 90 s. The route reads with the **user's**
   client (RLS: owner select on `health_samples`), filtered by `source_id =
   pending_health_source_id` (`health_samples.source_id`, `20260911000400_privileged.sql:17-22`). It
   returns per type the values stage 3 and the build need: `step_count` and `active_energy` —
   the daily values with dates and the day count; `body_mass`, `height`, `body_fat_percentage` —
   the latest value, unit, sample date (`end_time`) and source id. Stage 3 runs when at least one
   expected type has samples; the card names each expected type that did not arrive ("No weight
   came through — what do you weigh?"). A receipt with zero saved samples does not advance the
   chat.
   The turn route copies these values into the draft **from the same server read**, never from the
   client, with `source = health` and the sample date. Another account's source id returns no rows.
7. **Reload between Add Shortcut and Connect.** The draft keeps `pending_health_source_id`, not
   the token. If the page reloaded and the token is gone, Connect calls the connect route again,
   which rotates the source (step 2). Tests: reload after Add Shortcut → Connect works, the old
   token answers 401; a double tap on Connect → exactly one active shortcut source for the account,
   equal to `pending_health_source_id`.
8. Daily sync needs a personal automation, which a shared shortcut cannot install. The coach offers
   a short guided step at the end of onboarding or on day 2.
9. "Not now" and every failure continue the chat and ask the body questions directly.

Ingest recovery (finding 8): **DECIDED (run):** no change to the event and apply split in this
phase. Reason: a failed apply leaves no samples, so step 6 does not advance, and a rerun of the
shortcut has a new `sent_at`, so a new payload hash, so it is not `duplicate`
(`health-ingest.ts:97`). The chat offers "Try again" after 90 s. Making the two RPCs atomic is in
"Later" (it touches every ingest source).

Honest tap count: Yes → Add Shortcut → Add (in Shortcuts) → back → Connect → Health sheet (Turn On
All, Allow) → the first-run "allow sending to <host>" prompt. About eight taps, no typing.

**Server changes for Health:**
- New ingest types `height` (unit `cm`) and `body_fat_percentage` (unit `percent`, 0–75) in
  `INGEST_SAMPLE_TYPES`, `INGEST_UNITS`, `SAMPLE_TYPES`, the normalizer, and the widened
  `health_samples_type_ck`.
- No new backfill window (a Shortcut body has no age limit, facts).
- Activity from Health only with at least **14 distinct completed local days** of steps in the
  window of days 1–28 before `local_date` (the account's zone), the same window the existing
  activity prompt uses (`lib/activity/prompt.ts:3-4,51-57`). Today (a partial day) is never counted
  or averaged, for steps or active energy; the read-back card shows averages over completed days
  only. Then `activityLevelForSteps`; else stage 5 asks (round 10 finding 2). Test
  `tests/onboarding/health-activity.test.ts`: 13 complete days plus today → stage 5 asks activity;
  14 complete days plus a low partial today → the level from the 14 days only.

### Apple Shortcut feasibility: what is known, the probe, and the fallbacks

What is known (Apple's Shortcuts user guide; the probe confirms each on iOS 26):
- `shortcuts://x-callback-url/run-shortcut` accepts `name`, `input=text`, `text`, `x-success`,
  `x-cancel`, `x-error`; the text arrives as Shortcut Input. Documented.
- **Save File** / **Get File** work in the Shortcuts folder of iCloud Drive with "Ask Where to
  Save" off. Behavior with iCloud Drive off is **not known**.
- The first **Find Health Samples** run shows Apple's Health permission sheet. Expected for a
  shared shortcut; not yet proved on iOS 26.
- The first **Get Contents of URL** to a new host shows a privacy prompt. Expected; one tap.
- A 30-day **Find Health Samples** query has no documented limit; the shortcut groups steps and
  active energy by day. "Group by Day" is expected, not yet proved on iOS 26.
- **Vercel Deployment Protection** on Preview answers 401 to a request without a Vercel login,
  which a Shortcut does not have. Not yet checked for this project; P5 below shows it.

Preview probe (`docs/probes/2026-09-shortcut-probe.md`; Devin or Sasha run it on a real iPhone):
- A probe variant of the Preview shortcut posts step markers to `POST /api/dev/shortcut-probe`
  (Preview tools gate, below). The page `/dev/health-probe` shows each step PASS / FAIL with the
  iOS version and timings.
- P1 input arrives through `x-callback-url`. P2 a second run with no input reads the saved file.
  P3 the Health sheet shows and each type returns data. P4 grouped 30-day rows ≤ 31 per type, run
  time < 20 s. P5 ingest reaches the Preview and samples are saved (step 6 status). P6 the back
  control returns to the PWA.

| Step fails | Fallback |
|---|---|
| P1 or P2 | Manual paste: the chat shows the input with Copy; the shortcut asks for it once through its Import Question (`docs/apple-health.md:12-18`) and keeps it in a Text action. |
| P3 | The coach explains how to allow access (Settings → Health → Data Access → Shortcuts) and continues without Health. |
| P4 | 14 days (still meets the 14-day activity rule), then 7 days; with under 14 days, stage 5 asks activity. |
| P5 | If Deployment Protection blocks it: a protection bypass for `/api/health/ingest` on Preview (Open for Devin). Otherwise show the server reason and offer Health Auto Export (paid; `docs/apple-health.md:63-79`; 7-day summaries, so activity is asked) or manual entry. |
| P6 | Copy tells the user to tap the back control; the chat moves on from saved samples anyway. |

The manual paste path ships in every case. The probe result is recorded in the Phase 10 plan.

## The server draft and serialized turns

**DECIDED (run):** onboarding writes bypass the outbox; the draft is server-held; stage 9 is one
server transaction; the client then fetches templates and pulls. Reasons: every turn needs the
model, so onboarding is online-only; a queued `onboarded_at` stamp once sent a finished account
back to step 1 (`onboarding-client.ts:213-218`); `constraint_profiles` is not outbox-synced;
templates are not client-writable in Phase 9.

Tables (migration `20261110090000_onboarding_schema.sql`; RLS on; `authenticated` gets select on
its own rows only; no write policies):
- `onboarding_drafts` — `user_id uuid pk references auth.users on delete cascade`, `thread_id uuid
  references coach_threads` (null only in `mode = 'form'`), `stage text not null`, `draft jsonb not null`,
  `confirmed_build_id uuid references onboarding_builds` (set only by "Looks right", below),
  `pending_health_source_id uuid references health_sources`, `mode text not null default 'chat'
  check (mode in ('chat','form'))`, `check (mode = 'form' or thread_id is not null)`, `rev int not
  null default 1`, `completed_at timestamptz`,
  `result jsonb`, `updated_at`.
- `onboarding_builds` — `id uuid pk`, `user_id uuid not null references auth.users on delete
  cascade`, `draft_rev int not null` (the draft rev the build was made from), `build jsonb not
  null`, `build_hash text not null` (SHA-256 of the canonical JSON), `created_at`. **Immutable:** a
  `before update` trigger refuses every update; rows are only inserted.
- `onboarding_turns` — `user_id uuid references auth.users on delete cascade`, `client_turn_id
  uuid`, `draft_rev_after int not null`, `response jsonb not null`, `created_at`, `primary key
  (user_id, client_turn_id)`.

**Turn flow** (`POST /api/onboarding/turn` through `accountFetch`, body `{ client_turn_id,
expected_rev, message | reply }`):
1. `requireUser` runs the Phase 9 account and client checks (`409 account_mismatch`, `426
   client_upgrade_required`). The body is read with `readJson` and a 16 KB bound (the coach
   route's `MAX_BODY_BYTES`, `app/api/coach/route.ts:25`); a message over 2,000 characters answers
   413.
2. If `(user, client_turn_id)` exists in `onboarding_turns`, return its stored `response` (double
   tap, lost response after commit). This check runs **before** the budget, so a replay is never
   charged and never answers 429 (round 9 finding 3).
   **Turn budget (round 8 finding 4):** then, before any model call, `enforceSharedRateLimit` (the
   database-backed limiter from Phase 9 §1.3, shared across instances) is called twice with
   **distinct keys**, because counters are keyed by `(key, window_start)`:
   `onboarding:turn:10m:<user>` (30 per 600 s) and `onboarding:turn:day:<user>` (150 per
   86,400 s). Over either budget answers 429 and makes no model call. A full onboarding needs
   about 20 turns. Tests: 31 unique turn ids in 10 minutes → the 31st answers 429 and neither the
   Gemini adapter nor `systemOne` is called; at the limit, a retry of an already stored
   `client_turn_id` returns its stored response (not 429); turns on both sides of a UTC day
   boundary count against the right day window and never share a counter row with the 10-minute
   window.
3. Read the draft; if `rev ≠ expected_rev`, answer **`412 draft_changed`** with the current draft;
   the client re-renders and does not resend. **DECIDED (run):** 412, not 409. Reason: Phase 9 uses
   409 for `account_mismatch`, and the client must never confuse the two.
4. Health gate (above), extraction, judge, machine — outside any lock. Steps 2 and 3 are only a
   fast path; step 5 repeats both checks under the lock.
5. `onboarding_commit_turn(p_user_id, p_expected_rev, p_client_turn_id, p_draft, p_stage,
   p_messages, p_action, p_build, p_health_source_id)` — `security definer`, **execute granted to
   `service_role` only**; the route calls it after `requireUser`. In one transaction it:
   - takes the **per-user onboarding lock**: `pg_advisory_xact_lock(hashtextextended('onboarding:'
     || p_user_id::text, 0))`. The same lock is the first statement of
     `onboarding_rotate_health_source` and `complete_onboarding`. It exists before any draft row,
     so it also serializes the first turn;
   - rechecks `(p_user_id, p_client_turn_id)` in `onboarding_turns` under the lock and returns the
     stored `response` if present (two simultaneous retries with one id write once);
   - **checks eligibility (round 8 finding 2):** `account_claims.seed_policy = 'default'`,
     `user_settings.onboarded_at` null (or no row), the draft's `completed_at` null and `mode =
     'chat'`; else it raises `already_onboarded` or `form_chosen` and writes nothing. The route
     runs the same check (read only) before step 4, so an ineligible account costs no model call;
   - rechecks the revision: with no draft row, `p_expected_rev` must be 0 and the function inserts
     the draft and the onboarding thread; with a draft, `rev` must equal `p_expected_rev`. Else it
     raises `draft_changed` (412), never a unique-constraint error;
   - when the turn copies Health values, `p_health_source_id` must equal the current
     `pending_health_source_id` (else `draft_changed`);
   - requires `thread_id` to be a `kind = 'onboarding'` thread with `user_id = p_user_id`; allocates
     message `seq` values under the lock (not `nextSeq`); inserts the messages; writes the draft
     with `rev + 1` and clears `confirmed_build_id` (any draft change voids an approval); inserts
     the `onboarding_turns` row.

   `p_action` is one of:
   - `summary` — the stage-8 turn. **Before** the call, the route computes the next draft and, from
     that same in-memory draft, the build with `buildFrom(draft)`: the profile fields,
     `template_base_version` (`templates_version` read just before), `time_zone` and `local_date`
     (below), a `derivation_inputs` snapshot (sex, birth year, height, weight, `weight_source`,
     activity, goal, `goal_rate_bp_week`, training weekdays, `body_fat_pct`, `body_fat_source`,
     `body_fat_measured_on`, `effective_date`, `formula_name`), and, when the six inputs are known,
     the target revision from `deriveTargetRevision` over exactly that snapshot with `today =
     local_date` and `latestWeighInKg = null`. **DECIDED (run):** `latestWeighInKg = null`, so
     `weight_source` is always `"onboarding"` (`derive.ts:94`). Reason: the weight in the build is
     the one the user confirmed at the summary, whether typed or from Health; the build's own
     weigh-in is written in the same transaction, before the target (step 7). No weight selector
     is called at the summary. It passes the build as `p_build`.
     **Time zone and local date (round 4 finding 6):** every turn body carries the device zone
     (`Intl.DateTimeFormat().resolvedOptions().timeZone`); the route validates it with
     `ianaTimeZoneSchema` (`lib/health/contract.ts:47-48`) and stores it in the draft. At the
     summary, `local_date` = today in that zone. The build uses `local_date` for the target's
     `effective_date` and for the weigh-in date, and saves `time_zone` to `user_settings.time_zone`. The function inserts it into
     `onboarding_builds` with `draft_rev = rev + 1`, in the same transaction as the draft write.
     The summary card is rendered from that build row and carries its `id` and `build_hash`.
   - `approve { build_id, build_hash }` — "Looks right". It carries no field values. The function
     accepts it only when the build row belongs to the user, its `build_hash` matches, and its
     `draft_rev` equals the current `rev` (no change since the summary). Then it sets
     `confirmed_build_id = build_id` and bumps `rev` without other draft changes. Else it raises
     `stale_summary`; the route answers 412 and the chat shows the summary again from a new build.
   - `edit` and every other turn — changes the draft and so clears the approval.
6. The advisory lock is the per-user serialization point, including before the draft exists. Two
   tabs: the second commit fails the rev check and gets 412. Two first turns: one inserts the
   draft; the other sees `rev` 1 under the lock and gets 412.

**The onboarding thread is closed to every other writer.** The migration adds:
- `resolveThread` (`lib/server/coach-threads.ts:98-108`) selects `kind` and answers 404 for a
  thread whose `kind = 'onboarding'`, so a normal coach turn cannot write into an onboarding
  thread. Other kinds keep today's behavior.
- Restrictive RLS policies: on `coach_messages`, `insert`, `update` and `delete` by
  `authenticated` are refused when the parent thread's `kind = 'onboarding'` (today
  the owner has all four: first `coach_messages_rw` in `20260911000500_rls.sql:56-58,67`, now the
  `user_id = auth.uid()` policy of `20261103090100` (PR #250, applied); on
  `coach_threads`, `authenticated` cannot insert a row with `kind = 'onboarding'`, and cannot
  update or delete one. Only the service-role functions write them.
- **The user cannot delete the onboarding thread in Phase 10 (round 5 finding 8). DECIDED (run):**
  `DELETE /api/coach/threads/[id]` on an onboarding thread gets no row back from its RLS update
  and answers 404 as it does today for an unknown thread (`app/api/coach/threads/[id]/route.ts:
  55-67`). The thread goes only with the account (`on delete cascade`). Reason: a user-deletable
  onboarding thread needs a column-limited update path; that is more machinery than the value, so
  it is in "Later". Phase 11 lists the onboarding thread as pinned; its spec must show it without
  a Delete control (a note for the Phase 11 spec owner, Open for Devin).
- Tests: a coach turn with an onboarding thread id answers 404; a direct insert, update and delete
  of an onboarding message with the user's JWT is refused; a direct change of the thread's `kind`
  is refused.

Offline: the chat shows "You're offline — setup needs a connection" and retries when online. No
onboarding turn is queued. The client keeps no transcript copy; any cached view uses
`accountKey("onboarding:view")` (Phase 9 §0) and is purged on sign-out.

## The stage-9 build

**`complete_onboarding(p_expected_rev int) returns jsonb`** — `security definer`, execute granted
to `authenticated` (called through `accountFetch` by `POST /api/onboarding/complete`); identity
`auth.uid()`. It takes **no build data** from the caller. It reads the immutable
`onboarding_builds` row that `confirmed_build_id` names, which only the service-role turn commit
created and only the user's approval selected. In one transaction it:

1. Takes the per-user onboarding lock, then **the same `user_settings` lock `apply_sync_op` takes**
   (`pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':user_settings:settings', 0))`,
   `20260919090300_phase3_sync_entities.sql:436`), then locks the draft. So an outbox
   `user_settings` op that already read the old `rev` finishes before completion reads the row,
   and an op that arrives later waits, then sees the bumped `rev` and answers `conflict` instead of
   writing `onboarded_at = null` (round 4 finding 2). Lock order is always onboarding, then
   settings, then templates (step 4). If the draft's `completed_at` is set, returns that draft's
   own `result` (replay-safe). Otherwise requires, under the locks, `account_claims.seed_policy =
   'default'` and `user_settings.onboarded_at` null or no `user_settings` row; an account that
   finished by the form (or any other way) raises `already_onboarded`, writes nothing, and the chat
   goes to Today (round 5 finding 2). Then requires `rev =
   p_expected_rev`, `confirmed_build_id` not null, and that build's `draft_rev = rev - 1` (the
   approval was the last change); else raises `draft_changed` / `not_confirmed`.
2. Validates the build in SQL: every value inside its range; `goal` in the four `Goal` values or
   null; `goal_rate_bp_week` a preset of that goal or null; `body_fat_source` in the PR #241 set,
   with `body_fat_measured_on` required for `dexa`/`inbody`; slots in the closed vocabulary;
   `time_zone` is in `pg_timezone_names` and `local_date` is within one day of today in that zone
   (else `stale_build`, and the chat shows the summary again from a new build); every field of
   `derivation_inputs` (sex, birth year, height, weight, `weight_source = 'onboarding'`, activity,
   goal, `goal_rate_bp_week`, training weekdays, body fat value, source and date, `effective_date
   = local_date`, `formula_name`) equals the build's profile field of the same name; and **every**
   field of the target revision's `TargetInputs` (`effectiveDate`, `weightKg`, `weightSource`,
   `trainingWeekdays`, `activity`, `goal`, `goalRateBpWeek`, `formulaName`,
   `f743cfb:lib/types.ts:56-65`) equals the matching `derivation_inputs` field, with
   `goalRateBpWeek` compared to `coalesce(goal_rate_bp_week, 0)`. Any failure raises `bad_build`.
   Sex, birth year, height and body-fat provenance are checked through `derivation_inputs`, because
   `TargetInputs` does not hold them.
3. Upserts `user_settings` (with `onboarding_generation = 1` and, for a form build, the pinned
   `training_kcal`, `rest_kcal`, `protein_g`): `display_name`, sex, birth year, height, weight, units, activity level,
   goal, `goal_rate_bp_week`, `body_fat_pct`, `body_fat_source`, `body_fat_measured_on`, training
   weekdays, diet prefs, `time_zone = build.time_zone`, `onboarded_at = now()`. **On insert** (a
   fresh account has no row, Phase 9 §2.6) it also sets `first_opened_at = now()`, which is `not
   null` with no default (`20260911000200_user_schema.sql:88-90`); on update it keeps the stored
   `first_opened_at`. Other columns take their defaults. Bumps `rev` (insert: 1); writes one
   `user_settings` change row.
4. Calls `replace_day_template` when the Stage 7 conditions hold; else records `template_kept`.
5. Upserts `constraint_profiles` with confirmed allergens and conditions, **plus the existing
   flag mapping** that the form applies (round 5 finding 4): the build carries the constraint patch
   that the route computes at the summary with the same `FLAG_ALLERGENS` and `FLAG_CATEGORIES`
   tables the form uses (`lib/profile/onboarding-state.ts:352-364`; for example `no_peanuts` →
   `peanut`, `low_fodmap` → `onion_garlic`, `beans`), so `avoid_allergens` and
   `banned_categories` hold what catalog search and barcode policy read
   (`lib/server/catalog.ts:129-135`, `lib/server/barcode.ts:68-72`). Empty arrays when none. The
   mapping is imported, not copied, so the form and the chat cannot drift.
6. Calls `set_food_membership` once per confirmed Eat and Avoid name. Writes one `user_food_prefs`
   change row per pref row this transaction changed (`updated_at = now()`, key `food_ref_id`,
   `current = to_jsonb(row)`). Records per name the refs updated and the `truncated` flag in
   `result`. No `user_foods` row is created (see Eats and Avoids).
7. **Writes the typed weigh-in, then the target (round 24, DECIDED (run), same decision as Phase
   12).** There is **no** exact weight-match check and **no** `build_stale` retry path (rounds 21–23
   are superseded). The summary derives the targets from the **draft's** weight, whether from Health
   or typed (`buildFrom(draft)` with `latestWeighInKg = null`, `lib/profile/derive.ts:115`), and
   shows that weight. In this transaction:
   - Step 3 has already written `weight_kg` and `time_zone` to `user_settings` (the profile
     first).
   - When the weight was typed, it calls `health_weigh_in(local_date, time_zone, weight_kg)`
     (`auth.uid()` is the caller, as that function requires) **before** the target, so the saved
     weigh-in and the saved target agree (round 24 finding 2).
   - Then, when the build has a target revision, it calls exactly
     `write_target_revision_checked(auth.uid(), <revision row>, null)` (Phase 12 §1.1: three
     arguments, no floor parameter). `complete_onboarding` is `security definer` with the same
     owner, so it may call the service-role-only writer inside its own transaction. The writer
     selects a weight under its locks and computes the calorie, fat and protein minima from that
     weight; it writes its own change row. It replaces `write_target_revision` here.
   - **Accepted residual (Open for Devin 12):** the writer's selected weight can differ slightly
     from the draft's weight (for example a Health sample that arrived after the summary, or a
     same-day device sample that outranks a typed value). The target is then derived from a
     slightly older weight, but it is written only when it is above every minimum the writer
     computes from the newer weight. The normal retarget after the next weigh-in corrects it.
   - **`below_floor` (SQLSTATE `SF001`) is the only refusal handled here.** The whole completion
     rolls back. A form build returns to "Your plan" with "That is below the safe minimum of N"
     under the field the writer names (a pin below a minimum). A chat build shows a new summary:
     the route **re-stamps the build date to the server's today** in the draft's `time_zone`
     (round 25 finding 2: never the rejected build's `local_date`), calls
     `account_body_mass_kg(p_user_id, <new local_date>)` with the service role and that
     **explicit** date (round 24 finding 1: never the default date, which depends on a
     `user_settings` row a fresh account may not have), puts that weight into the draft through a
     service-role turn commit (which clears the approval), and derives a new summary for the new
     date. **One retry only:** the draft records `floor_retry_used = true`; if the next completion
     is refused with `SF001` again, the chat does not rebuild and asks the user instead: "Your
     targets are below the safe minimum for your current weight. Tap Edit to change your weight or
     goal, or choose a form." The user taps Looks right again after a rebuild or an edit.
   - Tests: (a) fresh chat and fresh form completion with a typed weight and no Health samples →
     complete, the weigh-in and the target both carry the typed weight; (b) a typed weight against
     an older stored Health weight, without and with a same-day device sample → completes, the
     weigh-in holds the typed value, the target is above every minimum (residual case documented);
     (c) a form pin of 0 g protein → `SF001` and the field error; (d) a chat build that falls below
     the minimum after a new Health sample → `SF001`, new summary with the service-role weight read
     on the explicit `local_date`, second approval completes; (e) a fresh Health account with no
     settings row near a UTC day boundary: the service-role read uses the explicit re-stamped date;
     (f) approval at 23:55 local, a higher Health sample after midnight, completion after midnight
     → `SF001`, the rebuild uses the new local date and the new weight and completes; a second
     `SF001` does not rebuild again and shows the ask-the-user line.
9. Sets `completed_at`, `pending_health_source_id = null` (the source stays active) and `result`
   (`{ targets: "set" | "needs_profile", template: "replaced" |
   "kept", eats_needing_details: [...], avoids_not_enforced: [...], avoided: [...] }`).
10. **Writes the stage-10 message (round 16 finding 4).** In a chat-mode draft it inserts one
    assistant message into the onboarding thread: `insert into coach_messages (thread_id, user_id,
    role, content, tool_calls, seq) values (draft.thread_id, auth.uid(), 'assistant', <hand-off
    text>, '[]'::jsonb, <max seq + 1 under the onboarding lock>)` — text only, no buttons (round 17
    finding 4). `tool_calls` is `not null` with default `'[]'::jsonb`
    (`20261001000000_phase7_coach.sql:44-46`), so the insert passes `'[]'::jsonb` (round 18
    finding 1). The completion integration test runs against the real local schema. The function is security
    definer and owns this write, so the thread's restrictive RLS does not block it; the thread is
    checked to be this user's `onboarding` thread. The insert is idempotent: a replay returns at
    step 1 (the draft's `completed_at` is set) and never inserts again. A form-mode draft has no
    thread; the form shows the same text on its last screen. Test
    `tests/onboarding/handoff.test.ts` (extended): after completion, a reload shows the stage-10
    message in the thread; a replayed completion adds no second message.

Any failure rolls back all of it; the chat shows "That didn't save — try again" with Retry.

After the call the client runs, for the bound account: `GET /api/plan/templates` (stores the new
`version` in `meta`), one `pullChanges` pass (Phase 9 §0 rules), then shows stage 10 in the chat.
**One navigation rule (round 15 finding 4):** the app goes to Today only when the user taps "Go to
Today" on stage 10, and that button is enabled only after the templates fetch succeeded (round 5
finding 6). **Holding stage 10 (round 19 finding 4):** once completion sets `onboarded_at`, any
auth event makes `AuthGate` re-read the account and `gateRedirect` sends `/onboarding` to `/`
(`components/AuthGate.tsx:178-183,286-288,321-323`). So the page sets a per-account
`sessionStorage` flag, `accountKey("onboarding:handoff_open")`, **immediately before it sends the
completion request** (round 20 finding 4), so the hold covers the server commit, the templates
fetch, "Finishing setup…" and every Retry; it clears the flag on "Go to Today", and on a completion
answer that returns the user to the chat (`below_floor`, `not_confirmed`, `draft_changed`).
**DECIDED (run):** a client flag set before the call, not a server field written by
`complete_onboarding`. Reason: the hold only has to outlive this page's own auth events, and a
server flag would need its own owner-checked write path to close it. While the flag is set, `gateRedirect` returns `null` for `/onboarding` in the `in` state
and `gateView` renders the page; the flag is dropped by the Phase 9 sign-out purge, so it never
leaks to another account. Tests: the server commits, the templates fetch fails, an auth
`TOKEN_REFRESHED` event fires → the page stays on "Finishing setup…" with Retry; stage 10 is open
and the same event fires → the page stays on stage 10; "Go to Today" clears the flag and opens Today; a reload with the flag set
reopens stage 10 from the stored message. Test: after completion the chat shows stage 10 and stays; "Go to Today" is disabled
until the fetch succeeds; tapping it opens Today. If the fetch fails, the chat shows
"Finishing setup…" with Retry; Retry calls `complete_onboarding` again (replay returns the stored
`result`) and then the fetch. If the app closes first, the gate finds `onboarded_at` on the next
open, and Today follows Phase 9's rule: with no stored templates it shows the pending state and
fetches on `onAccountReady` (Phase 9 §2.8). Test: the network drops right after the server
commits; Today never renders the old default slots.

**Stale settings writes are refused, never rewritten (round 11; replaces the coercing triggers of
rounds 5, 6 and 10).** A trigger that silently changes the saved row while the op answers
`applied` leaves the phone mirror wrong: the client takes its sent payload as the server row
(`lib/sync/settings-intents.ts:339-345`) and ignores a same-revision pull (`:360`). So Phase 10
does not rewrite any settings write. Two rules make every stale write impossible or refused:

1. **No old build can write for an invited account (round 11 finding 2).** Invited accounts exist
   only after the Phase 10 build ships: `NEXT_PUBLIC_INVITE_SIGNUP=1` and the first invite code on
   production come **last**, after the Phase 10 deploy and after `MIN_CLIENT_BUILD` is set to that
   build (Open for Devin 3; this is stricter than Phase 9's rollout, which opens invites after
   Phase 9 slice 6). Phase 9's minimum-client gate (§1.5b) makes `requireUser` answer `426
   client_upgrade_required` for a `default` account on any build below the minimum, so **every**
   write route an invited account reaches — `/api/sync/ops`, `/api/health/weigh-in`,
   `/api/targets`, `/api/constraints`, the onboarding routes — refuses an old build. An invited
   account's first session runs the new build, and the new build's form for a `default` account
   uses only the one-writer path ("One writer"). So no old-form settings op, target request or
   queued weigh-in (`lib/health/weigh-in-client.ts:217,243`) can ever exist for an invited
   account. A read-only check before invites open (Open for Devin 3) lists every `default`
   account that already exists; it must be none (Preview accounts live only on the Preview
   branch).
2. **Only `complete_onboarding` may change an invited account's stamp; any other change is
   refused.** A `before insert or update` trigger on `user_settings`, for an account whose
   `account_claims.seed_policy = 'default'`: `complete_onboarding` sets
   `set_config('app.onboarding_complete', 'on', true)` (transaction-local) before its upsert and
   passes. Without that flag, a write that would **change** `onboarded_at` (null to a value, a
   value to null, a value to another value; any non-null value on insert) **raises**
   `onboarding_stamp_locked`. The row does not change, and `apply_sync_op` answers `{ status:
   "error", message: "onboarding_stamp_locked" }`. **Client handling (round 12 finding 2):** today
   an `error` result retries three times and then parks (`lib/sync/outbox.ts:194-209,309-311`),
   and Sync Status offers only **Sync now**, which releases parked entries for another try
   (`components/SyncStatus.tsx:28-73,134-143`), so a Discard control would be new UI. **DECIDED
   (run):** no Discard control. The outbox result handler (`lib/sync/outbox.ts:291-320`) treats this
   one message as a **permanent** refusal and settles it through a new settlement kind in the one
   existing settlement transaction: `settleUserSettings(op, { status: "refused", row, rev })`,
   where `row` and `rev` come from a fresh pull. In one IndexedDB transaction over
   `[user_settings, outbox, meta]` (`lib/sync/settings.ts:231-262`) it: deletes **only** the
   refused entry and its generation's intents; clears `sent` when it names that entry (round 13
   finding 1: a null settlement leaves `sent` set, `settings-intents.ts:319-335`, and the next
   send then skips freezing the successor, `settings.ts:155-173`); moves the baseline to the
   fetched row and rev; rewrites every later pending generation and the meta's current intents
   onto that baseline, as a conflict does today; rebuilds the mirror. A newer edit is kept and sent
   next. Sync Status shows one line,
   "A settings change from before setup was not applied.", until the next successful sync.
   Reason: the refused change is always automatic pre-setup data (the gate blocks every settings
   screen before `onboarded_at`), so there is nothing for the user to choose; any other `error`
   keeps today's retry-then-park rule. A write that does not change the stamp (every normal edit
   after completion, which sends only changed fields) passes.
   Because nothing is rewritten, an applied entry's payload is the saved row, and the phone mirror
   stays true.
   This covers the only stale new-build case: a settings entry queued before completion (for
   example a first-open row with `onboarded_at: null`) and replayed after completion carries the
   null stamp as an intent and is refused whole, so its stale profile fields never land either.
3. **Client, before completion** (unchanged): the chat calls `flushOutboxNow()` and completes only
   when no `user_settings` entry for this account is left; the gate blocks every settings screen
   until `onboarded_at` is set.
4. **Client, after completion** (unchanged): no reset; the pull settles through
   `settleUserSettings(null, pull)` (`lib/sync/settings.ts:231`), which keeps pending newer edits.
   Two-tab test `tests/onboarding/two-tab-settings.test.ts` as before.
5. **A settings entry made before its device learned of completion is refused (rounds 12 and 14;
   replaces the round 12 `base_rev` rule).** `AuthGate` queues `captureTimeZone()` on the first
   online open of any account, including an unfinished one (`components/AuthGate.tsx:306-310`),
   and a `conflict` settles today by replaying intents onto the new row
   (`lib/sync/settings-intents.ts:226-233,315-324`; `lib/sync/outbox.ts:165-178`). A `base_rev`
   test cannot tell such an entry from a real edit: a second device opens the app from the gate's
   server read before its own pull (`AuthGate.tsx:296`) and writes on its local baseline
   (`settings-intents.ts:275`), so a genuine edit can carry an old `base_rev` (round 14 finding 1).
   Phase 10 uses an **onboarding generation marker** instead:
   - `user_settings.onboarding_generation int not null default 0`; `complete_onboarding` sets it
     to 1 in the same upsert. The gate's server read (`lib/profile/onboarding-state.ts:125`) also
     selects it.
   - The device keeps the highest generation it has seen, from the gate read or from any pulled
     settings row, under `accountKey("onboarding_generation")`. Every new `user_settings` entry
     (`mutateSettingsRow`, `lib/sync/settings.ts`) is stamped with that value as
     `onboarding_generation` on the entry; a generation keeps the stamp of the entry that created
     it, including across conflict replays.
   - **On the queued record (round 17 finding 3).** `onboarding_generation` is a field of the
     outbox record itself (`OutboxOp`), set when the entry is created, and **copied on every
     rebuild**: every op constructor in `lib/sync/settings.ts` (`mutateSettingsRow`,
     `captureTimeZone`, the `fresh` carrier) and `writeCarrier` (`lib/sync/settings.ts:201-217`,
     which today rebuilds the carrier by naming fields one by one) take it from the carrier or the
     generation that owns the intents, never from a default. A shared helper,
     `withOnboardingGeneration(op, source)`, is used at each site, and a unit test fails if any
     constructor in that file builds a `user_settings` op without it. Test
     `tests/onboarding/generation-rebase.test.ts` (two `fake-indexeddb` devices): after completion,
     device B (generation 1 from the gate read, old local baseline) edits units; the first send
     hits an ordinary rev conflict; `writeCarrier` rebuilds the op; the retry still carries
     generation 1 and applies.
   - **On the wire (round 16 finding 2).** The marker is a top-level field of the op, not part of
     `payload`: `SyncOp` gains `onboarding_generation?: number`, and `SyncOpSchema`
     (`lib/sync/types.ts:54-62`, which strips unknown top-level fields) gains
     `onboarding_generation: z.number().int().nonnegative().optional()`. `wireOp`
     (`lib/sync/outbox.ts:127-131`) removes only queue bookkeeping, so the field is sent. The route
     passes the parsed op to `apply_sync_op` as `p_op`, which reads
     `(p_op->>'onboarding_generation')::int`; a missing value counts as 0. The conflict result type
     (`OpResult`, `lib/sync/types.ts`) gains `reason?: "before_onboarding"`. Test
     `tests/sync/onboarding-generation-wire.test.ts`: the stamp survives queue, `wireOp`, schema
     parse, the SQL read, a conflict answer and a retry.
   - `apply_sync_op` (patched by anchored replacement, the PR #241 pattern), for a `user_settings`
     entry of a `default` account: when the entry's `onboarding_generation` is lower than the row's,
     it answers `conflict` with `reason: "before_onboarding"`; otherwise today's rev rules apply
     unchanged (a `base_rev` mismatch is an ordinary conflict with replay).
   - The client settles `before_onboarding` with the `refused` settlement above: only that
     generation and its intents are dropped, `sent` is cleared, the baseline becomes the server
     row, and later generations are kept.
   - Why a real edit is safe: a device can show Settings only after its gate read returned
     `onboarded_at`, and that same read gives it generation 1, so every edit made there is stamped
     1 and applies even before the device's pull. Only an entry created while the device still
     knew generation 0 (the automatic zone capture on an unfinished account) is refused.
   - `captureTimeZone()` also runs only when the disposition is `none`, so an unfinished account
     queues no zone entry at all; the build sets the zone.
   Test `tests/onboarding/second-device-zone.test.ts` (integration plus two `fake-indexeddb`
   devices): device A in `America/Denver`, device B in `Europe/London`. (a0) B opens while
   unfinished: normal use queues **no** zone entry (capture waits for onboarding). (a) The test
   then seeds B's outbox with an explicit settings entry stamped generation 0 (a zone of
   `Europe/London`), B goes offline, A completes, B drains → `before_onboarding`, the entry is
   dropped, `time_zone` stays `America/Denver` on the server and in B's mirror. (b) After A completes, B opens (gate read gives generation 1), goes to Settings
   **before** its pull finishes and changes units → the entry is stamped 1 and applies (after an
   ordinary rev conflict and replay if its baseline was old); the server has B's units and the
   approved profile.

Tests:
- `tests/onboarding/stamp-refused.test.ts` (integration plus `fake-indexeddb`): queue a whole-row
  settings entry with `onboarded_at: null` and stale weight, sex and goal before completion;
  complete; run the full drain (conflict, intent replay, resend, pull). The entry answers `error`
  (`onboarding_stamp_locked`) or, in the usual case, `conflict` with `before_onboarding`; either way
  the entry is removed, nothing is re-sent, the server row equals the approved build, the phone
  mirror equals the server row, and Sync Status shows the one-line notice for the stamp case. A
  normal units edit after completion applies. A third case (round 13 finding 1): while the refused
  entry is in flight (`sent` names it), the user's units edit is queued; after the refusal the
  units entry is frozen and sent next, applies, and the mirror equals the server row.
- `tests/onboarding/old-build-refused.test.ts`: as a `default` account with `x-smc-client` below
  `MIN_CLIENT_BUILD`, `/api/sync/ops`, `/api/health/weigh-in`, `/api/targets`,
  `/api/constraints` and each onboarding route answer `426` and write nothing.
- The rollout check (Open for Devin 3) is a read-only script, `scripts/p10/default-accounts-check.sql`,
  that prints every `account_claims` row with `seed_policy = 'default'`.

### Eats and Avoids

**DECIDED (run), smallest safe version:** Reason for both rules: rotation and policy read refs,
not names (`lib/store.ts:274-300`, `lib/rotation.ts:171-194`, `lib/policy/constraints.ts:141-142`),
and a food with invented nutrients would size meals wrongly.

- **Eats.** A confirmed Eat is recorded through `set_food_membership`. It joins rotation only
  through a `user_foods` row of this account that has a role pref and per-100 g protein, carbs and
  fat. A new account has no user foods, so in practice every Eat from onboarding is listed in
  `eats_needing_details`. **Round 13 finding 3:** a name with no ref is kept only as a name-level
  membership, which no screen or coach context reads (Foods lists `user_foods`,
  `lib/store.ts:274-311`; coach context reads `user_food_prefs`, `lib/server/coach-context.ts:
  129-146`), so the app never says it is "saved". **The hand-off is one chat message (round 15;
  the round 14 Today card is removed).** Stage 10 is a single coach message in the onboarding
  thread: "Oat milk and salmon aren't in your Foods yet. Add them from Foods to use them in your
  meals." **No Add buttons (round 17 finding 4, DECIDED (run)):** `/foods` exists (`app/foods`),
  but neither it nor `AddFoodSheet` accepts a prefilled name (`components/AddFoodSheet.tsx:101`),
  the coach `ui` button only sends its label as chat text (`components/coach/blocks/ui.tsx:50`),
  and the add sheet always creates an Eat (`AddFoodSheet.tsx:143`), which is wrong for an Avoid.
  So the lines are plain text naming Foods; the user adds each food there and marks Avoids there.
  A prefilled, Avoid-aware add route is in "Later". Nothing persistent is added to Today, and no
  dismissal state exists. The message stays readable in the onboarding thread (Phase 11 lists it).
  Test `tests/onboarding/handoff.test.ts`: stage 10 names each food in plain text and contains no
  button. The coach makes **no rotation promise** for a
  catalog-only or unmatched Eat. Composed slots without Eats show without meals, as Phase 9 §2.6
  already does for a fresh account.
- **Avoids.** A confirmed Avoid is recorded through `set_food_membership` at completion. **Round 16
  finding 3:** the stage-8 summary is shown before that write, so it says only "X — will be added
  to your Avoids". The real outcome is reported **after** completion, in the stage-10 message,
  from `result`: "Avoided: X" when the write updated at least one ref and `truncated` is false; and
  for every name in `avoids_not_enforced` (zero refs or `truncated`), one honest line: "X: noted,
  not blocked — add it from Foods and mark it Avoid." Nothing persistent is shown later, and no
  warning is cleared by a later food row (round 15 finding 2). An allergen named in the same answer is also saved in `constraint_profiles`
  (`avoid_allergens`), which policy checks by allergen tags (`constraints.ts:135-140`).
- **Allergens: honest limits (round 6 finding 2). DECIDED (run), cut:** catalog ingredient tags
  default to an empty array (`20260911000100_catalog_shell.sql:43`), and policy treats an empty
  array as "no allergen" (`constraints.ts:99-112,135-140`), so a food whose allergens were never
  assessed can show as allowed. Phase 10 does not change the policy engine. It never says an
  allergen is "blocked": the summary and hand-off say "I'll warn you when a food lists peanut. Many
  foods don't list allergens, so always check the label." Reason: fixing assessed-absence evidence
  touches every policy reader (catalog, barcode, Floor Day) and belongs with the policy owner;
  "Later" and Open for Devin carry it. Test: the summary and hand-off for a confirmed peanut
  allergy show that line and never the word "blocked"; a documenting test records that a food with
  empty tags evaluates `allowed` today, so the later policy fix flips it on purpose.
- **Diet flags: honest limits (round 6 finding 3). Cut:** only the mapped flags reach
  `avoid_allergens` and `banned_categories` (`onboarding-state.ts:352-364`). `vegan`,
  `vegetarian`, `pescatarian`, `no_pork`, `kosher` and other unmapped flags are saved in
  `diet_prefs`, and ordinary coach turns receive them (below), but catalog search passes no preference flags to
  policy (`lib/server/catalog.ts:262-270`) though rules exist (`lib/policy/facet-rules.ts:22-26`).
  The summary shows each unmapped flag as "Saved — I'll keep it in mind, but search results don't
  filter by it yet." Wiring the flags into catalog and barcode policy is in "Later". Test: a
  confirmed `vegan` flag shows that line.
- **Diet flags in ordinary coach turns (round 7 finding 2).** Today flags reach the prompt only
  through the gated profile line (`lib/server/coach-context.ts:70-93,96-104`). Like
  `displayName`, `buildCoachContext` reads `diet_prefs.flags` alone on every turn into
  `CoachContext.dietFlags` (the flag names only; no weight, goal, conditions or notes), and the
  prompt uses it for food suggestions. **Serializer (round 8 finding 3):** `renderCoachContext`
  (`lib/server/coach-context.ts:206-266`) adds `displayName` and `dietFlags` as top-level fields of
  the JSON it renders; neither is in the trim list, as `profile` is not (both are a few tokens).
  Test in `tests/coach/display-name-context.test.ts`: after onboarding with `vegan`, the
  **rendered** context string for "what should I eat for dinner?" contains `"dietFlags":["vegan"]`
  and the display name, and does not contain the `Profile:` line.
- Tests: a zero-ref Avoid and an over-50-ref Avoid both land in `avoids_not_enforced` and show the
  "can't block it yet" line; a catalog-only Eat lands in `eats_needing_details`.
- Enforcing a name-level Avoid in every policy path (including refs created later) and a catalog
  projection with verified nutrients are in "Later".

## `display_name`

- Column `user_settings.display_name text check (char_length(display_name) between 1 and 40)`,
  added to the `user_settings` branch of `_sync_current` / `_sync_upsert` by anchored replacement
  (PR #241 pattern).
- Client: `Settings.displayName` in the row mapping both ways (`lib/sync/user-settings.ts`), so the
  mirror keeps it.
- Consumers: the Settings profile section (a "Name" row with Edit, saved through the normal
  `user_settings` outbox op); the coach context. Today `buildCoachContext` loads the profile line
  only for profile actions and weight or target questions (`lib/server/coach-context.ts:96-104,
  182-196`). So the name is a **separate field**: `buildCoachContext` reads `display_name` alone
  on every turn (one column, owner RLS) into `CoachContext.displayName`, and the prompt uses it
  only to address the user. The profile line and its health fields keep today's gate. The coach
  never gives itself a name.
- Test `tests/coach/display-name-context.test.ts`: the first general chat turn after onboarding
  ("what's a good snack?") has `displayName` in the context and no profile line.

## The onboarding thread

- The chat is a `coach_threads` row with `kind = 'onboarding'`, created by the stage-1 commit. It
  stays as the user's first conversation so Phase 11 can recall it.
- Migration (the gap Phase 11 found): widen the check to `kind in
  ('chat','weekly_review','onboarding')`; unique partial index, one `onboarding` thread per user
  where `deleted_at is null`. Phase 11 then needs no schema change for it.
- The coach screen keeps reopening only `chat` threads (`CoachScreen.tsx:63`), so the hand-off opens
  a new chat thread.

## Migrations (after Phase 12's `20261108090000_phase12_target_floor.sql`)

Check `ls supabase/migrations | sort | tail -1` at implementation time.

- `20261110090000_onboarding_schema.sql`: thread kind widening and index; `onboarding_drafts`,
  `onboarding_builds` (with the no-update trigger), `onboarding_turns`; `user_settings.display_name`
  with the sync patch; `health_samples_type_ck` widened with `height` and `body_fat_percentage`;
  the restrictive thread and message policies; the `user_settings` stamp trigger that refuses (never
  rewrites) a stamp change outside `complete_onboarding`.
- **Fail fast (rounds 17, 18 and 20).** The **first** Phase 10 migration,
  `20261110090000_onboarding_schema.sql`, starts with the prerequisite check on the **exact**
  signature, so nothing of Phase 10 is applied without it: `do $$ begin if
  to_regprocedure('public.write_target_revision_checked(uuid, jsonb, jsonb)') is null then raise
  exception 'Phase 12 20261108090000_phase12_target_floor.sql must be applied before Phase 10';
  end if; end $$;`. `complete_onboarding` calls it with those three arguments. Because Phase 12's
  migration sorts first, a fresh local or CI stack applies it first. The thread-kind widening drops and re-creates
  `coach_threads_kind_check` with the union of the values present, so it is safe whether or not
  Phase 11 (`20261115…`, earlier in sort order) already widened it.
- `20261110090100_onboarding_functions.sql`: `templates_version(p_user_id)`,
  `replace_day_template` (service role only in Phase 10), `onboarding_commit_turn` and
  `onboarding_rotate_health_source` and `onboarding_stage_form_build` (service role only),
  `complete_onboarding` (authenticated);
  and a `create or replace` of the Phase 9 M2 `plan_days` key-validation trigger function
  (`20261106090000`) that adds the shared `templates:` lock as its first statement (Stage 7).
- Down files for both in `supabase/migrations/down/`.
- Backup (`app/api/jobs/backup/route.ts`): add to `TABLES` (`:36-48`) the Phase 10 tables
  `onboarding_drafts`, `onboarding_builds`, `onboarding_turns`, the existing
  `food_membership_revisions`, and — because the build writes the user's own schedule — the Phase 9
  tables `account_claims`, `day_templates`, `template_slots`, `slot_meals` and
  `slot_meal_components` (today none of these is in the list). `COMPOSITE_KEYS` entries
  (`:55-63`): `onboarding_drafts: ["user_id"]`, `onboarding_turns: ["user_id",
  "client_turn_id"]`, `food_membership_revisions: ["user_id", "name_norm"]`, `account_claims:
  ["user_id"]`, `slot_meal_components: ["slot_meal_id", "seq"]` (the others have `id`). If Phase 9
  already added its tables, Phase 10 adds only its own. This keeps the nightly JSON export
  **complete**; it does not make it a restore artifact.
- **Recovery artifact (round 4 findings 7, 8). DECIDED (run):** the restore path for Phase 10
  data is the existing whole-database dump, `scripts/backup.sh` (`pg_dump`, one consistent
  snapshot) restored with `scripts/restore-to-branch.sh` (`scripts/lib/database_backup.py:203-214`).
  The nightly JSON export stays a per-request copy with no restore path, as it is today. Reason:
  that is the only artifact with both a restore tool and a consistent snapshot; a JSON restore tool
  and a consistent nightly export are in "Later". The production step before each Phase 10
  migration uses `scripts/backup.sh` (Open for Devin).
- Tests:
  - `tests/jobs/backup-onboarding.test.ts` (integration, route level): after a completed onboarding,
    the nightly export holds rows of every table listed above for that account, and a table missing
    from `COMPOSITE_KEYS` without an `id` fails the test (no failed nightly run).
  - `tests/integration/onboarding-dump-restore.test.ts` (local stack, uses the real
    `scripts/backup.sh` and restore to a disposable local database): complete onboarding with a
    custom rhythm (no breakfast, two snacks), dump, restore, and assert `day_templates`,
    `template_slots`, `user_settings`, `account_claims`, the onboarding tables and
    `food_membership_revisions` equal the source. A second case holds `complete_onboarding` open
    (paused before commit), runs the dump, then commits: the dump holds either none or all of that
    account's stage-9 rows.

## Architecture

- `lib/onboarding/machine.ts` — pure stage machine: `(draft, event) → { draft, nextStage, ask }`.
- `lib/onboarding/draft.ts` — the draft type, provenance, thresholds, merge rules, `buildFrom(draft)`.
- `lib/onboarding/rhythm.ts` — stage 7 to slots.
- `lib/onboarding/extract.ts` — Gemini structured extraction per stage (zod schemas), purpose key
  `onboarding` mapped to `GEMINI_COACH`.
- `lib/onboarding/judge.ts` — the Jev questions.
- `lib/onboarding/health-connector.ts` — `HealthConnector` and the Shortcut implementation.
- `app/api/onboarding/turn/route.ts`, `app/api/onboarding/complete/route.ts`,
  `app/api/onboarding/health/connect/route.ts`, `app/api/onboarding/health/status/route.ts`.
- UI: the existing chat shell and blocks, full screen, a thin progress line.

## Testing

Every behavior below must be testable by Devin and Sasha on a Preview build, not only in CI.

### Preview-only controls (server-gated)

- One gate: `previewToolsAllowed(env)` in `lib/server/preview-tools.ts`. `true` only when
  `VERCEL_ENV === "preview"`, or when not on Vercel (`VERCEL` and `VERCEL_ENV` unset) and
  `PREVIEW_TOOLS=1` (local runs, CI). `false` whenever `VERCEL_ENV === "production"`, and when
  `VERCEL` is set without `VERCEL_ENV` (fail closed). Same pattern as
  `lib/server/dev-sign-in.ts:1-5`.
- Routes (404 when the gate is false, before auth and before any read):
  - **No Preview reset (round 20, DECIDED (run)).** The reset route of rounds 2–19 is removed:
    a correct reset needed one transaction across every user table, an epoch fence on every sync
    pass, and a purge that survives its own key deletion. Instead each test run uses a **fresh
    invited account** (`scripts/invite.ts create --uses 20 --label preview-runs` makes one
    multi-use code for testers). Nothing deletes account data on Preview.
  - `POST /api/dev/health/fake-backfill` — body `{ persona: "active" | "sedentary" | "no_scale" }`:
    calls the connect route's logic, then `applyIngest` with a generated 30-day envelope (the same
    code path as the phone).
  - `POST /api/dev/shortcut-probe` — probe step markers.
  - `GET /api/dev/preview-tools` — 200 when allowed. The UI shows the controls only after a 200;
    hiding in the UI is secondary.
- Fixtures for deterministic runs, honored only when `previewToolsAllowed()` is true:
  `ONBOARDING_MODEL=fixture` (scripted extraction, `lib/onboarding/fixture-model.ts`) and
  `ONBOARDING_JUDGE=fixture` (Jev answers replayed from `scripts/eval/onboarding-judge.cache.json`
  by normalized text; a missing entry fails the turn loudly).
- `tests/onboarding/preview-tools-gate.test.ts` — every dev route answers 404 with
  `VERCEL_ENV=production` (also with `PREVIEW_TOOLS=1`), with `VERCEL=1` and no `VERCEL_ENV`, and
  locally without `PREVIEW_TOOLS`; 200 on `preview`; both fixtures refused in production.

### Table-ops matrix (Phase 9 §3.2)

`tests/tenancy/table-ops.json` declares the three new tables, so the generated list still equals
the manifest: `onboarding_drafts: [select]`, `onboarding_builds: [select]`, `onboarding_turns:
[select]`. The matrix then proves, with two real JWTs, that A selects its own row, that A's
insert, update and delete on its own rows fail, and that every operation on B's rows affects zero
rows or fails. The new restrictive policies change no declared entry for `coach_threads` or
`coach_messages` (the matrix tests `chat` rows); `tests/onboarding/thread-guard.test.ts` covers
`onboarding` rows.

### RPC manifest (Phase 9 §3.3)

`complete_onboarding` is the only new function `authenticated` may execute, so it is added to the
Phase 9 RPC manifest with its cross-user case (round 5 finding 7): account A calls it directly
through PostgREST with A's JWT while B has an approved, unfinished build; the call changes none of
B's rows (settings, templates, constraints, prefs, targets, weigh-ins) and completes only A's
draft or answers `not_confirmed`. The manifest test also asserts that `replace_day_template`,
`onboarding_commit_turn`, `onboarding_rotate_health_source` and `onboarding_stage_form_build` are not
executable by `authenticated`.

### Admin-client entry points (Phase 9 §3.5)

Every Phase 10 route that reaches the admin client or a `service_role`-only function is added to
`tests/tenancy/admin-entry-points.json` with its cross-user test: `app/api/onboarding/turn`
(`onboarding_commit_turn`), `app/api/onboarding/complete` (`account_body_mass_kg` on the `SF001`
chat rebuild, called with an explicit `local_date`), `app/api/onboarding/health/connect`
(`onboarding_rotate_health_source`), `app/api/onboarding/form` (`onboarding_stage_form_build`),
`app/api/dev/health/fake-backfill`
and `app/api/dev/shortcut-probe`. `tests/tenancy/onboarding-cross-user.test.ts` seeds account B
with canary strings in its draft, builds, turns, onboarding thread, Health source and samples,
foods and prefs; then, as account A, it calls each route (including with B's thread id, B's
source id and B's build id in the body) and asserts: no canary in any response, no row of B's
changed or deleted, B's Health token still works. The PR records one manual mutation per route
(remove the `user_id` filter locally and see the test fail).

### Unit and integration (CI)

- `tests/onboarding/machine.test.ts` — every stage transition, skip-ahead, every skip path; "I'm
  34" asks the birth-year quick reply; motivation → goal mapping and confirm; rate presets per goal;
  a scan date without a year asks again, and an unconfirmed date gives `typed_unknown`.
- `tests/onboarding/estimate.test.ts` — a date only when `effectiveRatePctWeek` is non-zero and
  moves toward the amount; `kcal_min` bound with zero or opposite rate → no date and the bound line;
  no amount → no date.
- `tests/onboarding/rhythm.test.ts` — see Stage 7.
- `tests/onboarding/turns.test.ts` (integration, local Supabase, `createInvitedUser()`) — two
  concurrent turns: one commits, one gets `412 draft_changed`; a double tap with the same
  `client_turn_id` returns the stored response and writes one message pair; seq values are unique
  and in order; a thread of another user is refused; `onboarding_commit_turn` is not executable by
  `authenticated`; a wrong `x-smc-account` answers `409 account_mismatch` and writes nothing;
  two concurrent **first** turns → one draft, one onboarding thread, the other 412 (no
  unique-constraint error); two concurrent retries with the same `client_turn_id` → one write, the
  same response twice; a Connect rotation during a Health turn → that turn gets 412; a Connect
  rotation after "Looks right" → `complete_onboarding` answers `not_confirmed`.
- `tests/onboarding/thread-guard.test.ts` — the thread guard tests (see "The onboarding thread is
  closed to every other writer").
- `tests/onboarding/approval.test.ts` (integration) — the summary turn inserts one
  `onboarding_builds` row; an update to that row is refused; approve with the right id and hash
  sets `confirmed_build_id`; an edit turn committed between the summary and the approval makes the
  approval fail with `stale_summary`; an edit after the approval clears `confirmed_build_id` and
  `complete_onboarding` then answers `not_confirmed`; an approval with another user's build id is
  refused.
- `tests/onboarding/complete.test.ts` (integration) — replay returns the same result;
  `bad_build` for an out-of-range value, for a rate that does not match the goal, for a target
  revision whose inputs differ from `derivation_inputs`, and for a `derivation_inputs` that differs
  from the profile in sex, in birth year, in height, and in body-fat source or date (four separate
  cases); a forced failure in step 7 (the writer) rolls
  back steps 3–7; six inputs → a revision and one target change row (not two); a missing input →
  `needs_profile`, no revision; template replaced for a fresh account through
  `replace_day_template`; `template_kept` when a `plan_days` row exists, the template is not the
  default, or `templates_version` differs from the build's base version; a multi-ref Eat name writes
  one pref change row per ref and the next pull shows them; an unmatched or catalog-only Eat creates
  no `user_foods` row and is listed in `eats_needing_details`; a zero-ref Avoid and an over-50-ref
  Avoid are listed in `avoids_not_enforced`; DEXA with a full confirmed date inside 180 days →
  Katch; stale date and no date → Mifflin. Round 4 cases: a complete profile that skipped only the
  rate completes, with `goalRateBpWeek = 0` in the revision and `null` in `user_settings`; a
  mismatch in `effectiveDate` alone and in `weightSource` alone each raise `bad_build`; a user in
  `Pacific/Auckland` and one in `America/Los_Angeles`, completing at 23:30 local time (a different
  UTC day), get the weigh-in and the target `effective_from` on their own local date; round 5
  cases: completion on an account with **no** `user_settings` row inserts it with
  `first_opened_at` and `time_zone`; the form completes first, then a stale chat completion
  answers `already_onboarded` and changes nothing; `no_peanuts` and `low_fodmap` confirmed in chat
  give `avoid_allergens ⊇ {peanut}` and `banned_categories ⊇ {onion_garlic, beans}`, and catalog
  search and a barcode lookup then block a peanut food; a bad zone
  name raises `bad_build`.
- `tests/onboarding/complete-vs-settings-op.test.ts` (integration, two connections): an
  `apply_sync_op` `user_settings` update paused after its revision read (inside its lock), then
  `complete_onboarding`; and the reverse order. In both, `onboarded_at` is set at the end. In the
  first order the op commits first and completion reads its row; in the reverse order the late op
  answers `conflict`.
- `tests/onboarding/replace-vs-day.test.ts` — see Stage 7.
- `tests/onboarding/replace-template.test.ts` (integration) — `replace_day_template` refuses a
  stale base version, refuses to remove a slot a `plan_days` row uses, runs the §2.1 share check,
  writes no change row, and is not executable by `authenticated`.
- `tests/jobs/backup-onboarding.test.ts` — see Migrations.
- `tests/rls/coach-threads-kind.test.ts` — `onboarding` accepted; a second active onboarding thread
  refused.
- `tests/health/ingest-height-bodyfat.test.ts` — new types and units accepted; a 30-day Shortcut
  body applied; out-of-range body fat rejected per sample.
- `tests/onboarding/health-status.test.ts` — status returns saved values, units, dates and source
  id for the pending source only (including height and body fat); a receipt with zero samples does
  not advance; another account's source id returns no data; connect after reload revokes the old
  source; two parallel connect calls leave exactly one active shortcut source, equal to
  `pending_health_source_id`.
- `tests/onboarding/health-gate.test.ts` — with the gate refused, a condition named in stage 1 or
  stage 4 reaches neither the Gemini adapter nor `systemOne` (both spied), and the chat hands over
  to the form. With the gate open, the user says at stage 1 "I'm Sam, I have celiac and a peanut
  allergy, I want to lose weight", and at stage 4 "I want to lose weight before my Hashimoto's
  follow-up" (a condition on no list): with `JEV_HEALTH_ATTESTED` unset, a fetch spy on
  `https://api.typesafe.ai/v1/systemone` records **zero** requests for the whole run; with it set to
  `1`, requests may carry the text. In both cases the celiac and peanut candidates appear only as
  confirm quick replies and are saved only after the confirm, and no allergen or condition is ever
  a Jev question.
- Judge fixtures: 40 labelled **non-health** phrases in `scripts/eval/onboarding-judge.fixtures.json`
  (14 motivation, 14 diet flag including negations such as "I eat everything", 6 rhythm and
  training, 6 clarity), recorded answers in `scripts/eval/onboarding-judge.cache.json`, refreshed
  by hand with `scripts/eval/onboarding-judge.ts --refresh`. Gate
  `tests/onboarding/judge-thresholds.test.ts` reads the cache (the
  `tests/foods/facet-thresholds.test.ts:18` pattern) and fails when accept precision is under
  0.95. The fixtures are synthetic text written for the eval, not user data. They matter only
  when Jev is attested. The report prints precision per field type.
- `tests/onboarding/health-candidates.test.ts` (fixture model) — 12 allergen and 8 condition
  messages, including negations ("no allergies", "I used to be allergic"): every candidate is a
  confirm quick reply, none is saved without the confirm, and a negation yields no candidate.
- `tests/onboarding/jev-gate.test.ts` — `jevRouteConfig()` is open only for the exact value `1`;
  with it closed, the onboarding judge module never calls `systemOne`.

### End-to-end (one Playwright spec)

- `e2e/onboarding-chat.spec.ts`, with `playwright.config.ts`. **DECIDED (run):** add
  `@playwright/test` as a dev dependency (the repo has none, `package.json`). Reason: Devin asked
  for one Playwright spec; the slice PR names the dependency for his review.
- Runs in the CI Integration job after local Supabase starts, against `next build && next start`
  with `PREVIEW_TOOLS=1`, `ONBOARDING_MODEL=fixture`, `ONBOARDING_JUDGE=fixture`,
  `HEALTH_CONTEXT_PROVIDER=gemini` and `GEMINI_BILLING_ATTESTED=1` set on the app process, and the
  build-time flags `NEXT_PUBLIC_CHAT_ONBOARDING=1` and `NEXT_PUBLIC_INVITE_SIGNUP=1` set for
  `next build` (round 23 finding 5: `NEXT_PUBLIC_*` values are inlined at build time), all by the
  spec's `webServer.env` / build command in `playwright.config.ts` (round 9 finding 4: every onboarding turn calls
  `routeFor` with health context, `lib/ai/route.ts:48-57`, which refuses without both). The
  fixtures make no network model call, so the two variables send nothing anywhere. `routeFor` is
  **not** bypassed in the fixture path; the gate test stays meaningful. The spec asserts the page
  reaches the chat (the first coach bubble), not the form. So the stage order and every confirm are
  reproducible.
- Steps: create an invite code on the local stack → "New here?" → email and code → OTP from the
  local mail catcher → chat → fake backfill (`active`) → a multi-fact message → birth-year quick
  reply → goal confirm → a skipped breakfast, one snack at 4 pm → a confirmed dairy Avoid and a
  loved food → summary → Looks right → stage 10 names the loved food ("Add them from Foods") → "Go to
  Today" → Today shows Lunch, Snack, Dinner at the stated times, the account's targets, and none
  of the strings in
  `scripts/fixtures/sasha-plan.json` (Phase 9 §3.6).

### Accuracy eval (live model, not CI)

- `scripts/eval/onboarding-personas.ts` with 10 personas in `scripts/eval/onboarding-personas.json`
  (truth values plus scripted replies; 5 with Health via fake backfill, 5 without; one with a
  condition, one with an allergy, one that skips everything and ends in `needs_profile`).
- Runs against a Preview URL (`--target`) with the live Gemini model, creates users with
  `createInvitedUser()`, refuses a production URL, writes
  `docs/audit/evals/<date>-onboarding-personas.md`. Every saved field must equal the persona's
  truth or be marked Default or Missing.
- **Default run (round 15 finding 5):** `JEV_HEALTH_ATTESTED` unset, so Jev is not called and every
  extracted value goes through the confirm path; the personas answer each confirm from their
  truth. This run is the gate.
- **Optional second run** with `--jev-attested` against a Preview where `JEV_HEALTH_ATTESTED=1`,
  only after Devin approves (Open for Devin 10); it reports the same fields plus Jev precision.

## Testing on Preview

Preview: the Phase 10 PR's Vercel Preview on the `p9-tenancy` Supabase branch, after Phase 9
slices 1, 4, 5, 8 (M2, `20261106090000`) **and 6 (`20261107090000`)** are on that branch and Phase 9 slice 8's
acceptance gate passed there (an invited account's `eaten_slots` with `breakfast` accepted).
Reason: Phase 9 requires M2 before any invited account exists; the current check refuses
`breakfast` (`20261026090000_plan_days_eaten_slots.sql:6-14`; Phase 9 §2.5). No invite code is
created and no invite-based step below runs before that gate. Env on Preview: `HEALTH_INGEST_ENABLED=1`,
`GEMINI_BILLING_ATTESTED=1`, `HEALTH_CONTEXT_PROVIDER=gemini`, `NEXT_PUBLIC_INVITE_SIGNUP=1`,
`NEXT_PUBLIC_CHAT_ONBOARDING=1` (the chat is behind it, round 23 finding 5), `MIN_CLIENT_BUILD`
(Phase 9), and the Preview shortcut's URL and name once published. Step 2 below asserts the invited
user reaches the chat.

Devin:
1. Create two invite codes on the branch: `scripts/invite.ts create --label preview-devin` and
   `--label preview-sasha`.
2. On a desktop browser, sign up with the first code. The chat opens, not the form; stage 2 does not
   appear.
3. Tap "Fake Health data (Preview)" → Active. Stage 3 shows steps, weight and height with their
   dates.
4. Send "I'm 34, 5'6, want to lose 10 lb". The coach asks "Born in 1991 or 1992?" and confirms the
   goal; it does not ask height again.
5. Say "no breakfast, lunch at 1, snack at 4, dinner at 7; I lift Monday, Wednesday, Friday". Say
   you love salmon and avoid dairy. The summary shows those times and days with sources, an "about"
   date (or the reason there is none), and "dairy — will be added to your Avoids". After Looks
   right, stage 10 says "Avoided: dairy" or the "noted, not blocked" line.
6. Open the same onboarding in a second tab and change one answer there. In the first tab tap
   Looks right: the chat shows the summary again with the new value (approval refused).
7. Tap Looks right. Stage 10 names salmon and says to add it from Foods. Tap "Go to Today". Today shows
   Lunch, Snack, Dinner at those times and training targets on Monday.
8. Sign out. Sign up again with a new invited address (the multi-use `preview-runs` code). Skip
   everything. The summary says "Targets need: …"; Today shows the four default slots and the
   profile prompt, with no numbers.
9. With a third new address, tap "Prefer a form?" and finish with the form. The gate opens.
10. On the production site: the Preview buttons are absent and `POST /api/dev/health/fake-backfill`
    answers 404.

Sasha (on her iPhone, with the Preview added to the home screen):
1. Sign up with the second code. At stage 2 tap Yes → Add Shortcut → Add → back → Connect.
2. Allow Health. The chat returns and stage 3 shows her real numbers.
3. Mention a food that bothers her. The coach asks before it saves it.
4. Finish, then open the coach. It calls her by the name she gave and calls itself "your coach".
5. Run the shortcut probe (`/dev/health-probe`) once and send Devin the result screen.

## Slices (PR-sized, in order)

Phase 10 slices 1–3 need no invited account and may start after Phase 9 slices 1, 4 and 5 are
merged. Slices 4–7, every invite-based Preview test, the Playwright spec's run against a real
branch, and any production activation wait for Phase 9 slices 8 (M2) and 6 and slice 8's
acceptance gate (Phase 9 merge order 1, 2, 3, 4, 5, 7, 8, 6). **Release order (round 17, fixed):**
Phase 9 → Phase 12's `20261108090000_phase12_target_floor.sql` (the checked target writer) →
Phase 10 (`20261110…`). Phase 10 slice 1 (the first migration) does not merge before Phase 12's
migration is merged.

1. **Schema** — `20261110090000_onboarding_schema.sql` with down file; backup table list, keys and
   test; thread kind test; `height` and `body_fat_percentage` ingest with their test;
   `display_name` mapping, Settings row and coach context; `templates_version` in SQL if Phase 9
   computes it in TypeScript.
2. **Preview tools gate** — `lib/server/preview-tools.ts`, the dev routes (fake backfill, shortcut
   probe), the gate test, their admin entry-point entries and cross-user tests. No reset route.
3. **Pure core** — machine, draft, rhythm, estimate, judge with the 40 fixtures, cache, threshold
   gate, fixture model and fixture judge.
4. **Turns and chat UI** — `onboarding_builds`, `onboarding_commit_turn` with summary and approval,
   the turn route, the approval and health gate tests, the onboarding thread, the form fallback,
   the turn route's entry-point test. The chat is behind `NEXT_PUBLIC_CHAT_ONBOARDING=1` until slice
   5 lands.
5. **Build** — `replace_day_template`, `complete_onboarding`, the complete route, templates fetch
   and pull, the build and replace tests, the Playwright spec.
6. **Health connect** — `onboarding_rotate_health_source`, connect and status routes,
   `HealthConnector`, both shortcut flows with manual paste, the probe route and page, the
   fallbacks, the connect entry-point test. Merges after the probe result.
7. **Persona eval** — the harness, 10 personas, the first report.

## Success criteria

- A new user reaches Today in under four minutes with Health and under six without, measured on the
  Preview by Sasha's run.
- Zero saved allergens or conditions without an explicit confirm (judge gate and persona eval).
- With the health gate refused, no onboarding text reaches Gemini or Jev.
- On the 10-persona eval, every saved field is correct, Default, or Missing.
- A skip-all run ends in `needs_profile` with no numeric target; a full run writes one revision.
- The build is one transaction: the rollback, replay and approval tests pass; `complete_onboarding`
  accepts no build data from the caller and writes only an approved, unchanged, immutable build.
- Concurrent and repeated turns never duplicate or reorder messages.
- A fresh account's template after onboarding has share sums of exactly 1; a template that a day
  already uses is never replaced; the only template write is `replace_day_template`.
- Every Avoid that policy cannot enforce is shown to the user as not enforced; no Eat is promised
  for rotation without a user food that has role and nutrients.
- The nightly JSON export succeeds and holds rows of every new and newly listed table (export
  completeness), and a `scripts/backup.sh` dump restores them with a custom rhythm intact
  (restore success). The nightly JSON export has no restore path (round 8 finding 5).
- Every dev route answers 404 when `VERCEL_ENV=production`; every Phase 10 admin entry point has a
  passing cross-user canary test.
- Existing onboarded accounts never see the new flow; `manual` accounts never get the chat.

## Later (cut from Phase 10)

- Template editing after onboarding (client, coach, or onboarding re-run), a second template for
  training days, the grant of `replace_day_template` to `authenticated`, and everything Phase 9's
  "Later" lists for editing.
- Creating a user food from a bare name or a catalog ref with verified nutrients and role (catalog
  projection or a guided entry), so onboarding Eats can join rotation.
- Enforcing a name-level Avoid in every policy path, including refs created later and names with
  more than 50 catalog refs.
- Making `health_ingest_event` and `health_ingest_apply` one transaction for every ingest source.
- Onboarding offline (queued turns).
- Expiry of abandoned drafts and builds.
- A user-controlled delete of the onboarding thread (needs a column-limited update path).
- A prefilled, Avoid-aware "Add from onboarding" route into Foods (the stage-10 lines are plain
  text until then).
- Switching from the form back to the chat after `mode = 'form'`, and moving `manual` accounts'
  form onto the one-writer path.
- Policy: require evidence that a food's allergens were assessed before `allowed` (catalog,
  barcode, Floor Day), and pass the unmapped diet flags to catalog and barcode policy.
- A restore tool for the nightly `user-table-export-v1` JSON and a consistent-snapshot nightly
  export (today recovery uses `scripts/backup.sh`).

## Resolution of the revision-1 open questions

1. **Shortcut feasibility — DECIDED (run):** `x-callback-url` with file persistence, one shortcut
   per environment, gated by the Preview probe (P1–P6); manual paste ships in every case. Reason:
   the URL-scheme inputs are documented; persistence, the Health sheet, grouped queries and
   Preview protection need a real iPhone to prove.
2. **Server draft plus client outbox — DECIDED (run):** onboarding bypasses the outbox; the server
   holds the draft; stage 9 is one transaction; the client fetches templates and pulls afterwards.
   Reason: onboarding is online-only, a queued stamp caused the step-1 loop before, and two of the
   written entities are not client-writable.
3. **Jev thresholds per field type — DECIDED (run):** keep Devin's global 0.85 / 0.50 with the
   existing override (allergens and conditions always confirm); the judge report prints precision
   per type, and a split is proposed only with that data. Reason: 40 fixtures are too few to fit
   separate thresholds.

## Resolution of audit round 1

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "Targets at stage 9": six inputs → revision; any missing → finish in `needs_profile`, no numbers; both paths tested; persona and Preview step for skip-all | `lib/profile/derive.ts:109-116`; `lib/profile/energy.ts:163-170`; Phase 9 §2.6 |
| 2 | BLOCK | "Goal, motivation and rate": Jev gives a motivation; stored `goal` is one of four values, always confirmed; rate from `RATE_PRESETS_BP[goal]`, `validateRate`; SQL re-checks in `complete_onboarding` step 2 | `lib/types.ts:38`; `f743cfb:lib/profile/rate-goal.ts:11-16,33-35` |
| 3 | BLOCK | "Serialized turns" and "The stage-9 build": the build is stored in the draft only by the service-role turn commit at stage 8; `summary_confirmed_rev` records approval; `complete_onboarding(p_expected_rev)` takes no build data and re-validates; thread ownership and kind checked in the commit | spec design; `app/api/sync/ops/route.ts:51-57` (existing pattern of server-side RPC calls) |
| 4 | BLOCK | "Eats and Avoids": scope cut; no user food from a bare name; name-level membership only; unmatched Eats listed for the user; import moved to "Later" | `20261023090400_food_membership_v2.sql:25-55,93-115`; `lib/store.ts:274-300`; `lib/rotation.ts:171-194` |
| 5 | BLOCK | Build step 6: one `user_food_prefs` change row per changed pref row, keyed by `food_ref_id`; step 8: no extra target row; multi-ref and pull test | `lib/sync/keys.ts:10-12,34`; `20261023091000_target_revision_transactions.sql:64-67`; `app/api/sync/ops/route.ts:51-74` |
| 6 | BLOCK | Accuracy rule 6: every onboarding turn is a health-context turn; gate runs before Gemini and Jev; refused → form; test with a condition in stage 1 and 4 | `lib/ai/route.ts:48-64`; `lib/server/coach-turn.ts:263-269` |
| 7 | BLOCK | "Targets at stage 9": scan date asked and saved as `body_fat_measured_on`; no date → `typed_unknown`; Health → `consumer_scale`; eligible, stale and undated tests | `f743cfb:lib/profile/energy.ts:79-93`; `f743cfb:…/20261028090000_body_fat_provenance.sql:9-13` |
| 8 | BLOCK | Health step 6: advance only on saved samples for the pending source, per type, with missing types named; recovery by rerun (new `sent_at`, new hash); atomic ingest moved to "Later" | `lib/server/health-ingest.ts:93-114,97`; `20261024093100_health_source_status.sql:3-7`; `phase5_health_ingest.sql:55-60` |
| 9 | BLOCK | Health step 3: one shortcut per environment; the Preview shortcut takes `<origin>|<token>` with a fixed origin pattern inside it; status checks source ownership; Deployment Protection added to the probe (P5) and "Open for Devin" | `docs/apple-health.md:37-39`; `app/api/health/ingest/route.ts:18-40` |
| 10 | BLOCK | "Serialized turns": `client_turn_id` with stored responses, `expected_rev`, draft row lock, seq allocated under the lock, one commit for draft and messages; tests for concurrency, double tap, lost response | `lib/server/coach-threads.ts:134-138` |
| 11 | FIX | "`display_name`": column, sync patch, client mapping, Settings row with Edit, coach context select and profile line | `lib/sync/user-settings.ts:97-120`; `lib/server/coach-context.ts:89-93` |
| 12 | FIX | Preview reset: full fresh-account state through the Phase 9 table inventory, including targets, health, foods, draft and turns; asserts Phase 9 §3.6; second-run test | Phase 9 §3.2, §3.6 |
| 13 | FIX | Health step 2 and 7: `pending_health_source_id` in the draft; reconnect revokes and reissues; reload test | `app/api/health/tokens/route.ts:26-34`; `lib/health-client.ts:125-127` |
| 14 | FIX | "Goal, motivation and rate": estimate from `effectiveRatePctWeek` and current weight, labelled "about", shown only with an amount and a rate, not stored | `f743cfb:lib/profile/rate-goal.ts:57-71` |
| 15 | FIX | Migrations: both new tables added to the backup `TABLES` list and its inventory check; abandoned-draft expiry in "Later" | `app/api/jobs/backup/route.ts:36-47` |
| 16 | FIX | `ONBOARDING_JUDGE=fixture` replays the recorded cache in the Playwright run, behind the same gate; live Jev only in the persona eval | spec Testing; `tests/foods/facet-thresholds.test.ts:18` pattern |
| 17 | FIX | Conversation rules: age is not a birth year; a quick reply confirms the year; test in `machine.test.ts` | `lib/profile/onboarding-state.ts:307-316`; `lib/profile/energy.ts:163-170` |

No finding was rejected.

Round 1 rows 3 and 13 are superseded in part by round 2: approval now binds to an immutable
`onboarding_builds` row (round 2 #3), and connect is serialized in one function (round 2 #8).

## Resolution of audit round 2

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "Eats and Avoids": a zero-ref or truncated Avoid goes to `avoids_not_enforced`, and the summary and hand-off say plainly it is not blocked yet; allergens still go to `avoid_allergens`, which policy enforces; tests for zero-ref and over-50-ref names; name-level enforcement in "Later" | `lib/policy/constraints.ts:135-142`; `20261023090400_food_membership_v2.sql:38-56,117-120`; no reader of `food_membership_revisions` outside SQL (`grep`) |
| 2 | BLOCK | "Eats and Avoids": no rotation promise for a catalog-only or unmatched Eat; all such Eats go to `eats_needing_details` with a hand-off line; catalog projection in "Later" | `lib/store.ts:274-300`; `lib/rotation.ts:171-194` |
| 3 | BLOCK | "Serialized turns": the server computes the build (with target revision and template base version) at the summary turn into an immutable `onboarding_builds` row (no-update trigger) with a hash; "Looks right" carries only the build id and hash and is accepted only when the draft has not changed since; any later edit clears the approval; `complete_onboarding` reads only that row and checks the target inputs equal the build's profile fields; approval tests for edits during and after | spec design; round 2 audit |
| 4 | BLOCK | "Migrations": the three new tables plus `food_membership_revisions` added to `TABLES`, with `COMPOSITE_KEYS` for the three without `id`; backup and restore test | `app/api/jobs/backup/route.ts:36-47,55-74`; `20261023090100_food_membership.sql:6` |
| 5 | FIX | Health step 6: the status route returns saved values, units, sample dates and source id per type (incl. height and body fat) from an owner-scoped read of `health_samples` by `source_id`; the draft takes Health values only from that server read; cross-account test | `lib/health/contract.ts:93-105`; `20260911000400_privileged.sql:17-22` |
| 6 | FIX | Preview reset: after the server wipe the client runs the Phase 9 account purge without keeping unsent work, then reloads and rebinds at cursor 0; same-device skip-all test; Preview step 8 | `app/api/sync/changes/route.ts:40-44`; Phase 9 §0.7 |
| 7 | FIX | New "Admin-client entry points" section: five routes in `tests/tenancy/admin-entry-points.json`, one cross-user canary test with B's ids in A's requests, one manual mutation per route | Phase 9 §3.5 |
| 8 | FIX | Health step 2: `onboarding_rotate_health_source` locks the draft, revokes, inserts and assigns in one transaction; the UI disables Connect while in flight; double-tap and reload tests | `app/api/health/tokens/route.ts:26-34` |
| 9 | FIX | "Goal, motivation and rate": a date only when `effectiveRatePctWeek` is non-zero and moves toward the amount; else no date and the `bound` reason; estimate test | `f743cfb:lib/profile/rate-goal.ts:63-70` |
| 10 | FIX | "Targets at stage 9": the full scan date (year, month, day) is asked and confirmed; a partial or unconfirmed date gives `typed_unknown` with no date; machine test | `f743cfb:lib/profile/energy.ts:79-93` |

No finding was rejected.

Reconciliation with Phase 9 revision 4 (made in this revision, not audit findings):
- The template write uses the Phase 9 contract `replace_day_template(p_key, p_payload,
  p_base_version)` with `templates_version`; Phase 10 grants it to `service_role` only (stricter
  than the contract; reason in Stage 7).
- The Preview reset recreates the default template with `create_default_template(user_id)`.
- All onboarding client calls go through `accountFetch`; the draft conflict answers `412
  draft_changed` so it never collides with Phase 9's `409 account_mismatch`; invited accounts on an
  old build get Phase 9's `426` on every onboarding route; the ingest route (token auth) is
  outside that gate.
- Onboarding writes no floor rows, so Floor Day stays hidden for new accounts; Floor safety stays
  server-only (Phase 9 §2.4).
- Dependencies and slices follow Phase 9's order: templates slice 4, invites slice 5, resolver
  slice 6.

## Resolution of audit round 3

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "The onboarding thread is closed to every other writer": `resolveThread` answers 404 for an `onboarding` thread; restrictive RLS refuses `authenticated` insert, update and delete of onboarding messages and threads; tests for both paths | `lib/server/coach-threads.ts:98-108`; `20260911000500_rls.sql:56-58,67` |
| 2 | BLOCK | Turn flow `summary`: the route computes the next draft and the build (with a full `derivation_inputs` snapshot and the target derived from it) before the call and passes `p_build`, stored in the same transaction; `complete_onboarding` step 2 checks `derivation_inputs` against every profile field (sex, birth year, height, body-fat provenance) and the target's own `TargetInputs` against `derivation_inputs`; four mismatch tests | `f743cfb:lib/types.ts:56-66` |
| 3 | BLOCK | Turn flow step 5: a per-user advisory lock (`pg_advisory_xact_lock`) taken first in all three onboarding functions, before any draft exists; `client_turn_id` and revision rechecked under it; first turn needs `expected_rev = 0`; concurrent first-turn and same-id tests | spec design; Postgres advisory locks |
| 4 | BLOCK | "Testing on Preview" and "Slices": invite-based Preview tests, slices 4–7 and activation wait for Phase 9 slice 8 (M2) and its gate | `20261026090000_plan_days_eaten_slots.sql:6-14`; Phase 9 §2.5, rollout steps 5–7 |
| 5 | BLOCK | "Migrations" backup: adds `account_claims`, `day_templates`, `template_slots`, `slot_meals`, `slot_meal_components` with keys; restore test of a custom-rhythm account compares templates and slots | `app/api/jobs/backup/route.ts:36-48,55-63` |
| 6 | FIX | Health step 2: rotation bumps `rev` and clears `confirmed_build_id` under the lock; a turn that copies Health values must name the current pending source; two race tests | spec design |
| 7 | FIX | "`display_name`": a separate `displayName` context field read on every turn; the profile line keeps its gate; first-general-chat test | `lib/server/coach-context.ts:96-104,182-196` |

No finding was rejected. Every cut adds a check or a wait, not a new subsystem.

## Resolution of audit round 4

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Migrations renumbered to `20261110090000` and `20261110090100`, after Phase 9's last `20261107090000`; facts, Preview prerequisites, slices and production step updated | Phase 9 plan `README.md:23-37`; production has `20261103090000`, `20261103090100` |
| 2 | BLOCK | Build step 1: `complete_onboarding` takes the same `user_settings` advisory lock as `apply_sync_op` after the onboarding lock and before it reads the row; fixed lock order; two-connection test in both orders | `20260919090300_phase3_sync_entities.sql:436`; `20260911000600_rpc.sql:219-237`; `lib/sync/settings-intents.ts:31` |
| 3 | BLOCK | Stage 7 condition 3: `replace_day_template` takes an exclusive per-user `templates:` lock before the zero-days check; the M2 `plan_days` trigger takes the shared lock first; a late day write validates against the new template; test in both orders | `20260911000600_rpc.sql:209-218`; Phase 9 §2.5 |
| 4 | BLOCK | Rate: `user_settings` keeps `null`; the build check compares `coalesce(goal_rate_bp_week, 0)` with the revision's `goalRateBpWeek`; skip-only-the-rate test | `f743cfb:lib/profile/derive.ts:98` |
| 5 | BLOCK | `derivation_inputs` adds `weight_source` and `effective_date`; step 2 compares every `TargetInputs` field; `latestWeighInKg = null` so `weightSource` is always `"onboarding"`; mismatch tests for both fields | `f743cfb:lib/types.ts:56-65`; `f743cfb:lib/profile/derive.ts:91-100` |
| 6 | BLOCK | Every turn carries the device IANA zone, validated by `ianaTimeZoneSchema` and stored in the draft; the build fixes `time_zone` and `local_date`; SQL re-checks them; the weigh-in, target date and `user_settings.time_zone` use them; UTC-boundary tests | `20261019090000_manual_weigh_in.sql:40-73`; `lib/health/contract.ts:47-48` |
| 7 | FIX | Recovery uses `scripts/backup.sh` (`pg_dump`) and its restore tool; the nightly JSON export is only made complete; dump-restore test of a custom rhythm; JSON restore in "Later" | `app/api/jobs/backup/route.ts:119-126`; `scripts/lib/database_backup.py:203-214` |
| 8 | FIX | Same cut: `pg_dump` is one consistent snapshot; a test dumps while `complete_onboarding` is open and finds none or all of the stage-9 rows; a consistent nightly export in "Later" | `app/api/jobs/backup/route.ts:119-126` |
| 9 | FIX | New "Table-ops matrix" section: the three tables declared `[select]` in `tests/tenancy/table-ops.json`, tested with two JWTs | Phase 9 §3.2 |

No finding was rejected.

## Resolution of audit round 5

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Build step 3: on insert, `first_opened_at = now()`; `time_zone` from the build on insert and update; rowless-account test | `20260911000200_user_schema.sql:88-90`; Phase 9 §2.6 |
| 2 | BLOCK | Build step 1: under the locks, completion requires `seed_policy = 'default'` and no `onboarded_at`; else `already_onboarded`, no write; replay only for the draft's own `completed_at`; form-then-chat test | `lib/profile/onboarding-client.ts:187-204` |
| 3 | BLOCK | A `before update` trigger keeps a set `onboarded_at` when a write sends `null` (coerce, not raise, so the outbox drains); full conflict-and-replay drain test | `lib/sync/settings-intents.ts:226-233,315-324`; `lib/sync/settings.ts:251-260`; `20261025090200_log_entries_title.sql:202-204` |
| 4 | BLOCK | Build step 5: the build carries the form's own flag mapping (imported `FLAG_ALLERGENS`, `FLAG_CATEGORIES`) into `avoid_allergens` and `banned_categories`; catalog and barcode policy tests | `lib/profile/onboarding-state.ts:352-364`; `lib/server/catalog.ts:129-135`; `lib/server/barcode.ts:68-72` |
| 5 | FIX | Health step 2: the client opens the Shortcut only when the status route's `pending_health_source_id` equals the response's `source_id`; reversed-delivery test | round 5 audit |
| 6 | FIX | After completion the client navigates only after a successful templates fetch; Retry replays completion; a closed app falls back to Phase 9's pending state; network-drop test | Phase 9 §2.8 |
| 7 | FIX | New "RPC manifest" section: `complete_onboarding` with a direct cross-user case; the three service-role functions asserted not executable by `authenticated` | Phase 9 §3.3 |
| 8 | FIX | Cut: the onboarding thread is not user-deletable in Phase 10 (the existing DELETE answers 404 through RLS); user delete moved to "Later"; Phase 11 owner told to show it without Delete | `app/api/coach/threads/[id]/route.ts:55-67`; Phase 11 §1 |

No finding was rejected.

## Resolution of audit round 6

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "Pre-completion settings writes cannot undo the approved profile": the trigger keeps every onboarding profile column when a write tries to null a set stamp; the client drains settings ops before completion and resets the settings baseline to the pulled row after it; full-drain test checks profile, target and mirror | `lib/sync/settings-intents.ts:226-233,339-345`; `20261025090200_log_entries_title.sql:172,202-204` |
| 2 | BLOCK | Cut: Phase 10 never claims an allergen is blocked; summary and hand-off tell the user to check labels; a documenting test pins today's `allowed` for empty tags; assessed-absence policy moved to "Later" and flagged for Devin | `20260911000100_catalog_shell.sql:43`; `lib/policy/constraints.ts:99-112,135-140` |
| 3 | FIX | Cut: unmapped diet flags are saved and shown as "search results don't filter by it yet"; wiring into catalog and barcode policy in "Later" | `lib/profile/onboarding-state.ts:352-364`; `lib/server/catalog.ts:262-270`; `lib/policy/facet-rules.ts:22-26` |
| 4 | FIX | Holds, but the change is in Phase 11, which this run may not edit here: Open for Devin item 8 now names the exact Phase 11 lines to revise | `docs/specs/phase-11-conversations-memory.md:290-296,812-817` |

No finding was rejected.

## Resolution of audit round 7

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Fence 3: no settings reset after completion; the pull settles through `settleUserSettings`, which keeps pending generations; fence 2 guarantees only post-completion ops remain; two-tab test | `components/AuthGate.tsx:286-288`; `lib/sync/settings.ts:224-240` |
| 2 | FIX | Diet flags: a separate `dietFlags` field in every coach turn's context (flag names only, profile line keeps its gate); food-question test | `lib/server/coach-context.ts:70-93,96-104` |

No finding was rejected.

## Resolution of audit round 8

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "Chat and form are mutually exclusive": a draft `mode`; the form opens only after a locked server switch that a finished chat refuses; chat functions refuse after the switch; both interleavings tested; switching back is "Later" | `lib/profile/onboarding-client.ts:79-90,187-204` |
| 2 | BLOCK | Turn and rotation functions check eligibility under the onboarding lock (route checks first, before any model call); rotation revokes only this draft's pending shortcut source; completion clears `pending_health_source_id` and keeps the source active; Connect-after-completion test | `lib/server/health-tokens.ts:22` |
| 3 | FIX | `renderCoachContext` serializes `displayName` and `dietFlags` as untrimmed top-level fields; the test asserts the rendered string | `lib/server/coach-context.ts:206-266` |
| 4 | FIX | Turn route: 16 KB body bound, 2,000-character message cap, database-backed per-account budget (30 per 10 minutes, 150 per day) before any model call; replays free; test | `app/api/coach/route.ts:25`; `lib/ai/spend.ts:35` (spend check fails open, so the limiter is the bound); Phase 9 §1.3 |
| 5 | FIX | Success criterion split into nightly export completeness and `pg_dump` restore success | Migrations "Recovery artifact" |

No finding was rejected.

## Resolution of audit round 9

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "One writer for every invited account": the form for a `default` account stages an immutable build and completes only through `complete_onboarding` (first to set `onboarded_at` under the locks wins); old form tabs get Phase 9's `426` once `MIN_CLIENT_BUILD` is raised at chat activation; open-old-tab test | `lib/profile/onboarding-client.ts:72-236`; `app/api/targets/route.ts:115`; Phase 9 §1.5b |
| 2 | BLOCK | "Mode record on first use": the first onboarding function of either path creates the draft under the per-user lock; form mode needs no thread (`thread_id` nullable with a check); form-before-turn-one and refusal-before-turn-one tests | round 9 audit |
| 3 | FIX | Turn flow step 2: the stored-turn check runs before the budget; two distinct limiter keys; retry-at-limit and day-boundary tests | Phase 9 §1.3 (`key, window_start`) |
| 4 | FIX | Playwright `webServer.env` sets both gate variables with the fixtures; `routeFor` is not bypassed; the spec asserts it reaches the chat | `lib/ai/route.ts:48-57`; `scripts/ci-local-supabase.py:37` |

No finding was rejected. The round 8 `onboarding_set_mode` function and `POST /api/onboarding/mode`
route are replaced by `onboarding_stage_form_build` and `POST /api/onboarding/form`.

## Resolution of audit round 10

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "Only `complete_onboarding` stamps an invited account": a `user_settings` trigger lets only the completion transaction (transaction-local flag) change `onboarded_at` for a `default` account; any other change keeps the old stamp and, once stamped, the approved profile; old-tab → 426 → upgrade → full drain test before and after completion | `lib/profile/onboarding-client.ts:193-204`; `20261025090200_log_entries_title.sql:202-204` |
| 2 | FIX | Health activity: 14 distinct completed local days in days 1–28 before `local_date`; today never counted or averaged; 13+today test | `lib/activity/prompt.ts:3-4,51-57` |

No finding was rejected.

## Resolution of audit round 11

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "Stale settings writes are refused, never rewritten": the coercing triggers of rounds 5, 6 and 10 are removed; a stamp change outside `complete_onboarding` raises, the entry parks with Discard; an applied entry's payload is always the saved row, so the mirror stays true; drain test checks server row and phone mirror | `lib/sync/settings-intents.ts:339-345,360`; `lib/sync/outbox.ts:309-311` |
| 2 | BLOCK | Invites open last, after the Phase 10 build and `MIN_CLIENT_BUILD`; every write route answers `426` to an older build for a `default` account; no old-form weigh-in queue can exist for an invited account; a read-only check lists any existing `default` account before invites open | `lib/health/weigh-in-client.ts:217,243`; `lib/sync/post-sync.ts:36`; Phase 9 §1.5b |

No finding was rejected. The round 5, 6 and 10 resolutions that relied on coercing triggers are
superseded by this section.

## Resolution of audit round 12

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Rule 5: `onboarding_rev` set by completion; the existing `user_settings` conflict answer adds `before_onboarding` for an entry based on an older rev; the client drops that generation's intents instead of replaying them; zone capture runs only after onboarding; two-device, two-zone test | `components/AuthGate.tsx:306-310`; `lib/sync/settings.ts:96-115`; `lib/sync/settings-intents.ts:226-233,315-324`; `lib/sync/outbox.ts:165-178`; `20260919090300_phase3_sync_entities.sql:406,436-460` |
| 2 | FIX | No new Discard UI: `onboarding_stamp_locked` is a recognized permanent refusal; the outbox removes the entry at once, settles by a pull, and Sync Status shows one notice line; other errors keep retry-then-park | `lib/sync/outbox.ts:194-209,291-320`; `components/SyncStatus.tsx:28-73,134-143` |

No finding was rejected.

## Resolution of audit round 13

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | A `refused` settlement kind in the one settlement transaction: drops only the refused entry and its intents, clears `sent`, reconciles to the fetched row, rewrites later generations; used for `onboarding_stamp_locked` and `before_onboarding`; in-flight newer-edit test | `lib/sync/settings.ts:155-173,231-262`; `lib/sync/settings-intents.ts:319-335` |
| 2 | BLOCK | Accuracy rules 1–3: allergens and conditions are never sent to Jev; Gemini (gated) proposes them and every one needs an explicit confirm; Jev judges only filtered, non-health extracted phrases, never raw text; outbound TypeSafe body test after a stage-1 disclosure; fixtures reworked | `lib/ai/route.ts:48-55`; `lib/ai/typesafe.ts:191-200,255-256` |
| 3 | FIX | The app no longer says an unmatched name is "saved"; the hand-off lists it with an Add button into the existing Foods add flow | `20261023090400_food_membership_v2.sql:25-56,93-123`; `lib/store.ts:274-311`; `lib/server/coach-context.ts:129-146` |

No finding was rejected.

## Resolution of audit round 14

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Rule 5 now uses an onboarding generation marker: set to 1 by completion, learned by each device from the gate read, stamped on each settings entry; only an entry stamped lower than the row is refused; a real edit before the device's pull applies; two-device test for both cases | `components/AuthGate.tsx:296,306-310`; `lib/sync/settings-intents.ts:275`; `lib/profile/onboarding-state.ts:125` |
| 2 | BLOCK | No vocabulary filter. Jev (TypeSafe, `api.typesafe.ai/v1/systemone`) gets user text only with `JEV_HEALTH_ATTESTED=1`; otherwise it is not called for onboarding and Gemini's values are confirmed; allergens and conditions never go to Jev; outbound test with an unlisted condition | `lib/ai/typesafe.ts:10,255-256`; `components/AvoidRules.tsx:313` |
| 3 | BLOCK | The form's target edits travel in the build as pins, are applied to the revision, validated against `kcal_min`, and written to the pin columns; test that the numbers survive completion and the next derivation | `components/Onboarding/OnboardingSteps.tsx:259`; `lib/profile/onboarding-state.ts:25,331-344`; `lib/profile/derive.ts:83-88` |
| 4 | FIX | Stage 10 shows in the chat before navigation; Today shows a persistent, dismissible hand-off card from the completed draft's `result`, with prefilled Add actions that survive reload | round 14 audit |

No finding was rejected. The round 13 vocabulary filter and `lib/onboarding/jev-input.ts` are
removed.

## Resolution of audit round 15

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Cut: the persistent Today hand-off card, its route and its dismissal write are removed; the hand-off is one stage-10 chat message with Add buttons | round 15 audit (`onboarding_drafts` is select-only for `authenticated`) |
| 2 | BLOCK | Cut: no warning that a later food row could clear; an unmatched or truncated Avoid gets one summary line, "noted, not blocked — add it from Foods and mark it Avoid" | `components/AddFoodSheet.tsx:143-153`; `20261023090400_food_membership_v2.sql:38-56` |
| 3 | BLOCK | Pins are stored as chosen; completion compares only the revision's `pins` with the build's; the floor (`kcal_min`) is the only check, shown on the field; the summary shows resolved numbers when rounding changes them; 1,852 kcal test | `lib/scaling.ts:66-81`; `components/Stepper.tsx:31-76`; `lib/profile/derive.ts:96` |
| 4 | FIX | One rule: after completion the chat shows stage 10; "Go to Today" navigates and is enabled only after the templates fetch succeeds; test | round 15 audit |
| 5 | FIX | The persona eval's gate run uses the confirm path with Jev off; an optional attested run needs Devin's approval | Open for Devin 10 |

No finding was rejected.

## Resolution of audit round 16

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | No Phase 10 pin check; the revision goes through Phase 12's `_write_target_revision_checked`, which computes kcal, protein, fat and carbohydrate floors in the database; `below_floor` rolls back completion and the form names the field | `components/Stepper.tsx:54`; `lib/profile/derive.ts:45,131`; Phase 12 §1 (revision 18) |
| 2 | BLOCK | `onboarding_generation` is a top-level `SyncOp` field in `SyncOpSchema`, sent by `wireOp`, read by `apply_sync_op` from `p_op`; `OpResult` conflict gains `reason`; end-to-end wire test | `lib/sync/types.ts:54-62`; `lib/sync/outbox.ts:127-131` |
| 3 | BLOCK | The summary says "will be added to your Avoids"; the real outcome (Avoided, or noted-not-blocked) is reported after completion in the stage-10 message from `result` | round 16 audit |
| 4 | BLOCK | `complete_onboarding` step 10 inserts the stage-10 assistant message into the onboarding thread under the lock; replay never inserts twice; reload and replay test | round 16 audit |
| 5 | FIX | The two-device test checks that normal unfinished use queues no zone entry, then seeds a generation-0 entry explicitly | round 16 audit |

No finding was rejected.

## Resolution of audit round 17

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | The checked writer (Phase 12 M-a, a release prerequisite) checks training and rest targets against calorie, fat and the account-derived protein floor; a 0 g protein pin gives `build_stale` with a field error | `components/Stepper.tsx:54`; `lib/profile/derive.ts:45`; Phase 12 §1 |
| 2 | BLOCK | Fixed release order Phase 9 → Phase 12 M-a → Phase 10; Phase 10 migrations renumbered to `20261122…` and fail fast without the writer; `build_stale` defined for chat (new summary) and form (field error) with a test | Phase 12 `20261120090000`; Phase 12 §1 "Stored profile required" |
| 3 | BLOCK | The marker is a field of the outbox record, copied by every constructor and by `writeCarrier` through one helper; conflict-then-retry test | `lib/sync/settings.ts:201-217` |
| 4 | BLOCK | No Add buttons: `/foods` takes no prefilled name and the add sheet only creates Eats, so stage 10 is plain text naming Foods; the route is in "Later" | `components/AddFoodSheet.tsx:101,143`; `components/coach/blocks/ui.tsx:50` |

No finding was rejected.

## Resolution of audit round 18

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | The stage-10 insert passes `tool_calls = '[]'::jsonb`; completion test on the real schema | `20261001000000_phase7_coach.sql:44-46` |
| 2 | BLOCK | Migration numbers follow Phase 12 revision 20 (M-a `20261108090000`, Phase 10 `20261110…`); the prerequisite check is by function name at the start of the **first** Phase 10 migration; `complete_onboarding` calls the writer with named arguments | Phase 12 §1 (revision 20) "checked writer" and runbook step 1 |
| 3 | BLOCK | On `build_stale` the route re-reads the weight server-side with the writer's own selection, writes it into the draft (clearing approval) and builds a new summary; the test proves the second approval completes | Phase 12 §1 "Weight selection" |

No finding was rejected.

## Resolution of audit round 19

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | "Skip for now" for a `default` account posts a skip build and completes through `complete_onboarding`; early-step Skip test | `components/Onboarding/OnboardingFlow.tsx:166`; `lib/profile/onboarding-client.ts:223-236` |
| 2 | BLOCK | The Preview reset checks `seed_policy = 'default'` before any read or delete; `manual` answers 403 and nothing changes; row-count test | Phase 9 §1.2 (`seed_policy`) |
| 3 | FIX | `account_claims.reset_epoch` is bumped by the reset; every device compares it at the gate read and purges before any sync; the change feed is deleted with the rows; second-device test | `app/api/sync/changes/route.ts:40-44` |
| 4 | FIX | A per-account session flag holds `/onboarding` on stage 10 through auth refreshes until "Go to Today"; refresh test | `components/AuthGate.tsx:178-183,286-288,321-323` |

No finding was rejected.

## Resolution of audit round 20

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Calls exactly `write_target_revision_checked(auth.uid(), <row>, null)`; the first migration checks `to_regprocedure('public.write_target_revision_checked(uuid, jsonb, jsonb)')`; Phase 12's one migration is `20261108090000_phase12_target_floor.sql` | Phase 12 §1.1 (revision 22) |
| 2 | BLOCK | Cut: the Preview reset, its epoch and its purge are removed; each test run uses a fresh invited account | round 20 audit; `components/SyncBootstrap.tsx:63`; `components/AuthGate.tsx:286` |
| 3 | BLOCK | Same cut: no non-transactional delete exists any more | round 20 audit |
| 4 | FIX | The hand-off hold flag is set immediately before the completion request, so it covers commit, fetch, "Finishing setup…" and Retry; auth-refresh test during a failing fetch | `components/AuthGate.tsx:178-183` |

No finding was rejected. The round 2, 19 reset resolutions and the round 19 `reset_epoch` are
superseded.

## Resolution of audit round 21

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Build step 7b: after the draft's weight is stored (steps 3 and 7), `complete_onboarding` computes the writer's own weight (`account_body_mass_kg`) and raises `build_stale` unless it equals the build's weight; the rebuild uses that weight; tests for a non-breaching new sample and a typed weight under a same-day device sample | `lib/health/daily.ts:164`; Phase 12 §1.3 |
| 2 | FIX | The summary makes no template promise; stage 10 (and the form's last screen) reports `replaced` or `kept` from `result`; concurrent day-write test | Stage 7 conditions |

No finding was rejected.

## Resolution of audit round 22

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Step 7b: no tolerance and no pre-check; the revision carries its exact `input_weight_kg` and `input_weight_sample_id`; Phase 12's writer compares them with its own `account_body_mass_kg` selection under its locks and raises `weight_changed`; completion maps it to `build_stale`, rebuilds from the server weight and retries once only when the shown values are unchanged, else asks; tests for a 0.02 kg difference and a sample committed between steps 7 and 8 | `20261013090200_fix_health_dedupe_key.sql:31`; Phase 12 §1.2–1.3 |

No finding was rejected.

## Resolution of audit round 23

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Fresh account, typed weight: the summary uses the draft weight with a null sample id; completion writes it to the profile first and writes the manual weigh-in only after the writer (steps 7 and 8 swapped), so the writer's selection equals the build; fresh chat and form tests | `20261019090000_manual_weigh_in.sql:96`; Phase 9 §2.6 |
| 2 | BLOCK | Summary and retry call `account_body_mass_kg(p_user_id)` with the service role (Phase 12 grants it); listed as an admin entry point with a cross-user test | Phase 12 §1.3 privileges |
| 3 | BLOCK | The writer makes one `(kg, sample_id)` selection and uses it for the check and the floors (`account_floor` receives that weight) | Phase 12 §1.2 step 4; `20261013090200_fix_health_dedupe_key.sql:31` |
| 4 | FIX | One error contract: `build_stale` = `SF003` (only weight-change refusal, automatic retry once), `below_floor` = `SF001` (no retry); the route branches on SQLSTATE; test against the real RPC error | Phase 12 §1.2 |
| 5 | FIX | `NEXT_PUBLIC_CHAT_ONBOARDING=1` and `NEXT_PUBLIC_INVITE_SIGNUP=1` at build time for Playwright and on Preview; the spec asserts the invited user reaches the chat | round 23 audit |

No finding was rejected.

## Resolution of audit round 24

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Removed with the weight-match path: the summary no longer calls the selector; the one remaining service-role read (the `SF001` chat rebuild) passes the build's explicit `local_date`; boundary test | Phase 12 §1.3 (default date needs `user_settings.time_zone`) |
| 2 | BLOCK | Removed: no exact-match check, no `build_stale`; the build uses the draft's weight; the typed weigh-in is written before the target in the same transaction; a slightly older-weight target above every minimum is an accepted residual (Open for Devin 12); tests for typed vs stored weight | `lib/profile/derive.ts:115`; `lib/today/water-and-weight.ts:248` |
| 3 | BLOCK | The legacy form (manual / `invite`) saves and drains the profile first, then posts the target through `/api/targets` and the checked writer; incomplete-profile test | `lib/profile/onboarding-client.ts:82-92`; Phase 12 §1.2 step 3 |
| 4 | FIX | Phase 10 is Phase-10-only in this run; Open for Devin 11 gives the Phase 12 owner the corrected caller line (`SF001` → `below_floor`; there is no `build_stale`) | Phase 12 caller table |

No finding was rejected. The round 21–23 weight resolutions (`input_weight_sample_id`, `SF003`
retry) are superseded.

## Resolution of audit round 25

| # | Severity | Change made (section) | Evidence |
|---|---|---|---|
| 1 | BLOCK | Legacy form: profile saved with a null stamp, then target and constraints, then the stamp last; a failure leaves the account in onboarding; target-refusal and dropped-response tests | `lib/profile/onboarding-state.ts:280-304`; `lib/profile/onboarding-client.ts:193-204`; `components/AuthGate.tsx:178-186` |
| 2 | BLOCK | On `SF001` the chat re-stamps the build date to the server's today, reads the weight for that explicit date, and retries once; a second refusal asks the user instead of looping; midnight test | Phase 12 §1.2–1.3 |
| 3 | FIX | Phase 10 is the only file edited here; Open for Devin 13 gives the Phase 12 owner the account-specific form paths | Phase 12 caller table |

No finding was rejected.

## Open for Devin

Only Devin can do these (Apple ID, production, Vercel settings, product safety). Batched. Items
resolved by Devin's 2026-09-23 approval and BLOCKs that a later round re-audited without raising
again (rounds 3 to 24) are removed.

- Open BLOCK (round 25, resolved in spec by the run, not re-audited): the legacy form could stamp
  onboarding done before its target and constraints saved — now the stamp is written last.
- Open BLOCK (round 25, resolved in spec by the run, not re-audited): a floor refusal could loop
  across local midnight — now the rebuild re-stamps today's date and retries once, then asks.
- Round 24 BLOCK 3 (legacy form order) was re-audited in round 25 and extended by the first item
  above.

Other items:

1. Publish two iCloud shortcuts from your Apple ID — the production "Send Health to Meal
   Companion" (fixed production origin) and the Preview variant (origin pattern), plus the
   "Meal Companion Probe" — and send the links.
2. If probe P5 shows Vercel Deployment Protection blocks the Shortcut on Preview, add a protection
   bypass for `/api/health/ingest` on Preview, or turn protection off for this project's Previews.
3. Set on Production, after the Phase 9 production steps: `NEXT_PUBLIC_APPLE_HEALTH_SHORTCUT_URL`
   and `NEXT_PUBLIC_APPLE_HEALTH_SHORTCUT_NAME` (production shortcut); `GEMINI_BILLING_ATTESTED=1`
   and `HEALTH_CONTEXT_PROVIDER=gemini`; `HEALTH_INGEST_ENABLED=1` if it is not set;
   `MIN_CLIENT_BUILD` set to the first Phase 10 build; then `NEXT_PUBLIC_CHAT_ONBOARDING=1`. **Open
   invites last:** run `scripts/p10/default-accounts-check.sql` (it must list no `default`
   account), and only then set `NEXT_PUBLIC_INVITE_SIGNUP=1` and create the first invite code. This
   replaces Phase 9's step that opens invites after its slice 6. Never set `PREVIEW_TOOLS`, `ONBOARDING_MODEL` or
   `ONBOARDING_JUDGE` on Production.
4. Apply the Phase 10 migrations (`20261110…`) on production after every Phase 9 migration
   (through `20261107090000`) **and after Phase 12's `20261108090000_phase12_target_floor.sql`**,
   with a `scripts/backup.sh` dump before each. The Phase 10 migration refuses to run without it.
5. Approve the new dev dependency `@playwright/test` in the slice 5 PR.
6. Ask Sasha to run the Preview steps and the shortcut probe on her iPhone.
7. Next audit: the Phase 10 implementation plan audit (it re-checks the round 25 resolutions),
   before any Phase 10 code is written.
8. Tell the Phase 11 spec owner: the onboarding thread is not user-deletable in Phase 10. Phase
   11 must show it pinned without a Delete control and drop onboarding-thread deletion from its
   delete design and Preview test (`docs/specs/phase-11-conversations-memory.md:290-296,812-817`).
9. Product safety: schedule the policy fix so a food counts as allergen-free only when its
   allergens were assessed (catalog, barcode, Floor Day). Until then the app tells users to check
   labels. This affects every account, not only new ones.
10. **Jev may receive health context?** TypeSafe (Jev, `api.typesafe.ai`) is a separate processor.
    Decide whether it may receive onboarding text that can hold health data. If yes, record the
    basis and set `JEV_HEALTH_ATTESTED=1` on Preview and Production; until then it stays unset and
    onboarding does not call Jev.
11. Phase 12 revision 22 agrees: its one migration is `20261108090000`, ships before Phase 10,
    does not replace `complete_onboarding`, and names the exact three-argument writer Phase 10
    calls. Shared contract (round 24): the writer computes the minima from the weight it selects
    under lock; there is **no** weight-match check and no `build_stale`; the only refusal Phase 10
    handles is `below_floor` (`SF001`); `account_body_mass_kg(uuid, date)` is granted to
    `service_role` and Phase 10 calls it only with an explicit date. Note for the Phase 12 owner:
    its caller-table line for Phase 10 should read "on `SF001` `below_floor` it shows a new summary
    (chat) or a field error (form)". Phase 10 is `20261110…` and still sorts before Phase 11 (`20261115…`), so the
    `onboarding` kind widening lands in Phase 10 as first planned.
12. **Accepted residual (round 24):** at completion the target is derived from the weight on the
    summary; if a newer weigh-in arrived meanwhile, the saved target can be from a slightly older
    weight, but only when it is above every minimum computed from the newer weight. The next
    weigh-in's normal retarget corrects it. Accept, or ask for the exact-match check back.
13. Note for the Phase 12 owner (round 25 finding 3): the form paths differ by account. A `default`
    (invited) account's form completes only through `complete_onboarding` (Phase 10 "One writer");
    a `manual` account or an `invite` disposition uses the legacy form, which writes the profile
    (unstamped), then the target through `/api/targets` and the checked writer, then the stamp. An
    older client build for a `default` account gets `426` (Phase 9); older builds for `manual`
    accounts keep working. Phase 12's caller table should state these paths and not send a
    `manual` or `invite` account to `complete_onboarding`, which refuses it.
