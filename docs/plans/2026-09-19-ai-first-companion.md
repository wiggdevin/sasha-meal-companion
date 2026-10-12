# AI-first companion — profile-driven targets, the coach runs every card, Jev in the loop (2026-09-19)

**Superseded in part (2026-10-05..08).** Item 3 below ("the same food can never be on both" an
allow-list Eats/Avoid pair) describes the closed-world model. The open-world-by-default direction
(`docs/specs/phase-18-open-world-foods.md`, `docs/decisions/2026-10-05-phase-18-open-questions.md`
Q5) replaces the allow list with the universe plus Favorites: Eats is renamed "Favored" in the UI
(the wire name `eats` is unchanged) and favors without ever limiting what a plate can use.

Status: **approved by Devin's instruction of 2026-09-19** ("run until everything's figured out,
tested, everything's green, and then deploy"). Devin is away; every decision below is his to
reverse afterwards. Driven by `/goal`, slug `sasha-ai-first`, state in `~/.claude/goal-state/sasha-ai-first/`.

## 1. What Devin asked for (his words, condensed)

1. The AI does basically everything: every card can be calculated and manipulated by it.
2. Anthropometrics: a user logs age, height, weight, etc.; calories are calculated from that plus a
   few questions (goal, dietary preferences); everything auto-populates from that information.
3. The user can add and edit foods on the Eats list and the Avoid list; the same food can never be on
   both.
4. The coach handles: "I woke up late, move all my meals by 30 minutes"; "make me 5 suggestions /
   build me recipes from my allow list"; "suggest a snack that fits my remaining calories and macros".
5. The AI is almost the main user face: the user sees the schedule and talks to the AI.
6. Evaluate Jev (TypeSafe System One classifier) and use it where it helps. Key: ZS Vault
   `typesafe_api_key` (verified live 2026-09-19: `jev-1.13.0`, 322 ms, HTTP 200).
7. Deploy when needed, not on every change (Vercel builds cost money).

## 2. What is true today (from the 2026-09-19 code map)

- Coach: `app/api/coach/route.ts` → `lib/server/coach-turn.ts:runTurn` on Gemini (`GEMINI_COACH`
  = gemini-3.6-flash, 3.8-flash fallback). 11 actions in `lib/coach/actions.ts` (`log_meal`,
  `add_slot_item`, `remove_slot_item`, `set_slot_item`, `move_slot`, `add_to_avoid`,
  `remove_from_avoid`, `set_slot_meal`, `delete_entry`, `move_entry`, `save_recipe`), grounded
  server-side (`lib/coach/ground.ts`), applied phone-side (`lib/coach/apply-client.ts` +
  `apply-*.ts`) with Undo. One `compose_meal` tool (`lib/coach/compose.ts`) returns ONE meal card.
- Targets: `lib/targets.ts:RAMP_TABLE` (hard-coded from `analysis/targets.md`) +
  `Settings.activeTargetProfile?: { training: Macros; rest: Macros } | null` (the only path that
  changes a target today) + kcal/protein pins via `lib/scaling.ts:adjustCalories` (protein never
  moves).
- Profile: `user_settings` has `height_cm`, `birth_year`, `sex`, `body_fat_pct` (migration
  `20261013090000_body_profile.sql`), display-only in `lib/tdee.ts` (Mifflin-St Jeor and
  Katch-McArdle already implemented, never on the target path). No weight in the profile (weigh-ins
  exist: `20261019090000_manual_weigh_in`), no activity level, no goal, no dietary preferences, no
  onboarding.
- Schedule: `Settings.slotTimes` + `Settings.shiftMinutes` + `lib/plan.ts:resolveSlotTimes` already
  implement a whole-day shift; only the Settings UI (`components/ShiftTimes.tsx`) drives it.
- Foods: local `Food.status: eats|avoid` is single-valued; server `user_food_prefs` PK
  `(user_id, food_ref_id)` with one `status`. Same-name catalog rows are widened for avoid marks
  only (`lib/coach/ground.ts`, `alsoFoodRefIds`). No `add_to_eats` / `remove_from_eats` action.
- CI: lint (0 warnings), `tsc --noEmit`, `pnpm test` (388 files), integration on local Supabase,
  build. Production migrations are applied by `python3 scripts/apply-migrations.py --commit` after a
  branch rehearsal; Vercel Git integration deploys `main`; every push to any branch builds a preview.

## 3. Decisions taken for Devin (reverse any of them afterwards)

| # | Decision | Why |
|---|---|---|
| D1 | **Profile-derived targets become the base when the profile is complete; the authored ramp stays the fallback.** A complete profile (sex, birth year, height, weight, activity, goal) computes `{training, rest}` macros and writes them to `Settings.activeTargetProfile` through the existing approved-profile path. No ramp is applied to derived targets. Pins still apply on top; protein still never moves under a pin. | Devin's new instruction supersedes AGENTS.md "do not re-derive" for the profile path; Sasha's account has no profile so her behaviour does not change until someone completes one. |
| D2 | **Energy formulas:** Katch-McArdle when body fat % is known, else Mifflin-St Jeor; TDEE = BMR × activity (sedentary 1.2, light 1.375, moderate 1.55, active 1.725, very_active 1.9); goal offset lose_fat −20 %, recomp −5 %, maintain 0, gain_muscle +10 %; training day = TDEE×(1+offset)+10 % carbs shifted in, rest day −10 % carbs, week average = target; protein 2.0 g/kg (lose/recomp) or 1.8 g/kg (maintain/gain); fat 25 % of kcal with the 50 g authored hard floor; carbs the remainder with a 100 g floor; calories floor 1,200 (female) / 1,500 (male). Weight = latest weigh-in, else the onboarding weight (which is also written as a weigh-in). | Matches `analysis/targets.md` method (Katch-McArdle × activity) and its floors; reference values are unit-tested. |
| D3 | **One additive, nullable migration on `user_settings`** (`weight_kg`, `activity_level`, `goal`, `training_weekdays int[]`, `diet_prefs jsonb`, `onboarded_at`), rehearsed on a Supabase branch, backed up, and applied to production BEFORE the merge (AGENTS.md order of operations). | Established pattern (`20261013090000_body_profile.sql`); reversible; no destructive change. |
| D4 | **Jev is an accelerator and a judge, never a dependency.** Four placements: (a) intent + slot pre-pass on every coach message; (b) claim-without-action guardrail on the LLM reply; (c) ranking of code-generated suggestion candidates; (d) free-text dietary preferences → typed flags in onboarding. Any Jev failure (timeout 3 s, 401/429/529, malformed) falls through to today's behaviour. | Jev returns typed probabilities in ~100–300 ms at $0.042/MTok input, cannot hallucinate a type, and is explicitly not for text generation — so it routes, judges and ranks; Gemini keeps every generative turn. |
| D5 | **Fast path:** when the pre-pass returns a mechanical intent (`shift_schedule`, `add_to_eats`, `add_to_avoid`, `remove_from_eats`, `remove_from_avoid`, `log_water`, `log_weight`) with confidence ≥ 0.90 and code fills every required argument, the server returns the action(s) and a one-line templated reply WITHOUT calling Gemini. Below the threshold, or when an argument is missing, the normal LLM turn runs with the pre-pass result injected as a hint. | This is the "frictionless" feel: a mechanical request lands in well under a second instead of 5–10 s. Thresholds start conservative per TypeSafe's own guidance and are recorded as constants. |
| D6 | **Suggestions are generated by code and ranked by Jev.** New coach tool `suggest_options` builds up to 12 candidates through `composeMeal` (varied protein anchors from the Eats list), scores fit deterministically, asks Jev one Score per candidate in ONE request ("plausible as a {meal|snack|recipe} for this person now"), combines fit × plausibility, dedupes by protein anchor, returns N (1–5, default 3) cards. Snack sizing: min(still-to-eat, 300 kcal) unless the user names a size. | Arithmetic stays in code; Jev supplies the judgment "is this actually a snack"; every card keeps the existing three buttons (log / put in slot / save as recipe). |
| D7 | **Exclusivity is enforced in three places:** local `Food.status` (already single-valued), server PK (already one status per ref), and same-name-ref widening for BOTH eats and avoid marks (today only avoid is widened). A test proves that marking a name eats leaves zero avoid rows for that name and vice versa. | Devin: "shouldn't be able to have the same food on both". |
| D8 | **Onboarding is a five-step sheet at `/onboarding`**, offered once after sign-in when `onboardedAt` is null, skippable (skip keeps the authored targets), and re-openable from `/settings`. Steps: body · activity and training weekdays · goal · dietary preferences (free text, Jev flags, confirm chips) · your plan (derived targets shown, editable). | Devin: "a user comes in, they should be able to log their age, height, weight… a few questions… everything should auto-populate". |
| D9 | **New coach actions:** `shift_schedule {minutes, scope: all|remaining}`, `log_water {ml}`, `log_weight {kg}`, `update_profile {fields}`, `set_targets {kcal?, proteinG?, dayType?}`, `add_to_eats`, `remove_from_eats`; new tool `suggest_options`. Each has schema, tool-spec text, client apply, Undo and tests, in the same shape as the existing eleven. | Devin: "every card, it should be able to calculate and manipulate". |
| D10 | **Deploy discipline:** one feature branch, pushed only when local gates are green (each push builds a Vercel preview), one squash-merge to `main` through `~/bin/zs-land`, migration applied to production before the merge, `TYPESAFE_API_KEY` set on Vercel production/preview through the Vercel connector before the merge. | Devin: "do not deploy every five seconds". |
| D11 | **Executor/reviewer lanes:** Codex GPT-5.6 Sol (`codex exec`, effort high; xhigh on escalation) implements each task from a written brief; Grok 4.6 via `~/bin/grok-subscription` audits each task ONCE, a second pass only if the first found a blocking issue (mem0 rule fd243bfc: at most two Grok passes per task). Proof commands are the authority. | House lanes; the T0 night proved open-ended review loops burn the night. |

## 4. Scope

In: everything in §5 tasks. Out (recorded, not built): voice-to-voice, label scan, multi-day meal
plans, any change to the Today screen's visual design (DESIGN.md untouched), adaptive-TDEE engine
changes, deleting the authored ramp table, the legacy sync path, native apps.

## 5. Tasks

Each task lands on branch `feat/ai-first-companion` as one or more commits; the branch lands once.

### T1 — Jev adapter and the intent pre-pass (server)
- `lib/ai/typesafe.ts` (server-only): `systemOne(state, questions, {deadlineMs=3000})` → `POST
  https://api.typesafe.ai/v1/systemone`, bearer `TYPESAFE_API_KEY`, model `jev-latest`, one retry
  with backoff on 429/529, returns `null` on any failure; records usage the way `lib/ai/adapter.ts`
  records other providers (provider `typesafe`, cost from `usage.input_tokens × $0.042/MTok`).
  Question builders `noul()`, `choice()`, `score()` typed like the JS SDK (no SDK dependency).
- `lib/coach/intent.ts`: `classifyIntent(message, ctx)` → one request: Choice `intent` over
  {`shift_schedule`, `log_food`, `suggest_options`, `add_to_eats`, `add_to_avoid`,
  `remove_from_eats`, `remove_from_avoid`, `log_water`, `log_weight`, `update_profile`,
  `set_targets`, `question`, `other`} plus speculative questions consumed only for the winning
  intent: `direction` Choice {later, earlier}, `scope` Choice {all, remaining, one_slot},
  `suggest_kind` Choice {meal, snack, recipe}, `suggest_count` Choice {1..5}, `fit_remaining` Noul,
  `water_amount_stated` Noul, `weight_stated` Noul. Numbers are extracted in code from the message
  (`\d+ (min|minute|hour|h|cup|ml|oz|kg|lb)`); when several candidates exist Jev picks (Choice over
  the candidates, value-extraction cookbook); when none exists the argument is missing.
- `lib/server/coach-turn.ts`: call `classifyIntent` first; fast path per D5 returns
  `{ reply, actions, intent, fastPath: true }` with no Gemini call; otherwise append a one-line hint
  to the prompt and run today's turn. Thresholds in `lib/coach/intent.ts` as named constants.
- Tests: `tests/ai/typesafe.test.ts` (request shape, timeout → null, 429 retry once, malformed →
  null, usage recorded); `tests/coach/intent.test.ts` (fixtures: "I woke up late, can you move all
  my meals by 30 minutes" → `shift_schedule{minutes:30, direction:later, scope:remaining}` with NO
  LLM call asserted; "push everything back an hour" → 60; "move meals" without a number → LLM path;
  a low-confidence fixture → LLM path with hint; "add watermelon to my avoid list" → fast path
  add_to_avoid). Live smoke: `scripts/jev-smoke.ts` prints the classified intent for five sentences
  and exits 0 when the first is `shift_schedule`.

### T2 — Profile model, energy engine, derived targets
- Migration `supabase/migrations/20261022090000_profile_targets.sql` (+ `.down.sql`): additive
  nullable columns on `user_settings` per D3, with checks (`weight_kg` 20–400, `activity_level` in
  the five values, `goal` in the four values, `training_weekdays` elements 0–6); extend the
  `_sync_upsert` `user_settings` branch exactly as `20261013090000` did.
- `lib/types.ts` `Settings`: add `weightKg?`, `activityLevel?`, `goal?`, `trainingWeekdays?`,
  `dietPrefs?`, `onboardedAt?`; `lib/store.ts` defaults; `lib/sync` mapping both directions.
- `lib/profile/energy.ts` (pure): `bmr(profile)`, `tdee(profile)`, `deriveTargets(profile) →
  { training: Macros; rest: Macros }` per D2; `isProfileComplete(settings)`.
- `lib/targets.ts:resolveTargets`: when `isProfileComplete` and `activeTargetProfile` is unset, use
  `deriveTargets`; the onboarding "your plan" step and `update_profile` / recompute write
  `activeTargetProfile` so that the existing approved-profile path stays the single writer.
- `lib/plan.ts` day type: when `trainingWeekdays` is set it decides training vs rest; the fixed
  Mon/Wed/Thu/Fri rule stays the fallback.
- Tests: `lib/profile/energy.test.ts` with reference values (Mifflin-St Jeor: female 30 y, 165 cm,
  60 kg → BMR 1320.25; male 25 y, 180 cm, 80 kg → 1805 (1780 at age 30); Katch-McArdle from lean body mass),
  every activity factor, every goal offset, protein by weight, fat floor 50 g,
  carbs floor, calorie floors, week-average identity for training/rest cycling; `lib/targets.test.ts`
  proves fallback when the profile is incomplete and that `adjustCalories` still never moves
  protein; migration applies on the local Supabase (integration test extends the existing
  `user_settings` round-trip).

### T3 — Onboarding and profile editing
- `app/onboarding/page.tsx` + `components/Onboarding/*` (five steps per D8), `components/AuthGate.tsx`
  routes to `/onboarding` once when `onboardedAt` is null; `/settings` gets "Edit profile" opening
  the same steps; `BodyProfileFields` reused.
- Dietary preferences: `app/api/profile/prefs/route.ts` (auth, rate-limited) sends the free text to
  Jev: one Noul per flag {vegetarian, vegan, pescatarian, no_pork, no_beef, no_shellfish, no_eggs,
  no_soy, no_nuts, low_fodmap, halal, kosher} + Noul `mentions_specific_foods`; flags ≥ 0.8 become
  pre-ticked chips the user confirms; the confirmed flags land in `dietPrefs` and, where a flag maps
  to a banned category or allergen, also in the constraint profile through the existing
  `/api/constraints` PUT.
- Tests: component tests for each step, skip path leaves targets untouched, complete path writes
  the profile + `activeTargetProfile` + a weigh-in; `tests/profile/prefs-route.test.ts` with a Jev
  fixture and the Jev-down fallback (chips unticked, flow continues).

### T4 — Coach actions for every card
- `lib/coach/actions.ts`: add the D9 actions to `ACTION_KINDS`, the strict and flat schemas, and
  `buildToolSpec` text; `lib/coach/prompt.ts` examples for each.
- Client apply/undo: `apply-schedule.ts` (`shift_schedule` → `Settings.shiftMinutes` for scope
  `all`, or per-slot `slotTimes` for the remaining un-eaten slots of the date for scope
  `remaining`; undo restores the prior values), `apply-body.ts` (`log_water` → the water log,
  `log_weight` → a weigh-in, undo deletes the row), `apply-profile.ts` (`update_profile` →
  Settings fields and a recompute; `set_targets` → pins; undo restores the prior Settings).
- `apply-prefs.ts`: `add_to_eats` / `remove_from_eats` mirror the avoid pair; widening for both.
- Tests: `tests/coach/actions-v3.test.ts` (schemas, flat round-trip), `tests/coach/apply-schedule.test.ts`
  (30 min later on a day with two eaten slots moves only the remaining ones; undo restores),
  `apply-body`, `apply-profile`, and `tests/coach/exclusivity.test.ts` (D7).

### T5 — `suggest_options` tool and multi-card rendering
- `lib/coach/suggest.ts`: candidate generation via `composeMeal`, deterministic fit score, Jev
  ranking in one request (Score per candidate, levels "not a {kind}" / "acceptable" / "a natural
  {kind}"), dedupe, top N; snack sizing per D6. Tool registered in `lib/coach/registry.ts`,
  executor in `lib/server/coach-ports.ts`.
- Rendering: the reply can carry `composed: ComposedMeal[]`; `components/CoachChat.tsx` renders
  one `CoachComposedCard` per item.
- Tests: `tests/coach/suggest.test.ts` (5 asked → 5 distinct protein anchors, every item passes
  policy, every card within ±15 % of the target, snack ≤ 300 kcal, Jev-down → fit order only);
  `tests/coach/chat-state.test.ts` extended for a list of cards.

### T6 — Reply guardrail
- `lib/coach/verify.ts`: after the LLM turn, one Jev request with Noul "Does the reply claim that
  something was logged, moved, added, removed, changed or saved that is NOT in `actions`?" over
  `{ reply, actions }`; ≥ 0.80 with an empty or non-matching action list triggers the existing
  corrective step, then the honest fallback. The existing heuristic stays as the Jev-down path.
- Tests: `tests/coach/verify.test.ts` fixtures (claims "Logged your lunch" with no action →
  flagged; a benign answer → not flagged; Jev down → heuristic result).

### T7 — Docs and config
- `AGENTS.md`: new rows for `lib/ai/typesafe.ts`, `lib/coach/intent.ts`, `lib/profile/energy.ts`,
  `lib/coach/suggest.ts`, `lib/coach/verify.ts`, `app/onboarding`; the targets rule rewritten per
  D1; the actions list updated; env `TYPESAFE_API_KEY`.
- `docs/features.md` rows for every new surface (`pnpm lint:docs` guards them); `.env.example`
  `TYPESAFE_API_KEY`; `docs/ai-data-handling.md` gains a TypeSafe paragraph (what is sent: the
  message text, candidate meal names, preference text; nothing stored by TypeSafe per its terms —
  cite the page); `docs/decisions/2026-09-19-ai-first-rulings.md` = §3 of this document.

### T8 — Gates, schema, secrets, land
- Local gates once: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`.
- Supabase branch rehearsal of the migration (`scripts/db-branch.sh`), then `scripts/backup.sh`
  to `~/Backups/supabase/`, then `python3 scripts/apply-migrations.py --commit` on production,
  then `scripts/check-migration-drift.ts` clean.
- `TYPESAFE_API_KEY` added to Vercel production + preview through the Vercel connector (value from
  ZS Vault in process memory; never printed).
- Push once; CI green; `~/bin/zs-land`; Vercel production READY on the new `main` sha.

### T9 — Live verification and hand-off
- Local dev server against production Supabase config is NOT used. Verification is: (a) production
  `POST /api/coach` unauthenticated → 401; (b) `scripts/jev-smoke.ts` against the real Jev → exit 0;
  (c) a local authenticated turn (`pnpm dev` + dev sign-in) for the three Devin sentences of this
  PRD — "move all my meals by 30 minutes" (fast path, action card), "make me 5 suggestions from my
  eats list" (5 cards), "suggest a snack that fits my remaining macros" (snack cards) — captured to
  the proof directory; (d) summary + mem0 record.

## 6. Success criteria (each has a command; proof files under `~/.claude/goal-state/sasha-ai-first/proof/`)

| Id | Criterion | Verification command (exit 0 = pass) |
|---|---|---|
| C1 | Jev adapter works live and degrades to `null` | `pnpm exec vitest run tests/ai/typesafe.test.ts && pnpm exec tsx scripts/jev-smoke.ts` |
| C2 | Intent fast path: the 30-minute sentence yields `shift_schedule{minutes:30}` with no LLM call; missing number and low confidence fall through | `pnpm exec vitest run tests/coach/intent.test.ts` |
| C3 | Energy engine reference values, floors, cycling, fallback, protein invariant | `pnpm exec vitest run lib/profile/energy.test.ts lib/targets.test.ts lib/foods.test.ts lib/meals.test.ts` |
| C4 | Profile migration applies and round-trips through sync on local Supabase | `pnpm exec vitest run tests/sync/user-settings*.test.ts` (integration env) — or the branch rehearsal log when Docker is unavailable |
| C5 | Onboarding writes profile, derived targets and a weigh-in; skip leaves targets untouched; prefs parse with Jev fixture and Jev-down | `pnpm exec vitest run tests/onboarding tests/profile` |
| C6 | Every new action has schema, apply and undo tests; exclusivity holds across same-name refs | `pnpm exec vitest run tests/coach/actions-v3.test.ts tests/coach/apply-schedule.test.ts tests/coach/apply-body.test.ts tests/coach/apply-profile.test.ts tests/coach/exclusivity.test.ts` |
| C7 | `suggest_options` returns N distinct policy-clean cards within tolerance; snack cap; Jev-down order | `pnpm exec vitest run tests/coach/suggest.test.ts tests/coach/chat-state.test.ts` |
| C8 | Guardrail flags a claim without an action and passes a benign reply | `pnpm exec vitest run tests/coach/verify.test.ts` |
| C9 | Full local gates green once | `pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm build` |
| C10 | Landed and live: PR merged, production READY, 401 unauth, key present, drift clean | `bash scripts/readiness/ai-first-live.sh` (written in T8: gh pr view merged, Vercel READY sha == main, curl 401, drift script, env listing by NAME) |
| C11 | Three Devin sentences produce the expected cards on a local authenticated turn against real Jev + Gemini | `pnpm exec tsx scripts/coach-live-check.ts` (T9; asserts fast-path shift action, 5 cards, snack cards; writes the transcript to proof) |

## 7. Jev evaluation — where it helps and where it does not

Helps (built here): intent + argument routing (D4a, ~300 ms, confidence-gated), claim-without-action
verification (D4b), ranking code-built candidates (D4c), free-text → typed preferences (D4d).
Considered and deferred: catalog-hit reranking for "add X to avoid" when several rows match (the
same-name widening already covers the reported bug); gluten/dairy Noul over label ingredient text
for unverified items (a T3-label-scan follow-up, cut by Devin on 2026-09-18). Not suitable: any
generative turn (recipes, explanations, the reply text), arithmetic (portions, macros), anything
needing catalog lookups — code and Gemini keep those.
