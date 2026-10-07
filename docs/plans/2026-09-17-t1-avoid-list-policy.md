# T1 — Her Avoid list reaches the policy; the category switches are true — 2026-09-17

Program: `docs/plans/2026-09-17-fab-coach-program.md` (T1). Size M. No Gemini needed.
Coder: Opus 5. Panel holds AC1–AC11 outside the repo. Adversary: Grok 4.6.

## Why

Marking a food Avoid on the phone removes it from her plan and nothing else. The coach, food
search, the label scanner and the log commit run `evaluatePolicy` against the server profile,
which has never heard of her list: `setFoodStatus` writes localStorage and the legacy `foods`
map, no client emits the `user_food_prefs` op the server already accepts, and the policy has no
avoid branch at all — every caller collapses `"avoid"` to `false`. On top of that the five
"Off the plan" switches on Foods › Avoids read as enforced when four were never switched on and
`simple_sugars` cannot fire on a USDA row because the catalog carries USDA's own category text.

After T1: one Avoid mark on the phone is honoured everywhere within one sync, and a category
switch blocks the USDA foods it names.

## Facts the design rests on (recon 2026-09-17, file:line in the program doc)

- `user_food_prefs (user_id, food_ref_id) → status eats|avoid, role, no_cook, note, rev` exists;
  RLS on; the op-log entity, `encodeKey` (`entity_id = food_ref_id`), `merge.ts` field-wise
  newer-wins with `joinNotes`, and the `_sync_upsert` branch all exist. Only client emission is
  missing. Template: `lib/favorites-client.ts:38-68` (`putRow` + `enqueue`).
- `food_refs` is `kind catalog (catalog_food_id)` xor `kind user (user_food_id)`. The policy's
  callers read `prefStatus` through the **catalog** ref of a search hit
  (`lib/server/catalog.ts:206-210`). So a pref on her *user* ref alone never reaches a catalog
  hit — the pref must also sit on the catalog ref when her food is mapped.
- The 2026-09-11 legacy backfill minted `user_foods` rows (kind `custom`, fresh uuids, joined
  back to her phone only by `name`) and `scripts/apply-food-mapping.ts` set `catalog_food_id` on
  48 of 53 from the reviewed sheet. `lib/foods/adopt-client.ts` shows the client-side
  `user_foods` upsert + `get_or_create_food_ref` pattern.
- `catalog_food_revisions.category text` holds the USDA category (SR Legacy / Foundation group
  names, FNDDS WWEIA names, OFF categories for barcode imports). `lib/catalog/off-map.ts`
  already derives `banned_categories` for OFF imports.
- `constraint_profiles` default `banned_categories = '{simple_sugars}'`; no row exists until the
  Avoids tab saves one; `getProfile` returns `rev 0` + `DEFAULT_PROFILE` for "no row".
- Ruling 2026-09-14: logging marks, never refuses — the commit path flags a blocked item and
  records it.

## Design

### 1. Client: every pref change becomes a `user_food_prefs` op — `lib/foods/prefs-client.ts` (new)

```ts
export async function syncFoodPref(food: Food, opts?: { fetchImpl?, supabase? }): Promise<void>
export async function backfillFoodPrefs(foods: Record<string, Food>): Promise<{ synced: number; skipped: number }>
```

`syncFoodPref(food)`:
1. Resolve her `user_foods` row: look up by `(user_id, name, kind in ('custom','label_scan'), deleted_at is null)`
   (this is how the backfill rows join back). None → insert one with a deterministic uuid v5 of
   `food.id` (the legacy slug), `kind: "custom"`, `per_100g` from `perUnit` via
   `gramsPerUnit(name, unit)` (`lib/units.ts:127`; unresolvable unit → `per_100g: {}` and a
   note in the result, never a throw), `allergen_tags: []`.
2. `get_or_create_food_ref(kind: "user", user_food_id)` → `userRefId`.
3. If the row has `catalog_food_id`, also `get_or_create_food_ref(kind: "catalog", catalog_food_id)` → `catalogRefId`.
4. For each ref id: `putRow("user_food_prefs", refId, …)` and `enqueue({ entity: "user_food_prefs",
   entity_id: refId, kind: create|update, base_rev, payload: { food_ref_id: refId, status, role,
   no_cook: !!food.noCook, note: food.note ?? null } })` — the favorites pattern.
5. Cache `{ [food.id]: { userRefId, catalogRefId?, syncedAt, status, note } }` in localStorage
   `meal-companion:food-pref-refs` so a repeat call with the same status+note is a no-op.

Callers: every mutation site in `components/MyFoods.tsx` (`onSetStatus`, `onSetNote`, `onAdd` on
both tabs) and `components/AddFoodSheet.tsx`'s re-add path — `void syncFoodPref(next)` after the
local write. `lib/store.ts` stays synchronous and pure.

`backfillFoodPrefs(store.foods)` runs once per device on the Foods tab mount and once from
`SyncBootstrap` after the first successful sync: every food without a cache entry goes through
`syncFoodPref`, serialised, at most 20 per run (the rest next time). Offline: the RPC calls fail
→ the food stays uncached and is retried next run; the op-log itself queues normally once a ref
id is known.

### 2. Server: the policy gains the avoid branch — `lib/policy/constraints.ts`

```ts
export type PolicyEvidence = { …; onEatsList: boolean; onAvoidList: boolean };
// order: allergen → avoid_food_ref_ids → onAvoidList → category → unverified → allowed
if (e.onAvoidList) return { verdict: "blocked", reason: "avoid_list" };
```

`reason: "avoid_list"` already exists and `policyCopy` already prints "On your avoid list".
Every builder of `PolicyEvidence` passes `onAvoidList: prefStatus === "avoid"`:
`lib/server/catalog.ts` (both), `lib/server/barcode.ts` (`onEatsList` helper becomes
`prefStatusFor(...)` returning the status), `lib/server/capture.ts`, `lib/server/coach.ts`,
`lib/coach/actions.ts`, `lib/coach/policy.ts`, `lib/server/log.ts` (the commit path reads the
pref for each item's `food_ref_id` and, per the 2026-09-14 ruling, an avoid-listed item is
**flagged** in the response and recorded — never refused).

### 3. Categories: the mapping — `lib/catalog/category-map.ts` (new) + `docs/catalog/category-map.md`

Pure function `policyCategoriesFor(revision: { category: string | null; description: string; source: string }): string[]`
returning zero or more of the five keys. Rules are data, not prose: a table of
`(source pattern, USDA/OFF category pattern, description pattern) → key`, e.g.

| key | matches |
|---|---|
| `raw_cruciferous` | a cruciferous vegetable (broccoli, cauliflower, cabbage, kale, brussels, bok choy, arugula, radish, collard, kohlrabi, turnip greens, watercress, cress) eaten raw: description has "raw", or the row is a Foundation / SR whole-food row with no cooking word. Never "cooked", "boiled", "steamed", "roasted", "frozen", "pickled", "fermented", "dried"; prepared horseradish is a condiment, 0 |
| `raw_leafy_greens` | a leafy green (lettuce, romaine, iceberg, spinach, chard, endive, escarole, mesclun, mixed / salad greens, beet greens, dandelion greens, cress, watercress) eaten raw, same raw rule and the same cooking-word exclusions; a salad of raw greens is 1; a sandwich or taco that merely contains lettuce is 0; dips, dressings, spinach pasta, seaweed are 0 |
| `onion_garlic` | the allium itself (onion, garlic, shallot, leek, scallion, chive), raw, cooked or dried, and a dish named after it (onion rings, garlic bread, onion dip, French onion soup, garlic sauce); 0 for onion or garlic powder and for any "flavor" / "flavored" name on a snack or branded product — ingredient text is T3's job |
| `beans` | pulses: dried, canned, cooked or baked beans, lentils, chickpeas, garbanzo, split peas, and a dish whose name carries them; 0 for green / snap / string / wax beans, green peas, snow and snap peas, immature-seed rows, bean sprouts, and look-alikes (coffee, cocoa, vanilla, jelly beans); tofu and hummus excluded (coach's call) |
| `simple_sugars` | the sweetener or the sweet spread itself: honey, syrup, sugar, agave, molasses, jam, jelly, marmalade, preserves — matched on the description; the USDA / OFF category is used only to exclude, never required (FNDDS jams and syrups carry no "Sweets" category). 0 for confectionery and baked goods that merely contain them (candy, chews, nougat, cookies, honey buns, jelly doughnuts), fruit named after them (honeycrisp, honeydew, nectarine), nectars and sweetened drinks, honey-mustard dressings, peanut butter, and anything "no sugar" or "sugar-free" |

The table above is the contract; the panel's README ground truth states the same rules and its
labelled sample is scored against them (amended 2026-09-17 after the Grok suite review found the
first draft of this table and the panel's labels disagreed on candy, green beans and FNDDS jams).

The coder produces the rule table; the **panel** owns the labelled sample (100 rows per key,
hand-labelled from the live catalog) and measures precision and recall. Precision is the gate;
recall is reported. Any rule change goes back through the sample.

A migration adds `policy_categories text[] not null default '{}'` to `catalog_food_revisions`,
a script `scripts/annotate-policy-categories.ts` fills it for every active revision (idempotent,
prints counts per key and a 30-row sample per key into the proof folder), and the policy's
`category` evidence becomes the array (`evaluatePolicy` blocks when any element is banned).
Callers that today pass `hit.category ?? null` pass `hit.policy_categories`. `off-map.ts`'s
derived categories feed the same column on import.

### 4. Profile: the five switches are on

Migration: `alter table constraint_profiles alter column banned_categories set default
'{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}'`, and an `update` that adds
any missing key to every existing row. `DEFAULT_PROFILE` in `lib/policy/constraints.ts` matches.
The Avoids tab then shows five checks; a switch off is still hers to flip.

Applying the migration to production is a step Devin says go to (`python3 scripts/apply-migrations.py`
dry run, then `--commit`); the two pending migrations from loop010 go in the same run (T8 shares it).

### 5. Out of scope

Ruling 2 (barcode-scanned versions invisible to search) — T3. Coach memory/context — T6.
Deleting a pref row (never; a pref is a status with a note, F-021). Multi-user backfill beyond
her account (each device backfills its own store).

## Acceptance criteria (the panel's, hidden from the coder)

- **AC1** Mark a food Avoid on the phone (an existing backfilled food, e.g. "Onion") → after one
  sync, `user_food_prefs` has `status = 'avoid'` on her user ref, and on the catalog ref when
  `user_foods.catalog_food_id` is set. Note text preserved.
- **AC2** Mark it Eats again → `status = 'eats'`, same note (F-021). The op carries `base_rev`.
- **AC3** A device with 53 foods and an empty ref cache → after the Foods tab mounts twice (20 +
  20 + 13), 53 pref rows exist; a third mount is a no-op (zero RPC calls).
- **AC4** `evaluatePolicy`: `onAvoidList: true` → `blocked`, reason `avoid_list`; precedence
  allergen > avoid_food_ref_ids > onAvoidList > category; `onAvoidList` never turns
  `unverified` into `allowed`.
- **AC5** `GET /api/foods/search?q=onion` for her user → the avoided catalog food's hit carries
  `policy.verdict = "blocked"` and the UI badge reads "On your avoid list".
- **AC6** Coach: `search_foods("onion")` evidence blocks it; a reply naming it renders the
  blocked card with reason; a `log_meal` action containing it applies with the item **flagged**,
  not refused (ruling 2026-09-14).
- **AC7** Barcode: a scanned product whose catalog ref she avoids → `ScanConfirmSheet` shows the
  flag; Log still works.
- **AC8** Category mapping: precision ≥ 95 % on the panel's 100-row labelled sample for each of
  the five keys; recall reported; counts per key and the 30-row samples are in the proof folder.
- **AC9** After the migration: her profile row has all five keys; a fresh user's default has all
  five; Foods › Avoids shows five checks; switching one off removes it and the policy stops
  blocking that key on the next request.
- **AC10** Offline: mark Avoid in airplane mode → the pref op is in the outbox (or the food is
  uncached and retried) → reconnect → AC1 holds within one drain.
- **AC11** `pnpm test` once green; tsc, lint, design lint clean; `docs/features.md` F-057 → exists
  with this PR, F-076/F-077 amended; `AGENTS.md` row for `lib/foods/prefs-client.ts`;
  `docs/catalog/category-map.md` written.

## Proof folder — `~/Desktop/proof/t1-avoid-list-policy/`

`acceptance-criteria.md`, `AC1..AC11.txt`, phone screenshots (Avoid mark, search badge, coach
blocked card, scanner flag, five checks), `category-samples/*.csv`, `grok-review.md`,
`production-evidence.md` (migration dry-run + commit output, PR, sha, live check).
