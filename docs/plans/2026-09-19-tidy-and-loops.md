# Tidy and three loops — apply the Sol rulings, house-keep, then prove production (2026-09-19, evening)

Status: **approved by Devin's instruction of 2026-09-19** ("if you agree with the answers then let's go with them.
Then let's tidy the application up. Pick 3 loops … Run until they are all completed /goal"). Driven by `/goal`,
slug `sasha-tidy-loops`. Rulings and dispositions: `docs/decisions/2026-09-19-sol-rulings.md`. Base: main 54db447.

## 1. Tasks

### U1 — One target authority (D1, D9-targets, F1)
The derived profile and the pins persist server-side through the existing targets path (`lib/server/targets.ts`,
`app/api/targets`, `target_profiles`) so `resolveTargets` on the phone, `buildDayContext` for the coach and the
export all read one revision. `applyDerivedProfile` takes an explicit effective date, the latest weigh-in and the
training weekdays; onboarding "Use this plan", `update_profile`, `set_targets` (with explicit pin clearing) and a new
weigh-in all recompute through it and sync before the reply is final. The authored ramp stays the base for an
incomplete profile.

### U2 — Energy engine correctness (D2, F3)
Rest-day multiplier `1 − 0.10 × trainingDays / restDays` so the week averages to the target; per-day calorie floor
(1200 F / 1500 M) and 100 g carbohydrate floor enforced after cycling; when a floor binds the weekly average is
allowed to rise and the result says so. Tests: all four goals × 0–7 training days × floor-bound and not.

### U3 — Food membership (D7, D9-eats, F5)
A transactional server operation `set_food_membership(user, normalizedName, status | null)` that updates every
catalog and user `food_refs` row with that normalized name in one statement (bounded); `null` clears the rows
(neutral). The client's `add_to_eats` / `add_to_avoid` / `remove_from_eats` / `remove_from_avoid` and the Foods
sheets go through it; local `Food.status` gains `"neutral"` (not in Eats, not in Avoid, not in the rotation pool;
nothing is deleted). `scripts/food-membership-audit.ts` lists every user whose same-name refs disagree (read-only;
`--fix` repairs to the most recent mark). Rules tests stay green (a food on Avoid never appears in a plan).

### U4 — Coach fast path, suggestions, telemetry, context (D4, D5, D6, D12, F9, F10)
`FAST_PATH_CONFIDENCE_MUTATING = 0.95`, `FAST_PATH_CONFIDENCE_SUGGEST = 0.90`, every argument field ≥ 0.90 or
deterministically parsed; fast-path copy in the present tense ("Moving your remaining meals 30 minutes later."),
the action card carries the applied state. Suggestions: rank = fit × plausibility, drop plausibility < 0.50 when
Jev confidence ≥ 0.6, dedupe by canonical food identity (ref id, else normalized name), "built around your Eats
foods" unless every item is on Eats; executor budget 8 s total → partial cards or an honest retry line, never a
Gemini turn. Telemetry (privacy-safe, in `ai_calls`/`client_timings` as the repo records elsewhere): latency,
fallback reason, winning and argument confidences, fast-path taken, apply failure, Undo — never the utterance.
Context: no raw weight or anthropometrics every turn; include the profile line only when the intent is
`update_profile`, `set_targets`, `log_weight` or a question about weight/targets. Docs rephrase "cannot hallucinate
a type" to "shape-constrained; classification can still be wrong".

### U5 — Onboarding for existing accounts (D8, F4, F8)
Forced redirect only for accounts created after this change (marker: `user_settings.first_opened_at` older than
the U6 migration timestamp → grandfathered); grandfathered accounts see a non-blocking "Set up your profile" row on
Settings and a one-line invitation on Today, dismissible. Preference chips split into "enforced exclusions" (map to a
policy key) and "preferences for coach suggestions" (advisory), labeled as such; `no_nuts` becomes `no_peanuts` in
the UI and storage with backward-compatible parsing of stored `no_nuts`.

### U6 — Migration tweaks and the sync contract (D3, F2)
Follow-up migration: `training_weekdays` elements unique and within 0–6; `diet_prefs` must be a JSON object when
non-null. Branch-backed integration test: create, update, omission preserves, explicit null clears, pull round-trip,
stale-rev retry — for the six profile fields.

### H — Housekeeper tidy (#041 The housekeeper loop, adapted)
Prove one low-risk cleanup at a time (dead code, stale files/comments, unused deps, duplication, broken links,
inconsistent names) with direct evidence; smallest coherent change; rerun lint/tsc/targeted tests after each;
protect uncertain candidates; stop when no confirmed low-risk cleanup remains. Record every cleanup in
`docs/housekeeping/2026-09-19.md` with its evidence.

### L1 — Data-integrity sweep (#014 The production data cleanup loop, adapted, read-only on production)
Against production through the admin client, READ-ONLY: (a) same-name `user_food_prefs` contradictions per user;
(b) `user_settings` profile fields vs `target_profiles` revision consistency; (c) orphaned `food_refs`, `user_foods`
without refs, prefs pointing at missing refs; (d) plan_days slots referencing foods on Avoid; (e) weigh-in / water rows
outside sane ranges. Each finding: count, sample ids, severity, the fix path (script with `--fix`, run on a branch
first). Terminal: every check reports 0 or an owner step; the audit script lives in `scripts/audit/data-integrity.ts`
and is idempotent.

### L2 — Production readiness sweep (#048 The Groundtruth loop, adapted from the 2026-09-12 version)
Area by area from live evidence: deploy state at the main sha; every API route's unauthenticated status; env var names
vs `.env.example`; crons registered; Supabase security and performance advisors; RLS cross-user on a branch; Today,
Foods, Settings, Coach, Onboarding at 390 px (Playwright or a browser task space, screenshots to
`docs/readiness/2026-09-19/`); PWA manifest and service worker; runtime errors last 24 h (Vercel runtime logs);
AI spend cap check; backup/restore readiness (restore the latest dump into a branch). D10 receipts. Terminal: every
area proved / weak / N/A / owner step; a weak area is fixed only by a bounded reversible change with a targeted test.

### L3 — Coach quality streak (#009 The quality streak loop, adapted)
On a Supabase branch with real Jev + Gemini: a corpus of 20 realistic sentences (`scripts/eval/coach-corpus.json`;
the four Devin sentences, five list edits, four schedule/water/weight, four suggestions incl. wishes, three questions
that must NOT act) with expected path, action kinds, card counts, latency bound (fast path < 2 s, LLM < 15 s) and "no
unsupported claim". Run until N = 10 consecutive passes over randomly drawn cases; every failure gets a regression
test (or a corpus fix when the expectation was wrong, recorded), then the streak restarts. Results in
`docs/evals/2026-09-19-coach-streak.md`. Model behaviour that is not a code defect is recorded, not "fixed".

### W — Docs, gates, land
AGENTS.md / features.md / decisions updated; `pnpm lint`, `tsc`, `pnpm test` once, `pnpm build`; migration (U6)
rehearsed on a branch, backed up, applied to production before merge; one push; CI; `zs-land`; D10 receipts.

## 2. Success criteria

| Id | Criterion | Command (exit 0 = pass) |
|---|---|---|
| K1 | Targets: one authority — onboarding, update_profile, set_targets, log_weight all recompute and persist server-side; phone, coach context and export agree on a fixture | `pnpm exec vitest run tests/targets tests/coach/apply-profile.test.ts tests/coach/apply-body.test.ts tests/onboarding/persistence.test.ts` |
| K2 | Energy: 4/3 week averages to target; floors per day; all goals × 0–7 days | `pnpm exec vitest run lib/profile/energy.test.ts lib/targets.test.ts` |
| K3 | Membership: transactional op updates every same-name ref; neutral clears; audit script finds 0 on a seeded branch after `--fix`; rules tests green | `pnpm exec vitest run tests/coach/exclusivity.test.ts tests/foods lib/foods.test.ts lib/meals.test.ts && pnpm exec tsx scripts/food-membership-audit.ts --branch-check` |
| K4 | Fast path thresholds/arguments, present-tense copy, suggestion product ranking, 8 s budget, telemetry rows, context minimization | `pnpm exec vitest run tests/coach/fast-path.test.ts tests/coach/intent.test.ts tests/coach/suggest.test.ts tests/coach/context.test.ts tests/ai/typesafe.test.ts` |
| K5 | Onboarding: grandfathered account not redirected, new account redirected once; chips labeled; no_peanuts with legacy parse | `pnpm exec vitest run tests/onboarding tests/profile` |
| K6 | Migration tweaks apply; sync contract integration test green on a branch | `pnpm exec vitest run tests/sync && branch rehearsal log` |
| K7 | Housekeeper: `docs/housekeeping/2026-09-19.md` lists each cleanup with evidence; gates green after | `pnpm lint && pnpm exec tsc --noEmit` |
| K8 | L1 terminal: every check 0 or owner step; script idempotent | `pnpm exec tsx scripts/audit/data-integrity.ts --production --read-only` |
| K9 | L2 terminal: readiness table with no silent gaps; receipts | `test -s docs/readiness/2026-09-19/README.md && bash scripts/readiness/ai-first-live.sh` |
| K10 | L3 terminal: 10 consecutive passes; every failure documented with a regression test | `pnpm exec tsx scripts/eval/coach-streak.ts --report` |
| K11 | Landed and live: PR merged, production READY, migration drift none, 401, key present | `bash scripts/readiness/ai-first-live.sh <PR>` |
