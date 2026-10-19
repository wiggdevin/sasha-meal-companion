# UI makeover plan

*2026-10-19. Planning thread "UI makeover". Built from eight area maps of the current code, three independent drafts, a three-judge panel, a merged plan and four adversarial critics. Every BLOCK the critics raised is fixed below. The brand name is a name only; "the owner" means the project owner.*

**Decisions made in this plan** (no open questions for the owner):
1. The Day card has two tabs, **Calendar** and **Overview**. Overview opens first.
2. The companion lives in Overview as one labelled row that opens in place. Each companion can be shown or hidden per account, synced across phones (default shown).
3. Add a cup is one 44 px pill in the Day card header, on both tabs, near the top of the screen.
4. "Your week" charts in Overview: three small charts always visible (Calories, Sleep, Activity); tap one to open it big with Protein, Water and Weight too, 7 days or 4 weeks. Hand-drawn SVG, no library.
5. The Foods first tab holds only **Preferred shopping list** and **Often eaten**, both grouped by aisle. "Your usual foods" and the Protein/Carbs/Fats cards are gone.
6. Shopping: **Have AI build my list** card at the very top, then saved named and dated lists with arrows to cycle, then the list by aisle, then a pick list in the Favorites row layout. The AI flow asks a budget, walks yes/no through ingredients and then meals, and ends at a real tappable map of nearby stores.
7. The AI in "Have AI build my list" is real: a registered Jev purpose that ranks the admitted candidates (it can reorder, never admit). If Jev is down the flow still works in plain order and the label says so.
8. Free map stack only: Leaflet + OpenStreetMap tiles, Nominatim for the area code, Overpass for stores, all lookups through our own server routes.
9. No free grocery price source exists, so the budget cannot be totalled yet. The budget steers the plan and the flow says "Prices aren't available yet" in one line. Picked stores are saved with the list for later.
10. "Shop for you" (placing an order or checkout) is out of scope: no free grocery-ordering API exists. The flow ends with a saved list and picked stores.
11. Shopping stays behind the recipe pilot gate (`RECIPE_PLANNING_USER_IDS`). To see the redesign, an account must be on that allowlist (a Vercel env value, a Mac step).

---

## 1. Goals

| Owner complaint | Fix |
|---|---|
| Every card too big, too much text | One `CardFrame` with sizes sm/md/lg (12/16/20 px padding). One title, at most one supporting line, at most two actions. W6 sweeps the meal card, recipe, coach and plan cards; the other workstreams adopt it on their screens. |
| Cards blend into the card behind | Contrast step: each surface differs from the one behind it by at least 1.10:1 at every gradient stop, with a hairline. Built into `CardFrame` and applied once to legacy nested `.surface`. A new surface-vs-surface test enforces it. |
| Companion section needs work; collapsed view makes no sense | One 64 px labelled row in Overview that opens in place. No bubbles, swipes, holds or hidden grabbers. |
| Option to get rid of any companion | Per-companion Show/Hide, synced per account (`user_settings.companions_hidden`), from Settings and from the companion itself. |
| Add a cup barely on screen | 44 px "+ Cup 4/8" pill in the Day card's first header row on both tabs, about 120 px from the top. Tap adds a cup; hold and slide sets an amount. |
| Hard to know where you are | Every dock tab shows its label at every width. Every page has a visible title. The Foods sub-tab is kept in the URL hash. `/week` gets the dock and lights Today. |
| No analytical graphs | "Your week" card in Overview (see decision 4). |
| Overview makes no sense; Board has no use | Two tabs. Overview absorbs the old Overview, the Board and the companion. |
| "Your usual foods" should go | Foods first tab = Preferred shopping list + Often eaten, by aisle. |
| Shopping 100 % redesign | Section 7. |

---

## 2. Navigation

### 2.1 Day card, two tabs (W0)
- `DayFace = "calendar" | "overview"` in `components/today/FaceSwitch.tsx`. Both faces exist with or without targets.
- `FaceSwitch` becomes two equal segments, each always showing its word at 14 px, 44 px track. The `ACTIVE` width table and the orbit/bento glyphs go. The olive lens rides `SPRINGS.snappy`. Roving tabindex and Arrow/Home/End keys stay.
- Faces stay mounted; the inactive face is `inert` and `aria-hidden`. `useFacesHeight` springs between two heights, instant under reduced motion.
- Overview is the default on every load. The face is never stored.
- Header: row 1 is the Rest/Training pill on the left and the CupSlot on the right; row 2 is the full-width switch. The date moves into the page title.
- Calendar face (`components/today/CalendarFace.tsx`): week/month strip plus one line, "1,240 kcal left · 2 of 4 meals". Until W3 merges it still shows the strip plus `LiveWidget`.

### 2.2 "Where am I"
- `components/ui/PageTitle.tsx` (W0): `{ eyebrow?, title, trailing?, back? }`, a visible `h1` at 28 px with an overline eyebrow.
  - Today (W0, `app/page.tsx`): eyebrow is the short date, h1 "Today". On another date the h1 is the weekday and a "Back to today" link appears. `DayTypeToggle` and `HeaderAvatar` sit in `trailing`. The `sr-only` h1 and the small "Week" link go (the charts link to `/week`).
  - Body, Settings, Week (W1). `/week` gets `back` to Today.
  - Foods (W5): `PageTitle` "Foods" with `Segmented` on its own row, labels 12 → 14 px. The Shopping panel's second `h1` becomes an `h2` (W7).
- Dock (W1, `components/dock/TabCapsule.tsx`, `components/TabBar.tsx`): icon over a 12 px label on every tab at every width; glyph-only mode removed; slot padding tightens below 360 px. Active tab keeps the lens, heavier stroke and `aria-current="page"`. Raw colours in `TabBar.module.css` become tokens. Destinations and order unchanged, so coach `COACH_PAGES` is untouched.
- `lib/design/section.ts`: `/week` → `today`; `components/AppChrome.tsx` gives `/week` the dock (W1).
- Foods tab in the URL (W5): `history.replaceState` writes `#eats`, `#avoids` or `#shopping`. `#recipes` and `#discover-recipes` keep resolving through `tabForHash`.

---

## 3. Card style system (W0)

### 3.1 Roles in `app/globals.css`
Roles live in `globals.css` (the contract allows tokens or roles), so W0 does not depend on the Design MD CLI. W0 tries `npx -p @google/design.md@0.3.0` for the prose/frontmatter change; if it is unreachable, DESIGN.md frontmatter is not touched and only §Elevation prose changes.

| Role | Value | Measured contrast |
|---|---|---|
| `--grad-card` (changed) | `#fbf9f4 → #f6f2e9` | vs ground base: oat 1.30/1.23, sage 1.22/1.15, clay 1.27/1.19, mist 1.23/1.16 |
| `--grad-card-inset` (new) | `#e9e4d8 → #e8e3d6` | vs card: 1.21/1.15 |
| `--grad-panel` | kept a literal gradient, copied from the new card stops (parsers in `tests/design/contrast-table.ts` and `grok-contrast-2026-10-04.test.ts` read literals) | — |
| `--hairline-card` (new) | `rgb(var(--ink-rgb) / 0.12)` | nested card edge |
| `.surface` hairline | 6 % → 10 % | E1 edge |
| `--card-pad-sm/md/lg` | 12 / 16 / 20 px (existing spacing tokens) | — |
| `--card-radius-sm/md/lg` | 16 / 24 / 32 px | all on the allowed scale |

Text on the inset: primary 12.9, secondary 8.2, muted 5.1, faint 4.3 (faint stays large-text and icons only, as on the recess).

### 3.2 Contrast-step rule (DESIGN.md §Elevation prose)
A surface on another surface differs from its parent by at least 1.10:1 at every stop and carries a hairline. Steps alternate: ground → card (E1, `--shadow-card`) → inset (E0, 12 % hairline, no shadow) → card (E0). No fourth level. No shadow inside a shadow. Matte charcoal stays for the meal card and the dock.

### 3.3 `components/ui/CardFrame.tsx` (new)
Named `CardFrame` so it stays outside the card-inventory filename pattern.

```ts
type CardFrameProps = {
  as?: "section" | "div" | "article" | "li";
  size?: "sm" | "md" | "lg";               // default md
  level?: "auto" | "raised" | "inset";     // auto: raised at depth 0, else the opposite of the parent
  tone?: "ivory" | "recess" | "olive";     // olive = primary fill with on-primary text (call to action)
  title?: ReactNode; titleAs?: "h2" | "h3";
  meta?: ReactNode;                        // one line, caption, muted, truncates
  aside?: ReactNode;                       // count, Edit, chevron
  footer?: ReactNode;
  onClick?: () => void;                    // whole card is a button, >= 44 px, Enter/Space
  className?: string;                      // layout only
  children?: ReactNode;
} & Pick<HTMLAttributes<HTMLElement>, "aria-label" | "aria-labelledby" | "id">;
```

| Size | Padding | Radius | Title | Gap |
|---|---|---|---|---|
| sm | 12 | 16 | 16/600 | 8 |
| md | 16 | 24 | 16/600 | 12 |
| lg | 20 | 32 | `text-title` (20 Fraunces) | 16 |

- `CardToneContext` carries the parent face, so a same-tone nest cannot happen; depth 3 throws in development.
- Renders `.shell` (raised) or `.surface` plus `.card-sm|md|lg` and `.card-ivory|recess|olive`, so markup tests that look for `shell`/`surface` keep passing.
- `components/ui/Surface.tsx` stays; its `nested` variant takes the inset.

### 3.4 Legacy nested cards, one guarded rule
```css
html[data-card-step] .surface :where(.surface):not(.matte, .meal-card-in, .matte-reset, .olive-panel) {
  background: var(--grad-card-inset); border-color: var(--hairline-card); box-shadow: none; }
html[data-card-step] .surface .surface :where(.surface):not(.matte, .meal-card-in, .matte-reset, .olive-panel) {
  background: var(--grad-card); }
```
`data-card-step` is set on `<html>` in `app/layout.tsx`; removing it reverts all legacy nested sites at once.

### 3.5 Tests (W0)
- `tests/design/contrast-table.ts`: SURFACES gain the lifted card and the inset.
- `tests/design/surface-step.test.ts` (new): ground→card on all four grounds, card→inset, inset→card, card→olive-panel, each ≥ 1.10 at every stop; the guarded rule exists.
- `tests/design/sweep-elevation.test.tsx`: CardFrame classes (nested: no shadow, 12 % hairline). The DayBoard and TipTile reads move verbatim to `tests/design/sweep-elevation-dayboard.test.tsx` (W2 deletes it with those files).
- `tests/ui/card-frame.test.tsx` (new): size classes, tone alternation, the depth-3 throw, whole-card button ≥ 44 px with keys, meta is one line.
- `tests/design/grounds.test.ts`, `tests/design/gallery.test.tsx` (`/design` gains a Cards section).

---

## 4. Overview tab (W2 owns the face, W3 the companion, W4 the charts)

**CupSlot** (`components/today/CupSlot.tsx`, header, both faces): 44 px pill, at least 96 px wide. A droplet that fills with `--color-gauge-water`, "4/8" in the account's unit, "+". Tap adds one stored cup. Hold and slide opens the existing scrub layer (`lib/today/water-scrub.ts`, `lib/today/water-gesture.ts`); the total is written once, capped at `MAX_CUPS`, and a mid-slide sync never moves the base. Arrow keys + Enter. Name "Add a cup of water. 4 of 8 cups." No tilt prompt.

**Overview body** (`components/today/overview/OverviewFace.tsx`), 12 px gaps, every block a `CardFrame size="sm"` (an inset step inside the Day card):
1. **Summary** (`SummaryRow.tsx`): "1,240 kcal left" or "180 kcal over"; an 8 px calorie bar; three macro mini-bars "P 62/140 g". Partial days say "at least"/"at most". Tap scrolls to `DayNutrients` (`id="day-nutrients"`, added by W0). No revision: "Finish your profile to see targets" plus a link; nothing invented.
2. **Next meal** (`NextMealRow.tsx`): 48 px thumbnail, "Next · 12:30", name, kcal · P g, a 44 px Mark eaten circle with the 400 ms double-tap guard. All eaten: "Every planned meal today is eaten." Uses `nextMeal` from `lib/today/board.ts`.
3. **Rebalance** (`RebalanceRow.tsx`): only when the page passes `overview.rebalance` (from `useRebalancePanel`). Read-only, links out.
4. **Companion** (`overview/CompanionSlot.tsx`, W3). Nothing when hidden.
5. **Your week** (`overview/TrendsSlot.tsx`, W4). Section 4.1.

Dropped: the DayOverview ring wells, macro rings and the LiquidOrb bead; the Board's TipTile, tips, explainer pin, WaterTile and week bars; the LiveWidget island, bubbles, fuel, water and edit tray.

### 4.1 Your week (W4)
- Collapsed: a `CardFrame size="md"` titled "Your week" with a 3-column grid of mini charts, **Calories, Sleep, Activity**, each 96×56 with its 7-day average under it. Tap a mini chart to open it in place (`DisclosurePanel`): one 320×160 chart, chips for Calories · Protein · Water · Sleep · Weight · Activity, and `Segmented` "7 days | 4 weeks". A footer link "See week" → `/week`.
- 7 days: daily bars (weight: points + trend line). 4 weeks: 4 weekly-mean bars with "n of 7 days".
- Each column is a focusable 44 px button; tapping it shows "Tue · 1,840 of 2,000 kcal" above the chart. The chart is `role="img"` with a summary label and a visually hidden table. Bars rise on `SPRINGS.smooth`, instant under reduced motion.

| Metric | Source | Honesty |
|---|---|---|
| Calories, Protein | stored log entries and eaten slots/recipes for each past date via `lib/trends/series.ts` (not `resolveDay`'s generator: 28 generated days on mount is too slow); target per date from `targetRevisionOn` (`lib/targets/revision.ts`) | A day with no entry, no eaten slot and no consumed recipe is a gap, never 0. Partial days drawn outline-only ("at least"). No target line before the first revision. |
| Water | IDB `water_log` via `getRow` (`lib/water-client.ts`); goal from `resolveWaterGoal` (`lib/water-goal.ts`) per day type | A missing row is a gap. |
| Sleep | `fetchDaily` `sleep_minutes` (`lib/health-client.ts`) | gaps |
| Weight | `fetchDaily` `body_mass_kg` (kg stored; unit display only) + a new additive `/api/expenditure` field `weightTrendPoints: { date, kg }[]` (the series is undated today; `lib/server/expenditure.ts` returns the dates it already reads), drawn only where points exist | Gaps over 3 days not joined. |
| Activity | `fetchDaily` `active_kcal`, `steps` + training-day dots from the plan's day type | One line in the open chart only: "Workouts aren't recorded yet." No workout data exists in the app. |

- One 28-day `fetchDaily` when a health metric is first shown, with a new `{ cache: false }` option that never overwrites the shared `health_daily` cache and returns null (not the cached window) on 503 or offline.
- Health off: "Connect health to see sleep" → `/settings`, never a chart of zeros.
- Drawing: `components/charts/TrendBars.tsx`, `TrendLine.tsx`, `MiniTrend.tsx`, geometry in `lib/charts/geometry.ts`, colours from `--color-gauge-*` in a CSS module.

---

## 5. Companion (W3, migration)

- **Where:** Overview only (today and past days). Calendar loses it.
- **Collapsed** (default; open state never stored): one 64 px `CardFrame size="sm"` button with `aria-expanded`: a 48 px `SproutFigure` in the current mood, the name through `named()` with one observational mood line (OD19: never sad on a shortfall, never tells anyone to eat), a "Seeds 12" tag only when the care read succeeded, and a chevron. Name: "{Name}: {mood}. Open".
- **Open** (in place, `DisclosurePanel` + `AutoHeight`): a 160 px stage (figure, `aria-live` mood line, "Care today 60 %"), at most two buttons, **Visit the pond** (swaps the stage for `PondScene` with its own Back) and **Seeds** (modal `CareShop`), then `CareNotes` and a text link **Hide {Name}** with an Undo toast. Frame loops pause when collapsed, off screen or under reduced motion.
- **Hiding, synced per account:**
  - Migration `supabase/migrations/20270107090000_user_settings_companions_hidden.sql` (+ down file): `user_settings.companions_hidden text[] not null default '{}'`, check `cardinality <= 8` and each element 1–40 chars, `NOT VALID` then validate in `20270107090100_user_settings_companions_hidden_validate.sql`; patch `_sync_upsert` with the anchor-and-replace mechanism of `20261225090000_user_settings_mascot.sql`, and the semantics of `cuisines` in `20261217090200_profile_sync_cuisines_country.sql` (omitted key keeps the stored value; `[]` clears; JSON null refused).
  - `lib/sync/user-settings.ts` maps it both ways; `Settings.companionsHidden: MascotKey[]` in `lib/types.ts` (added on the existing `mascot` line: the file is at the 400-line cap in `tests/speed/file-size.test.ts`); unknown keys are dropped on read with `isMascotKey` and deduped (not `mascotKeyOf`, which maps unknowns to Sprout).
  - Writes go through `syncProfileSettings(..., ["companionsHidden"])` on the same serialized, account-bound queue as the mascot, with rollback.
  - `useCompanionShown(key)` (`lib/today/companion-visibility.ts`, `useSyncExternalStore` whose snapshot is a boolean for that key, so it is stable; refreshes on `SYNCED_EVENT` and a new `COMPANION_VISIBILITY_EVENT`).
  - Hidden: `CompanionSlot` renders nothing, `CareLayer` does not mount (no care reads, notes or awards), the tour shows no figure. Onboarding's guide is unchanged.
- **Settings › Your companion** (`components/settings/CompanionSection.tsx`): the picker stays; hidden companions carry a "Hidden" tag; a 44 px switch row "Show {Name} on Today" for the selected companion.
- **First line of the W3 PR:** "Needs migrations 20270107090000 and 20270107090100 applied to production before merge." Not auto-merged.

---

## 6. Foods first tab (W5)

Tab label stays "Favorites"; the wire name `eats` never renames.

1. `OpenWorldInvitation` (unchanged, dismissible; shown only to accounts it applies to).
2. **Preferred shopping list** (`components/foods/PreferredList.tsx`, new), `CardFrame md` inside `<section aria-label="Favorites">`. Title is "Preferred shopping list" when the recipe pilot is on, "Your favorites" otherwise (no Shopping tab to point at). Favored foods grouped by aisle under overline sub-headers, starred first. Rows are the existing `FoodRow` (dot, name, kcal per 100 g, star, swipe/Edit to Remove). Each group a `CappedList` of 6 with "Show all N"; footer Add on the right. Tapping a row opens `FoodSheet` (role, note, Favor, Avoid). This is where Favored-food management lives now.
3. **Often eaten** (`components/EatenOften.tsx`): same `loadTaste` read, grouped by aisle, server order inside each group; "Add" only when `favorable && !favored`; one meta line "From the last 6 months".
4. **Saved recipes** stays as one collapsed row (`RecipesSection`, `id="recipes"`, a `Disclosure` "Saved recipes (N)"), so the `#recipes` deep link still lands. The FavoritesStrip leaves this tab (food stars live on the rows; it stays in the log sheet).

Removed: the "Your usual foods" h2 (`components/EatsView.tsx:27`), the intro sentence, the three role cards, "None right now", and the neutral "Other foods" disclosure.

**Aisle taxonomy** (`lib/foods/aisle.ts`, W0, shared by W5, W7, W8): `aisleOf({ name, bundledId?, role? })` → `produce | protein | dairy_eggs | grains | pantry | drinks | other`, fixed label order. Rules in order: a bundled id or exact name match in `lib/food-db.json` takes its `category` (vegetable/fruit → produce, protein → protein, dairy/dairy-free → dairy_eggs, carb → grains, fat/condiment/sweet/supplement → pantry, drink → drinks, meal → other); else `mealFamily(name)` → protein; else role (protein/carb/fat → protein/grains/pantry); else other. Runs on the phone; no server change.

Avoids adopts `CardFrame` sizes with no behaviour change.

---

## 7. Shopping (W7 lists and screen, W8 AI build and map)

Everything stays behind the recipe pilot gate on client and server.

### 7.1 Screen, top to bottom (W7, `components/ShoppingView.tsx`)
1. **Have AI build my list** (`components/shopping/BuildListSlot.tsx`, W0 stub mounted by W0, filled by W8): a collapsed `CardFrame tone="olive" size="md"`, title "Have AI build my list", one line "Pick foods and meals, yes or no.", a primary "Start".
2. **Saved-list switcher** (`SavedListSwitcher`): `‹ Weekly shop ›` with "20–26 Oct · 12 items · 3 in cart". 44 px arrows cycle lists by `start_date` desc then `updated_at`. Tap the title for `SavedListsSheet`: "New list" (optional title + This week / Next week / Custom), every list with title, dates and progress, Rename, Delete (`ConfirmSheet` "Meals you already planned stay on Today." then Undo toast). An untitled list shows "List for 20–26 Oct" (not stored).
3. **Your list** (`ShoppingList`): progress and Share; rows grouped by `aisleOf`; `ShoppingRow` behaviour unchanged (whole row a checkbox, `ruleMark` always shown and in the checkbox name, optimistic revision-held ticks); "In cart" disclosure keeps "Clear N bought items".
4. **Pick from your foods** (`components/shopping/PickList.tsx`, `PickRow.tsx`), replacing the "From your Favorites" pills and copying the Favorites row layout: a search box "Add something else" (`planQuickAdd`), sections **Favorites** (Favored + starred) and **Often eaten** (`loadTaste`), each grouped by aisle in a `CappedList` of 6. `PickRow` = dot, name, source meta, its `RuleMark` from the verified set, and a 44 px "+" toggle that becomes ✓ "On list" (`aria-pressed`, "Add Eggs to list"). On adds a manual line; off deletes only a manual unchecked line. Avoid foods are never offered; a `blocked` food shows its mark and cannot be added; `unknown` shows its mark.
5. **More options** disclosure (closed): the trimmed `ShoppingControls` (period, meals, people, effort, area and store notes, Preview), the ingredient picker and the preview diff. The area field stays here, so "location only after a direct tap" keeps its test. Copy: "Nearby store search is in Have AI build my list."
6. **Have already** disclosure: pantry + `PantryPhotoCapture` (privacy notice before every capture).
7. One footer line: "Store prices aren't available yet."

### 7.2 Saved named and dated lists (W7, migration)
- `supabase/migrations/20270107090200_shopping_period_titles.sql`: `alter table public.shopping_periods add column title text;` plus a guarded `check (title is null or char_length(btrim(title)) between 1 and 60) not valid`; `20270107090300_shopping_period_titles_validate.sql` validates. Down files in `supabase/migrations/down/`.
- `title` in `periodFields`/`periodPatch` (`lib/shopping/validation.ts`, trimmed 1–60, nullable optional; omitted keeps, null clears), `ShoppingPeriod.title` (`lib/shopping/types.ts`), repository mapping.
- `POST /api/shopping/periods` takes an optional `title`. PATCH keeps its body `{ expectedRevision, requestId, patch }`; `title` goes inside `patch`.
- **New `DELETE /api/shopping/periods/[id]`** `{ expectedRevision, requestId }` sets `deleted_at`, answers 200 when already deleted with the same `last_request_id`, 409 on a stale revision, owner RLS, pilot 404, the existing `shopping-period-item:<uid>` limiter, no-store. Accepted meal selections are kept (they belong to dates, not lists).
- **List semantics:** lists may overlap in dates. Meal plans live per date (`recipe_plan_selections`), so only lists made by the planner carry meals; "New list" makes a manual list (lock mode none). One shared resolver `currentShoppingPeriod(periods, today)` in `lib/shopping/current.ts` (covering today, latest `start_date`, then `updated_at`) is used by `addToCurrentShoppingList` (`lib/shopping-client.ts`), `ShoppingTodayCard`, the switcher default and `lib/server/shopping-focus.ts`. Deleted lists are absent from GET, focus keys and the current-list rule (tested).
- Client: `renameShoppingPeriod`, `deleteShoppingPeriod` in `lib/shopping/list-client.ts` through `fetchWithDeadline` with the existing commit deadline.
- Preview exclusion for the meal walk: `excludeRecipeIds: z.array(id).max(50).optional()` in `lib/shopping/preview-contract.ts`; `lib/shopping/planner.ts` drops those candidates before scoring (only removes, never admits; byte-identical when absent); `lib/server/recipe-plan.ts` passes it through.
- **First line of the W7 PR:** "Needs migrations 20270107090200 and 20270107090300 applied to production before merge." (Writes of `title` fail before the column exists.) Not auto-merged.

### 7.3 Have AI build my list (W8)
`lib/shopping/build-flow.ts` is a pure reducer. Steps open in place with Back; Close discards everything; nothing is written before Save.
1. **Budget** (first screen): "Budget for this list?" number field + currency chip (USD prefilled only when the stored `country_code` is US), "Skip" / "Next". One line: "Prices aren't available yet." Dates and meals default to the next 7 days and the account's own meal slots, editable on the Save step.
2. **Ingredients** (`YesNoDeck.tsx`): candidates from `lib/shopping/build-candidates.ts` = Favored ∪ starred ∪ admitted taste rows ∪ ingredients of the account's saved recipes and favorite meals, deduped by normalized name; minus Avoid, pantry and lines already listed; `blocked` dropped with a visible "N left out by your food rules"; `unknown` shows its mark. **AI ranking:** the admitted candidate names go to Jev through `callModel` under a new purpose `shopping-build-rank` (registered in `lib/ai/call-registry.ts`, typed builder in `lib/ai/payloads.ts`, spend reservation, shared limiter, fail closed to plain order). It may only reorder. No budget, location, demographic or health field is sent. Cap 30 cards. Each card: name, source tag, Yes / No (52 px), "3 of 18", "Yes to the rest", Back. Provenance `{ ai: true, source: "jev", purpose }` when Jev ranked, else `{ ai: false, source: "app" }` and the deck says "In your usual order".
3. **Meals:** `previewShopping(input, null)` with `excludeRecipeIds` forwarded in the request body (write-free). Meals come from the recipe catalog, which is what the planner and `recipe_plan_selections` support; the account's saved recipes and favorite meals feed the Ingredients deck. Planning the account's own recipes as meals needs a schema change and is a named follow-up. Each planned meal is a card (name, day, slot, kcal · P g) with Yes / No. No answers are excluded in one re-preview; replacements are walked once more, at most 2 rounds, then "Keep these".
4. **Stores** (optional): area field (prefilled from `shopping-location:<id>`) + a country chip (stored `country_code`, else pick one) or "Use my location" (direct tap only, coarse). A ZIP uses Nominatim's structured `postalcode=` query. The resolved place shows "Near Mission District, San Francisco. Is this right?" before stores load. Then the map (7.4) or "Skip".
5. **Save:** title (default "Weekly shop"), dates and meals summary, "18 items · 9 meals · 2 stores". **Save list** runs `acceptShopping` (CAS, `requestId`; accept creates the period as today), then PATCHes the title with the revision from the accept answer, then adds the manual lines, each with its own `requestId`, retrying into the same period. A failure after accept leaves a usable list and offers "Finish saving". Dispatches `recipe-plan-accepted`; the switcher jumps to the new list. Test: Save makes exactly one period and it carries the title.

### 7.4 Map (W8)
- Leaflet 1.9.4 + `@types/leaflet`, imported only with `next/dynamic(..., { ssr: false })` from the `"use client"` `StepStores.tsx`, so it stays out of first load (about +46 KB to `totalKb`; W8 records the measured headroom in the PR, raising `scripts/perf-budget.json` only if CI requires it).
- `leaflet/dist/leaflet.css` imported in `StoreMap.tsx`; overrides in `StoreMap.module.css` use tokens only. `map.invalidateSize()` after the step's transition and on resize.
- Tiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, zoom 12–17. Two-finger pan on phones ("Use two fingers to move the map"), pinch zoom. `L.divIcon` markers with 44 px hit areas; a picked store shows ✓. A 44 px row list under the map mirrors it. At most 5 picks. "© OpenStreetMap contributors" always visible (tested).
- CSP (`lib/security-headers.ts`): add exactly `https://tile.openstreetmap.org` to `img-src`. `connect-src` unchanged.
- Routes (POST with JSON bodies, so the area never sits in a URL): `POST /api/shopping/places/geocode { q, country }` → `{ lat, lon, label }` rounded to 2 decimals; `POST /api/shopping/places/stores { lat, lon }` → named stores within 4 km (one 8 km retry when fewer than 3), Overpass query with `[timeout:8]`.
- `lib/server/places.ts`: fixed hosts, `User-Agent` with the app name and `VERCEL_PROJECT_PRODUCTION_URL` through its own exported helper that returns null when the variable is absent (then the route answers 503, never an anonymous call), server budget 6 s for Nominatim and 9 s total for Overpass including the one wider retry (under the phone's 12 s `places` deadline), a global `enforceRateLimit("places:nominatim", 1, 1)` (a reviewed exception added to `tests/server/ratelimit-call-sites.test.ts`), per-user limits `places-geocode:<uid>` 10/10 min and `places-stores:<uid>` 20/10 min, fail closed. A 429 or timeout → `503 places_unavailable`, UI "Store search isn't available right now. You can skip this step." Logs carry status only. Expect this path sometimes: public Overpass is shared and rate-limits busy hosts.
- Stored: nothing on the server. On the phone, the area text in the existing `shopping-location:<id>`; picked store names (≤ 5) in a new `shopping-picked-stores:<id>` key (listed in `tests/device/storage-keys.test.ts`).
- `components/settings/ProcessorsSection.tsx` row: "OpenStreetMap: the area and country you type, and rounded coordinates, go through our server. Map tiles load from OpenStreetMap, which sees your IP address."

---

## 8. Workstreams

**Rules.** Every path belongs to exactly one workstream. W0 creates the stubs and shared modules listed below; after W0 merges they belong only to the named workstream. Read-only imports across workstreams are fine. These exports are **frozen** (nobody removes or changes them): all of `components/today/LiveWidgetPanels.tsx`; `CappedList`, `ListFooter` (`components/MyFoods.list.tsx`); `MyFoods` `{ AvoidFoods, default }`; `FavoritesStrip` default and props; `BodyDashboard` `{ lastSeen }`; `useDayCardMotion` `{ useFacesHeight }`; `nextMeal`; every `lib/shopping-client.ts` signature; `lib/shopping/contracts.ts`; `lib/shopping/list-client.ts`; `lib/foods/aisle.ts` (`aisleOf`, `AISLES`, `aisleLabel`, `aisleRank`, `groupByAisle`); `components/today/overview/types.ts`; `components/ui/PageTitle.tsx`; `lib/today/page-title.ts`; Sprout exports used by tests (`SproutStage`, `SproutFigure`, `SPROUT_HERO_ART`). `lib/today/widget-prefs.ts` and `lib/today/rebalance-widget.ts` are untouched until Close-out.

Shared ratchet: W0 changes `tests/design/buttons.test.ts` from exact counts to "at most" (a rise still fails); Close-out tightens every entry back to exact.

### W0 Foundation (this thread, Opus; no migration, no env)
Card roles, `CardFrame`, `PageTitle`, the two-tab shell with CupSlot and face stubs, shared contracts, test re-homing.
- Contract: `app/globals.css`, `app/layout.tsx` (`data-card-step`), `DESIGN.md` (§Elevation prose; frontmatter only if the CLI runs), `docs/plans/2026-10-19-ui-makeover.md` (new, a copy of this plan).
- UI: `components/ui/CardFrame.tsx` (new), `components/ui/PageTitle.tsx` (new), `components/ui/Surface.tsx`, `components/ui/index.ts`.
- Shell: `components/today/DayCard.tsx`, `DayCard.module.css`, `FaceSwitch.tsx`, `DayCard.test.tsx`, `DayCard.motion.test.tsx`, `components/today/overview/types.ts` (new, full `OverviewData`: today's `PanelData` + board fields + body + `when`).
- Today page: `app/page.tsx` (`PageTitle`, `overview=` prop, drops `ExplainerPlayer`/`boardTips` imports), `components/DayNutrients.tsx` (`id="day-nutrients"` only), `tests/cards/today.test.tsx`.
- Shopping contracts: `lib/shopping/contracts.ts` (new: `ShoppingDraft`, `defaultShoppingDraft`, `draftProblem`, `ShoppingPreviewInput` with `excludeRecipeIds?`, `title?`, `SavedListSummary`, `PlaceStore`, `GeocodeResult`), with re-exports left in `components/ShoppingControls.tsx` and `components/ShoppingView.tsx`; `lib/shopping-client.ts` imports from contracts; `ShoppingView.tsx` also mounts `BuildListSlot` at the top.
- Shared modules: `lib/foods/aisle.ts` (new) + `tests/foods/aisle.test.ts` (new).
- Gallery: `app/design/page.tsx`, `app/design/CardsGallery.tsx` (new).
- Design tests: `tests/design/contrast-table.ts`, `surface-step.test.ts` (new), `sweep-elevation.test.tsx`, `grounds.test.ts`, `gallery.test.tsx`, `buttons.test.ts`, `tests/ui/card-frame.test.tsx` (new).
- Inventory: `tests/cards/manifest.ts` becomes an aggregator over `tests/cards/manifest/*.ts`; `tests/cards/inventory.test.ts` scans every shard for the no-wildcard check. W0 keeps `manifest/{core,today-shell,coach,onboarding,sheets}.ts`.
- Settings markup: `tests/settings/settings-page-markup.test.tsx` becomes structural (section order and headings); its snapshot is deleted.
- **Stubs (owner):** `components/today/CalendarFace.tsx` + `CalendarFace.test.tsx` (W3); `components/today/CupSlot.tsx` (W2); `components/today/overview/OverviewFace.tsx` + `OverviewFace.test.tsx` (W2); `overview/CompanionSlot.tsx` (W3); `overview/TrendsSlot.tsx` (W4); `tests/design/sweep-elevation-dayboard.test.tsx` and `tests/design/gallery-board.test.tsx` (W2); `components/shopping/BuildListSlot.tsx` (W8); `lib/shopping/list-client.ts` (W7); manifest shards `today-overview` (W2), `today-companion` (W3), `today-trends` (W4), `foods` (W5), `shopping` (W7), `shopping-build` (W8), `body`, `settings`, `week` (W1), `cards-sweep` (W6).
- **Test hand-offs:** W0 rewrites `DayCard.test.tsx` and `DayCard.motion.test.tsx` to be face-agnostic (faces mocked; no ExplainerPlayer, boardTips, LiveWidget, Board or explainer assertions; those move to `OverviewFace.test.tsx` and `CalendarFace.test.tsx`, which W2 and W3 own). The `tests/cards/today.test.tsx` "Active burn"/"Sleep and recovery" case moves to `OverviewFace.test.tsx`. The TipTile and water-liquid cases of `tests/design/gallery.test.tsx` move to `tests/design/gallery-board.test.tsx` (W2).
- Interim after W0: Calendar = strip + `LiveWidget`; Overview = `DayOverview` + `DayBoard` (no tips, no explainers) + rebalance; CupSlot = a plain 44 px "Add a cup" button. Every current card stays mounted, so the inventory stays green.

### W1 Navigation, page titles, Body and Settings cards (Sonnet; no migration)
- `components/TabBar.tsx`, `TabBar.module.css`, `components/dock/TabCapsule.tsx`, `components/AppChrome.tsx`, `lib/design/section.ts`, `lib/design/section.test.ts`
- `app/body/page.tsx`, `app/settings/page.tsx`, `app/week/page.tsx`
- `components/settings/Card.tsx` (→ `CardFrame md`), `components/settings/Section.tsx`, `components/settings/settings-styles.ts` (CAPTION 12 px light → 14 px muted), `components/tour/HowSashaWorksCard.tsx`
- `components/HealthMetricCard.tsx` (`CardFrame sm`, `/body` as a 2-column compact grid), `components/BodyDashboard.tsx`
- Tests: `tests/tabbar/flags-off.test.tsx` (every tab labelled), `tests/tabbar/labels-width.test.tsx` (new: four labels at 320 and 390 px, no overflow), `tests/chrome/app-chrome.test.tsx`, `tests/body/today-card.test.tsx`, `tests/body/metric-cards.test.tsx`, `components/BodyDashboard.test.tsx`, `tests/cards/body.test.tsx`, `tests/cards/settings.test.tsx`, `tests/cards/week.test.tsx`, `components/tour/HowSashaWorksCard.test.tsx`, shards `body`, `settings`, `week`.
- Merge first among the build threads (others' Settings specs assert structure, not W1's classes).

### W2 Overview face and the cup (Opus; no migration)
- `components/today/overview/OverviewFace.tsx`, `OverviewFace.test.tsx`, `OverviewFace.module.css` (new), `SummaryRow.tsx`, `NextMealRow.tsx`, `RebalanceRow.tsx` (new)
- `components/today/CupSlot.tsx`, `CupSlot.module.css` (new)
- `components/today/WaterLiquid.tsx`, `WaterLiquid.module.css` (new; liquid styles move here from `WaterTile.module.css`)
- `components/today/useDayCardMotion.ts` (drops `BOARD_MORPH`, `boardMorph`, `TILES_*`; keeps `useFacesHeight`), `lib/today/board.ts` (keeps `nextMeal`, drops `boardTips`), `lib/today/board.test.ts`
- `app/design/DesignGallery.tsx`, `app/design/gallery-fixtures.ts`, `app/design/NutritionGallery.tsx` (drops the DayOverview demo), `tests/nutrition/honest-today.test.tsx`, `tests/design/gallery-board.test.tsx` (W0 stub)
- Deletes: `components/today/{DayOverview.tsx, DayOverview.module.css, DayBoard.tsx, DayBoard.module.css, DayBoard.test.tsx, TipTile.tsx, TipTile.module.css, TipTile.test.tsx, ExplainerPlayer.tsx, WaterTile.tsx, WaterTile.module.css}`, `components/today/island/LiquidOrb.tsx`, all of `components/today/tips/`, `tests/design/sweep-elevation-dayboard.test.tsx`
- Tests: `tests/today/water-tile.test.tsx` → `tests/today/cup-slot.test.tsx` (tap, unit, scrub, Escape, scroll vs hold, keys, mid-slide sync), `OverviewFace.test.tsx`, shard `today-overview`.

### W3 Companion and synced hide (Opus; **migration**)
- Migrations: `supabase/migrations/20270107090000_user_settings_companions_hidden.sql`, `20270107090100_user_settings_companions_hidden_validate.sql`, `supabase/migrations/down/` pair; `tests/migrations/companions-hidden-db.test.ts` (new)
- `lib/sync/user-settings.ts`, `lib/sync/user-settings.test.ts`, `lib/types.ts` (`Settings.companionsHidden` only), `tests/migrations/profile-taste-db.test.ts` and `tests/migrations/profile-cuisines-country-db.test.ts` (add the new down files to their peel lists), `lib/today/companion-visibility.ts` (new) + `tests/today/companion-visibility.test.ts` (new)
- `components/today/CalendarFace.tsx`, `CalendarFace.test.tsx`, `components/today/overview/CompanionSlot.tsx`, `CompanionCard.tsx`, `CompanionCard.module.css`, `CompanionCard.test.tsx` (new)
- `components/settings/CompanionSection.tsx`, `CompanionSection.module.css`
- `components/today/care/CareLayer.tsx`, `CareLayer.module.css`, `MascotPicker.tsx`, `care-today.test.tsx`, `awards.test.tsx`
- `components/today/island/Sprout.tsx`, `Sprout.module.css`, `views.ts`, `Sprout.test.tsx`, `SproutFigure.test.tsx`, `mascot-scenes.test.tsx`, `companion-today.test.tsx`, `components/today/LiquidRingsPanel.test.tsx`
- `components/tour/AppTour.tsx`, `AppTour.test.tsx`, `TourLayer.tsx`, `components/tour/TodayTour.test.tsx`
- `app/design/WellGallery.tsx` (drops the LiveWidget demo)
- Deletes: `components/today/{LiveWidget.tsx, LiveWidget.test.tsx, LiveWidget.projection.test.tsx, WidgetEditTray.tsx, WidgetEditTray.test.tsx}`, `components/today/island/{FuelView.tsx, FuelView.module.css, FuelView.test.tsx, IslandGoo.tsx}`. Kept: `LiveWidgetPanels.tsx` (frozen), `PondScene`, `LiquidRings`, `WellWater`, `WaterSwim`.
- Shard `today-companion`. Merges after W2.

### W4 Weekly trends (Opus; no migration)
- `components/today/overview/TrendsSlot.tsx`, `TrendsCard.module.css` (new)
- New: `components/charts/{TrendBars,TrendLine,MiniTrend,MetricChips}.tsx`, `components/charts/Charts.module.css`, `lib/charts/geometry.ts`, `lib/trends/{series,sources,use-trends}.ts`
- `lib/health-client.ts` (`{ cache?: boolean }`)
- Tests (new): `tests/trends/series.test.ts` (no-entry day is a gap, partial days, no target before the first revision, kg, weekly means, weight trend date mapping), `tests/trends/sources.test.ts`, `tests/trends/health-window.test.ts` (no cache overwrite, null on 503/offline), `tests/charts/geometry.test.ts`, `tests/trends/trends-slot.test.tsx` (hidden table, 44 px columns, readout, Connect health, reduced motion), shard `today-trends`.

### W5 Foods first tab (Sonnet; no migration)
- `app/foods/page.tsx`, `components/FoodsTabs.tsx`, `components/Segmented.tsx`
- `components/EatsView.tsx`, `components/foods/PreferredList.tsx` (new), `components/MyFoods.tsx`, `components/MyFoods.list.tsx`, `components/EatenOften.tsx`, `components/FavoritesStrip.tsx`, `components/CatalogFavorites.tsx`, `components/RecipesSection.tsx`, `components/foods/OpenWorldInvitation.tsx`
- `components/AvoidsView.tsx`, `components/AvoidRules.tsx`
- Tests: `components/FoodsTabs.test.tsx`, `components/MyFoods.test.tsx`, `components/AvoidRules.test.tsx`, `tests/cards/foods.test.tsx`, `tests/foods/foods-list.test.tsx`, `tests/cards/eaten-often.test.tsx`, `tests/cards/eaten-often-favor.test.tsx`, `tests/favorites/favorites-strip.test.tsx`, `tests/favorites/favorites-strip-limit.test.tsx`, `tests/recipes/recipes-page.test.tsx`, `tests/foods/avoids-ui-audit.test.tsx`, `tests/recipes-hub/new-recipe-button.test.tsx`, `tests/cards/recipe-access.test.tsx`, `tests/design/action-feedback-rollout.test.ts`, `tests/foods/food-sheet-membership.test.tsx`, `tests/foods/preferred-list.test.tsx` (new: aisles, starred first, pilot title switch, no "Your usual foods"), shard `foods`.

### W6 Card sweep: meal card, recipes, coach, plan, Today extras (Sonnet; no migration)
Moves every remaining card onto `CardFrame` sizes and the one-title, one-line, two-action rule. Behaviour unchanged.
- Meal card: `components/SlotCard.tsx`, `SlotCardDetail.tsx`, `MealCardTray.tsx`, `MealCardActions.tsx`, `MealCardActions.module.css`, `MealTimeline.tsx`, `MealTimeline.module.css`, `AfterDarkCards.module.css` (its tinted rgba literals become tokens), `components/ui/MealNutritionDivider.tsx`, `MealNutritionDivider.module.css`, `components/ui/MealPhoto.tsx`, `MealPhoto.module.css`
- Recipes: `components/recipes-hub/**`, `components/RecipeDetails.tsx`, `RecipeDiscovery.tsx`, `CatalogRecipeResults.tsx`
- Coach: `components/coach/**`, `components/CoachComposedCard.tsx`, `CoachMessage.tsx`, `CoachSuggestion.tsx`, `CoachSuggestions.tsx`, `CoachActionCard.tsx`
- Plan: `components/plan/**`, `components/PlanSheet.tsx`
- Today extras: `components/ProposalCard.tsx`, `components/today/DuplicateEntryCard.tsx`, `DuplicateEntryCard.module.css`, `components/today/DayCompleteControl.tsx`
- Tests: every `components/SlotCard*.test.tsx`, `components/MealCardActions.test.tsx`, `components/CoachComposedCard.test.tsx`, `components/RecipeDiscovery.test.tsx`, `components/today/DuplicateEntryCard.test.tsx`, `components/today/DayCompleteControl.test.tsx`, `tests/coach/**` except `tests/coach/action-golden/` and the shopping-action specs, `tests/recipes-hub/**` except `new-recipe-button.test.tsx` (W5), `tests/plan/**/*.tsx`, `tests/today/plan-sheet*.test.tsx`, `tests/cards/{coach,coach-suggestion,sheets,meal-cards-swaps,recipe-plan-sheet}.test.tsx`, `tests/design/meal-type.test.ts`, `tests/design/grok-contrast-2026-10-04.test.ts`, `tests/expenditure/proposal-card-copy.test.tsx`, `tests/rebalance/no-ismissed.test.ts`, `tests/speed/file-size.test.ts` (baselines may move only for files W6 owns), the W0 `coach` and `sheets` manifest shards (W6 keeps each entry's states), shard `cards-sweep`.

### W7 Shopping lists and screen (Opus; **migration**)
- Migrations: `supabase/migrations/20270107090200_shopping_period_titles.sql`, `20270107090300_shopping_period_titles_validate.sql`, `down/` pair; `tests/migrations/shopping-period-titles-db.test.ts` (new)
- Data: `lib/shopping/validation.ts`, `types.ts`, `repository.ts`, `preview-contract.ts`, `planner.ts`, `lib/shopping/current.ts` (new), `lib/shopping/list-client.ts`, `lib/server/recipe-plan.ts`, `lib/server/shopping-focus.ts`, `app/api/shopping/periods/route.ts`, `app/api/shopping/periods/[id]/route.ts` (DELETE), `app/api/shopping/preview/route.ts`, `lib/shopping-client.ts` (`addToCurrentShoppingList` uses `currentShoppingPeriod`; `previewShopping` forwards `excludeRecipeIds`)
- Screen: `components/ShoppingRoot.tsx`, `ShoppingView.tsx`, `ShoppingList.tsx`, `ShoppingRow.tsx`, `ShoppingControls.tsx`, `ShoppingIngredientPicker.tsx`, `ShoppingPreview.tsx`, `ShoppingLineCard.tsx`, `ShoppingPurchaseWindowCard.tsx`, `components/today/ShoppingTodayCard.tsx`, new `components/shopping/{PickList,PickRow,SavedListSwitcher,SavedListsSheet}.tsx`, `lib/shopping/{pick-sources,saved-lists}.ts` (new), `lib/shopping/quick-add.ts` (drops `favoriteChips`)
- Tests: `tests/shopping/{planner,preview-contract,ui-client,quick-add}.test.ts`, `tests/shopping/{ui,root,ui-audit,ingredient-picker-ui,rule-mark-ui,rule-mark-root}.test.tsx`, `components/ShoppingList.test.tsx`, `tests/today/shopping-today-card.test.tsx`, `tests/today/shopping-today-weeks.test.tsx`, `tests/server/shopping-focus.test.ts`, `tests/server/shopping-focus-route.test.ts`, `tests/tenancy/admin-shopping-focus.test.ts`; new `tests/server/shopping-periods-route.test.ts` (title, PATCH clear, DELETE idempotent and CAS, pilot 404, deleted lists absent), `tests/shopping/{preview-exclude,list-client,current,saved-lists}.test.ts`, `tests/shopping/{pick-list,saved-list-switcher}.test.tsx`, shard `shopping`.
- First PR line names the two migrations; not auto-merged.

### W8 Have AI build my list and the store map (Opus; adds a dependency and an AI purpose; no migration, no env)
- `components/shopping/BuildListSlot.tsx`; new `components/shopping/build/{BuildFlow,StepBudget,StepIngredients,StepMeals,StepStores,StepSave,YesNoDeck}.tsx`, `components/shopping/build/build.module.css`, `components/shopping/BuildListCard.tsx` (the card, mounted by the slot), `components/shopping/StoreMap.tsx`, `StoreMap.module.css`
- New lib: `lib/shopping/{build-flow,build-candidates,build-rank-client,places-client}.ts`; server: `lib/server/places.ts`, `lib/server/shopping-build-rank.ts` (reads through the session client only; if it needs the admin client like `lib/server/plan-ideas.ts`, add `tests/tenancy/admin-entry-points.json` and a canary `tests/tenancy/admin-shopping-build-rank.test.ts`), `app/api/shopping/places/geocode/route.ts`, `app/api/shopping/places/stores/route.ts`, `app/api/shopping/build/rank/route.ts`
- AI: `lib/ai/call-registry.ts` (purpose `shopping-build-rank`), `lib/ai/payloads.ts` (typed builder)
- Shared config: `lib/fetch-with-deadline.ts` (`places` 12 s, `rank` 5 s) + `lib/fetch-with-deadline.test.ts`, `lib/security-headers.ts`, `components/settings/ProcessorsSection.tsx`, `package.json`, `pnpm-lock.yaml`, `scripts/perf-budget.json` (only if CI needs it)
- Tests: `tests/security/headers.test.ts`, `middleware.test.ts`, `components/settings/ProcessorsSection.test.tsx`, `tests/server/ratelimit-call-sites.test.ts` (one reviewed exception), `tests/ai/call-registry.test.ts`, `tests/device/storage-keys.test.ts`; new `tests/shopping/build-flow.test.ts` (Avoid never offered, blocked left out with a count, Yes to the rest, Back, 2-round cap, no write before Save, one period with its title), `tests/shopping/build-candidates.test.ts` (saved recipes and favorite meals included), `tests/server/shopping-build-rank.test.ts` (reorder only, never admits, no budget/location/demographics in the payload, Jev down → plain order), `components/shopping/build/BuildFlow.test.tsx`, `components/shopping/StoreMap.test.tsx` (Leaflet mocked; attribution; list mirrors map; at most 5; invalidateSize after open; location only after a tap), `tests/server/places.test.ts` (rounding, ZIP structured query, no country never auto-centres, 429 → 503, no query in logs, missing UA URL → 503), `tests/server/places-routes.test.ts` (auth, pilot 404, limiters), shard `shopping-build`.

### Close-out (this thread, `chore/makeover-close`, after the last merge)
`AGENTS.md` rows (Today, companion, trends, Foods, Shopping), `docs/design/KIT.md` (§6 card rule, §15.1), `docs/features.md`, comment fixes naming deleted files (`lib/today/water-scrub.ts`, `lib/design/motion.ts`, `lib/today/pet-mood.ts`, `island/{Island,Well}.module.css`), `tests/design/buttons.test.ts` back to exact counts, retirement of `lib/today/rebalance-widget.ts` (+ test) and `lib/today/widget-prefs.ts` (moving `WidgetPanel` into `LiveWidgetPanels.tsx` if still needed), `tests/profile/diet-prefs-taste.test.ts` and `tests/rebalance/import-graph.test.ts` rows for them. One signed-in phone walkthrough with no CSP report.

### File-ownership summary

| Owner | Files |
|---|---|
| W0 | globals.css, layout.tsx, DESIGN.md, docs/plans copy, ui/{CardFrame,PageTitle,Surface,index}, DayCard(.module.css/.test/.motion.test), FaceSwitch, overview/types.ts, app/page.tsx, DayNutrients (id), tests/cards/today, lib/shopping/contracts.ts (+ re-export lines in ShoppingControls/ShoppingView, BuildListSlot mount, shopping-client import), lib/foods/aisle(+test), app/design/{page,CardsGallery}, design tests listed, card-frame test, manifest aggregator + inventory test + core/today-shell/coach/onboarding/sheets shards, settings markup test |
| W1 | dock, AppChrome, section, body/settings/week pages, settings Card/Section/styles, HowSashaWorksCard, HealthMetricCard, BodyDashboard, listed tests, body/settings/week shards |
| W2 | OverviewFace + rows, CupSlot, WaterLiquid, useDayCardMotion, board, DesignGallery, gallery-fixtures, NutritionGallery, honest-today, the Board/Overview/Tip/Water deletions, cup-slot test, today-overview shard |
| W3 | companions migration + db test, user-settings sync, Settings type field, companion-visibility, CalendarFace, CompanionSlot/Card, CompanionSection, care, Sprout + its tests, tour files, WellGallery, LiveWidget/WidgetEditTray/FuelView/IslandGoo deletions, today-companion shard |
| W4 | TrendsSlot, charts, lib/charts, lib/trends, health-client, trends tests, today-trends shard |
| W5 | Foods page, tabs, Segmented, Eats/Preferred/MyFoods/EatenOften/FavoritesStrip/CatalogFavorites/RecipesSection/OpenWorldInvitation, Avoids, listed tests, foods shard |
| W6 | meal card files, MealNutritionDivider, MealPhoto, recipes-hub, recipe components, coach components, plan components, ProposalCard, DuplicateEntryCard, DayCompleteControl, listed tests, cards-sweep shard |
| W7 | shopping migration + db test, lib/shopping data files, current.ts, list-client, recipe-plan, shopping-focus, period and preview routes, shopping-client, add-to-shopping-list action, Shopping components, ShoppingTodayCard, pick/saved-list components, listed tests, shopping shard |
| W8 | BuildListSlot, build flow, BuildListCard, StoreMap, build/rank/places libs and routes, call-registry, payloads, fetch-with-deadline, security-headers, ProcessorsSection, package.json, lockfile, perf budget, listed tests, shopping-build shard |
| Close-out | AGENTS.md, KIT.md, features.md, comment fixes, buttons test tightening, widget/rebalance retirement and their test rows |

---

## 9. Risks

- **Card inventory gate:** every new `*Card|*Panel|*Section|*Sheet.tsx` (`CompanionCard`, `BuildListCard`, `SavedListsSheet`) needs a shard entry with each state named in a test title, in the same PR. `CardFrame`, `PageTitle`, `*Slot`, `*Row`, `*Face` avoid the pattern. Dead cards are deleted, never allowlisted.
- **Import hazards resolved:** `WaterLiquid` → `WaterTile.module.css` (W2 moves styles); `NutritionGallery` → `DayOverview` (W2); `WellGallery` → `LiveWidget` (W3); `PondScene`/`NutritionGallery`/`WellGallery` → `LiveWidgetPanels` (frozen); `app/page.tsx` → `ExplainerPlayer`, `boardTips` (W0); `DesignGallery` → `TipTile`, `gallery-fixtures` → `BoardTip` (W2).
- **Global nested rule:** a 390 px look at `/design` and the main routes before W0 merges; the `data-card-step` attribute is the one-line rollback.
- **Migrations:** W3 and W7 each carry two files with fresh timestamps (20270107090000–090300). Both PRs stop at ready; a Mac session applies the files to production, then merges.
- **OSM policy:** Nominatim is 1 request per second app-wide (global limiter), Overpass and tiles are volunteer-run. Household scale and the pilot gate keep volume low; "Store search isn't available right now" will sometimes show.
- **CSP_ENFORCE:** the page gate only loads `/sign-in`, so the Close-out signed-in walkthrough is required before any flip.
- **Honesty:** missing is never 0; no target before the first revision; "Workouts aren't recorded yet"; the budget is never shown as a total; Avoid is never offered or planned; `ruleMark` stays on every line and pick row; a taste dislike never excludes; the AI label shows only when Jev actually ranked.
- **Cloud rules:** each thread runs lint, `tsc --noEmit` and its targeted vitest specs, opens a draft PR early, has a reviewer subagent check the diff before ready, and says in the PR that Sol did not review it.

## 10. Order and merge order

| # | Workstream | Gate |
|---|---|---|
| 1 | W0 | CI green, reviewer check; auto-merge |
| 2 | W1 | first of the build threads; auto-merge |
| 3 | W4, W5, W6 (any order) | auto-merge |
| 4 | W2 | auto-merge |
| 5 | W3 | after W2; Mac applies 20270107090000/090100, then merges |
| 6 | W7 | Mac applies 20270107090200/090300, then merges |
| 7 | W8 | after W7; bundle and CSP checked; auto-merge |
| 8 | Close-out | after all |

All eight build threads can start the moment W0 merges; the order above is only the merge order.
