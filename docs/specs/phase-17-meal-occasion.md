# Phase 17 — Meal occasion, pairing and portion awareness (v2)

Date: 2026-10-04 (v2 after the GPT-6 Sol design review, `~/Inbox/notes/sasha-meal-occasion-spec-gpt6.md`:
six BLOCKs and two WARNs, all addressed in §Decisions v2 below, which overrides the earlier text where
they differ). Owner: Devin. Source: AI-integration audit
(`docs/audit/2026-10-04-ai-integration/report.md`, revised fix plan steps 2–5) and GPT-6 Sol's design
review. This spec is the PRD for the autonomous build; §Acceptance is the done list.

## Problem

The daily layout puts "tuna, canned in water with banana" into a 7:30 slot. It knows the slot's
clock (`resolveDay` computes it) but never uses it; it ranks proteins by leanness, takes "any carb",
and names the plate after its first two foods. Only the coach's `suggest_options` knows meal types,
pairings and portion bands, and those live in `lib/coach` with English-name regexes. Jev already
scores `breakfast_fit` … `snack_fit` for every food, and nothing reads them.

## Principles

1. **Occasion is a soft affinity with provenance, never a global ban.** People eat fish at breakfast
   in many food cultures. The engine ranks; it does not forbid. Only safety (allergens, Avoid,
   conditions) forbids, and it stays at the write boundaries.
2. **The account's own behaviour outranks every generic prior.** Order of evidence for "is food F a
   good fit at occasion O for this account":
   1. an explicit choice (the user placed or swapped F into an O slot; an occasion override);
   2. the account's own log history (F logged in O slots, recency-weighted);
   3. a curated, cuisine-diverse prior (dish/template table — data, not regexes in code);
   4. a calibrated Jev occasion judgment, cached per food (facets v2);
   5. neutral.
   Each affinity carries its source, so the UI and the coach can say why.
3. **Pairing is a plate template, not a word list.** A plate is an anchor plus sides by part
   (starch, veg, fruit, fat) for an occasion; compatibility is scored per (anchor family, side
   part, side family, occasion), from the same evidence ladder.
4. **Portions are bands per part and occasion**, with a hard upper bound on every generated item.
5. **Generated choices share one pure ranking contract; authored meals and saved recipes are never
   re-judged.** The layout, swaps, `compose_meal` and the suggestion cards rank with it. A meal the
   user set, a saved recipe and a logged entry are not re-ranked or rescaled.
6. **Pure on the phone.** The layout runs on the phone. It receives a versioned, account-scoped
   snapshot from the server with the eligible foods; a missing or stale snapshot means no automatic
   suggestion rather than a bad one.

## Design

### Module: `lib/meals/` (pure)

- `occasion.ts` — `occasionAt(slotClock, overrides)`: one set of clock bands (replaces the two
  disagreeing copies), plus an account override per slot ("Meal 2 is my breakfast").
- `parts.ts` — food → part (`protein`, `starch`, `veg`, `fruit`, `fat`) from the snapshot (role +
  side part), not from regexes at plate time.
- `affinity.ts` — `affinity(food, occasion, snapshot)` → `{ score: 0..1, source }` following the
  evidence ladder.
- `pairing.ts` — `pairScore(anchor, side, part, occasion, snapshot)`.
- `bands.ts` — portion band per part and occasion; generated grams are clamped to it.
- `plate.ts` — `rankPlates(slot, target, foods, snapshot)`: candidate plates = anchor × sides by
  template, sized within bands to the slot target, scored = macro fit × affinity × pairing ×
  variety; returns the best plate and its name ("Greek yogurt with berries and granola").

### Snapshot: `GET /api/foods/eligible` v2

Adds, per eligible food: `part`, `occasion: { breakfast, lunch, dinner, snack: { score, source } }`,
`pairFamily`, and a `snapshotVersion` (rules + facets + history watermark). Server-side it joins
Jev facets v2, the curated table (`lib/meals/data/*.json`) and the account's log history
(`log_entries` × slot occasion over the last 90 days). Account-scoped; cached on the phone with the
eligible ids it already caches.

### Facets v2 (Jev)

Occasion rubric changes from "eaten that way in any ordinary food culture" to "a typical choice at
this meal for most people who eat this food", with a calibration eval set across cuisines and a
recalibrated threshold. New rubric version; old judgments are re-warmed, not reinterpreted.

### Paths that adopt the ranking contract

| Path | Today | After |
|---|---|---|
| Daily layout (`layoutMealsForDay`) | leanest protein, any carb, oil | `rankPlates` per slot with its occasion; nutrition guards; shortage state |
| Swap sheet (`swap-alternatives.ts`) | every protein × carb × fat, alphabetical | `rankPlates` top N for the slot's occasion |
| `compose_meal` | no meal type, no bands | O4b: one pinned-plate entry point on `rankPlates` (occasion from the scoped/viewed slot; bands) |
| `suggest_options` | already occasion/pairing aware (coach copy) | moved onto `lib/meals`, one copy |
| Recipe search / period planner | strips meal words; breakfast = meal-1 | O4a: meal words rank by recipe meal type, never filter; placement by slot occasion |
| `set_slot_meal`, `save_recipe`, logs | — | unchanged: authored by the user, policy only |

### Nutrition guards (audit B4)

A food enters generation only with finite, non-negative per-unit macros and positive energy, and
with the macro its part needs (protein > 0 for an anchor). When no plate can be built, the slot
shows an explicit shortage ("Add a breakfast protein to Eats") instead of `undefined` or a partial
plate.

## Decisions v2 (override the sections above where they differ)

- **D1 History has its own occasion field.** `log_entries` gains a nullable `occasion`
  (`breakfast | lunch | dinner | snack | other`) and `occasion_source` (`slot_clock | override |
  user`), written at log time from the slot's clock on that day (or the user's override); edits that
  move an entry recompute it; old rows stay null and are not used. History counts a food for an
  occasion only after **3 distinct days in the last 90**, recency-weighted, live rows only
  (`deleted_at is null`). One accidental breakfast log changes nothing.
- **D2 Snapshot contract.** `GET /api/foods/eligible?v=2` returns
  `{ schemaVersion, rankingVersion, accountId, computedAt, inputsHash, foods: { [localFoodId]: {
  userRefId, catalogRefId, parts: Part[], occasion: { [o]: { score, source } }, family } } }`.
  `inputsHash` covers the rules revision, the Eats watermark, the facet rubric version, the history
  watermark and the schedule. The phone stores it account-scoped in IndexedDB beside the eligible
  ids and invalidates it on: rule change, Eats edit, a log, facet warm, schedule change, account
  switch. Offline: cards already shown stay as they are; a new suggestion needs a snapshot with the
  current `accountId` no older than 7 days, otherwise the slot shows "Suggestions need a
  connection". Phone/server parity is tested with identical foods, targets, schedule, date and
  snapshot.
- **D3 Tenancy.** The history aggregate runs with the user's own client (RLS) plus an explicit
  `user_id` filter on `log_entries`, `deleted_at is null`, a bounded 90-day window read through
  `lib/server/date-chunks.ts`. It returns scores and provenance only — never notes, times or items.
  Account-derived affinity never enters `food_facets`, any shared cache or telemetry. Tests:
  cross-account, deleted entries, account switch on the phone.
- **D4 Parts and plates.** A food has `parts[]` (a food may be an anchor *and* a side, e.g. eggs,
  yogurt, legumes) with a band per part; it is used once per plate. A plate follows an **occasion
  template** (required and optional parts, e.g. breakfast: anchor + starch|fruit, optional fat;
  main: anchor + starch + veg, optional fat). A plate is accepted only if the template is satisfied
  and every pair (anchor×side) and the whole plate pass a coherence rule; mixed dishes count as a
  complete plate. When nothing coherent fits, the slot gets a precise shortage reason naming the
  missing part ("Add a breakfast starch or fruit to Eats").
- **D5 Cold start and sparse Eats.** Distinct proteins across the day are preferred; a protein may
  repeat (at half score) when that makes the better day, never in adjacent slots unless the only
  other choice is an empty slot (amended 2026-10-04 during O1: a repeated meal beats no meal). A two-food plate is
  valid when its template allows. An infeasible target within portion bands takes the closest plate
  inside the bands and says so. The availability count and the shortage copy are computed by the
  same function as the generator.
- **D6 Rubric and fairness.** The Jev occasion rubric asks per food *and* per dish example drawn
  from several cuisines; uncertain scores are **neutral (0.5), never negative**. Curated templates
  are cuisine-tagged; the generic side tables are reviewed for US bias. Fairness is measured on
  complete plates per cuisine against a human-labeled holdout (not Jev rating itself). History that
  supports an anchor at an occasion does not imply any particular side.
- **D7 Slicing.** O1 (pure, phone-only): `lib/meals` with parts, templates, bands and the curated
  cuisine-tagged table; the occasion-aware, coherence-checked layout and swaps using **curated data
  only**; shortage reasons; swap writes keep their policy recheck. O2: `log_entries.occasion` +
  snapshot v2 with curated + history (facets abstain). O3: facets v2 calibrated → snapshot reads
  them. O4: compose_meal and recipe search/period placement with server schedule reads (the period
  planner stops mapping breakfast to meal-1), split into O4a and O4b (2026-10-05, below). Each PR is
  checked old-client/new-server and new-client/old-server.

- **O1 build notes (2026-10-04).** A vegetable on a main is a strong preference (×0.6 without
  it), not a requirement, so a tight protein target can leave it off. Whole-plate coherence at
  breakfast: fruit, yogurt or a shake sits only with porridge, cereal or bread, and fruit never
  shares a plate with a vegetable. Anchors come from the curated family, the stored role, or (for
  a carb-role food that is not produce) protein ≥ 25 % of calories. Tofu is a usual breakfast.
  GPT-6 Sol audit: `~/Inbox/notes/sasha-o1-review-gpt6.md`.

- **O3 build notes (2026-10-05).** Rubric versions are per facet: `breakfast_fit` … `snack_fit` are
  `OCCASION_RUBRIC_VERSION` 2, every other facet stays at 1 (`lib/foods/facet-vocabulary.ts`). The
  v2 question is "a typical choice at this meal for most people who eat this food", with dish
  examples from six cuisines in the criteria (`lib/foods/facet-questions.ts`); the v1 wording is kept
  only for the committed jev-facets eval cache. Readers and the warm job match each facet to its own
  version, so v1 occasion rows are never read as v2; the facet-warm cron treats a food as warm only
  with `human_food`@1 and `breakfast_fit`@2, re-warms the rest (never-warmed first), and adds v2
  rows beside the v1 ones. A facet speaks only for a food curated does not know, maps a calibrated
  "typical" to 0.60–0.85 only above max(threshold, 0.65) and abstains otherwise, so an uncertain 0.5
  is always neutral and nothing is ever lowered (`lib/meals/facet-affinity.ts`). The Eats warm counts a
  food warm only with `human_food`@1 and all four occasion facets @2. Acceptance 9 is measured on
  generated plates: `scripts/eval/facets-occasion-eval.ts` runs `rankPlates` over a labelled pantry per
  cuisine (seed holdout: 66 foods and dishes plus 61 pantry foods, unreviewed) and judges each plate
  against the human labels (no food on it labelled not-typical at that occasion); label accuracy is
  reported, not gated. The gate (`lib/foods/occasion-gate.ts`) stays shut until `--live --freeze`
  stores a passing report on an owner-reviewed holdout. The snapshot reads facets through
  `lib/server/occasion-facets.ts` (rows with source `"facets"`; the phone carries them in
  `MealEvidence.facets`). An O2-era phone rejects a snapshot with `"facets"` rows, so the gate opens
  only after O3 clients are out. A rescore with perfect Jev answers still scores plates 25–81 % per
  cuisine: plate plausibility is bounded by the curated sides and templates, not by facets alone.

- **O4 is split (2026-10-05, owner approved).** The first O4 build mixed a sound planner/recipe
  slice with a `compose_meal` rewrite that re-implemented the engine's part, template and sizing
  rules beside it; each review round closed one route and opened another (GPT-6 Sol re-plan,
  `~/.claude/goal-state/sasha-backend-2026-10-05/reviews/t12-replan-sol.md`). The two halves land
  separately.
  - **O4a — recipe search and period placement (branch `feat/meals-o4-planner`).** One shared
    parser, `lib/meals/occasion-phrase.ts`, returns `{ occasion, rest }` with the WHOLE phrase
    removed: "for/at/as", a determiner and modifiers ("salmon for a late dinner" searches
    "salmon"; "eggs as a quick snack"; "for brunch" is breakfast); a bare meal word ("easy
    breakfast" keeps "easy"); a meal word inside a dish name stays in the dish and names the meal
    only when nothing else does ("breakfast burrito for dinner" is dinner and searches "breakfast
    burrito"). Time words around a meal phrase leave with it ("chicken for dinner tomorrow night"
    searches "chicken"). Recipe search maps it to `RecipeSearch.occasion`, a ranking boost on the
    recipe's dish-tag meal type that never filters (`lib/recipes/occasion.ts`); no word the parser
    reads as a meal is ever a hard search term (`lib/recipe-catalog/query.ts` takes the parser's
    `MEAL_WORDS`). Search ranks; query words never remove a recipe (round 3).
    Only explicit filters do: cuisine, time, effort, exclusions and eligibility; the occasion
    ranks. Each recipe scores the query words it carries (name, ingredients, dish tags) above the
    meal fit, so recipes carrying every word come first and then partial matches; when none
    carries them all, the response says `exactMatch: false` ("pork": the closest recipes). SQL no
    longer narrows by text. The period planner reads `user_settings` slot
    times, shift and meal count (count as Today derives it; `lib/plan-schedule.ts`) plus each
    date's own time edit. Meal words map one to one to slots: each takes the free slot whose clock
    is that meal, nearest its usual time; a word with no match falls back to the old fixed slot
    only when no other word took it (`lib/shopping/coverage.ts`). The preview says "planned in
    Meal N" only once a recipe fills that slot, else "Breakfast is not planned on …"; the planner
    prefers recipes of the slot's meal type and names a slot it cannot fill by its meal ("No lunch
    recipe fits Meal 1 on …"). The coach's viewed day reads the same saved schedule
    (`lib/server/viewed-day.ts`, `lib/server/day-context.ts`), so `suggest_options` reads a saved
    09:30 meal-2 as breakfast. The saved schedule is the phone's: a meal-time or whole-day-shift
    edit, from any writer, queues `slot_times` / `shift_minutes` through the settings-intent path
    (`lib/store.ts` schedule-edit hook → `lib/sync/schedule-settings.ts`), and the server applies
    the shift unbounded with Today's own `resolveSlotTimes` (`lib/plan-schedule.ts`). A pull does
    not write the phone's schedule, and a schedule saved before O4a reaches the server at its next
    edit.
  - **O4b — `compose_meal` on the meal engine (waiting).** One constrained one-slot entry point on
    `rankPlates`: the account's marked Eats rows with refs, nutrition and policy verdicts; the
    foods the wish names pinned inside the plate search; missing parts filled from eligible Eats;
    the occasion from the scoped/viewed slot, else the shared parser, else the turn's clock. It
    waits on a new open-world foods spec: what the card shows for a named food with no Eats row or
    unknown nutrition, and whether the four-food-term cap stays. Until then `compose_meal` is
    unchanged from main: no occasion, at most four food terms (`MAX_TERMS` in
    `lib/coach/compose.ts`).

## Acceptance (the done list, v2)

1. Anchor affinity and pairing are tested separately: a 07:30 slot ranks eggs/yogurt/oats-type
   anchors above canned tuna for an account with no tuna-at-breakfast history; with ≥ 3 days of
   tuna-at-breakfast history tuna may anchor breakfast, and its side is still chosen by pairing
   (never banana unless the curated or history evidence pairs them).
2. Every generated plate satisfies its occasion template and the coherence rule; every item is
   within its band.
3. Foods with unusable nutrition are never picked (done, #359); a slot with no coherent plate shows a
   shortage reason that names the missing part.
4. Parity: identical foods, targets, schedule, date and snapshot give the identical plate on phone
   and server.
5. Frozen authored content: user-set meals, saved recipes, logs and override titles are unchanged
   by generation (swap's existing rescaling of saved meals is out of scope and unchanged).
6. Sparse and multi-role cases: 2-protein Eats over 4 slots; eggs as anchor and side; an overnight
   schedule (a 02:00 slot); a mixed dish as a whole plate.
7. History: deleted and edited entries change the signal; another account's history never appears;
   an account switch clears the phone snapshot.
8. Offline/stale: a 7-day-old or other-account snapshot yields no new suggestion.
9. Fairness: per-cuisine complete-plate plausibility on a human-labeled holdout reaches ≥ 85 % for
   each cuisine set, and no cuisine's mean is more than 10 points below the best.
10. "easy breakfast" recipe search returns breakfast recipes first; the period planner places by
    the slot's real clock.
11. No new hard prohibition outside safety rules.

## Delivery

| PR | Contents |
|---|---|
| O1 | `lib/meals/` with occasion, parts, bands, pairing, the curated data files, moved from `lib/coach` (no behaviour change for `suggest_options`) + nutrition guards and shortage state in the layout |
| O2 | Snapshot v2 on `/api/foods/eligible` (curated + history + current facets) and the occasion-aware layout and swaps |
| O3 | Facets v2 rubric + calibration eval; snapshot reads v2 |
| O4a | Recipe search and period placement on the contract; the shared occasion-phrase parser |
| O4b | `compose_meal` on the meal engine (waits on the open-world foods spec) |

Each PR gets a GPT-6 Sol review before it opens.
