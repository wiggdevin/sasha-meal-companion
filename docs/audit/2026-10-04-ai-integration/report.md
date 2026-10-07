# AI integration audit — how every model connects, and what it changes (2026-10-04)

Owner: Devin. Backend lane. Sources: three read-only code maps of `main` `6877f51` (AI call
inventory, meal/recipe generation, proactive messaging), checked against the code. Auditor: GPT-6
Sol (`~/Inbox/notes/sasha-ai-integration-audit-gpt6.md`). This report is the input to the fix plan
at the end; every item there is a separate, small PR.

## 1. What runs on a model today

23 purposes are registered (`lib/ai/call-registry.ts`); nothing reaches a provider outside
`callModel` (`tests/ai/call-registry.test.ts`). They fall into four groups:

| Group | Purposes | Provider | What the output changes |
|---|---|---|---|
| Coach conversation | `coach`, `coach-openrouter`, `coach-intent`, `coach-verify`, `coach-transcribe`, `lookup` | Gemini / OpenRouter; Jev for intent + verify | Coach messages and **actions that apply on arrival** (Undo, no confirm); thread `summary` memory |
| Logging | `textToItems`, `voiceToItems`, `photoToItems`, `labelToNutrients` (+ OpenRouter twins), `log_sanity` | OpenRouter → Gemini; Jev | A draft the user confirms before `/api/log/commit` writes |
| Planning | `suggest-options`, `meal-component-role`, `photoToIdeas`, `documentToPlan`, `weeklyReview` | Jev; OpenRouter; Gemini | Ranked meal cards (tap to apply); a stored food role; a weekly-review message |
| Food knowledge | `food_facets`, `profile-prefs` | Jev | **Shared** `food_facets` and `food_allergen_evidence` rows; onboarding chips |
| Dead | `serving_identity`, `jev_facets_eval` (eval only) | Jev | nothing in production |

The deterministic engines beside them decide what a model must not: policy and allergens
(`lib/policy/*`, fail closed; a model may escalate an allergen, never clear it), scaling
(`lib/scaling.ts`, protein never moves), suggestion candidates and composition (`lib/coach/suggest*`,
`compose*`), recipe adaptation (`lib/recipes/adapt.ts`) and the TDEE engine (`lib/expenditure*`).

## 2. Findings, by severity

### P0 — wrong food on the plate (Devin's "tuna, water and a banana" for breakfast)

1. **The daily layout has no idea what time it is.** `layoutMealsForDay`
   (`lib/foods/layout-plan.ts`) picks the leanest proteins (egg white, tuna win most days), "any
   carb" (banana and apple are carbs, `lib/foods/starter.ts:41-42`) and an oil, in every slot. Slot
   times are computed in `resolveDay` but never passed in. It names the plate "first two foods with".
   Starters have egg whites and oatmeal but no whole eggs, yogurt or vegetables.
2. **Only one path is time- and pairing-aware.** The coach's `suggest_options` uses meal type from
   the slot clock (`lib/coach/meal-type.ts`), a 19-family pairing table (`meal-pairings.ts`) and
   portion bands (`portion-bands.ts`). The layout, the swap sheet, `compose_meal`, `set_slot_meal`,
   `save_recipe`, recipe search and the period planner use none of it.
3. **The occasion knowledge already computed is thrown away.** Jev warms 25 facets per food,
   including `breakfast_fit`, `lunch_fit`, `dinner_fit` and `snack_fit`; **no production code reads
   them**, and their rubric ("any ordinary food culture") and `dinner_fit` threshold (~0.10) are too
   permissive to rule tuna out at breakfast.
4. **Recipe search discards meal words.** "easy breakfast" strips "breakfast" from the query
   (`recipe-query.ts:21`), and the period planner maps breakfast to `meal-1` whatever its time.
5. **Two copies of the meal-time bands disagree** (`document-clean.ts:72-74` vs `meal-type.ts`).

### P1 — writes the user did not confirm, or cannot see

6. **Coach actions apply on arrival**; Undo is device-local (localStorage, capped at 50).
7. **`meal-component-role` stores a food's role without showing it** (`roleAdvice` is never
   rendered, so its `requiresConfirmation` is not honoured).
8. **Coach `memory` becomes the thread summary unreviewed** and is fed into later prompts — a
   persistence path for injected text.
9. **Jev facets write shared tables for every account** (`food_facets`, `food_allergen_evidence`)
   with no review; a Jev "absent" alone clears vegetarian/vegan/pescatarian/no-pork/no-beef
   (`constraints.ts:349-355`). Allergens are never cleared this way.
10. **The Plan panel's plate "Log" commits a different model's result than it showed**
    (photoToIdeas macros displayed, photoToItems committed, no confirm sheet).

### P1 — reliability and governance

11. **No fallback:** `weeklyReview` (its prose is already app-written from enums — a deterministic
    choice is easy), `coach-transcribe`, `photoToIdeas`, `documentToPlan` (single OpenRouter model).
12. **Five OpenRouter model ids come from env vars**, outside the pinned lane table and the lane
    bench rule.
13. **Health details can reach TypeSafe** (D2 through `coach-intent`, `coach-verify`, the suggest
    wish text) while TypeSafe is cleared for D1 only — already an open item in the registry.

### P2 — reach and transparency

14. **The app cannot reach anyone.** No web push, no in-app notification centre, no email digest;
    the calendar export goes stale after a schedule change.
15. **The weekly review fires at one UTC time** (Monday 01:30 UTC = Sunday evening only in US
    Eastern) and lands with no badge.
16. **No surface says AI was involved** (weekly review, drafts, quick replies, facet-shaped
    suggestions, applied actions).
17. **Dead behaviour:** the "Log your next meal" chip is hard-wired off (`hasUnloggedMealToday:
    false`, `reply.ts:145`); `serving_identity` has no caller.

## 3. Where Jev fits (and where it must not)

**Use Jev for typed food knowledge, cached per food, never for a target or an allergen decision:**
- **Meal occasion fit** — reuse the `*_fit` facets with a stricter rubric ("typical in the user's
  food culture at that meal") and recalibrated thresholds; cached per food, so it costs nothing at
  plate time.
- **Pairing compatibility** for foods the curated table does not cover (anchor × side × occasion).
- **Whole-plate plausibility** — the existing `suggest-options` question, extended to the layout,
  swaps and `compose_meal` where the time budget allows.
- **Day completeness nudge** (from the TDEE work) before "Day fully logged".

**Keep deterministic:** the clock → occasion mapping, the never-rules (no seafood or steak at
breakfast unless asked; fruit is never a main's starch), portion bands and sizing, policy and
allergens (fail closed), macro fit, and final ranking.

## 4. Auditor corrections (GPT-6 Sol, adopted)

The audit (`~/Inbox/notes/sasha-ai-integration-audit-gpt6.md`) confirmed the P0 diagnosis and added
four blockers this report had missed, all verified in the code:

- **B1 Plan writes skip the account policy.** `set_slot_meal` grounds and flags its items, but
  `lib/coach/apply-slot.ts` writes every item, up to 31 dates, without re-checking the verdict.
- **B2 A recipe save can silently become a different dish.** `lib/coach/recipe-policy.ts` drops a
  disallowed ingredient but keeps the `save_recipe` action, and the remaining ingredients are saved
  under the original name.
- **B3 The Plan photo "Log it" commits a draft nobody saw**, and it refuses blocked food instead of
  logging it with a mark, contradicting the "logging marks, never refuses" ruling.
- **B4 The layout trusts nutrition it never validated**: a food with unknown or zero macros can
  make a pick `undefined` or the protein weighting invalid.

Design change: occasion is a **soft affinity with provenance**, not a global prohibition ("no
seafood at breakfast" is not account-neutral). Pairings are dish/template relationships, not
English-name regexes. Account choices and explicit requests outrank generic taste priors, never
safety rules. The phone gets a **versioned, account-scoped eligibility + occasion snapshot**; a
missing or stale snapshot means no automatic suggestion. Policy admission stays at write
boundaries; a shared *ranking* contract serves generated choices only — authored meals and saved
recipes are never re-judged.

## 5. Fix plan (revised; each a small PR)

| Order | Priority | Change |
|---|---|---|
| 1 | P0 | Close the plan and recipe write-policy gaps (B1, B2); keep mark-only logging; the photo log shows its real draft (B3; UI lane for the screen). |
| 2 | P0 | Guard layout nutrition inputs with an explicit shortage state (B4); pass slot times; explicit occasion override. |
| 3 | P0 | Versioned, account-scoped eligibility + occasion snapshot to the phone; occasion- and pairing-aware layout and swaps that never alter saved meals. |
| 4 | P1 | The same ranking contract for generated coach choices; explicit meals and recipes stay user-controlled. Tests across cuisines, unusual schedules, sparse Eats lists. |
| 5 | P1 | Occasion-aware recipe search and period placement; calibrate Jev occasion metadata (stricter rubric, eval set) before it ranks anything. |
| 6 | P1/P2 | Hidden writes, confirmation and memory handling, model fallbacks, local-time weekly review, AI labels, dead `serving_identity`, the `log_meal` chip. |
