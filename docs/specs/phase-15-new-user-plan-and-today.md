# Phase 15 — A new account gets a real plan, and Today is fully editable

Status: approved 2026-09-25. Devin reported these problems after he signed up a new account and
ran `/goal` with "fix every one of them and do not stop until they have been completed and have
been tested and are green". His report is the contract. This file turns each problem into a
pass/fail criterion. Code maps: `~/.claude/goal-state/sasha-phase-15/notes/map-*.md`.

## Owner amendment — 2026-09-26 (takes precedence)

Devin approved execution in Codex and explicitly requires no user to inherit hard-coded
plans, meal cards or preferences from the original single-user application. This supersedes
all legacy-preservation exceptions below. All accounts use account-derived meal layouts.
Preserve explicitly saved user choices, logged meals and overrides; never delete user data
or infer personal preferences from the original client's defaults. Remove original-client
food restrictions from generic starter selections: filter using the current account's
explicit diet/allergen settings only. Automatically seeded historical defaults need a
provenance-aware reconciliation that does not erase genuine user choices.

The experience must be premium, simple and intuitive within the existing DESIGN.md system.
Use plain action copy, clear progress, useful loading/empty/error states, accessible sheets
and reliable undo. Defer optional enhancements when they would block core completion; record
the reason. Do not waive account isolation, food safety or end-to-end proof.

Execution transfers to GPT-6 Sol in Codex; independent review and captured proof remain
required. The historical Opus executor instruction below is superseded by this transfer.

## Status — 2026-10-03

R1–R9 and R13–R14 are in `main`. This pass closed the gaps found when each ruling was checked
against the code:

- **R12:** a focus-only "More for Meal N" control again opens Clear and Delete for keyboard and
  screen-reader users. #290 removed the visible button; this one stays off the card face until it
  is focused (`components/MealCardActions.tsx`).
- **R14:** coach meal and snack suggestions, including the Plan sheet's automatic request, wait
  for the rule review (`ruleReviewRequired` in `lib/coach/suggest.ts`).
- **R4:** an eaten recipe snapshot counts as a fixed meal when the other meals are sized.
- **c2:** the ritual-name tenancy rule scans all of `app/`, `components/` and `lib/`. Every file
  outside the legacy modules needs a stated reason (`tests/tenancy/no-personal-defaults.test.ts`).
- **R11:** Today shows the macro spheres from #310 instead of rings. A test now covers the
  over-goal state (red fill and "N grams over"). Superseded 2026-10-05: the Day card ledger shows the
  figures, and over-goal reads "N g over" in words (`components/today/DayCard.test.tsx`).

Later owner design changes supersede three details. These are not gaps:

- **R10:** the Plan sheet attaches under its meal card instead of opening as a modal (#296).
- **R10:** the floating coach button is gone, and `/coach` is in the primary navigation (#290).
- **R10:** with recipe access on, Plan opens recipe discovery.

## 1. The problems (Devin, 2026-09-25)

| # | Problem as reported |
|---|---|
| P1 | After onboarding, the plan is empty. The app must build a suggested meal plan automatically, say "this is your suggested meal plan", pick the number of meals the person needs, and get macros, portions and variety right. |
| P2 | Coffee and hot chocolate appear pre-programmed for a new account. |
| P3 | Foods › Eats and Foods › Avoids are empty after onboarding. |
| P4 | Onboarding never asks to connect a device. |
| P5 | Swipe right to swap an AI-built meal shows only "Use this meal" and "Use today's pick", which do the same thing, and nothing can be edited. Show at least 5 similar meals with the correct calories. |
| P6 | "Plan" on an empty meal opens an empty coach chat with no directions, on a different page. The coach must open over Today, with Today visible behind it, and tell the person what to do. |
| P7 | A person cannot add more meals (meal 4, 5, 6). |
| P8 | The rings never show going over a goal. Over-goal must keep filling and turn red; adding a food must show the projected total (for example fat 120 / 70 g). |
| P9 | A meal cannot be deleted. Swipe left reveals "Clear", further reveals "Delete" with an icon, and a full hard swipe deletes. |

## 2. Rulings made for this phase

- **R1 Layout, not rituals.** Every account uses a *meal layout*: `Meal 1 … Meal N`, no
  coffee, no pre-training carbs, no refuel, no hot chocolate — on Today, Settings › Schedule, the
  `.ics` export, the coach prompt and the server day context. Historical slot ids remain readable
  only to preserve saved user data; they never seed a plan.
- **R2 Meal count.** New column `user_settings.meals_per_day smallint null check (between 2 and 6)`.
  Null on a layout account means "derived": training-day calories ≤ 1,800 → 3 meals, ≤ 2,600 → 4,
  above → 5. Onboarding's "Your plan" step shows the derived count with a stepper (2–6).
  Default times: 2 → 09:00 18:00; 3 → 08:00 12:30 18:30; 4 → 08:00 11:30 15:00 18:30; 5 → 07:30 10:30 13:30 16:30
  19:30; 6 → 07:00 09:30 12:00 14:30 17:00 19:30. `settings.slotTimes` overrides still apply.
- **R3 Slot ids.** `SlotId` gains `meal-4`, `meal-5`, `meal-6`. Every zod enum, allowlist and the
  `eaten_slots` SQL check accept them (one migration, `20261125090000_meal_layout.sql`, which also
  adds `meals_per_day` and extends `_sync_upsert` for it).
- **R4 Per-meal targets on a layout day.** Day target (the revision's calories/macros for the day
  type) minus the macros of every meal the person fixed that day (an item override, a swap to a
  recipe, an eaten meal) is split evenly across the remaining generated meals. Adding or deleting
  a meal therefore re-sizes the other generated meals automatically. A calorie change still never
  moves a protein portion on legacy accounts (existing rule, unchanged).
- **R5 Starter foods.** A curated starter list in code (`lib/foods/starter.ts`) built from
  `lib/food-db.json` entries: at least 8 proteins, 8 carbs, 6 fats, each tagged with diet
  compatibility (omnivore, pescatarian, vegetarian, vegan) and with no apple, gluten or dairy.
  Onboarding gains a **Foods** step after Dietary preferences: the starter foods that pass the
  person's flags, allergens and dietary profile appear pre-selected as chips by role; the person
  can deselect, add from search, and mark foods to avoid. Foods named in the dietary free text are
  matched against the food list and pre-marked eats or avoid by the words around them ("love",
  "more" → eats; "hate", "don't eat", "allergic", "avoid", "no" → avoid). Completion writes
  eats/avoid memberships through the existing `food_membership` path. At least 2 per role must
  remain selected to continue (the step says why).
- **R6 Existing new accounts.** A layout account that has finished onboarding and has zero foods
  gets the same starter selection applied once, automatically, the first time Today loads (the
  filters come from its saved flags and constraints; idempotent; never on legacy accounts).
- **R7 Avoids shows diet style.** Foods › Avoids renders the diet style flags (vegetarian, vegan,
  pescatarian, no pork, no beef, halal, kosher), the dietary profile rules and the avoided foods.
- **R8 Device step.** After "Use this plan" stamps `onboarded_at`, a **Connect a device** screen
  appears before Today: Apple Health (Health Auto Export token, same actions as
  `HealthSourcesSheet`), Oura only when the server reports it configured (`OURA_CLIENT_ID` set),
  and "Skip for now". The Oura callback honours a safe same-origin `returnTo`. Hidden entirely when
  `HEALTH_INGEST_ENABLED` is off.
- **R9 Swap sheet.** Swipe right on any meal slot (layout or legacy meal-1..6) opens one sheet that
  lists at least 5 alternatives, each within ±10 % of that slot's calorie target, each with a
  different main protein where the pool allows, drawn from the person's eats (composed and sized
  to the slot), their recipes and their favourite meals. Each row shows name, kcal and P/C/F.
  Tapping one writes an item override (components + title) and closes the sheet. "Edit this meal"
  opens `EditSlotSheet`. "Back to the suggested meal" appears only when the slot holds an override,
  and it clears the title too. The two duplicate buttons are gone.
- **R10 Plan with the coach.** "Plan" and "Plan with the coach" open a sheet over Today (the URL
  stays `/`, Today visible behind a dimmed backdrop). Header: "Plan Meal N · <time>" and the slot's
  target ("about 620 kcal · 45 g protein"). Guidance line and four starter chips ("Suggest
  something", "High protein", "Something quick", "Use what I have"). The sheet starts a fresh
  thread and immediately sends a planning request for that slot, so meal options with
  "Put it in Meal N" appear without typing. Placing a meal closes the sheet and the card updates.
  The floating coach button still opens `/coach`.
- **R11 Rings.** When consumed > target a red (`--color-alert`) arc draws on top of the full ring
  for the excess (capped at one extra lap), the end dot moves to its end, the aria-label and footer
  say "N g over". Log a food, the portion step of scan/capture confirm, and Build meal show the
  projected day total per macro ("Fat 69 → 120 / 70 g"), red when it would exceed the goal.
- **R12 Swipe left.** Past 64 px the card reveals **Clear**; past 150 px it also reveals **Delete**
  with a trash icon; releasing leaves the revealed buttons open for a tap; a swipe past 60 % of the
  card width deletes on release. Clear = an empty, untitled override (renders as the empty
  "Nothing planned yet" card). Delete = a per-date `removed: true` marker on that slot's override
  (the slot disappears for that date; generated meals re-size, R4). Both show an Undo toast for
  5 s. A focusable "More" control gives keyboard and screen-reader access to Clear and Delete.
- **R13 Add a meal.** "+ Add a meal" at the end of Today's plan adds the next unused slot id up to
  meal-6 for that date (an override marker `added: true`, time = previous meal + 2 h 30 m, capped
  at 21:30), planned automatically from eats (R4). Settings › Schedule shows "Meals per day"
  (2–6) for layout accounts, which sets `meals_per_day` for every day.
- **R14 Confirm ambiguous historical food rules.** A prior migration copied the original client's
  food restrictions into existing account rows without provenance. For accounts created before that
  migration, preserve every row and require a one-time, server-backed review before starter seeding
  or generated meal suggestions. Show each inherited candidate rule with explicit Keep and Remove
  choices; an unanswered rule has no default answer and cannot complete the review. Save the chosen
  rules through the revision-checked constraints path, then record a review marker. Migration
  `20261125090100_historical_rule_review.sql` flags only candidate rows whose account was created
  before 2026-09-21 05:40 UTC using `auth.users.created_at`; new rows default to unflagged.
  Generic constraint edits cannot remove flagged candidate keys until the review is complete.
  `20261125090200_rule_review_write_guard.sql` withholds marker-column writes and direct row
  deletion from authenticated database clients; the verified review route stamps it via service role.
  Authored meals, logs and preferences stay visible. New accounts do not inherit this review or
  those rules.

## 3. Success criteria (each needs a captured proof)

| id | Criterion | Proof |
|---|---|---|
| c1 | A fresh layout account with a revision and starter foods renders Today with N generated meals (N per R2), a "Your suggested meal plan" heading, per-day totals within ±5 % of target calories and protein ≥ 95 % of target, portions in sensible household units, and no protein repeated within a day; checked for omnivore, pescatarian, vegetarian and vegan across 14 consecutive dates. | vitest run of the new plan tests |
| c2 | A layout account shows no coffee, pre-training carbs, refuel or hot chocolate on Today, Settings › Schedule, `.ics` and the coach prompt; all accounts use their own target-backed layout; explicit saved meals and preferences survive and no original-client defaults are inherited. A lexical rule for ritual names outside legacy modules is added to the tenancy tests. | vitest |
| c3 | Onboarding has a Foods step; completing it writes eats and avoid memberships; Foods › Eats lists the eats; Foods › Avoids lists avoid foods and diet style; free-text food mentions are pre-marked; an onboarded layout account with zero foods is seeded once on Today. | vitest |
| c4 | After "Use this plan" the Connect a device screen appears with Apple Health, Oura only when configured, and Skip; the Oura callback honours a safe `returnTo`; hidden when ingest is off. | vitest |
| c5 | Swipe right on an AI-built meal lists ≥ 5 alternatives within ±10 % of the slot's calorie target; choosing one writes an override that changes the card; "Edit this meal" opens the editor; "Back to the suggested meal" clears the title; no duplicate buttons. | vitest |
| c6 | Plan opens a sheet over Today (no navigation), with header, target line, guidance, 4 starter chips and an auto-sent planning request producing "Put it in Meal N"; placing closes the sheet; the FAB still routes to `/coach`. | vitest |
| c7 | "+ Add a meal" adds meal-4..6 for the date with auto-planned content and re-sizes other generated meals; Settings › Schedule meals-per-day persists; the migration accepts meal-4..6 in `eaten_slots` and adds `meals_per_day`. | vitest + migration applied to production before the merge that needs it |
| c8 | Over-goal rings draw a red excess arc and "over" copy; projected totals appear in log/capture/build sheets, red when over. | vitest |
| c9 | Swipe left reveals Clear then Delete, a full swipe deletes, Undo restores, keyboard path works, a cleared slot renders the empty card, a deleted slot is gone for that date only. | vitest |
| c10 | Every slice merged to `main` through the required CI checks; `main` CI green; the production deploy of the final `main` commit READY. | CI + Vercel API capture |
| c11 | End-to-end on a local stack (local Supabase + `pnpm dev`): a new account signs up, onboards, and every behaviour c1–c9 is observed in the browser, with screenshots. | screenshots + a written walk-through |
| c12 | Historical accounts with ambiguous migrated food rules see an explicit rule review before automated food seeding or meal suggestions. Each candidate requires Keep or Remove, no row is silently changed, the server stores completion, and another device sees the choice. Authored content remains visible. | migration + route/UI tests and local browser walkthrough |

## 4. Slices (one branch and one PR each)

| Slice | Branch | Covers | Depends on |
|---|---|---|---|
| S1 | `feat/p15-meal-layout` | R1–R4, R13's Settings stepper, migration, c2 and the layout half of c7 | — |
| S2 | `feat/p15-starter-plan` | R5–R7, "Your suggested meal plan", c1, c3 | S1 |
| S3 | `feat/p15-device-step` | R8, c4 | — |
| S4 | `feat/p15-swap-sheet` | R9, c5 | S1 |
| S5 | `feat/p15-swipe-and-add` | R12, R13's Today button, c9 and the Today half of c7 | S1, S4 |
| S6 | `feat/p15-plan-sheet` | R10, c6 | — |
| S7 | `feat/p15-over-goal-rings` | R11, c8 | — |
| S8 | (no branch) | c10, c11 | all |
| S9 | `feat/p15-rule-provenance` | R14, c12; integrate before automated suggestions ship | S1 |

Method (Devin's standing ruling from Phase 13): Opus 5.5 implements test-first in its own
worktree; one review round with GPT-6 Sol and DeepSeek V4.1 Flash in parallel; one Opus fix round;
captured proof; land through CI. Migrations go to production through
`scripts/apply-migrations.py` **before** the merge that reads them.

## 5. Limits

- Oura needs a registered Oura developer app (`OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`,
  `OURA_REDIRECT_URI`). None exists in production or ZS Vault; the Oura button stays hidden until
  Devin registers one. Apple Health works now.
- File-size budgets in `tests/speed/file-size.test.ts` are never raised; split modules instead.
- Preserve explicitly authored user content; remove inherited single-user defaults for every account.
