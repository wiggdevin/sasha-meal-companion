# Foods tab: Eats / Avoids, and the Today dials — 2026-09-16

Devin, 2026-09-16: "why do I see protein swaps twice under both pages? why are allergens
in the settings menu? why is there so much redundancy and no conformity." This is the
consolidation. Coding model: Opus 5. Adversarial pass: Grok 4.6. One PR, one deploy.

## What is wrong today

The Foods tab has an Eats / Avoid toggle on "My foods" only. Everything under "The rules"
(pouch rule, safe carbs, the Never card, protein swaps, collagen, working around a job)
sits below the toggle and repeats under both states. That is the "twice".

"Can't eat" lives in four places:

| # | Where | What | Who obeys it |
|---|---|---|---|
| 1 | Foods → My foods → Avoid | Her list, `Food.status = "avoid"`, note kept. localStorage, synced as the legacy `foods` map. | The meal plan. An avoided food leaves every future day. |
| 2 | Foods → The rules → Never | Static prose from `lib/reference.ts` `NEVER_LIST`, with the reason. | Nobody. Reading only. F-018 says it must work offline. |
| 3 | Settings → Constraints (`NEXT_PUBLIC_COACH_ENABLED`) | Server `constraint_profiles`: `avoid_allergens` (gluten, dairy, apple locked), `banned_categories`, `avoid_food_ref_ids`, `conditions`, `notes`. | The coach, food search, the barcode scanner, recipe saves — `lib/policy/constraints.ts`. |
| 4 | Add a food → refusal | `bannedReason()` refuses a typed simple sugar. | The add-food form. |

#1 and #3 cannot become one store today: her foods do not map to catalog rows (F-057, planned)
and `setFoodStatus` never writes `user_food_prefs`, so the policy cannot see her Avoid marks.
#2 duplicates #3's keys as prose. #4 is a guard, not a screen, and stays.

`/api/constraints` has no coach-flag guard. Only the Settings *mount* is behind the flag. The
policy those toggles feed runs on search, scanner and log whether or not the coach ships, so
the toggles belong on the Foods tab, unguarded.

## Design

### Today dials (`components/MacroRings.tsx`, `DESIGN.md`)

- Triangle flips: **protein alone on top**, carbs and fat side by side beneath. Protein is the
  target that never moves and the one the "Still to eat" line names. Colours stay fixed per
  macro. `TRIANGLE_TOP = [protein]`, `TRIANGLE_BOTTOM = [carbs, fat]`.
- Fewer notches: calorie dial `tickN` 60 → **30**, macro dials 30 → **16**. Update the Gauge
  line in `DESIGN.md` §Techniques ("60 tick marks" → 30, "Mini gauges: 30 ticks" → 16) and
  re-run the design lint. Nothing else in the gauge geometry changes.

### Foods tab (`app/foods/page.tsx`)

The page-level control is a two-segment tablist, **Eats | Avoids**, on the title row where
the "Recipes" pill sits today. It switches the whole page. Proper tabs semantics:
`role="tablist"`, two `role="tab"` buttons with `aria-selected`, one `role="tabpanel"`. The
visual is the existing ink-segment pill from `MyFoods.tsx` (`SEGMENT_ON` / `SEGMENT_OFF`),
extracted to `components/Segmented.tsx`. Default segment: Eats. No URL state.

`app/foods/page.tsx` stays a server component with its `metadata`; it renders `<FoodsTabs />`.

### Eats (`components/EatsView.tsx`)

Top to bottom:

1. **Favorites strip** — as now.
2. **My foods** — Protein / Carbs / Fats groups and "Add a food", as now, minus the toggle.
   `MyFoods.tsx` becomes: `useFoodsStore()` (the load + `SYNCED_EVENT` effect), `FoodList`,
   `EatsFoods` (default export) and `AvoidFoods` (named). Sheets stay where they are.
3. **Recipes** — `components/RecipesSection.tsx`, `id="recipes"`. Section header "Recipes",
   count on the right, a "New" pill. The list and the `RecipeSheet` move here from
   `app/recipes/page.tsx` unchanged. Empty copy stays: "Nothing saved yet. A recipe is a tray
   you make often — save it once, log a serving after."
4. **Reference** — section header "Reference", caption "From the plan. These do not change."
   Then the three cards about *what to eat*: Safe carbs, Protein swaps, Bone broth & collagen.
   `components/EatsReference.tsx`, lifted from `FoodsReference.tsx`.

Nothing on Eats mentions an avoided food. No Never card, no pouch rule.

### Avoids (`components/AvoidsView.tsx`)

Top to bottom:

1. **The pouch rule** — the olive panel, first. It is the one to get right. `components/PouchRule.tsx`,
   lifted from `FoodsReference.tsx`.
2. **Allergens** — glass card. Caption: "The plan is built without these. Search, the scanner and
   the coach block them." One row per floor allergen — apple first, then gluten, dairy — with the
   name (15/400) and the reason (12/300 muted) under it, and a filled olive check on the right
   (DESIGN.md: "check in a filled olive circle"). The floor three are locked: no button, the
   check is decorative, `aria-label="Always avoided"`. Under the rows, an eyebrow "Also avoiding"
   and a chip row of the optional allergens — soy, egg, shellfish, peanut, sesame — as `Pill`
   toggles reflecting `avoid_allergens`.
3. **Off the plan** — glass card. Caption: "Switched on, the coach and search block it too."
   One row per category — raw cruciferous vegetables, raw leafy greens, onion and garlic, beans,
   simple sugars — name + reason, and a `role="switch"` on the right: filled olive check when the
   key is in `banned_categories`, an empty ring when not. Tapping toggles and saves.
4. **Can't eat right now** — her list (#1). Section header with the count. Rows as today
   (role dot, name, italic note); tap opens `FoodSheet` to bring the food back. Empty copy:
   "Nothing here. Open a food on Eats and mark it Avoid, or add one below." Pill:
   "Add a food to avoid" → `AddFoodSheet`; the result is stored with `status: "avoid"`.
   This is how Devin adds "raw onion — hurt on 9/12" after a flare in one step (phase-7 §Devin).
5. **Conditions** — glass card, caption "What the coach knows about her." The comma-separated
   input as today.

Cards 2, 3 and 5 are `components/AvoidRules.tsx`, which owns the `/api/constraints` load and
save. It takes an optional `initial` profile prop so it renders without a fetch in tests.

Offline and load-failure rule (F-018): the rows, names and reasons **always render** from the
static reference. Only the on/off state comes from the server. While offline, or before the
profile loads, or after a load failure, switches and chips are disabled and one caption reads
"Needs a connection to change." Nothing goes blank. A `409` reloads the profile and says
"Your rules changed elsewhere. Check them and try again." (existing copy, kept).

**Dropped:** the "Avoided foods" catalog search from the Settings card. It was a list she could
not read (ids only, a count), it took the note through `window.prompt`, and it dumped every
note into one text blob. `avoid_food_ref_ids` stays in the data and the policy; MCP
`set_constraints` can still write it. Follow-up (not this PR): F-057 maps her foods to catalog
rows, and then her Avoid list is the enforced list.

### One source of the "why" text (`lib/reference.ts`)

```ts
export const ALLERGEN_RULES: { key: "apple" | "gluten" | "dairy"; item: string; why: string }[]
export const OPTIONAL_ALLERGENS = ["soy", "egg", "shellfish", "peanut", "sesame"] as const
export const CATEGORY_RULES: { key: "raw_cruciferous" | "raw_leafy_greens" | "onion_garlic" | "beans" | "simple_sugars"; item: string; why: string }[]
export const NEVER_LIST = [...ALLERGEN_RULES, ...CATEGORY_RULES].map(({ item, why }) => ({ item, why }))
```

The `item` and `why` strings are today's `NEVER_LIST` strings, verbatim, apple first. The keys
are the server's keys (`lib/server/constraints.ts` `FLOOR_ALLERGENS`, and the category strings
the old editor listed). `NEVER_LIST` stays exported and derived because `app/api/mcp/route.ts`
reads it. `FLOOR_ALLERGENS` (client copy) and `saveConstraints` move from `ConstraintsEditor.tsx`
to `lib/constraints-client.ts`, with a `loadConstraints`. `ConstraintsEditor.tsx` is deleted.

### Settings (`app/settings/page.tsx`)

- Remove the `ConstraintsEditor` import and its flagged section.
- Add `components/WorkingAroundAJob.tsx` (the card lifted from `FoodsReference.tsx`) directly
  after `<ShiftTimes />`. It explains that control; it is about timing, not food.

### Routes and links

- `app/recipes/page.tsx` → `redirect("/foods#recipes")`. Nothing else renders there.
- `components/FavoritesStrip.tsx` `favoriteHref`: recipe → `/foods#recipes`.
- `components/LogFoodSheet.tsx` `handleFavoritePick`: `router.push("/foods#recipes")`.
- `components/BuildMealSheet.tsx` link to `/foods` is already right.

### Copy

Coach voice per DESIGN.md: short, plain, no exclamation marks. Every string above is final.
Category labels are human — "Raw cruciferous vegetables", never `raw_cruciferous`.

## Files

Changed: `app/foods/page.tsx`, `app/recipes/page.tsx`, `app/settings/page.tsx`,
`components/MyFoods.tsx`, `components/FavoritesStrip.tsx`, `components/LogFoodSheet.tsx`,
`components/MacroRings.tsx`, `lib/reference.ts`, `DESIGN.md`.
New: `components/FoodsTabs.tsx`, `components/Segmented.tsx`, `components/EatsView.tsx`,
`components/AvoidsView.tsx`, `components/RecipesSection.tsx`, `components/EatsReference.tsx`,
`components/PouchRule.tsx`, `components/AvoidRules.tsx`, `components/WorkingAroundAJob.tsx`,
`lib/constraints-client.ts`.
Deleted: `components/FoodsReference.tsx`, `components/ConstraintsEditor.tsx`.
Every file under 400 lines. Style, comment density and the `React.CSSProperties` recipe
constants match the neighbours.

## Tests — write first, watch each fail, then implement

There is no `@testing-library/react`; components render with `renderToStaticMarkup`, which
runs no effects, so state-bearing components take an `initial` prop or are tested as pure parts.

1. `components/MacroRings.test.tsx` — add: `TRIANGLE_TOP` keys equal `["protein"]` and
   `TRIANGLE_BOTTOM` keys equal `["carbs", "fat"]` (export both); the rendered markup has exactly
   30 + 16 × 3 = 78 `<line` elements.
2. `lib/reference.test.ts` (new) — `NEVER_LIST[0].item` is "Apple and applesauce"; every
   `ALLERGEN_RULES` and `CATEGORY_RULES` entry appears once in `NEVER_LIST`; the category keys are
   exactly the five strings above; the allergen keys are exactly the three floor keys.
3. `components/AvoidRules.test.tsx` (new) — given `initial = { avoid_allergens: ["gluten","dairy","apple","soy"], banned_categories: ["simple_sugars"], … }`:
   every rule name and reason renders; the floor rows have no `<button`; the soy chip is
   `aria-pressed="true"` and peanut `"false"`; the simple-sugars switch is `aria-checked="true"`
   and raw-cruciferous `"false"`. Given no `initial`: every name and reason still renders and
   "Needs a connection to change." is present.
4. `components/FoodsTabs.test.tsx` (new) — the "no repeats" guard the complaint deserves.
   `EatsView` markup contains "Safe carbs", "Protein swaps", "Bone broth", `id="recipes"`,
   `aria-label="Favorites"`, and contains **none** of the `NEVER_LIST` reasons and not the
   pouch-rule headline. `AvoidsView` markup contains the pouch-rule headline, every `NEVER_LIST`
   item and reason, "Can't eat right now", and contains **neither** "Protein swaps" nor
   "Safe carbs". `FoodsTabs` markup has `role="tablist"` with two `role="tab"` and the Eats tab
   `aria-selected="true"`.
5. `tests/recipes/recipes-page.test.tsx` — replace: the Foods page mounts `FoodsTabs`;
   `app/recipes/page.tsx` calls `redirect` with `/foods#recipes` (mock `next/navigation`).
6. `tests/favorites/favorites-strip.test.tsx` — recipe href becomes `/foods#recipes`.
7. `components/FoodsReference.test.tsx` → delete; its three assertions live on in 3 and 4.
8. `components/ConstraintsEditor.test.tsx` → `lib/constraints-client.test.ts`, same assertion.
9. `grep -rn ConstraintsEditor\|FoodsReference` over `app components lib tests docs` returns
   only this plan and the changelog line in `docs/features.md`.

Run only the touched test files while working (`pnpm vitest run <file>`), then `pnpm tsc --noEmit`
and `pnpm lint`. Do **not** run the full `pnpm test`; the driver runs it once before the PR.

## Docs to update in the same PR

- `docs/features.md` rows F-018, F-020, F-021: where each lives now (Avoids / Eats / Eats+Avoids).
  F-076 gets one sentence: the editor lives on Foods › Avoids; `avoid_food_ref_ids` has no UI.
- `AGENTS.md` "Where things live": the `MyFoods` row and a row for `FoodsTabs` / `AvoidRules`.
- `docs/specs/phase-7-coach.md` line 183: `ConstraintsEditor` from Settings → `AvoidRules` on
  Foods › Avoids.
- `DESIGN.md` gauge ticks, as above. `npx --yes -p @google/design.md@0.3.0 design.md lint DESIGN.md`
  must still exit 0.

## Verify (driver)

Phone-width screenshots at 390 and 360 of Today, Foods › Eats, Foods › Avoids, Settings.
Grok 4.6 adversarial pass over the full diff with the changed sources inline. Then `pnpm test`
once, `zs-land`, and a production check.
