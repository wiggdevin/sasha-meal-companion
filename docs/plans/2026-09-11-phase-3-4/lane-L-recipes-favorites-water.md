# Lane L — Recipes, favorites, water (Phase 3): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A saved recipe, a starred food and a cup of water each become a first-class synced entity. Saving a recipe freezes its nutrients into a new immutable revision and mints a loggable `user_foods(kind='recipe')` twin, so one serving logs through the unchanged Phase 2 commit path. Favorites survive a set-union merge across two offline devices; water settles on the larger cup count on both devices and on the server; the daily goal lives on `user_settings`. Foods gains a favorites strip and a route to Recipes; Today gains a water card at integration.

**Architecture:** Three migrations. `…090000` adds the sync bookkeeping columns Phase 0's tables lack (`rev`, `updated_at`, `deleted_at`). `…090200` adds `user_settings.water_goal_cups`. `…090300` replaces the five Phase 0/2 sync functions (`create or replace`, same signatures) so `apply_sync_op` accepts four new entities — `recipes`, `favorites_foods`, `favorites_recipes`, `favorites_meals` — and so `water_log` takes the server-side max. Every recipe write computes `nutrients_per_serving` in SQL from `compute_item_snapshot(food_ref_id, grams)` per item, so the server value wins over the client's provisional one. The client half is four pure engines (`lib/recipes/nutrients.ts`, `lib/water.ts`, `lib/favorites.ts`, plus the sync additions), three thin clients that write IndexedDB first and enqueue an op, four screens, and three export kinds.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4 (DESIGN.md tokens only), pnpm 11, Node 22, vitest 5 (node environment), Supabase Postgres 17, `zod` 4, `idb` 8, `motion` 13. No new npm dependencies.

**Specs:** `docs/specs/phase-3-fast-capture.md` (Data changes, API changes, Client changes, Engines and logic, Test plan, AC 7–12). Contracts: `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §1 row L and §3, over `docs/plans/2026-09-10-phase-0/00-contracts.md` §2–§8 and `docs/plans/2026-09-11-phase-1-2/00-contracts.md` §2–§5. Architecture: `docs/architecture.md` §3.2, §3.3, §3.7, §4.6, §5.

**Pre-lane dependency:** `lib/capture/types.ts`, `lib/capture/flags.ts` and `lib/policy/constraints.ts` are not on this checkout yet (verified 2026-09-11) — this lane imports none of them, so nothing here is blocked; no task below references a pre-lane file.

## Global Constraints
Phase 0 §8 and Phase 1–2 §8a (TDD, conventional commits, no AI attribution, request-local clients, `user_id` from `auth.uid()`, rate-limit → identity → body order, files < 400 lines, `null` ≠ `0`) plus: no new npm dependencies beyond the pre-lane `zxing-wasm`; provider and model text is data, never instruction; no draft reaches `log_entries` without her tap; the only request-path writer of `catalog_*` is `lib/server/catalog-writer.ts`; every prompt is temperature 0 with a per-purpose `maxOutputTokens`; gates are measured and reported, never lowered.

**Lane-local additions.** `@testing-library/react` is not installed and no dependency may be added: components are proved by `renderToStaticMarkup` from `react-dom/server` (the pattern `components/AuthGate.test.tsx` already uses) plus pure view-model helpers; interaction is a manual phone gate. Nobody on this branch edits `app/page.tsx`, `components/QuickActions.tsx` or `components/LogFoodSheet.tsx` — their mounts are the hand-off diff at the end of this file. Sync payloads are snake_case on the wire; the TypeScript engine types are camelCase exactly as the spec writes them.

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260919090000_phase3_recipes_favorites.sql` | ALTERs only: `rev`/`updated_at`/`deleted_at` on the favorites tables, `updated_at` on `recipes` |
| `supabase/migrations/down/20260919090000_phase3_recipes_favorites.down.sql` | Drops exactly those columns |
| `supabase/migrations/20260919090200_phase3_water_goal.sql` | `user_settings.water_goal_cups integer not null default 8 check (1..30)` |
| `supabase/migrations/down/20260919090200_phase3_water_goal.down.sql` | Drops that column |
| `supabase/migrations/20260919090300_phase3_sync_entities.sql` | `create or replace` of `_sync_assert_key`, `_sync_current`, `_sync_tombstone`, `_sync_upsert`, `apply_sync_op` with the four new entities, the recipe nutrient computation, and `water_log`'s `greatest()` |
| `supabase/migrations/down/20260919090300_phase3_sync_entities.down.sql` | Restores the Phase 0 `_sync_assert_key` gate and the Phase 2 `_sync_upsert` |
| `lib/sync/types.ts` | `Entity` union + `ENTITIES` gain the four entities (`SyncOpSchema` follows `ENTITIES`, unchanged) |
| `lib/sync/keys.ts` | The four `entity_key` shapes: `recipes`/`favorites_meals` → `id`, `favorites_foods` → `food_ref_id`, `favorites_recipes` → `recipe_id` |
| `lib/sync/idb.ts` | `DB_VERSION = 3` only; the upgrade loop over `ENTITIES` creates the four stores |
| `lib/sync/merge.ts` | `recipes` returns the local payload unchanged (immutable revisions); favorites keep field-wise newer-wins |
| `lib/recipes/nutrients.ts` | `recipeInputGrams`, `servingGrams`, `computeRecipeNutrients` — per-serving maths, null ≠ 0, coverage |
| `lib/water.ts` | `CUP_ML`, `mergeCups`, `waterProgress`, `clampGoal` |
| `lib/favorites.ts` | `nextSort`, `mergeFavorites` (set union, newer `sort`), `pinnedAndRest`, `FavoriteRow` |
| `lib/recipes-client.ts` | `saveRecipe`, `listRecipes`, `provisionalNutrients`, `recipeFoodRefId` |
| `lib/favorites-client.ts` | `toggleFavorite`, `listFavorites` |
| `lib/water-client.ts` | `getWater`, `addCups`, `setGoal` |
| `components/WaterCard.tsx` | Cups against `water_goal_cups`, ± steppers ≥ 44 px, goal editable inline |
| `components/FavoritesStrip.tsx` | Horizontal row, 12 pinned then "All", `onPick` or a link fallback |
| `components/RecipeItemRow.tsx` | One recipe item: name, grams `Stepper`, remove |
| `components/RecipeSheet.tsx` | Name, servings, yield grams, `CatalogSearch` picker, live per-serving strip, "Saving creates version N+1", Save |
| `app/recipes/page.tsx` | Recipe list + open `RecipeSheet` |
| `app/foods/page.tsx` | Mounts `FavoritesStrip` above `MyFoods` and the "Recipes" pill |
| `lib/server/export.ts` | `streamRecipes`, `streamFavorites`, `streamWater` + their column lists and row mappers |
| `app/api/export/route.ts` | `recipes\|favorites\|water` move from the buffered `SOURCES` map to the streamed path |
| `tests/recipes/**`, `tests/favorites/**`, `tests/water/**` | Engine, client and component tests |
| `tests/sync/phase3-entities.test.ts`, `tests/sync/phase3-cross-user.test.ts` | Branch suites for the SQL |
| `tests/export/phase3-kinds.test.ts` | Export column and row tests |

---

## Task 1 — Sync bookkeeping columns on the Phase 0 recipe and favorites tables

**Files**
- Create: `supabase/migrations/20260919090000_phase3_recipes_favorites.sql`
- Create: `supabase/migrations/down/20260919090000_phase3_recipes_favorites.down.sql`
- Test: `tests/sync/phase3-entities.test.ts`

**Interfaces**
- Consumes: `recipes(id, user_id, name, rev, servings, yield_grams, deleted_at)`, `favorites_foods(user_id, food_ref_id, sort)`, `favorites_recipes(user_id, recipe_id, sort)`, `favorites_meals(id, user_id, name, rev, sort)` — all from `supabase/migrations/20260911000200_user_schema.sql`; RLS from `…000500_rls.sql`; `HAS_BRANCH`, `adminClient()`, `ensureUser`, `resetUser`, `userClient` from `tests/helpers/supabase.ts`.
- Produces: `favorites_foods.rev/created_at/updated_at/deleted_at`, `favorites_recipes.rev/created_at/updated_at/deleted_at`, `favorites_meals.created_at/updated_at/deleted_at`, `recipes.updated_at`.

`created_at` on the three favorites tables is a genuine widening beyond contracts §3's "only adds: rev, updated_at, deleted_at" enumeration, landed as its own contract-change commit below — see the resolved Open question 3. Without it, `added_at` in the Task 17 export has no honest source: `updated_at` moves every time a favorite is re-sorted, so re-ordering the Foods strip would silently rewrite "date added" for the row that moved.

**Steps**

- [ ] Commit the contract change first, in `00-contracts.md` §3, widening the migration's own enumeration:
```
`20260919090000_phase3_recipes_favorites.sql` also adds `created_at timestamptz not null default now()`
to `favorites_foods`, `favorites_recipes` and `favorites_meals` — populated once at insert, never
written again by `_sync_upsert`'s `on conflict … do update`, so it is the row's real "date added" and
is what the `favorites` export's `added_at` column reads (not `updated_at`, which a re-sort changes).
```
  **Already landed in `00-contracts.md` (2026-09-11)** — read the contract section and confirm it says this; do not commit a contract change (docs: phase-3-4 contract change — favorites gain a real created_at)
- [ ] Write the failing test `tests/sync/phase3-entities.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, adminClient } from "../helpers/supabase";

describe.skipIf(!HAS_BRANCH)("phase 3 sync bookkeeping columns", () => {
  beforeAll(() => { /* migrations are applied by `pnpm db:push` before this suite runs */ });

  it("gives every favorites table rev, created_at, updated_at and deleted_at", async () => {
    const admin = adminClient();
    for (const table of ["favorites_foods", "favorites_recipes"]) {
      const { error } = await admin.from(table)
        .select("rev, created_at, updated_at, deleted_at").limit(1);
      expect([table, error]).toEqual([table, null]);
    }
    const meals = await admin.from("favorites_meals")
      .select("rev, created_at, updated_at, deleted_at").limit(1);
    expect(meals.error).toBeNull();
  });

  it("gives recipes an updated_at", async () => {
    const { error } = await adminClient().from("recipes").select("updated_at").limit(1);
    expect(error).toBeNull();
  });
});
```
- [ ] Run it **[needs branch]** (skip condition: `SUPABASE_TEST_URL` unset): `pnpm test:integration tests/sync/phase3-entities.test.ts` → FAILS with `column favorites_foods.rev does not exist`.
- [ ] Write `supabase/migrations/20260919090000_phase3_recipes_favorites.sql`:
```sql
-- Phase 3, contracts §3 "Reconciled data changes". Phase 0 (20260911000200_user_schema.sql)
-- already created recipes, recipe_revisions, recipe_items, favorites_foods, favorites_recipes,
-- favorites_meals and favorites_meal_items, and 20260911000500_rls.sql already enabled their
-- RLS with the §2.1 policy pairs. This migration adds only what the sync envelope needs.
--
-- deleted_at on the favorites tables is what keeps "deletes dominate" (architecture §3.7) true
-- under a set-union merge: without a tombstone, a favorite she removed on the phone is
-- resurrected by the laptop's copy on the next pull.
--
-- created_at is a real "date added": set once at insert, and _sync_upsert's on-conflict clause
-- never assigns it, so re-sorting a favorite (which does touch updated_at) leaves it alone.

alter table favorites_foods
  add column rev integer not null default 1,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;

alter table favorites_recipes
  add column rev integer not null default 1,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;

-- favorites_meals already carries rev (Phase 0); it lacks the stamps and the tombstone.
alter table favorites_meals
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;

-- recipes already carries rev and deleted_at; serverTimestampOf (lib/sync/outbox.ts) reads
-- updated_at first, so a conflict on a recipe compares real stamps instead of falling back to now.
alter table recipes
  add column updated_at timestamptz not null default now();
```
- [ ] Write `supabase/migrations/down/20260919090000_phase3_recipes_favorites.down.sql`:
```sql
-- Drops only what 20260919090000 created.
alter table recipes drop column updated_at;
alter table favorites_meals drop column deleted_at, drop column updated_at, drop column created_at;
alter table favorites_recipes drop column deleted_at, drop column updated_at, drop column created_at, drop column rev;
alter table favorites_foods drop column deleted_at, drop column updated_at, drop column created_at, drop column rev;
```
- [ ] Apply and run **[needs branch]**: `pnpm db:push && pnpm test:integration tests/sync/phase3-entities.test.ts` → PASSES (2 tests).
- [ ] Commit: `git add supabase/migrations tests/sync && git commit -m "feat: add sync bookkeeping columns to recipes and favorites"`

---

## Task 2 — `user_settings.water_goal_cups`

**Files**
- Create: `supabase/migrations/20260919090200_phase3_water_goal.sql`
- Create: `supabase/migrations/down/20260919090200_phase3_water_goal.down.sql`
- Test: `tests/sync/phase3-entities.test.ts` (extend)

**Interfaces**
- Consumes: `user_settings(user_id, first_opened_at, …, rev)` from `20260911000200_user_schema.sql`.
- Produces: `user_settings.water_goal_cups integer not null default 8 check (water_goal_cups between 1 and 30)`.

**Steps**

- [ ] Add the failing test to `tests/sync/phase3-entities.test.ts`:
```ts
  it("gives user_settings a water goal that defaults to 8 and refuses 0 or 31", async () => {
    const admin = adminClient();
    const user = await ensureUser("a");
    await resetUser(user.id);
    const created = await admin.from("user_settings")
      .insert({ user_id: user.id, first_opened_at: new Date().toISOString() })
      .select("water_goal_cups").single();
    expect(created.data?.water_goal_cups).toBe(8);
    const tooLow = await admin.from("user_settings")
      .update({ water_goal_cups: 0 }).eq("user_id", user.id);
    expect(tooLow.error).not.toBeNull();
    const tooHigh = await admin.from("user_settings")
      .update({ water_goal_cups: 31 }).eq("user_id", user.id);
    expect(tooHigh.error).not.toBeNull();
  });
```
  (add `ensureUser, resetUser` to the import from `../helpers/supabase`.)
- [ ] Run **[needs branch]**: `pnpm test:integration tests/sync/phase3-entities.test.ts` → FAILS with `column user_settings.water_goal_cups does not exist`.
- [ ] Write `supabase/migrations/20260919090200_phase3_water_goal.sql`:
```sql
-- Phase 3 spec open question 3, reconciled by contracts §3: the spec's `user_prefs` table is not
-- created. Phase 0 already owns a per-user settings row, and one integer does not earn a table,
-- a policy pair, an entity_key shape and a merge rule of its own.
alter table user_settings
  add column water_goal_cups integer not null default 8
    check (water_goal_cups between 1 and 30);
```
- [ ] Write `supabase/migrations/down/20260919090200_phase3_water_goal.down.sql`:
```sql
-- Run the downs in reverse timestamp order. 20260919090300's _sync_upsert names this column, so
-- down/20260919090300_phase3_sync_entities.down.sql (which restores the Phase 2 _sync_upsert)
-- must run before this file, or every user_settings op breaks.
alter table user_settings drop column water_goal_cups;
```
- [ ] Apply and run **[needs branch]**: `pnpm db:push && pnpm test:integration tests/sync/phase3-entities.test.ts` → PASSES (3 tests).
- [ ] Commit: `git add supabase/migrations tests/sync && git commit -m "feat: add water_goal_cups to user_settings"`

---

## Task 3 — Four synced entities in the sync wire types and key encoder

**Files**
- Modify: `lib/sync/types.ts` (line 6 `export type Entity =`; line 10 `export const ENTITIES`)
- Modify: `lib/sync/keys.ts` (line 7 `const ID_KEYED`; line 26 `encodeKey`; line 34 `decodeKey`)
- Test: `lib/sync/keys.test.ts` (extend)

**Interfaces**
- Consumes: `Entity`, `ENTITIES`, `SyncOpSchema` (`z.enum(ENTITIES)` — it follows `ENTITIES`, so it needs no edit), `encodeKey`, `decodeKey`.
- Produces:
```ts
export type Entity = … | "recipes" | "favorites_foods" | "favorites_recipes" | "favorites_meals";
export const ENTITIES = [ …existing, "recipes", "favorites_foods", "favorites_recipes",
  "favorites_meals" ] as const satisfies readonly Entity[];
// encodeKey("recipes", { id }) -> lowercase uuid; encodeKey("favorites_meals", { id }) -> lowercase uuid
// encodeKey("favorites_foods", { food_ref_id }) -> lowercase uuid
// encodeKey("favorites_recipes", { recipe_id }) -> lowercase uuid
```

**Steps**

- [ ] Add the failing test to `lib/sync/keys.test.ts`:
```ts
describe("phase 3 entity keys", () => {
  it("keys recipes and favorites_meals by their own id", () => {
    expect(encodeKey("recipes", { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }))
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(encodeKey("favorites_meals", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("keys favorites_foods by food_ref_id and favorites_recipes by recipe_id", () => {
    expect(encodeKey("favorites_foods", { food_ref_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }))
      .toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(encodeKey("favorites_recipes", { recipe_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }))
      .toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("decodes each key back to its own column", () => {
    expect(decodeKey("recipes", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .toEqual({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(decodeKey("favorites_foods", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
      .toEqual({ food_ref_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(decodeKey("favorites_recipes", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
      .toEqual({ recipe_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
  });

  it("refuses a favorites_recipes row with no recipe_id", () => {
    expect(() => encodeKey("favorites_recipes", { id: "nope" })).toThrow(TypeError);
  });
});
```
- [ ] Run: `pnpm test lib/sync/keys.test.ts` → FAILS (`"recipes"` is not assignable to `Entity`; `encodeKey` throws "not a synced entity").
- [ ] Edit `lib/sync/types.ts`:
```ts
export type Entity =
  | "user_foods" | "user_food_prefs" | "log_entries" | "log_items"
  | "water_log" | "plan_days" | "user_settings" | "gut_log" | "duplicate_groups"
  | "recipes" | "favorites_foods" | "favorites_recipes" | "favorites_meals";

/** The entities that sync on their own. `log_items` ride inside `log_entries.payload.items[]`;
 *  `recipe_items` and `favorites_meal_items` ride the same way inside their parent's payload. */
export const ENTITIES = [
  "user_foods", "user_food_prefs", "log_entries", "water_log",
  "plan_days", "user_settings", "gut_log", "duplicate_groups",
  "recipes", "favorites_foods", "favorites_recipes", "favorites_meals",
] as const satisfies readonly Entity[];
```
- [ ] Edit `lib/sync/keys.ts` — the key-set declarations and the two functions:
```ts
const ID_KEYED = new Set<Entity>(["user_foods", "log_entries", "gut_log", "duplicate_groups",
  "recipes", "favorites_meals"]);
const DATE_KEYED = new Set<Entity>(["plan_days", "water_log"]);
/** Registry-UUID keyed: the row's tenant is (user_id, food_ref_id), and food_ref_id is unique
 *  across catalog and user foods (architecture §3.2), so it is the key on its own. */
const REF_KEYED = new Set<Entity>(["user_food_prefs", "favorites_foods"]);
```
```ts
export function encodeKey(entity: Entity, row: Record<string, unknown>): string {
  if (ID_KEYED.has(entity)) return uuid(entity, "id", row.id);
  if (DATE_KEYED.has(entity)) return localDate(entity, row.local_date);
  if (entity === "user_settings") return "settings";
  if (REF_KEYED.has(entity)) return uuid(entity, "food_ref_id", row.food_ref_id);
  if (entity === "favorites_recipes") return uuid(entity, "recipe_id", row.recipe_id);
  throw new TypeError(`${entity}: not a synced entity — it has no entity_key of its own`);
}

export function decodeKey(entity: Entity, key: string): Record<string, unknown> {
  if (ID_KEYED.has(entity)) return { id: uuid(entity, "id", key) };
  if (DATE_KEYED.has(entity)) return { local_date: localDate(entity, key) };
  if (entity === "user_settings") {
    if (key !== "settings") fail(entity, "entity_key", key);
    return {}; // the PK is user_id, which the client never supplies (contracts §8)
  }
  if (REF_KEYED.has(entity)) return { food_ref_id: uuid(entity, "food_ref_id", key) };
  if (entity === "favorites_recipes") return { recipe_id: uuid(entity, "recipe_id", key) };
  throw new TypeError(`${entity}: not a synced entity — it has no entity_key of its own`);
}
```
- [ ] Run: `pnpm test lib/sync/keys.test.ts` → PASSES.
- [ ] Commit: `git add lib/sync/types.ts lib/sync/keys.ts lib/sync/keys.test.ts && git commit -m "feat: register recipes, favorites_foods, favorites_recipes and favorites_meals as synced entities"`

---

## Task 4 — IndexedDB v3

**Files**
- Modify: `lib/sync/idb.ts` (line 13 `export const DB_VERSION = 2;`)
- Test: `lib/sync/idb.test.ts` (extend)

**Interfaces**
- Consumes: `ENTITIES` (Task 3), `openSmcDb`, `DB_VERSION`, `CATALOG_STORE`.
- Produces: `export const DB_VERSION = 3;` — the existing `upgrade` loop over `ENTITIES` creates `recipes`, `favorites_foods`, `favorites_recipes` and `favorites_meals`; nothing else changes.

**Steps**

- [ ] Add the failing test to `lib/sync/idb.test.ts`:
```ts
  it("is version 3 and carries a store for each of the four phase 3 entities", async () => {
    const db = await openSmcDb();
    expect(db.version).toBe(3);
    for (const store of ["recipes", "favorites_foods", "favorites_recipes", "favorites_meals"]) {
      expect(db.objectStoreNames.contains(store)).toBe(true);
    }
    expect(db.objectStoreNames.contains(CATALOG_STORE)).toBe(true);
  });
```
  (add `CATALOG_STORE` to the import from `./idb`.)
- [ ] Run: `pnpm test lib/sync/idb.test.ts` → FAILS (`expected 2 to be 3`).
- [ ] Edit `lib/sync/idb.ts`:
```ts
/** v3 (Phase 3): the upgrade loop over ENTITIES adds the recipes and three favorites stores.
 *  A phone that skips a version still runs the whole loop, so v1 → v3 is one upgrade. */
export const DB_VERSION = 3;
```
- [ ] Run: `pnpm test lib/sync/idb.test.ts` → PASSES.
- [ ] Commit: `git add lib/sync/idb.ts lib/sync/idb.test.ts && git commit -m "feat: bump the client store to v3 for the phase 3 entities"`

---

## Task 5 — Merge rules for recipes and favorites

**Files**
- Modify: `lib/sync/merge.ts` (line 89 `export function mergeEntity`)
- Test: `lib/sync/merge.test.ts` (extend)

**Interfaces**
- Consumes: `newerWinsFields(local, server, localTs, serverTs)`, `settle(merged, local, server)`, `Row<E>`, `NEVER_MERGED`, `MergeRefusedError`.
- Produces: `mergeEntity("recipes", local, server, localTs, serverTs)` → the local payload, with the server's `rev` and either side's tombstone; `mergeEntity("favorites_*", …)` → field-wise newer-wins (unchanged path, now asserted).

**Steps**

- [ ] Add the failing test to `lib/sync/merge.test.ts`:
```ts
describe("mergeEntity on phase 3 entities", () => {
  const local = { id: "r1", name: "Rice tray v2", servings: 4,
    items: [{ seq: 1, food_ref_id: "f1", grams: 400 }] };
  const server = { id: "r1", name: "Rice tray", servings: 3, rev: 7,
    items: [{ seq: 1, food_ref_id: "f1", grams: 300 }] };

  it("never field-merges a recipe: the local payload wins whole, on the server's rev", () => {
    const merged = mergeEntity("recipes", local, server,
      "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect(merged.name).toBe("Rice tray v2");
    expect(merged.servings).toBe(4);
    expect(merged.items).toEqual(local.items);
    expect(merged.rev).toBe(7);
  });

  it("keeps a recipe tombstone from either side", () => {
    const merged = mergeEntity("recipes", local, { ...server, deleted_at: "2026-09-19T09:00:00.000Z" },
      "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect(merged.deleted_at).toBe("2026-09-19T09:00:00.000Z");
  });

  it("settles a favorite's sort on the newer client_ts", () => {
    const mine = { food_ref_id: "f1", sort: 9 };
    const theirs = { food_ref_id: "f1", sort: 2, rev: 3 };
    const newer = mergeEntity("favorites_foods", mine, theirs,
      "2026-09-19T12:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect([newer.sort, newer.rev]).toEqual([9, 3]);
    const older = mergeEntity("favorites_foods", mine, theirs,
      "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect(older.sort).toBe(2);
  });
});
```
- [ ] Run: `pnpm test lib/sync/merge.test.ts` → FAILS (`expected 'Rice tray' to be 'Rice tray v2'` — `newerWinsFields` gave the server the field because its stamp is newer).
- [ ] Edit `lib/sync/merge.ts` — insert the recipes branch at the top of `mergeEntity`, before `newerWinsFields` runs:
```ts
export function mergeEntity<E extends Entity>(
  entity: E, local: Row<E>, server: Row<E>, localTs: string, serverTs: string,
): Row<E> {
  if (NEVER_MERGED.has(entity)) throw new MergeRefusedError(entity);

  // architecture §3.7: recipes are immutable revisions. A conflict creates a new rev on top of
  // current_rev with NO field merge — half of her edit and half of the laptop's would be a
  // recipe neither device ever meant. rebaseOp (below) re-aims this payload at current_rev, and
  // the server writes it as a whole new recipe_revisions row, so the old revision — and every
  // log_items snapshot taken from it — stays byte-identical.
  if (entity === "recipes") return settle({ ...local }, local, server) as Row<E>;

  // favorites_*: field-wise newer-wins is the whole per-row rule (`sort` is the only scalar).
  // Set union is a STORE-level rule, not a row-level one — two devices each starring a different
  // food produce two rows that never conflict with each other, so mergeEntity never sees them.
  // lib/favorites.ts mergeFavorites is where the union happens, over the rows of both stores.
  const merged = newerWinsFields(local, server, localTs, serverTs);

  if (entity === "water_log") {
    merged.cups = Math.max(Number(local.cups ?? 0), Number(server.cups ?? 0));
  } else if (entity === "user_food_prefs" || entity === "log_entries" || entity === "gut_log") {
    const note = joinNotes(local.note, server.note, localTs, serverTs);
    if (note === undefined) delete merged.note;
    else merged.note = note;
    if (entity === "log_entries") {
      merged.items = mergeItems(asItems(local.items), asItems(server.items), localTs, serverTs);
    }
  }

  return settle(merged, local, server) as Row<E>;
}
```
- [ ] Run: `pnpm test lib/sync/merge.test.ts` → PASSES.
- [ ] Commit: `git add lib/sync/merge.ts lib/sync/merge.test.ts && git commit -m "feat: never field-merge a recipe on conflict"`

---

## Task 6 — `lib/recipes/nutrients.ts`

**Files**
- Create: `lib/recipes/nutrients.ts`
- Test: `tests/recipes/nutrients.test.ts`

**Interfaces**
- Consumes: `MACRO_CODES`, `NutrientCode` from `lib/nutrients/codes.ts`.
- Produces:
```ts
export type RecipeItemInput = { seq: number; foodRefId: string; qty: number; unit: string;
  grams: number; state: "raw" | "cooked"; foodRevisionId?: number | null };
export type Per100gByRef = Record<string, Record<NutrientCode, number | null>>;
export const TRACKED_MACROS: readonly NutrientCode[];
export function recipeInputGrams(items: RecipeItemInput[]): number;
export function servingGrams(totalGrams: number, servings: number, yieldGrams?: number): number;
export function computeRecipeNutrients(items: RecipeItemInput[], per100g: Per100gByRef,
  servings: number, yieldGrams?: number): { perServing: Record<string, number | null>; coverage: number };
```

**The coverage rule, stated once.** Per nutrient code: sum the items that measured it and ignore the ones that did not — a nutrient is `null` only when **no** item measured it, never `0`. Per-code coverage is *items with a value ÷ all items*, so an item that carries no value for a code (whether the code is absent from its source or present with `amount: null`) pulls that code's coverage down. The single scalar stored as `nutrients_per_serving.coverage` is the **minimum** of that ratio across the five tracked macros (`energy_kcal`, `protein`, `carbohydrate`, `fat_total`, `fiber_total`) — the strictest macro, so a recipe with one unmeasured item never reads as complete (AC 8). `yieldGrams` does not change a per-serving amount: a serving is one `servings`-th of the whole recipe however much water cooked off. It only converts grams into a serving fraction, which is `servingGrams`' job.

**Steps**

- [ ] Write the failing test `tests/recipes/nutrients.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeRecipeNutrients, recipeInputGrams, servingGrams,
  type Per100gByRef, type RecipeItemInput } from "@/lib/recipes/nutrients";

const rice: RecipeItemInput = { seq: 1, foodRefId: "rice", qty: 1, unit: "g", grams: 400, state: "cooked" };
const chicken: RecipeItemInput = { seq: 2, foodRefId: "chx", qty: 1, unit: "g", grams: 200, state: "cooked" };

const per100g = {
  rice: { energy_kcal: 130, protein: 2.7, carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 },
  chx: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: null },
} as unknown as Per100gByRef;

describe("recipeInputGrams and servingGrams", () => {
  it("adds the item grams", () => {
    expect(recipeInputGrams([rice, chicken])).toBe(600);
  });

  it("divides the input weight by the servings when there is no yield", () => {
    expect(servingGrams(600, 4)).toBe(150);
  });

  it("uses the cooked yield when she weighed the tray", () => {
    expect(servingGrams(600, 4, 520)).toBe(130);
  });

  it("refuses zero servings", () => {
    expect(() => servingGrams(600, 0)).toThrow(RangeError);
  });
});

describe("computeRecipeNutrients", () => {
  it("divides the whole-recipe totals by the servings", () => {
    const { perServing } = computeRecipeNutrients([rice, chicken], per100g, 4);
    expect(perServing.energy_kcal).toBe(212.5);   // (520 + 330) / 4
    expect(perServing.protein).toBe(18.2);        // (10.8 + 62) / 4
  });

  it("keeps a per-serving amount identical whether or not she gave a yield weight", () => {
    const withYield = computeRecipeNutrients([rice, chicken], per100g, 4, 520);
    const without = computeRecipeNutrients([rice, chicken], per100g, 4);
    expect(withYield.perServing).toEqual(without.perServing);
  });

  it("sums the measured fiber and never reports the unmeasured item as zero", () => {
    const { perServing, coverage } = computeRecipeNutrients([rice, chicken], per100g, 4);
    expect(perServing.fiber_total).toBe(0.4);     // 1.6 g from the rice alone, over 4 servings
    expect(coverage).toBe(0.5);                   // fiber: 1 item of 2
    expect(coverage).toBeLessThan(1);
  });

  it("reports null, not zero, for a nutrient no item measured", () => {
    const noneMeasured = { rice: { iron: null }, chx: { iron: null } } as unknown as Per100gByRef;
    const { perServing } = computeRecipeNutrients([rice, chicken], noneMeasured, 4);
    expect(perServing.iron).toBeNull();
  });

  it("reports coverage 1 when every item measures every tracked macro", () => {
    const { coverage } = computeRecipeNutrients([rice], per100g, 2);
    expect(coverage).toBe(1);
  });

  it("reports coverage 0 for an empty recipe", () => {
    expect(computeRecipeNutrients([], per100g, 2)).toEqual({ perServing: {}, coverage: 0 });
  });
});
```
- [ ] Run: `pnpm test tests/recipes/nutrients.test.ts` → FAILS (`Cannot find module '@/lib/recipes/nutrients'`).
- [ ] Write `lib/recipes/nutrients.ts`:
```ts
/**
 * Recipe nutrient maths — Phase 3 spec, "Engines and logic". The client half of the SQL in
 * 20260919090300_phase3_sync_entities.sql: same sums, same null rule, same coverage, so the
 * sheet shows the numbers the server is about to store. The server's value still wins on sync.
 *
 * `null` is "not measured" and `0` is "measured zero" (architecture §3.3). Summing a null as a
 * zero would let a recipe with one unmeasured item read as a complete one, which is the exact
 * failure `daily_totals`' coverage column exists to prevent.
 *
 * Pure. No I/O.
 */
import { MACRO_CODES, type NutrientCode } from "@/lib/nutrients/codes";

export type RecipeItemInput = {
  seq: number; foodRefId: string; qty: number; unit: string;
  grams: number; state: "raw" | "cooked"; foodRevisionId?: number | null;
};

/** food_ref_id → the per-100 g map of the revision (or user food) that ref resolves to. */
export type Per100gByRef = Record<string, Record<NutrientCode, number | null>>;

/** The five macros the coverage scalar is the minimum over. */
export const TRACKED_MACROS: readonly NutrientCode[] = [
  MACRO_CODES.kcal, MACRO_CODES.protein, MACRO_CODES.carbs, MACRO_CODES.fat, MACRO_CODES.fiber,
];

/** Four decimals, matching Postgres `round(numeric, 4)` in compute_item_snapshot. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function recipeInputGrams(items: RecipeItemInput[]): number {
  return round4(items.reduce((sum, item) => sum + item.grams, 0));
}

/**
 * Grams in one serving. `yieldGrams` is the weight of the finished dish when she weighed it;
 * without it the input weight stands in, which over-reads a serving of anything that lost water.
 */
export function servingGrams(totalGrams: number, servings: number, yieldGrams?: number): number {
  if (!(servings > 0)) throw new RangeError("servings must be greater than 0");
  const finished = yieldGrams === undefined || yieldGrams === null ? totalGrams : yieldGrams;
  return round4(finished / servings);
}

export function computeRecipeNutrients(
  items: RecipeItemInput[], per100g: Per100gByRef, servings: number, yieldGrams?: number,
): { perServing: Record<string, number | null>; coverage: number } {
  if (!(servings > 0)) throw new RangeError("servings must be greater than 0");
  // A serving is one servings-th of the whole recipe whatever the finished weight is; the yield
  // only converts grams into a serving fraction (servingGrams). Taken so the signature matches
  // the spec's Engines section.
  void yieldGrams;

  const totals = new Map<string, number>();
  const measured = new Map<string, number>();
  for (const item of items) {
    for (const [code, value] of Object.entries(per100g[item.foodRefId] ?? {})) {
      if (!totals.has(code)) totals.set(code, 0);
      if (value === null || value === undefined) continue;
      totals.set(code, (totals.get(code) ?? 0) + (value * item.grams) / 100);
      measured.set(code, (measured.get(code) ?? 0) + 1);
    }
  }

  const perServing: Record<string, number | null> = {};
  for (const [code, total] of totals) {
    perServing[code] = (measured.get(code) ?? 0) === 0 ? null : round4(total / servings);
  }

  const coverage = items.length === 0
    ? 0
    : Math.min(...TRACKED_MACROS.map((code) => (measured.get(code) ?? 0) / items.length));
  return { perServing, coverage: round4(coverage) };
}
```
- [ ] Run: `pnpm test tests/recipes/nutrients.test.ts` → PASSES (9 tests).
- [ ] Commit: `git add lib/recipes tests/recipes && git commit -m "feat: add the recipe per-serving nutrient engine"`

---

## Task 7 — `lib/water.ts` and `lib/favorites.ts`

**Files**
- Create: `lib/water.ts`, `lib/favorites.ts`
- Test: `tests/water/water.test.ts`, `tests/favorites/favorites.test.ts`

**Interfaces**
- Consumes: nothing (pure).
- Produces:
```ts
// lib/water.ts
export const CUP_ML = 240;
export const WATER_GOAL_MIN = 1;
export const WATER_GOAL_MAX = 30;
export function mergeCups(mine: number, theirs: number): number;
export function waterProgress(cups: number, goal: number): { pct: number; met: boolean };
export function clampGoal(cups: number): number;
// lib/favorites.ts
export type FavoriteKind = "food" | "recipe" | "meal";
export type FavoriteRow = { kind: FavoriteKind; id: string; name: string; sort: number;
  foodRefId?: string; catalogFoodId?: number | null; revisionId?: number | null };
export const PINNED_LIMIT = 12;
export function nextSort(existing: { sort: number }[]): number;
export function mergeFavorites<T extends { key: string; sort: number; clientTs: string }>(
  mine: T[], theirs: T[]): T[];
export function pinnedAndRest(rows: FavoriteRow[], limit?: number):
  { pinned: FavoriteRow[]; rest: FavoriteRow[] };
```

**Steps**

- [ ] Write the failing tests.
```ts
// tests/water/water.test.ts
import { describe, expect, it } from "vitest";
import { clampGoal, CUP_ML, mergeCups, waterProgress } from "@/lib/water";

describe("water", () => {
  it("is 240 ml a cup and takes the larger count on a conflict", () => {
    expect(CUP_ML).toBe(240);
    expect([mergeCups(3, 5), mergeCups(5, 3)]).toEqual([5, 5]);
  });

  it("reports progress against the goal and caps the bar at 100 %", () => {
    expect(waterProgress(4, 8)).toEqual({ pct: 50, met: false });
    expect(waterProgress(9, 8)).toEqual({ pct: 100, met: true });
    expect(waterProgress(0, 0)).toEqual({ pct: 0, met: false });
  });

  it("clamps a goal into the column's check range", () => {
    expect([clampGoal(0), clampGoal(31), clampGoal(8.4)]).toEqual([1, 30, 8]);
  });
});
```
```ts
// tests/favorites/favorites.test.ts
import { describe, expect, it } from "vitest";
import { mergeFavorites, nextSort, pinnedAndRest, type FavoriteRow } from "@/lib/favorites";

const row = (key: string, sort: number, clientTs: string) => ({ key, sort, clientTs });

describe("favorites", () => {
  it("puts the next favorite after the last one", () => {
    expect(nextSort([{ sort: 1 }, { sort: 7 }])).toBe(8);
    expect(nextSort([])).toBe(1);
  });

  it("unions two offline devices and lets the newer client_ts set the sort", () => {
    const merged = mergeFavorites(
      [row("food:a", 1, "2026-09-19T12:00:00.000Z"), row("food:b", 2, "2026-09-19T09:00:00.000Z")],
      [row("food:c", 1, "2026-09-19T10:00:00.000Z"), row("food:b", 5, "2026-09-19T11:00:00.000Z")],
    );
    expect(merged.map((f) => f.key)).toEqual(["food:a", "food:c", "food:b"]);
    expect(merged.find((f) => f.key === "food:b")?.sort).toBe(5);
  });

  it("pins the first twelve and hides the rest behind All", () => {
    const rows: FavoriteRow[] = Array.from({ length: 14 }, (_, i) =>
      ({ kind: "food", id: `f${i}`, name: `Food ${i}`, sort: i }));
    const { pinned, rest } = pinnedAndRest(rows);
    expect([pinned.length, rest.length]).toEqual([12, 2]);
    expect(rest[0].id).toBe("f12");
  });
});
```
- [ ] Run: `pnpm test tests/water tests/favorites` → FAILS (both modules missing).
- [ ] Write `lib/water.ts`:
```ts
/**
 * Water — Phase 3 spec, "Engines and logic". Pure. No I/O.
 *
 * `mergeCups` is the client half of the server's `greatest(water_log.cups, excluded.cups)`
 * (architecture §3.7): a cup she drank is never un-drunk by a stale device.
 */
export const CUP_ML = 240;
export const WATER_GOAL_MIN = 1;
export const WATER_GOAL_MAX = 30;

export function mergeCups(mine: number, theirs: number): number {
  return Math.max(mine, theirs);
}

export function waterProgress(cups: number, goal: number): { pct: number; met: boolean } {
  if (!(goal > 0)) return { pct: 0, met: false };
  const pct = Math.round((cups / goal) * 100);
  return { pct: Math.min(100, Math.max(0, pct)), met: cups >= goal };
}

/** The range user_settings.water_goal_cups actually accepts, so the stepper can never write a
 *  value the check constraint refuses. */
export function clampGoal(cups: number): number {
  return Math.min(WATER_GOAL_MAX, Math.max(WATER_GOAL_MIN, Math.round(cups)));
}
```
- [ ] Write `lib/favorites.ts`:
```ts
/**
 * Favorites — Phase 3 spec, "Engines and logic". Pure. No I/O.
 *
 * Membership merges by set union and `sort` by the newer `client_ts` (architecture §3.7). The
 * union is a STORE-level rule: two devices each starring a different food write two rows that
 * never conflict, so `mergeEntity` never sees them — this is where both sides are reconciled.
 * A removed favorite carries `deleted_at` and is filtered out before it reaches here, which is
 * why the tombstone columns in 20260919090000 exist: without them the union resurrects it.
 */
export type FavoriteKind = "food" | "recipe" | "meal";

/** One row of the strip. `foodRefId`, `catalogFoodId` and `revisionId` are what the integration
 *  mount needs to hand a pick to the log sheet's existing pick-a-food path; they are absent for
 *  a favorite whose food she has not opened on this device. */
export type FavoriteRow = {
  kind: FavoriteKind; id: string; name: string; sort: number;
  foodRefId?: string; catalogFoodId?: number | null; revisionId?: number | null;
};

/** Spec open question 5: 12 pinned, the rest behind a tap. */
export const PINNED_LIMIT = 12;

export function nextSort(existing: { sort: number }[]): number {
  return existing.reduce((max, row) => Math.max(max, row.sort), 0) + 1;
}

export function mergeFavorites<T extends { key: string; sort: number; clientTs: string }>(
  mine: T[], theirs: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const row of [...mine, ...theirs]) {
    const seen = byKey.get(row.key);
    if (!seen || Date.parse(row.clientTs) > Date.parse(seen.clientTs)) byKey.set(row.key, row);
  }
  return [...byKey.values()].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}

export function pinnedAndRest(
  rows: FavoriteRow[], limit: number = PINNED_LIMIT,
): { pinned: FavoriteRow[]; rest: FavoriteRow[] } {
  const ordered = [...rows].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  return { pinned: ordered.slice(0, limit), rest: ordered.slice(limit) };
}
```
- [ ] Run: `pnpm test tests/water tests/favorites` → PASSES (6 tests).
- [ ] Commit: `git add lib/water.ts lib/favorites.ts tests/water tests/favorites && git commit -m "feat: add the water and favorites engines"`

---

## Task 8 — `_sync_assert_key`, `_sync_current` and `_sync_tombstone` accept the four entities

**Files**
- Create: `supabase/migrations/20260919090300_phase3_sync_entities.sql`
- Create: `supabase/migrations/down/20260919090300_phase3_sync_entities.down.sql`
- Test: `tests/sync/phase3-entities.test.ts` (extend)

**Interfaces**
- Consumes: `_sync_assert_key(text, text)`, `_sync_current(uuid, text, text)`, `_sync_tombstone(uuid, text, text, text, integer)` — bodies in `supabase/migrations/20260911000600_rpc.sql`, signatures unchanged.
- Produces: the same three functions, replaced; `_sync_current('recipes', …)` returns the recipe row plus `food_ref_id`, `revision_id`, `revision_rev`, `nutrients_per_serving` and `items[]` of the latest revision.

**Steps**

- [ ] Add the failing test to `tests/sync/phase3-entities.test.ts`:
```ts
  it("refuses an entity key that is not a uuid", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    const { data } = await client.rpc("apply_sync_op", {
      p_user_id: user.id,
      p_op: { op_id: crypto.randomUUID(), entity: "recipes", entity_id: "2026-09-19",
              kind: "create", base_rev: null, payload: {}, client_ts: new Date().toISOString() },
    });
    expect(data).toBeNull();   // the RPC raises bad_entity_key; supabase-js reports it in `error`
  });
```
- [ ] Run **[needs branch]**: `pnpm test:integration tests/sync/phase3-entities.test.ts` → FAILS (the RPC raises `unknown_entity`, not `bad_entity_key`; the assertion on the raised message fails).
- [ ] Write the first three statements of `supabase/migrations/20260919090300_phase3_sync_entities.sql`:
```sql
-- Phase 3, contracts §3. Five `create or replace` with the Phase 0 signatures unchanged and the
-- Phase 0 semantics unchanged for every existing entity. What is new: four entities
-- (recipes, favorites_foods, favorites_recipes, favorites_meals), the recipe nutrient
-- computation, water_log's server-side max, and user_settings.water_goal_cups.

-- entity_key encoding, contracts §4. These strings must match lib/sync/keys.ts exactly.
--   user_foods | log_entries | gut_log | duplicate_groups | user_food_prefs | recipes
--     | favorites_foods | favorites_recipes | favorites_meals  -> lowercase uuid
--   plan_days | water_log                                      -> YYYY-MM-DD
--   user_settings                                              -> 'settings'
create or replace function _sync_assert_key(p_entity text, p_key text) returns void
  language plpgsql immutable as $$
begin
  if p_key is null then raise exception 'entity_key_required' using errcode = '22023'; end if;
  if p_entity in ('user_foods','log_entries','gut_log','duplicate_groups','user_food_prefs',
                  'recipes','favorites_foods','favorites_recipes','favorites_meals') then
    if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity in ('plan_days','water_log') then
    if p_key !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity = 'user_settings' then
    if p_key <> 'settings' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  else
    raise exception 'unknown_entity' using errcode = '22023';
  end if;
end; $$;
revoke execute on function _sync_assert_key(text, text) from public, anon;

create or replace function _sync_current(p_user_id uuid, p_entity text, p_key text) returns jsonb
  language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    select to_jsonb(t) into v from user_foods t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'user_food_prefs' then
    select to_jsonb(t) into v from user_food_prefs t
      where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
  elsif p_entity = 'log_entries' then
    select to_jsonb(e) || jsonb_build_object('items', coalesce(
             (select jsonb_agg(to_jsonb(i) order by i.seq) from log_items i where i.entry_id = e.id),
             '[]'::jsonb))
      into v from log_entries e where e.user_id = p_user_id and e.id = p_key::uuid;
  elsif p_entity = 'water_log' then
    select to_jsonb(t) into v from water_log t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'plan_days' then
    select to_jsonb(t) into v from plan_days t
      where t.user_id = p_user_id and t.local_date = p_key::date;
  elsif p_entity = 'user_settings' then
    select to_jsonb(t) into v from user_settings t where t.user_id = p_user_id;
  elsif p_entity = 'gut_log' then
    select to_jsonb(t) into v from gut_log t where t.user_id = p_user_id and t.id = p_key::uuid;
  elsif p_entity = 'duplicate_groups' then
    select to_jsonb(t) || jsonb_build_object('fingerprint', encode(t.fingerprint, 'hex'))
      into v from duplicate_groups t where t.user_id = p_user_id and t.id = p_key::uuid;
  -- Phase 3. `current` has to be enough for a second device to write the row straight into
  -- IndexedDB (architecture §3.7), so a recipe carries its latest revision inline, and it
  -- carries food_ref_id: that registry row is what lib/recipes-client.ts logs a serving through,
  -- and the client has no other way to learn it.
  elsif p_entity = 'recipes' then
    select to_jsonb(r) || jsonb_build_object(
             'food_ref_id', (select fr.id from food_refs fr where fr.user_food_id = r.id),
             'revision_id', lr.id, 'revision_rev', lr.rev,
             'nutrients_per_serving', lr.nutrients_per_serving,
             'items', coalesce((select jsonb_agg(to_jsonb(i) order by i.seq)
                                  from recipe_items i where i.recipe_revision_id = lr.id),
                               '[]'::jsonb))
      into v
      from recipes r
      left join lateral (select rv.* from recipe_revisions rv
                          where rv.recipe_id = r.id order by rv.rev desc limit 1) lr on true
     where r.user_id = p_user_id and r.id = p_key::uuid;
  elsif p_entity = 'favorites_foods' then
    select to_jsonb(t) into v from favorites_foods t
      where t.user_id = p_user_id and t.food_ref_id = p_key::uuid;
  elsif p_entity = 'favorites_recipes' then
    select to_jsonb(t) into v from favorites_recipes t
      where t.user_id = p_user_id and t.recipe_id = p_key::uuid;
  elsif p_entity = 'favorites_meals' then
    select to_jsonb(m) || jsonb_build_object('items', coalesce(
             (select jsonb_agg(to_jsonb(i) order by i.seq) from favorites_meal_items i
               where i.meal_id = m.id), '[]'::jsonb))
      into v from favorites_meals m where m.user_id = p_user_id and m.id = p_key::uuid;
  end if;
  return v;
end; $$;
revoke execute on function _sync_current(uuid, text, text) from public, anon;

create or replace function _sync_tombstone(p_user_id uuid, p_entity text, p_key text,
                                           p_kind text, p_rev integer) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare v_deleted_at timestamptz := case when p_kind = 'delete' then now() else null end;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    update user_foods set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'log_entries' then
    update log_entries set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'gut_log' then
    update gut_log set deleted_at = v_deleted_at, rev = p_rev
      where user_id = p_user_id and id = p_key::uuid;
  elsif p_entity = 'recipes' then
    update recipes set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and id = p_key::uuid;
    -- The recipe's loggable twin follows it, so a deleted recipe stops appearing in search.
    -- Existing log_items keep their own snapshots either way (architecture §3.3).
    update user_foods set deleted_at = v_deleted_at
      where user_id = p_user_id and id = p_key::uuid and kind = 'recipe';
  elsif p_entity = 'favorites_foods' then
    update favorites_foods set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and food_ref_id = p_key::uuid;
  elsif p_entity = 'favorites_recipes' then
    update favorites_recipes set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and recipe_id = p_key::uuid;
  elsif p_entity = 'favorites_meals' then
    update favorites_meals set deleted_at = v_deleted_at, rev = p_rev, updated_at = now()
      where user_id = p_user_id and id = p_key::uuid;
  end if;
  return _sync_current(p_user_id, p_entity, p_key);
end; $$;
revoke execute on function _sync_tombstone(uuid, text, text, text, integer) from public, anon;
```
- [ ] Apply and run **[needs branch]**: `pnpm db:push && pnpm test:integration tests/sync/phase3-entities.test.ts` → PASSES (4 tests; the create still fails later in `_sync_upsert`, which Task 9 writes — this test only asserts the key gate).
- [ ] Commit: `git add supabase/migrations tests/sync && git commit -m "feat: teach the sync key, read and tombstone functions the phase 3 entities"`

---

## Task 9 — `_sync_upsert` writes recipes, favorites and the water max; `apply_sync_op` widens its allowlist

**Files**
- Modify: `supabase/migrations/20260919090300_phase3_sync_entities.sql` (append after `revoke execute on function _sync_tombstone…`)
- Modify: `supabase/migrations/down/20260919090300_phase3_sync_entities.down.sql`
- Test: `tests/sync/phase3-entities.test.ts` (extend)

**Interfaces**
- Consumes: `compute_item_snapshot(p_food_ref_id uuid, p_grams numeric) returns jsonb` (`20260918090100`) → `{code: {amount, unit, basis, source, source_version, revision_id}}` with `amount: null` for an unmeasured nutrient; `get_or_create_food_ref(p_user_id uuid, p_kind text, p_catalog_food_id bigint, p_user_food_id uuid) returns uuid` (`20260911000600`); `next_change_seq(uuid)`.
- Produces: `_sync_upsert` with branches for `recipes`, `favorites_foods`, `favorites_recipes`, `favorites_meals`, `water_log` (`greatest`) and `user_settings` (`water_goal_cups`); `apply_sync_op` whose delete/restore allowlist is `user_foods, log_entries, gut_log, recipes, favorites_foods, favorites_recipes, favorites_meals`.

**Steps**

- [ ] Add the failing test to `tests/sync/phase3-entities.test.ts` (the `op()` helper is the one in `tests/rls/apply-sync-op.test.ts`; copy it into this file):
```ts
  it("writes a recipe, its revision, its items, and a loggable user_foods twin", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    const rice = await seedCatalogFood(adminClient(), user.id, { sourceId: "p3-rice",
      description: "Rice, white, cooked", per100g: { energy_kcal: 130, protein: 2.7,
        carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 } });
    const applied = await op(client, user.id, "recipes", RECIPE, "create", null, {
      id: RECIPE, name: "Rice tray", servings: 4,
      items: [{ seq: 1, food_ref_id: rice.foodRefId, qty: 1, unit: "g", grams: 400, state: "cooked" }],
    });
    expect(applied).toMatchObject({ status: "applied", rev: 1 });

    const current = await client.rpc("_sync_current", { p_user_id: user.id, p_entity: "recipes",
      p_key: RECIPE });
    expect(current.data.revision_rev).toBe(1);
    expect(current.data.nutrients_per_serving.energy_kcal).toBe(130);   // 520 kcal / 4
    expect(current.data.nutrients_per_serving.coverage).toBe(1);
    expect(current.data.food_ref_id).toEqual(expect.any(String));

    const twin = await adminClient().from("user_foods")
      .select("kind, per_100g").eq("id", RECIPE).single();
    expect(twin.data?.kind).toBe("recipe");
    expect(twin.data?.per_100g.energy_kcal).toBe(130);                  // 520 × 100 / 400 g
  });
```
  (`_sync_current` is `revoke`d from `authenticated`; call it with `adminClient()` in the assertion, or read the `current` the conflict path returns. Use `adminClient().rpc(…)`.)
- [ ] Run **[needs branch]**: `pnpm test:integration tests/sync/phase3-entities.test.ts` → FAILS: `_sync_upsert` has no `recipes` branch, so it writes nothing and `_sync_current` returns `null`.
- [ ] Append the `_sync_upsert` replacement to `supabase/migrations/20260919090300_phase3_sync_entities.sql`. Everything down to the `duplicate_groups` branch is the Phase 2 body from `20260918090100_phase2_compute_item_snapshot.sql`, unchanged except the two lines marked *Phase 3*:
```sql
create or replace function _sync_upsert(p_user_id uuid, p_entity text, p_key text,
                                        p_payload jsonb, p_rev integer) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_prior       jsonb   := '{}'::jsonb;
  v_force       boolean := coalesce((p_payload->>'recompute_snapshots')::boolean, false);
  v_revision_id uuid;
  v_items       integer;
  v_servings    numeric;
  v_total_grams numeric;
  v_per_serving jsonb;
  v_coverage    numeric;
  v_per_100g    jsonb;
begin
  perform _sync_assert_key(p_entity, p_key);
  if p_entity = 'user_foods' then
    insert into user_foods (id, user_id, name, brand, ingredients_text, catalog_food_id, kind,
                            per_100g, allergen_tags, rev, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'name', p_payload->>'brand',
            p_payload->>'ingredients_text', (p_payload->>'catalog_food_id')::bigint,
            coalesce(p_payload->>'kind', 'custom'),
            coalesce(p_payload->'per_100g', '{}'::jsonb),
            coalesce(array(select jsonb_array_elements_text(p_payload->'allergen_tags')), '{}'::text[]),
            p_rev, null)
    on conflict (id) do update set name = excluded.name, brand = excluded.brand,
      ingredients_text = excluded.ingredients_text, catalog_food_id = excluded.catalog_food_id,
      kind = excluded.kind, per_100g = excluded.per_100g, allergen_tags = excluded.allergen_tags,
      rev = excluded.rev
      where user_foods.user_id = p_user_id;
  elsif p_entity = 'user_food_prefs' then
    insert into user_food_prefs (user_id, food_ref_id, status, role, no_cook, note, rev, updated_at)
    values (p_user_id, p_key::uuid, p_payload->>'status', p_payload->>'role',
            coalesce((p_payload->>'no_cook')::boolean, false), p_payload->>'note', p_rev, now())
    on conflict (user_id, food_ref_id) do update set status = excluded.status,
      role = excluded.role, no_cook = excluded.no_cook, note = excluded.note,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'log_entries' then
    insert into log_entries (id, user_id, note, media_ref, eaten_at, tz, local_date, slot, method,
                             rev, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'note', p_payload->>'media_ref',
            (p_payload->>'eaten_at')::timestamptz, p_payload->>'tz',
            (p_payload->>'local_date')::date, p_payload->>'slot', p_payload->>'method', p_rev, null)
    on conflict (id) do update set note = excluded.note, media_ref = excluded.media_ref,
      eaten_at = excluded.eaten_at, tz = excluded.tz, local_date = excluded.local_date,
      slot = excluded.slot, method = excluded.method, rev = excluded.rev
      where log_entries.user_id = p_user_id;
    if exists (select 1 from log_entries e where e.id = p_key::uuid and e.user_id = p_user_id) then
      select coalesce(jsonb_object_agg(id::text, jsonb_build_object(
               'grams', grams, 'food_ref_id', food_ref_id, 'snapshot', snapshot)), '{}'::jsonb)
        into v_prior from log_items where entry_id = p_key::uuid;

      delete from log_items where entry_id = p_key::uuid;
      insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot,
                             food_revision_id, portion_id, was_edited, confidence)
      select coalesce(i.id, gen_random_uuid()), p_key::uuid, i.seq, i.qty, i.unit, i.food_ref_id,
             i.grams,
             case when not v_force
                   and i.id is not null
                   and v_prior ? i.id::text
                   and (v_prior->(i.id::text)->>'grams')::numeric = i.grams
                   and (v_prior->(i.id::text)->>'food_ref_id')::uuid = i.food_ref_id
                   and coalesce(v_prior->(i.id::text)->'snapshot', '{}'::jsonb) <> '{}'::jsonb
                  then v_prior->(i.id::text)->'snapshot'
                  else compute_item_snapshot(i.food_ref_id, i.grams) end,
             i.food_revision_id, i.portion_id,
             coalesce(i.was_edited, false), i.confidence
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(id uuid, seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  snapshot jsonb, food_revision_id bigint, portion_id bigint,
                  was_edited boolean, confidence numeric);
    end if;
  elsif p_entity = 'water_log' then
    insert into water_log (user_id, local_date, cups, rev)
    values (p_user_id, p_key::date, coalesce((p_payload->>'cups')::integer, 0), p_rev)
    -- Phase 3, contracts §3: server-side max. Phase 0 wrote excluded.cups, which let a stale
    -- device un-drink a cup; the client merge already took the max, and now the server agrees.
    on conflict (user_id, local_date) do update
      set cups = greatest(water_log.cups, excluded.cups), rev = excluded.rev;
  elsif p_entity = 'plan_days' then
    insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                           rev, updated_at)
    values (p_user_id, p_key::date, p_payload->>'day_type_override',
            coalesce((p_payload->>'floor_day')::boolean, false),
            coalesce(p_payload->'swaps', '{}'::jsonb),
            coalesce(p_payload->'slot_notes', '{}'::jsonb), p_rev, now())
    on conflict (user_id, local_date) do update set day_type_override = excluded.day_type_override,
      floor_day = excluded.floor_day, swaps = excluded.swaps, slot_notes = excluded.slot_notes,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'user_settings' then
    -- Phase 3: water_goal_cups joins the column list. Every column is replaced from the payload,
    -- so lib/water-client.ts setGoal sends the whole settings row, never just the goal.
    insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                               rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                               shift_minutes, changed_at, water_goal_cups, rev)
    values (p_user_id, coalesce((p_payload->>'first_opened_at')::timestamptz, now()),
            coalesce((p_payload->>'scale_warning_dismissed')::boolean, false),
            (p_payload->>'training_kcal')::integer, (p_payload->>'rest_kcal')::integer,
            (p_payload->>'protein_g')::numeric,
            coalesce((p_payload->>'protein_locked')::boolean, true),
            (p_payload->>'ramp_override')::smallint,
            coalesce(p_payload->'slot_times', '{}'::jsonb),
            coalesce((p_payload->>'shift_minutes')::integer, 0),
            (p_payload->>'changed_at')::timestamptz,
            coalesce((p_payload->>'water_goal_cups')::integer, 8), p_rev)
    on conflict (user_id) do update set first_opened_at = excluded.first_opened_at,
      scale_warning_dismissed = excluded.scale_warning_dismissed,
      training_kcal = excluded.training_kcal, rest_kcal = excluded.rest_kcal,
      protein_g = excluded.protein_g, protein_locked = excluded.protein_locked,
      ramp_override = excluded.ramp_override, slot_times = excluded.slot_times,
      shift_minutes = excluded.shift_minutes, changed_at = excluded.changed_at,
      water_goal_cups = excluded.water_goal_cups, rev = excluded.rev;
  elsif p_entity = 'gut_log' then
    insert into gut_log (id, user_id, local_date, tz, state, note, rev, deleted_at)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date, p_payload->>'tz',
            p_payload->>'state', p_payload->>'note', p_rev, null)
    on conflict (id) do update set local_date = excluded.local_date, tz = excluded.tz,
      state = excluded.state, note = excluded.note, rev = excluded.rev
      where gut_log.user_id = p_user_id;
  elsif p_entity = 'duplicate_groups' then
    insert into duplicate_groups (id, user_id, local_date, fingerprint, slot, state,
                                  merged_into_entry_id, decided_at, rev)
    values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date,
            decode(p_payload->>'fingerprint', 'hex'), p_payload->>'slot',
            coalesce(p_payload->>'state', 'open'),
            (p_payload->>'merged_into_entry_id')::uuid,
            (p_payload->>'decided_at')::timestamptz, p_rev)
    on conflict (id) do update set local_date = excluded.local_date,
      fingerprint = excluded.fingerprint, slot = excluded.slot, state = excluded.state,
      merged_into_entry_id = excluded.merged_into_entry_id, decided_at = excluded.decided_at,
      rev = excluded.rev
      where duplicate_groups.user_id = p_user_id;

  -- ---------- Phase 3 entities ---------------------------------------------------------
  elsif p_entity = 'recipes' then
    insert into recipes (id, user_id, name, servings, yield_grams, rev, updated_at, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'name',
            coalesce((p_payload->>'servings')::numeric, 1),
            (p_payload->>'yield_grams')::numeric, p_rev, now(), null)
    on conflict (id) do update set name = excluded.name, servings = excluded.servings,
      yield_grams = excluded.yield_grams, rev = excluded.rev, updated_at = now()
      where recipes.user_id = p_user_id;

    if exists (select 1 from recipes r where r.id = p_key::uuid and r.user_id = p_user_id) then
      -- Every applied create or update writes a NEW revision at the recipe's new rev. The old
      -- revision row and every log_items snapshot taken from it are never touched (AC 7).
      insert into recipe_revisions (recipe_id, rev, nutrients_per_serving)
      values (p_key::uuid, p_rev, '{}'::jsonb)
      returning id into v_revision_id;

      insert into recipe_items (recipe_revision_id, seq, qty, unit, food_ref_id, grams,
                                food_revision_id, state)
      select v_revision_id, i.seq, i.qty, i.unit, i.food_ref_id, i.grams, i.food_revision_id,
             coalesce(i.state, 'raw')
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(seq integer, qty numeric, unit text, food_ref_id uuid, grams numeric,
                  food_revision_id bigint, state text);

      select count(*), coalesce(sum(grams), 0) into v_items, v_total_grams
        from recipe_items where recipe_revision_id = v_revision_id;
      select servings, coalesce(yield_grams, v_total_grams) into v_servings, v_total_grams
        from recipes where id = p_key::uuid;

      -- Per nutrient: sum the items that measured it, ignore the ones that did not. A code is
      -- null only when NO item measured it — never 0 (architecture §3.3). Per-code coverage is
      -- measured items ÷ all items, and the scalar stored as nutrients_per_serving.coverage is
      -- the MINIMUM of that ratio across the five tracked macros, so one unmeasured item makes
      -- the recipe read as incomplete (AC 8). lib/recipes/nutrients.ts computes the same thing.
      with per_item as (
        select compute_item_snapshot(i.food_ref_id, i.grams) as snap
          from recipe_items i where i.recipe_revision_id = v_revision_id),
      vals as (
        select kv.key as code, (kv.value->>'amount')::numeric as amount
          from per_item cross join lateral jsonb_each(per_item.snap) kv),
      per_code as (
        select code, count(*) filter (where amount is not null) as measured,
               sum(amount) as total                         -- sum() already ignores nulls
          from vals group by code),
      macros as (
        select coalesce(pc.measured, 0) as measured
          from unnest(array['energy_kcal','protein','carbohydrate','fat_total','fiber_total'])
               as m(code)
          left join per_code pc on pc.code = m.code)
      select
        coalesce((select jsonb_object_agg(code, case when measured = 0 then null
                          else to_jsonb(round(total / v_servings, 4)) end) from per_code),
                 '{}'::jsonb),
        coalesce((select min(measured::numeric / nullif(v_items, 0)) from macros), 0)
        into v_per_serving, v_coverage;

      update recipe_revisions
         set nutrients_per_serving = v_per_serving || jsonb_build_object('coverage', v_coverage)
       where id = v_revision_id;

      -- The loggable twin. per_100g is the whole-recipe total × 100 ÷ the recipe's finished
      -- weight (yield_grams when she weighed it, else the input grams) — the same denominator
      -- servingGrams uses, so logging `servingGrams × servings eaten` reproduces the per-serving
      -- numbers exactly and a recipe travels the unchanged Phase 2 commit path.
      select coalesce(jsonb_object_agg(key, case when value = 'null'::jsonb then null
               else to_jsonb(round((value#>>'{}')::numeric * v_servings * 100
                                   / nullif(v_total_grams, 0), 4)) end), '{}'::jsonb)
        into v_per_100g from jsonb_each(v_per_serving);

      insert into user_foods (id, user_id, name, kind, per_100g, rev, deleted_at)
      values (p_key::uuid, p_user_id, p_payload->>'name', 'recipe', v_per_100g, p_rev, null)
      on conflict (id) do update set name = excluded.name, kind = 'recipe',
        per_100g = excluded.per_100g, rev = excluded.rev
        where user_foods.user_id = p_user_id;

      if exists (select 1 from user_foods f where f.id = p_key::uuid and f.user_id = p_user_id) then
        perform get_or_create_food_ref(p_user_id, 'user', null, p_key::uuid);
      end if;
    end if;
  elsif p_entity = 'favorites_foods' then
    -- created_at is intentionally absent from the on-conflict SET list: a re-sort touches only
    -- sort/rev/updated_at, so the row's real "date added" survives every later write.
    insert into favorites_foods (user_id, food_ref_id, sort, rev, created_at, updated_at, deleted_at)
    values (p_user_id, p_key::uuid, coalesce((p_payload->>'sort')::integer, 0), p_rev, now(), now(), null)
    on conflict (user_id, food_ref_id) do update set sort = excluded.sort,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'favorites_recipes' then
    insert into favorites_recipes (user_id, recipe_id, sort, rev, created_at, updated_at, deleted_at)
    values (p_user_id, p_key::uuid, coalesce((p_payload->>'sort')::integer, 0), p_rev, now(), now(), null)
    on conflict (user_id, recipe_id) do update set sort = excluded.sort,
      rev = excluded.rev, updated_at = now();
  elsif p_entity = 'favorites_meals' then
    insert into favorites_meals (id, user_id, name, sort, rev, created_at, updated_at, deleted_at)
    values (p_key::uuid, p_user_id, p_payload->>'name',
            coalesce((p_payload->>'sort')::integer, 0), p_rev, now(), now(), null)
    on conflict (id) do update set name = excluded.name, sort = excluded.sort,
      rev = excluded.rev, updated_at = now()
      where favorites_meals.user_id = p_user_id;
    -- Items are replaced wholesale, like log_items, and only when the row is really hers.
    if exists (select 1 from favorites_meals m where m.id = p_key::uuid and m.user_id = p_user_id) then
      delete from favorites_meal_items where meal_id = p_key::uuid;
      insert into favorites_meal_items (meal_id, seq, food_ref_id, grams)
      select p_key::uuid, i.seq, i.food_ref_id, i.grams
        from jsonb_to_recordset(coalesce(p_payload->'items', '[]'::jsonb))
             as i(seq integer, food_ref_id uuid, grams numeric);
    end if;
  end if;
  return _sync_current(p_user_id, p_entity, p_key);
end; $$;
revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;
```
- [ ] Append the `apply_sync_op` replacement to the same file. It is the Phase 0 body from `20260911000600_rpc.sql` with one line changed — the tombstone allowlist:
```sql
-- Phase 0's body, unchanged except the delete/restore allowlist (contracts §3).
create or replace function apply_sync_op(p_user_id uuid, p_op jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_op_id   uuid    := (p_op->>'op_id')::uuid;
  v_entity  text    := p_op->>'entity';
  v_key     text    := p_op->>'entity_id';
  v_kind    text    := p_op->>'kind';
  v_base    integer := (p_op->>'base_rev')::integer;
  v_current jsonb;
  v_rev     integer;
  v_seq     bigint;
  v_after   jsonb;
begin
  perform _sync_assert_caller(p_user_id);
  if v_op_id is null then raise exception 'op_id_required' using errcode = '22023'; end if;
  if v_kind not in ('create','update','delete','restore') then
    raise exception 'bad_op_kind' using errcode = '22023';
  end if;
  perform _sync_assert_key(v_entity, v_key);

  -- Tombstone-capable entities. Phase 3 adds recipes and the three favorites kinds; everything
  -- else still answers 'unsupported' and writes nothing, never raising.
  if v_kind in ('delete', 'restore') and v_entity not in
       ('user_foods', 'log_entries', 'gut_log', 'recipes',
        'favorites_foods', 'favorites_recipes', 'favorites_meals') then
    return jsonb_build_object('op_id', v_op_id, 'status', 'unsupported');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_entity || ':' || v_key, 0));

  if exists (select 1 from change_log where op_id = v_op_id) then
    return jsonb_build_object('op_id', v_op_id, 'status', 'duplicate');
  end if;

  v_current := _sync_current(p_user_id, v_entity, v_key);

  if v_kind = 'create' then
    if v_current is not null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);
    end if;
    v_rev := 1;
  else
    if v_current is null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'gone');
    end if;
    if v_current->>'deleted_at' is not null and v_kind <> 'restore' then
      return jsonb_build_object('op_id', v_op_id, 'status', 'deleted', 'entity', v_entity,
                                'deleted_at', v_current->>'deleted_at');
    end if;
    if v_kind = 'restore' and v_current->>'deleted_at' is null then
      return jsonb_build_object('op_id', v_op_id, 'status', 'applied',
        'rev', (v_current->>'rev')::integer,
        'seq', coalesce((select max(seq) from change_log
                           where user_id = p_user_id and entity = v_entity and entity_key = v_key), 0));
    end if;
    if v_base is null or v_base <> (v_current->>'rev')::integer then
      return jsonb_build_object('op_id', v_op_id, 'status', 'conflict', 'entity', v_entity,
                                'current_rev', (v_current->>'rev')::integer, 'current', v_current);
    end if;
    v_rev := (v_current->>'rev')::integer + 1;
  end if;

  if v_kind in ('create','update') then
    v_after := _sync_upsert(p_user_id, v_entity, v_key, coalesce(p_op->'payload', '{}'::jsonb), v_rev);
  else
    v_after := _sync_tombstone(p_user_id, v_entity, v_key, v_kind, v_rev);
  end if;

  v_seq := next_change_seq(p_user_id);
  insert into change_log (user_id, seq, entity, entity_key, rev, op, op_id, current)
  values (p_user_id, v_seq, v_entity, v_key, v_rev, v_kind, v_op_id,
          case when v_kind = 'delete' then null else v_after end);

  return jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'rev', v_rev, 'seq', v_seq);
end; $$;
revoke execute on function apply_sync_op(uuid, jsonb) from public, anon;
grant execute on function apply_sync_op(uuid, jsonb) to authenticated, service_role;
```
- [ ] Write `supabase/migrations/down/20260919090300_phase3_sync_entities.down.sql`. 20260919090300 creates no object — it replaces five bodies — so its down restores the gate every Phase 3 entity comes in through, plus the one body that names a column `20260919090200`'s down drops. `_sync_current`, `_sync_tombstone` and `apply_sync_op` need no restoration: `_sync_assert_key` runs first in all three and raises `unknown_entity` for the four new names, so their Phase 3 branches become unreachable.
```sql
-- Rollback of 20260919090300. Run BEFORE down/20260919090200_phase3_water_goal.down.sql.
create or replace function _sync_assert_key(p_entity text, p_key text) returns void
  language plpgsql immutable as $$
begin
  if p_key is null then raise exception 'entity_key_required' using errcode = '22023'; end if;
  if p_entity in ('user_foods','log_entries','gut_log','duplicate_groups','user_food_prefs') then
    if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity in ('plan_days','water_log') then
    if p_key !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  elsif p_entity = 'user_settings' then
    if p_key <> 'settings' then
      raise exception 'bad_entity_key' using errcode = '22023';
    end if;
  else
    raise exception 'unknown_entity' using errcode = '22023';
  end if;
end; $$;
revoke execute on function _sync_assert_key(text, text) from public, anon;
```
- [ ] Append the Phase 2 `_sync_upsert` to that down file verbatim from the migration that owns it, so the down never re-types a body it does not own:
```bash
sed -n '/^create or replace function _sync_upsert/,/^revoke execute on function _sync_upsert/p' \
  supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql \
  >> supabase/migrations/down/20260919090300_phase3_sync_entities.down.sql
```
- [ ] Apply and run **[needs branch]**: `pnpm db:push && pnpm test:integration tests/sync/phase3-entities.test.ts` → PASSES (5 tests).
- [ ] Commit: `git add supabase/migrations tests/sync && git commit -m "feat: apply recipe, favorites and water sync ops in SQL"`

---

## Task 10 — Branch suite: revision immutability, coverage, water max, favorites union, cross-user denial

**Files**
- Modify: `tests/sync/phase3-entities.test.ts` (append)
- Create: `tests/sync/phase3-cross-user.test.ts`
- Test paths: both of the above

**Interfaces**
- Consumes: `apply_sync_op(p_user_id uuid, p_op jsonb)`, `createTestUsers()` from `tests/helpers/supabase.ts`, `seedCatalogFood`/`seedUserFood`/`uuid` from `tests/log/fixtures.ts`, `applyLogEntry` through `POST /api/log/commit` (unchanged Phase 2 path).
- Produces: proof of AC 7, 8, 9, 10 and 11.

**Steps**

- [ ] Append the failing cases to `tests/sync/phase3-entities.test.ts`:
```ts
  it("an edit under a stale base_rev conflicts and writes nothing", async () => {
    const { user, client, rice } = await seedRecipe();
    await op(client, user.id, "recipes", RECIPE, "update", 1,
      { id: RECIPE, name: "Rice tray v2", servings: 4, items: riceItems(rice, 400) });
    const stale = await op(client, user.id, "recipes", RECIPE, "update", 1,
      { id: RECIPE, name: "Nope", servings: 4, items: riceItems(rice, 400) });
    expect(stale).toMatchObject({ status: "conflict", entity: "recipes", current_rev: 2 });
    const revs = await adminClient().from("recipe_revisions")
      .select("rev").eq("recipe_id", RECIPE).order("rev");
    expect(revs.data?.map((r) => r.rev)).toEqual([1, 2]);
  });

  it("an applied edit adds rev + 1 and leaves revision 1 and its log byte-identical", async () => {
    const { user, client, rice } = await seedRecipe();
    const admin = adminClient();
    const before = await admin.from("recipe_revisions")
      .select("id, rev, nutrients_per_serving").eq("recipe_id", RECIPE).eq("rev", 1).single();
    const logged = await admin.from("log_items").select("id, snapshot")
      .eq("food_ref_id", await recipeRefId(admin, RECIPE)).single();

    await op(client, user.id, "recipes", RECIPE, "update", 1,
      { id: RECIPE, name: "Rice tray", servings: 8, items: riceItems(rice, 400) });

    const after = await admin.from("recipe_revisions")
      .select("id, rev, nutrients_per_serving").eq("recipe_id", RECIPE).eq("rev", 1).single();
    expect(after.data).toEqual(before.data);
    const loggedAfter = await admin.from("log_items").select("id, snapshot")
      .eq("id", logged.data!.id).single();
    expect(loggedAfter.data).toEqual(logged.data);
  });

  it("reports coverage below 1, and never zero, for a nutrient one item does not measure", async () => {
    const { user, client, rice } = await seedRecipe();
    const admin = adminClient();
    const oil = await seedUserFood(admin, user.id,
      { name: "Olive oil", per100g: { energy_kcal: 884, protein: 0, carbohydrate: 0,
        fat_total: 100, fiber_total: null } });
    await op(client, user.id, "recipes", RECIPE, "update", 1, { id: RECIPE, name: "Rice tray",
      servings: 4, items: [...riceItems(rice, 400),
        { seq: 2, food_ref_id: oil.foodRefId, qty: 1, unit: "g", grams: 10, state: "raw" }] });
    const row = await admin.from("recipe_revisions")
      .select("nutrients_per_serving").eq("recipe_id", RECIPE).eq("rev", 2).single();
    const n = row.data!.nutrients_per_serving;
    expect(Number(n.coverage)).toBeLessThan(1);
    expect(Number(n.coverage)).toBeGreaterThan(0);
    expect(Number(n.fiber_total)).toBe(0.4);      // the rice's 1.6 g over 4 servings, not 0
  });

  it("settles two clients logging 3 and 5 cups on the larger count", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    await op(client, user.id, "water_log", "2026-09-19", "create", null, { cups: 5 });
    await op(client, user.id, "water_log", "2026-09-19", "update", 1, { cups: 3 });
    const row = await adminClient().from("water_log")
      .select("cups").eq("user_id", user.id).eq("local_date", "2026-09-19").single();
    expect(row.data?.cups).toBe(5);
  });

  it("keeps both favorites when two clients each star a different food", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    const admin = adminClient();
    const a = await seedCatalogFood(admin, user.id, { sourceId: "fav-a", description: "Food A",
      per100g: { energy_kcal: 100 } });
    const b = await seedCatalogFood(admin, user.id, { sourceId: "fav-b", description: "Food B",
      per100g: { energy_kcal: 100 } });
    await op(client, user.id, "favorites_foods", a.foodRefId, "create", null,
      { food_ref_id: a.foodRefId, sort: 1 });
    await op(client, user.id, "favorites_foods", b.foodRefId, "create", null,
      { food_ref_id: b.foodRefId, sort: 2 });
    const rows = await admin.from("favorites_foods")
      .select("food_ref_id").eq("user_id", user.id).is("deleted_at", null);
    expect(rows.data?.length).toBe(2);
  });

  it("tombstones a favorite and refuses to resurrect it with a stale update", async () => {
    const { user, client, rice } = await seedRecipe();
    await op(client, user.id, "favorites_foods", rice.foodRefId, "create", null,
      { food_ref_id: rice.foodRefId, sort: 1 });
    const removed = await op(client, user.id, "favorites_foods", rice.foodRefId, "delete", 1, {});
    expect(removed).toMatchObject({ status: "applied", rev: 2 });
    const stale = await op(client, user.id, "favorites_foods", rice.foodRefId, "update", 1,
      { food_ref_id: rice.foodRefId, sort: 9 });
    expect(stale).toMatchObject({ status: "deleted" });
  });
```
  Helpers at the top of the file: `RECIPE = uuid(31)`, `riceItems(fixture, grams)` returning `[{ seq: 1, food_ref_id: fixture.foodRefId, qty: 1, unit: "g", grams, state: "cooked" }]`, `seedRecipe()` (reset user a, seed the rice fixture, apply the `create`, commit one `log_entries` op whose single item is the recipe's food ref at `servingGrams` grams), and `recipeRefId(admin, id)` reading `food_refs.id where user_food_id = id`.
- [ ] Write `tests/sync/phase3-cross-user.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { HAS_BRANCH, createTestUsers } from "../helpers/supabase";

/** AC 11: every Phase 3 table refuses a read and a write from a second authenticated user. */
describe.skipIf(!HAS_BRANCH)("phase 3 cross-user denial", () => {
  const OWNED = ["recipes", "recipe_revisions", "recipe_items", "favorites_foods",
    "favorites_recipes", "favorites_meals", "favorites_meal_items", "user_settings"];

  it("shows user b none of user a's rows", async () => {
    const { a, b, admin } = await createTestUsers();
    await admin.from("recipes").upsert({ id: RECIPE, user_id: a.userId, name: "Hers", servings: 4 });
    for (const table of OWNED) {
      const { data, error } = await b.client.from(table).select("*");
      expect([table, error]).toEqual([table, null]);   // RLS filters, it does not error
      expect([table, data?.length ?? 0]).toEqual([table, 0]);
    }
  });

  it("refuses user b's write into user a's recipe", async () => {
    const { a, b } = await createTestUsers();
    const { error } = await b.client.from("recipes")
      .update({ name: "Mine now" }).eq("user_id", a.userId);
    expect(error === null).toBe(true);
    const still = await b.client.from("recipes").select("id").eq("user_id", a.userId);
    expect(still.data?.length ?? 0).toBe(0);
  });

  it("refuses an apply_sync_op aimed at another user", async () => {
    const { a, b } = await createTestUsers();
    const { error } = await b.client.rpc("apply_sync_op", { p_user_id: a.userId,
      p_op: { op_id: crypto.randomUUID(), entity: "recipes", entity_id: RECIPE, kind: "update",
              base_rev: 1, payload: {}, client_ts: new Date().toISOString() } });
    expect(error?.message).toContain("forbidden");
  });
});
```
- [ ] Run **[needs branch]**: `pnpm test:integration tests/sync/` → PASSES (all phase-3 cases plus the Phase 0 suites, unchanged).
- [ ] Commit: `git add tests/sync && git commit -m "test: prove recipe immutability, coverage, water max, favorites union and cross-user denial"`

---

## Task 11 — `lib/recipes-client.ts`

**Files**
- Create: `lib/recipes-client.ts`
- Test: `tests/recipes/recipes-client.test.ts`

**Interfaces**
- Consumes: `putRow`, `getRow`, `allRows` from `lib/sync/idb.ts`; `enqueue(op, now?)` from `lib/sync/outbox.ts`; `getRevision(id)` / `CachedRevision` from `lib/db/catalog-cache.ts`; `computeRecipeNutrients`, `recipeInputGrams`, `servingGrams`, `RecipeItemInput`, `Per100gByRef` from `lib/recipes/nutrients.ts`.
- Produces:
```ts
export type RecipeInput = { id?: string; name: string; servings: number;
  yieldGrams?: number | null; items: RecipeItemInput[]; baseRev?: number };
export type RecipeRow = { id: string; name: string; servings: number;
  yield_grams: number | null; rev: number; items: Record<string, unknown>[];
  nutrients_per_serving: Record<string, number | null>; food_ref_id?: string };
export async function saveRecipe(input: RecipeInput): Promise<{ recipeId: string; rev: number }>;
export async function listRecipes(): Promise<RecipeRow[]>;
export async function provisionalNutrients(items: RecipeItemInput[], servings: number,
  yieldGrams?: number | null): Promise<{ perServing: Record<string, number | null>; coverage: number }>;
export async function recipeFoodRefId(recipeId: string): Promise<string | null>;
```

**Steps**

- [ ] Write the failing test `tests/recipes/recipes-client.test.ts`:
```ts
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { closeSmcDb, allOps, getRow } from "@/lib/sync/idb";
import { putRevision } from "@/lib/db/catalog-cache";
import { listRecipes, provisionalNutrients, recipeFoodRefId, saveRecipe } from "@/lib/recipes-client";

const rice = { seq: 1, foodRefId: "ref-rice", qty: 1, unit: "g", grams: 400,
  state: "cooked" as const, foodRevisionId: 11 };

beforeEach(async () => { await closeSmcDb(); globalThis.indexedDB = new IDBFactory(); });

describe("saveRecipe", () => {
  it("writes the local row and enqueues a create with a snake_case payload", async () => {
    const { recipeId, rev } = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    expect(rev).toBe(1);
    const row = await getRow("recipes", recipeId);
    expect(row).toMatchObject({ id: recipeId, name: "Rice tray", servings: 4, rev: 1 });
    const [op] = await allOps();
    expect(op).toMatchObject({ entity: "recipes", entity_id: recipeId, kind: "create", base_rev: null });
    expect(op.payload.items).toEqual([{ seq: 1, food_ref_id: "ref-rice", qty: 1, unit: "g",
      grams: 400, state: "cooked", food_revision_id: 11 }]);
  });

  it("enqueues an update carrying base_rev when she edits a saved recipe", async () => {
    const first = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    const second = await saveRecipe({ id: first.recipeId, baseRev: 1, name: "Rice tray",
      servings: 8, items: [rice] });
    expect(second.rev).toBe(2);
    const ops = await allOps();
    expect(ops[1]).toMatchObject({ kind: "update", base_rev: 1 });
  });

  it("lists saved recipes by name and skips tombstones", async () => {
    await saveRecipe({ name: "Zucchini bake", servings: 2, items: [rice] });
    await saveRecipe({ name: "Apple-free crumble", servings: 2, items: [rice] });
    expect((await listRecipes()).map((r) => r.name))
      .toEqual(["Apple-free crumble", "Zucchini bake"]);
  });
});

describe("provisionalNutrients and recipeFoodRefId", () => {
  it("reads per-100 g from the catalog cache", async () => {
    await putRevision({ revision_id: 11, catalog_food_id: 1, description: "Rice", brand: null,
      source: "fdc_sr_legacy", version_label: "v1", portions: [], cached_at: new Date().toISOString(),
      per_100g: { energy_kcal: 130, protein: 2.7, carbohydrate: 28, fat_total: 0.3, fiber_total: 0.4 } });
    const { perServing, coverage } = await provisionalNutrients([rice], 4);
    expect([perServing.energy_kcal, coverage]).toEqual([130, 1]);
  });

  it("has no food ref until the server answers", async () => {
    const { recipeId } = await saveRecipe({ name: "Rice tray", servings: 4, items: [rice] });
    expect(await recipeFoodRefId(recipeId)).toBeNull();
  });
});
```
- [ ] Run: `pnpm test tests/recipes/recipes-client.test.ts` → FAILS (`Cannot find module '@/lib/recipes-client'`).
- [ ] Write `lib/recipes-client.ts`:
```ts
/**
 * The client half of the recipes entity — Phase 3 spec, "Client changes".
 *
 * Local first: the row lands in IndexedDB and the op goes to the outbox, so a recipe saved on the
 * train is hers the moment she taps Save. The nutrients shown until the op lands are provisional,
 * computed from the cached catalog rows with lib/recipes/nutrients.ts; the server recomputes them
 * in SQL from compute_item_snapshot and its value wins on the next pull (architecture §3.3).
 */
import { getRevision } from "@/lib/db/catalog-cache";
import { computeRecipeNutrients, type Per100gByRef, type RecipeItemInput } from "@/lib/recipes/nutrients";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { allRows, getRow, putRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";

export type RecipeInput = {
  id?: string; name: string; servings: number; yieldGrams?: number | null;
  items: RecipeItemInput[]; baseRev?: number;
};

export type RecipeRow = {
  id: string; name: string; servings: number; yield_grams: number | null; rev: number;
  items: Record<string, unknown>[]; nutrients_per_serving: Record<string, number | null>;
  deleted_at?: string | null; food_ref_id?: string;
};

function wireItems(items: RecipeItemInput[]): Record<string, unknown>[] {
  return items.map((item) => ({ seq: item.seq, food_ref_id: item.foodRefId, qty: item.qty,
    unit: item.unit, grams: item.grams, state: item.state,
    food_revision_id: item.foodRevisionId ?? null }));
}

export async function provisionalNutrients(
  items: RecipeItemInput[], servings: number, yieldGrams?: number | null,
): Promise<{ perServing: Record<string, number | null>; coverage: number }> {
  const per100g: Per100gByRef = {};
  for (const item of items) {
    const cached = item.foodRevisionId == null ? undefined : await getRevision(item.foodRevisionId);
    // An item with no cached revision contributes an empty map, so it counts against coverage
    // rather than silently reading as measured.
    per100g[item.foodRefId] = (cached?.per_100g ?? {}) as Record<NutrientCode, number | null>;
  }
  return computeRecipeNutrients(items, per100g, servings, yieldGrams ?? undefined);
}

export async function saveRecipe(input: RecipeInput): Promise<{ recipeId: string; rev: number }> {
  const recipeId = input.id ?? crypto.randomUUID();
  const rev = (input.baseRev ?? 0) + 1;
  const payload = {
    id: recipeId, name: input.name, servings: input.servings,
    yield_grams: input.yieldGrams ?? null, items: wireItems(input.items),
  };
  const { perServing, coverage } = await provisionalNutrients(
    input.items, input.servings, input.yieldGrams);
  const existing = (await getRow("recipes", recipeId)) as RecipeRow | undefined;
  await putRow("recipes", recipeId, {
    ...existing, ...payload, rev, deleted_at: null,
    nutrients_per_serving: { ...perServing, coverage },
    updated_at: new Date().toISOString(),
  });
  await enqueue({
    op_id: crypto.randomUUID(), entity: "recipes", entity_id: recipeId,
    kind: input.baseRev === undefined ? "create" : "update",
    base_rev: input.baseRev ?? null, payload, client_ts: new Date().toISOString(),
  });
  return { recipeId, rev };
}

export async function listRecipes(): Promise<RecipeRow[]> {
  const rows = (await allRows("recipes")) as unknown as RecipeRow[];
  return rows.filter((row) => !row.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The registry row her recipe logs through. It is minted server-side by _sync_upsert and comes
 * back in the recipe's `current`, so it is null until the recipe's first op is applied — an
 * offline-created recipe is not loggable until the phone has synced once, and the sheet says so.
 */
export async function recipeFoodRefId(recipeId: string): Promise<string | null> {
  const row = (await getRow("recipes", recipeId)) as RecipeRow | undefined;
  return typeof row?.food_ref_id === "string" ? row.food_ref_id : null;
}
```
- [ ] Run: `pnpm test tests/recipes/recipes-client.test.ts` → PASSES (5 tests).
- [ ] Commit: `git add lib/recipes-client.ts tests/recipes && git commit -m "feat: save and list recipes from the client store"`

---

## Task 12 — `lib/favorites-client.ts` and `lib/water-client.ts`

**Files**
- Create: `lib/favorites-client.ts`, `lib/water-client.ts`
- Test: `tests/favorites/favorites-client.test.ts`, `tests/water/water-client.test.ts`

**Interfaces**
- Consumes: `allRows`, `getRow`, `putRow`, `openSmcDb`, `META_STORE` from `lib/sync/idb.ts`; `enqueue` from `lib/sync/outbox.ts`; `FavoriteRow`, `FavoriteKind`, `nextSort`, `pinnedAndRest` from `lib/favorites.ts`; `clampGoal`, `mergeCups` from `lib/water.ts`.
- Produces:
```ts
// lib/favorites-client.ts
export type FavoriteMeta = { name?: string; catalogFoodId?: number | null; revisionId?: number | null };
export async function toggleFavorite(kind: FavoriteKind, id: string, sort?: number,
  meta?: FavoriteMeta): Promise<boolean>;          // true = now starred
export async function listFavorites(): Promise<FavoriteRow[]>;
// lib/water-client.ts
export async function getWater(localDate: string): Promise<{ cups: number; goal: number }>;
export async function addCups(localDate: string, delta: number): Promise<number>;
export async function setGoal(cups: number): Promise<number>;
```

**Steps**

- [ ] Write the failing tests:
```ts
// tests/favorites/favorites-client.test.ts
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { allOps, closeSmcDb, putRow } from "@/lib/sync/idb";
import { listFavorites, toggleFavorite } from "@/lib/favorites-client";

const REF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => { await closeSmcDb(); globalThis.indexedDB = new IDBFactory(); });

describe("toggleFavorite", () => {
  it("stars a food with a create op keyed by food_ref_id", async () => {
    expect(await toggleFavorite("food", REF, undefined, { name: "Rice" })).toBe(true);
    const [op] = await allOps();
    expect(op).toMatchObject({ entity: "favorites_foods", entity_id: REF, kind: "create" });
    expect(op.payload).toEqual({ food_ref_id: REF, sort: 1 });
  });

  it("unstars with a delete op on the row's rev", async () => {
    await toggleFavorite("food", REF, undefined, { name: "Rice" });
    await putRow("favorites_foods", REF, { food_ref_id: REF, sort: 1, rev: 1 });
    expect(await toggleFavorite("food", REF)).toBe(false);
    const ops = await allOps();
    expect(ops.at(-1)).toMatchObject({ kind: "delete", base_rev: 1 });
  });

  it("lists foods, recipes and meals in sort order with their names", async () => {
    await toggleFavorite("food", REF, 2, { name: "Rice" });
    await putRow("recipes", "r1", { id: "r1", name: "Rice tray", rev: 1 });
    await putRow("favorites_recipes", "r1", { recipe_id: "r1", sort: 1, rev: 1 });
    const rows = await listFavorites();
    expect(rows.map((r) => [r.kind, r.name])).toEqual([["recipe", "Rice tray"], ["food", "Rice"]]);
  });
});
```
```ts
// tests/water/water-client.test.ts
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { allOps, closeSmcDb, getRow, putRow } from "@/lib/sync/idb";
import { addCups, getWater, setGoal } from "@/lib/water-client";

beforeEach(async () => { await closeSmcDb(); globalThis.indexedDB = new IDBFactory(); });

describe("water client", () => {
  it("adds a cup locally and never lets a subtraction go below zero", async () => {
    expect(await addCups("2026-09-19", 1)).toBe(1);
    expect(await addCups("2026-09-19", -3)).toBe(0);
    const ops = await allOps();
    expect(ops[0]).toMatchObject({ entity: "water_log", entity_id: "2026-09-19", kind: "create" });
  });

  it("keeps the larger count when the local row is already ahead", async () => {
    await putRow("water_log", "2026-09-19", { local_date: "2026-09-19", cups: 5, rev: 2 });
    expect(await addCups("2026-09-19", 1)).toBe(6);
    expect((await allOps())[0]).toMatchObject({ kind: "update", base_rev: 2 });
  });

  it("sends the whole settings row when she changes the goal", async () => {
    await putRow("user_settings", "settings", { rev: 4, first_opened_at: "2026-09-01T00:00:00.000Z",
      training_kcal: 2400, rest_kcal: 2100, protein_g: 150, protein_locked: true,
      slot_times: { coffee: "06:30" }, shift_minutes: 0, water_goal_cups: 8 });
    expect(await setGoal(10)).toBe(10);
    const [op] = await allOps();
    expect(op).toMatchObject({ entity: "user_settings", entity_id: "settings", base_rev: 4 });
    expect(op.payload).toMatchObject({ training_kcal: 2400, protein_g: 150, water_goal_cups: 10 });
    expect((await getRow("user_settings", "settings"))?.water_goal_cups).toBe(10);
  });

  it("clamps a goal into the column's range", async () => {
    expect(await setGoal(99)).toBe(30);
  });

  it("reads cups and goal together, defaulting the goal to 8", async () => {
    expect(await getWater("2026-09-19")).toEqual({ cups: 0, goal: 8 });
  });
});
```
- [ ] Run: `pnpm test tests/favorites/favorites-client.test.ts tests/water/water-client.test.ts` → FAILS (both modules missing).
- [ ] Write `lib/favorites-client.ts`:
```ts
/**
 * The client half of the three favorites entities — Phase 3 spec, "Client changes".
 *
 * A favorite's payload is only `{ sort }`, so the strip needs a name from somewhere: recipes and
 * saved meals carry theirs in their own store, and a starred food carries none — food_ref_id is a
 * registry uuid. `toggleFavorite` therefore records what she starred in a client-only name index
 * in the `meta` store. The index is a convenience, never a source of truth: a missing entry
 * renders "Saved food" rather than blocking the row.
 */
import { nextSort, type FavoriteKind, type FavoriteRow } from "@/lib/favorites";
import { allRows, getRow, META_STORE, openSmcDb, putRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import type { Entity } from "@/lib/sync/types";

export type FavoriteMeta = { name?: string; catalogFoodId?: number | null; revisionId?: number | null };

const NAME_INDEX_KEY = "favorite_names";
const ENTITY: Record<FavoriteKind, Entity> = {
  food: "favorites_foods", recipe: "favorites_recipes", meal: "favorites_meals",
};
const KEY_COLUMN: Record<FavoriteKind, string> = {
  food: "food_ref_id", recipe: "recipe_id", meal: "id",
};

type NameIndex = Record<string, FavoriteMeta>;

async function readIndex(): Promise<NameIndex> {
  return ((await (await openSmcDb()).get(META_STORE, NAME_INDEX_KEY)) as NameIndex | undefined) ?? {};
}

async function writeIndex(key: string, meta: FavoriteMeta): Promise<void> {
  const index = await readIndex();
  await (await openSmcDb()).put(META_STORE, { ...index, [key]: { ...index[key], ...meta } },
    NAME_INDEX_KEY);
}

/** Returns the new state: true when it is now starred. */
export async function toggleFavorite(
  kind: FavoriteKind, id: string, sort?: number, meta?: FavoriteMeta,
): Promise<boolean> {
  const entity = ENTITY[kind];
  const row = (await getRow(entity, id)) as Record<string, unknown> | undefined;
  const rev = typeof row?.rev === "number" ? row.rev : null;
  const now = new Date().toISOString();
  if (meta) await writeIndex(`${kind}:${id}`, meta);

  if (row && !row.deleted_at) {
    await putRow(entity, id, { ...row, deleted_at: now });
    await enqueue({ op_id: crypto.randomUUID(), entity, entity_id: id, kind: "delete",
      base_rev: rev, payload: {}, client_ts: now });
    return false;
  }
  if (row) {
    await putRow(entity, id, { ...row, deleted_at: null });
    await enqueue({ op_id: crypto.randomUUID(), entity, entity_id: id, kind: "restore",
      base_rev: rev, payload: {}, client_ts: now });
    return true;
  }
  if (kind === "meal") {
    throw new Error("favorites_meals: a saved meal is starred, not created, by toggleFavorite");
  }
  const existing = (await allRows(entity)) as { sort: number }[];
  const payload = { [KEY_COLUMN[kind]]: id, sort: sort ?? nextSort(existing) };
  await putRow(entity, id, { ...payload, rev: 1, deleted_at: null, updated_at: now });
  await enqueue({ op_id: crypto.randomUUID(), entity, entity_id: id, kind: "create",
    base_rev: null, payload, client_ts: now });
  return true;
}

export async function listFavorites(): Promise<FavoriteRow[]> {
  const index = await readIndex();
  const out: FavoriteRow[] = [];
  for (const kind of ["food", "recipe", "meal"] as FavoriteKind[]) {
    for (const row of (await allRows(ENTITY[kind])) as Record<string, unknown>[]) {
      if (row.deleted_at) continue;
      const id = String(row[KEY_COLUMN[kind]]);
      const meta = index[`${kind}:${id}`] ?? {};
      const owner = kind === "recipe" ? await getRow("recipes", id)
        : kind === "meal" ? row : undefined;
      out.push({
        kind, id, sort: Number(row.sort ?? 0),
        name: (owner?.name as string | undefined) ?? meta.name ?? "Saved food",
        foodRefId: kind === "food" ? id : undefined,
        catalogFoodId: meta.catalogFoodId ?? null, revisionId: meta.revisionId ?? null,
      });
    }
  }
  return out.sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
}
```
- [ ] Write `lib/water-client.ts`:
```ts
/**
 * The client half of water — Phase 3 spec, "Client changes".
 *
 * `addCups` applies the same max rule the server applies (`greatest`, migration 20260919090300),
 * so an offline tap and a later pull agree. `setGoal` sends the WHOLE user_settings row: Phase 0's
 * _sync_upsert replaces every column from the payload, so a payload carrying only the goal would
 * blank her targets and slot times.
 */
import { clampGoal, mergeCups } from "@/lib/water";
import { getRow, putRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";

const DEFAULT_GOAL = 8;
const SETTINGS_KEY = "settings";

type Settings = Record<string, unknown> & { rev?: number };

export async function getWater(localDate: string): Promise<{ cups: number; goal: number }> {
  const day = (await getRow("water_log", localDate)) as { cups?: number } | undefined;
  const settings = (await getRow("user_settings", SETTINGS_KEY)) as Settings | undefined;
  return {
    cups: Number(day?.cups ?? 0),
    goal: Number(settings?.water_goal_cups ?? DEFAULT_GOAL),
  };
}

export async function addCups(localDate: string, delta: number): Promise<number> {
  const row = (await getRow("water_log", localDate)) as
    { cups?: number; rev?: number } | undefined;
  const current = Number(row?.cups ?? 0);
  const next = delta >= 0
    ? mergeCups(current, current + delta)      // a cup she drank is never un-drunk
    : Math.max(0, current + delta);            // her own correction, applied as she asked
  const rev = typeof row?.rev === "number" ? row.rev : null;
  const payload = { local_date: localDate, cups: next };
  await putRow("water_log", localDate, { ...row, ...payload, rev: (rev ?? 0) + 1 });
  await enqueue({ op_id: crypto.randomUUID(), entity: "water_log", entity_id: localDate,
    kind: rev === null ? "create" : "update", base_rev: rev, payload,
    client_ts: new Date().toISOString() });
  return next;
}

export async function setGoal(cups: number): Promise<number> {
  const goal = clampGoal(cups);
  const settings = ((await getRow("user_settings", SETTINGS_KEY)) ?? {}) as Settings;
  const rev = typeof settings.rev === "number" ? settings.rev : null;
  const { rev: _rev, user_id: _userId, ...columns } = settings;
  void _rev; void _userId;
  const payload = { ...columns, water_goal_cups: goal };
  await putRow("user_settings", SETTINGS_KEY, { ...settings, water_goal_cups: goal });
  await enqueue({ op_id: crypto.randomUUID(), entity: "user_settings", entity_id: SETTINGS_KEY,
    kind: rev === null ? "create" : "update", base_rev: rev, payload,
    client_ts: new Date().toISOString() });
  return goal;
}
```
- [ ] Run: `pnpm test tests/favorites tests/water` → PASSES (11 tests).
- [ ] Commit: `git add lib/favorites-client.ts lib/water-client.ts tests/favorites tests/water && git commit -m "feat: add the favorites and water clients"`

---

## Task 13 — `components/WaterCard.tsx`

**Files**
- Create: `components/WaterCard.tsx`
- Test: `tests/water/water-card.test.tsx`

**Interfaces**
- Consumes: `getWater`, `addCups`, `setGoal` from `lib/water-client.ts`; `waterProgress` from `lib/water.ts`; `.shell`, `.surface`, `.pill`, `.pill-in`, `.tap`, `.ts` from `app/globals.css`.
- Produces: `export default function WaterCard({ localDate }: { localDate: string })`.

**Design.** The Also-today card from `Main.dc.html` line 149 — `.shell` + `.surface`, 16 px / 18 px padding, 6 px gap, the label at 12 px/300 `#6B6B6B`, the count at 28 px/300 with `-0.025em` tracking and a 14 px `#6B6B6B` unit. The ± pair is the `LogMeal.dc.html` serving stepper: a `.pill` around a `.pill-in`, two 44 × 44 px buttons at 18 px/300 `#4A4A4A`. The goal line is a 44 px-tall button that swaps to a second stepper, so the goal is editable inline and every target clears 44 px.

**Steps**

- [ ] Write the failing test `tests/water/water-card.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WaterCard from "@/components/WaterCard";

describe("WaterCard", () => {
  const markup = renderToStaticMarkup(<WaterCard localDate="2026-09-19" />);

  it("renders the count against the default goal", () => {
    expect(markup).toContain("cups");
    expect(markup).toContain("of 8");
  });

  it("gives both steppers a 44 px target and an accessible name", () => {
    expect(markup).toContain('aria-label="Add a cup"');
    expect(markup).toContain('aria-label="Remove a cup"');
    expect((markup.match(/width:44px;height:44px/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
```
- [ ] Run: `pnpm test tests/water/water-card.test.tsx` → FAILS (`Cannot find module '@/components/WaterCard'`).
- [ ] Write `components/WaterCard.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { addCups, getWater, setGoal } from "@/lib/water-client";
import { waterProgress } from "@/lib/water";

/* Card from Main.dc.html "Also today"; stepper from the LogMeal.dc.html serving control. */
const STEP: React.CSSProperties = { width: 44, height: 44, borderRadius: 9999,
  color: "#4A4A4A", fontSize: 18, fontWeight: 300 };
const LABEL: React.CSSProperties = { fontSize: 12, fontWeight: 300, color: "#6B6B6B" };

export default function WaterCard({ localDate }: { localDate: string }) {
  const [cups, setCups] = useState(0);
  const [goal, setGoalState] = useState(8);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let live = true;
    void getWater(localDate).then((w) => {
      if (!live) return;
      setCups(w.cups);
      setGoalState(w.goal);
    });
    return () => { live = false; };
  }, [localDate]);

  async function step(delta: number) {
    setCups(await addCups(localDate, delta));
  }

  async function stepGoal(delta: number) {
    setGoalState(await setGoal(goal + delta));
  }

  const { pct, met } = waterProgress(cups, goal);

  return (
    <div className="shell">
      <div className="surface flex flex-col gap-1.5" style={{ padding: "16px 18px" }}>
        <div className="flex items-center justify-between gap-2">
          <span style={LABEL}>Water</span>
          <button type="button" onClick={() => setEditing((open) => !open)}
            aria-expanded={editing} aria-label="Change the water goal"
            className="tap flex items-center px-2" style={LABEL}>
            of {goal}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="ts tabular-nums" style={{ fontSize: 28, fontWeight: 300,
            letterSpacing: "-0.025em", lineHeight: 1 }}>
            {cups} <span style={{ fontSize: 14, color: "#6B6B6B" }}>cups</span>
          </span>
          <div className="pill inline-flex shrink-0">
            <div className="pill-in flex items-center">
              <button type="button" aria-label="Remove a cup" onClick={() => void step(-1)}
                className="flex items-center justify-center" style={STEP}>−</button>
              <button type="button" aria-label="Add a cup" onClick={() => void step(1)}
                className="flex items-center justify-center" style={STEP}>+</button>
            </div>
          </div>
        </div>
        <div aria-hidden="true" style={{ height: 4, borderRadius: 9999, background: "rgba(0,0,0,0.05)" }}>
          <div style={{ width: `${pct}%`, height: 4, borderRadius: 9999,
            background: met ? "linear-gradient(90deg,#6B7059,#8C917A)" : "rgba(0,0,0,0.18)" }} />
        </div>
        {editing && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <span style={LABEL}>Daily goal</span>
            <div className="pill inline-flex shrink-0">
              <div className="pill-in flex items-center">
                <button type="button" aria-label="Lower the goal" onClick={() => void stepGoal(-1)}
                  className="flex items-center justify-center" style={STEP}>−</button>
                <span className="ts tabular-nums text-center" style={{ minWidth: 44, fontSize: 13 }}>
                  {goal}
                </span>
                <button type="button" aria-label="Raise the goal" onClick={() => void stepGoal(1)}
                  className="flex items-center justify-center" style={STEP}>+</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```
- [ ] Run: `pnpm test tests/water/water-card.test.tsx` → PASSES (2 tests).
- [ ] **[manual gate]** On her phone at integration: tap + four times, confirm the count and the bar move, open the goal stepper, set 10, reload and confirm 10 survives, then confirm the same count on the laptop after a sync.
- [ ] Commit: `git add components/WaterCard.tsx tests/water && git commit -m "feat: add the water card"`

---

## Task 14 — `components/FavoritesStrip.tsx`

**Files**
- Create: `components/FavoritesStrip.tsx`
- Test: `tests/favorites/favorites-strip.test.tsx`

**Interfaces**
- Consumes: `listFavorites` from `lib/favorites-client.ts`; `pinnedAndRest`, `FavoriteRow` from `lib/favorites.ts`; `next/link`.
- Produces:
```tsx
export function favoriteHref(row: FavoriteRow): string;   // "/recipes" | "/foods" | "/"
export default function FavoritesStrip({ initial, onPick }: {
  initial?: FavoriteRow[]; onPick?: (row: FavoriteRow) => void }): JSX.Element | null;
```

**Design.** A horizontal `overflow-x-auto` row of `.pill`/`.pill-in` chips, 44 px tall, 12 px/400 `#4A4A4A` label, `Foods.dc.html` line 25. Twelve pinned; the thirteenth chip is **All**, which reveals the rest in the same row. With no `onPick` (the Foods tab) each chip is a `Link`, so no tap is dead.

**Steps**

- [ ] Write the failing test `tests/favorites/favorites-strip.test.tsx`:
```tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FavoritesStrip, { favoriteHref } from "@/components/FavoritesStrip";
import type { FavoriteRow } from "@/lib/favorites";

const rows: FavoriteRow[] = Array.from({ length: 14 }, (_, i) =>
  ({ kind: "food", id: `f${i}`, name: `Food ${i}`, sort: i }));

describe("FavoritesStrip", () => {
  it("renders nothing when she has no favorites", () => {
    expect(renderToStaticMarkup(<FavoritesStrip initial={[]} />)).toBe("");
  });

  it("pins twelve and offers All for the rest", () => {
    const markup = renderToStaticMarkup(<FavoritesStrip initial={rows} />);
    expect(markup).toContain("Food 0");
    expect(markup).not.toContain("Food 12");
    expect(markup).toContain("All");
  });

  it("sends each kind somewhere real when no onPick is given", () => {
    expect(favoriteHref({ kind: "recipe", id: "r", name: "R", sort: 1 })).toBe("/recipes");
    expect(favoriteHref({ kind: "food", id: "f", name: "F", sort: 1 })).toBe("/foods");
    expect(favoriteHref({ kind: "meal", id: "m", name: "M", sort: 1 })).toBe("/");
  });
});
```
- [ ] Run: `pnpm test tests/favorites/favorites-strip.test.tsx` → FAILS (module missing).
- [ ] Write `components/FavoritesStrip.tsx`:
```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { listFavorites } from "@/lib/favorites-client";
import { pinnedAndRest, type FavoriteRow } from "@/lib/favorites";

const CHIP: React.CSSProperties = { height: 44, padding: "0 14px", fontSize: 12,
  fontWeight: 400, color: "#4A4A4A" };

/** Where a chip goes when the host screen has no pick handler (the Foods tab). */
export function favoriteHref(row: FavoriteRow): string {
  if (row.kind === "recipe") return "/recipes";
  if (row.kind === "food") return "/foods";
  return "/";
}

export default function FavoritesStrip({ initial, onPick }: {
  initial?: FavoriteRow[]; onPick?: (row: FavoriteRow) => void;
}) {
  const [rows, setRows] = useState<FavoriteRow[]>(initial ?? []);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let live = true;
    void listFavorites().then((next) => { if (live) setRows(next); });
    return () => { live = false; };
  }, []);

  if (rows.length === 0) return null;
  const { pinned, rest } = pinnedAndRest(rows);
  const shown = showAll ? [...pinned, ...rest] : pinned;

  return (
    <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Favorites">
      {shown.map((row) => (
        <div key={`${row.kind}:${row.id}`} className="pill inline-flex shrink-0">
          {onPick ? (
            <button type="button" onClick={() => onPick(row)}
              className="pill-in tap ts flex items-center whitespace-nowrap" style={CHIP}>
              {row.name}
            </button>
          ) : (
            <Link href={favoriteHref(row)}
              className="pill-in tap ts flex items-center whitespace-nowrap" style={CHIP}>
              {row.name}
            </Link>
          )}
        </div>
      ))}
      {rest.length > 0 && !showAll && (
        <div className="pill inline-flex shrink-0">
          <button type="button" onClick={() => setShowAll(true)}
            className="pill-in tap ts flex items-center whitespace-nowrap" style={CHIP}>
            All ({rows.length})
          </button>
        </div>
      )}
    </div>
  );
}
```
- [ ] Run: `pnpm test tests/favorites/favorites-strip.test.tsx` → PASSES (3 tests).
- [ ] Commit: `git add components/FavoritesStrip.tsx tests/favorites && git commit -m "feat: add the favorites strip"`

---

## Task 15 — `components/RecipeItemRow.tsx` and `components/RecipeSheet.tsx`

**Files**
- Create: `components/RecipeItemRow.tsx`, `components/RecipeSheet.tsx`
- Test: `tests/recipes/recipe-sheet.test.tsx`

**Interfaces**
- Consumes: `Sheet` from `components/Sheet.tsx`; `Stepper` from `components/Stepper.tsx`; `CatalogSearch` + `CatalogRow` from `components/CatalogSearch.tsx` / `lib/catalog-client.ts`; `saveRecipe`, `provisionalNutrients` from `lib/recipes-client.ts`; `recipeInputGrams`, `servingGrams`, `RecipeItemInput` from `lib/recipes/nutrients.ts`; `Food` from `lib/foods.ts`.
- Produces:
```tsx
// components/RecipeItemRow.tsx
export default function RecipeItemRow({ item, name, onGrams, onRemove }: {
  item: RecipeItemInput; name: string; onGrams: (grams: number) => void; onRemove: () => void });
// components/RecipeSheet.tsx
export function nextVersionCopy(rev: number): string;   // "Saving creates version N+1"
export default function RecipeSheet({ recipe, mine, onClose, onSaved }: {
  recipe?: RecipeRow; mine: Record<string, Food>; onClose: () => void;
  onSaved: (result: { recipeId: string; rev: number }) => void });
```

**Steps**

- [ ] Write the failing test `tests/recipes/recipe-sheet.test.tsx`:
```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RecipeItemRow from "@/components/RecipeItemRow";
import { nextVersionCopy } from "@/components/RecipeSheet";

vi.mock("@/components/Sheet", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

describe("RecipeSheet copy", () => {
  it("tells her which version a save creates", () => {
    expect(nextVersionCopy(1)).toBe("Saving creates version 2.");
    expect(nextVersionCopy(0)).toBe("Saving creates version 1.");
  });
});

describe("RecipeItemRow", () => {
  it("shows the food, its grams and a remove target", () => {
    const markup = renderToStaticMarkup(
      <RecipeItemRow name="Jasmine rice, cooked" onGrams={() => {}} onRemove={() => {}}
        item={{ seq: 1, foodRefId: "r", qty: 1, unit: "g", grams: 180, state: "cooked" }} />);
    expect(markup).toContain("Jasmine rice, cooked");
    expect(markup).toContain("180");
    expect(markup).toContain('aria-label="Remove Jasmine rice, cooked"');
  });
});
```
- [ ] Run: `pnpm test tests/recipes/recipe-sheet.test.tsx` → FAILS (both modules missing).
- [ ] Write `components/RecipeItemRow.tsx`:
```tsx
"use client";

import Stepper from "@/components/Stepper";
import type { RecipeItemInput } from "@/lib/recipes/nutrients";

/* Row shape from LogMeal.dc.html "In this meal": 12/14 px padding, 14 px/400 title,
   12 px/300 #6B6B6B meta, the serving stepper on the right. */
export default function RecipeItemRow({ item, name, onGrams, onRemove }: {
  item: RecipeItemInput; name: string; onGrams: (grams: number) => void; onRemove: () => void;
}) {
  return (
    <div className="shell">
      <div className="surface flex flex-col gap-2" style={{ borderRadius: 16, padding: "12px 14px" }}>
        <div className="flex items-center justify-between gap-3">
          <span className="ts min-w-0 flex-grow truncate" style={{ fontSize: 14, fontWeight: 400 }}>
            {name}
          </span>
          <button type="button" onClick={onRemove} aria-label={`Remove ${name}`}
            className="tap flex shrink-0 items-center justify-center"
            style={{ width: 44, height: 44, borderRadius: 9999, color: "#4A4A4A" }}>
            ×
          </button>
        </div>
        <Stepper label={`${name} grams`} value={item.grams} step={10} unit="g"
          onChange={(next) => onGrams(Math.max(0, next))} />
      </div>
    </div>
  );
}
```
- [ ] Write `components/RecipeSheet.tsx`:
```tsx
"use client";

import { useMemo, useState } from "react";
import CatalogSearch from "@/components/CatalogSearch";
import RecipeItemRow from "@/components/RecipeItemRow";
import Sheet from "@/components/Sheet";
import Stepper from "@/components/Stepper";
import type { CatalogRow } from "@/lib/catalog-client";
import type { Food } from "@/lib/foods";
import { resolveFoodRef } from "@/lib/log-client";
import { recipeInputGrams, servingGrams, type RecipeItemInput } from "@/lib/recipes/nutrients";
import { provisionalNutrients, saveRecipe, type RecipeRow } from "@/lib/recipes-client";

/** Phase 3 spec, "Client changes": editing shows "saving creates version N+1". */
export function nextVersionCopy(rev: number): string {
  return `Saving creates version ${rev + 1}.`;
}

type Draft = RecipeItemInput & { name: string };

export default function RecipeSheet({ recipe, mine, onClose, onSaved }: {
  recipe?: RecipeRow; mine: Record<string, Food>; onClose: () => void;
  onSaved: (result: { recipeId: string; rev: number }) => void;
}) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [servings, setServings] = useState(recipe?.servings ?? 4);
  const [yieldGrams, setYieldGrams] = useState<number | null>(recipe?.yield_grams ?? null);
  const [items, setItems] = useState<Draft[]>([]);
  const [strip, setStrip] = useState<{ kcal: number; coverage: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const totalGrams = useMemo(() => recipeInputGrams(items), [items]);

  async function refreshStrip(next: Draft[], nextServings: number, nextYield: number | null) {
    const { perServing, coverage } = await provisionalNutrients(next, nextServings, nextYield);
    setStrip({ kcal: Math.round(Number(perServing.energy_kcal ?? 0)), coverage });
  }

  async function addFood(row: CatalogRow) {
    if (row.catalogFoodId === null) return;
    const foodRefId = await resolveFoodRef(row.catalogFoodId);
    if (!foodRefId) return;
    const next: Draft[] = [...items, { seq: items.length + 1, foodRefId, qty: 1, unit: "g",
      grams: 100, state: "cooked", foodRevisionId: row.revisionId ?? null, name: row.description }];
    setItems(next);
    await refreshStrip(next, servings, yieldGrams);
  }

  async function save() {
    setSaving(true);
    const result = await saveRecipe({ id: recipe?.id, baseRev: recipe?.rev, name, servings,
      yieldGrams, items });
    setSaving(false);
    onSaved(result);
  }

  return (
    <Sheet title={recipe ? "Edit recipe" : "New recipe"}
      subtitle={nextVersionCopy(recipe?.rev ?? 0)} onClose={onClose}
      footer={
        <button type="button" className="btn-ink tap w-full" disabled={saving || items.length === 0}
          onClick={() => void save()} style={{ height: 52, fontSize: 14, fontWeight: 400 }}>
          {saving ? "Saving…" : "Save recipe"}
        </button>
      }>
      <div className="flex flex-col gap-4">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Recipe name"
          placeholder="Rice and chicken tray"
          className="well h-12 px-4 text-body-sm font-light text-charcoal outline-none" />
        <Stepper label="Servings" value={servings} step={1}
          onChange={(next) => { const v = Math.max(1, next); setServings(v);
            void refreshStrip(items, v, yieldGrams); }} />
        <Stepper label="Cooked weight" value={yieldGrams ?? 0} step={50} unit="g"
          helperText="Optional — only needed to turn “I ate 150 g” into a serving fraction."
          onChange={(next) => { const v = next <= 0 ? null : next; setYieldGrams(v);
            void refreshStrip(items, servings, v); }} />

        <div className="flex items-center justify-between gap-3 px-1.5">
          <span className="ts" style={{ fontSize: 12, fontWeight: 400, color: "#4A4A4A" }}>
            {items.length === 0 ? "Add what goes in it" : `${items.length} items · ${totalGrams} g`}
          </span>
          {strip && (
            <span className="tabular-nums" style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
              {strip.kcal} kcal a serving · {servingGrams(totalGrams, servings, yieldGrams ?? undefined)} g
              {strip.coverage < 1 && " · some nutrients unmeasured"}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {items.map((item, i) => (
            <RecipeItemRow key={`${item.foodRefId}-${item.seq}`} item={item} name={item.name}
              onGrams={(grams) => { const next = items.map((it, j) => j === i ? { ...it, grams } : it);
                setItems(next); void refreshStrip(next, servings, yieldGrams); }}
              onRemove={() => { const next = items.filter((_, j) => j !== i)
                .map((it, j) => ({ ...it, seq: j + 1 }));
                setItems(next); void refreshStrip(next, servings, yieldGrams); }} />
          ))}
        </div>

        <CatalogSearch mine={mine} onPick={(row) => void addFood(row)} />
      </div>
    </Sheet>
  );
}
```
- [ ] Run: `pnpm test tests/recipes/recipe-sheet.test.tsx` → PASSES (2 tests).
- [ ] **[manual gate]** On her phone at integration: save a four-serving tray, log one serving, edit it to six servings, confirm the subtitle reads "Saving creates version 2." and the earlier log's numbers do not move.
- [ ] Commit: `git add components/RecipeItemRow.tsx components/RecipeSheet.tsx tests/recipes && git commit -m "feat: add the recipe sheet and item row"`

---

## Task 16 — `app/recipes/page.tsx` and the Foods mounts

**Files**
- Create: `app/recipes/page.tsx`
- Modify: `app/foods/page.tsx` (line 1 imports; line 23 `<h1>`; line 26 `<MyFoods />`)
- Test: `tests/recipes/recipes-page.test.tsx`

**Interfaces**
- Consumes: `listRecipes`, `RecipeRow` from `lib/recipes-client.ts`; `RecipeSheet`; `FavoritesStrip`; `getFoods` from `lib/store.ts`.
- Produces: the `/recipes` route and the two Foods mounts. `TabBar` is not this lane's file — Recipes is reached from Foods.

**Steps**

- [ ] Write the failing test `tests/recipes/recipes-page.test.tsx`:
```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import FoodsPage from "@/app/foods/page";

vi.mock("@/components/MyFoods", () => ({ default: () => <div data-testid="my-foods" /> }));
vi.mock("@/components/FoodsReference", () => ({ default: () => <div /> }));

describe("the Foods tab", () => {
  it("mounts the favorites strip above her food list and links to Recipes", () => {
    const markup = renderToStaticMarkup(<FoodsPage />);
    expect(markup).toContain('aria-label="Favorites"');
    expect(markup).toContain('href="/recipes"');
    expect(markup.indexOf('aria-label="Favorites"'))
      .toBeLessThan(markup.indexOf('data-testid="my-foods"'));
  });
});
```
  (the strip renders `null` with no favorites, so seed one first: `vi.mock("@/lib/favorites-client", () => ({ listFavorites: async () => [] }))` and pass `initial` from the page — see the edit below, which gives the strip no `initial`, so instead assert on the wrapper `<section aria-label="Favorites">` the page renders around it.)
- [ ] Run: `pnpm test tests/recipes/recipes-page.test.tsx` → FAILS (no strip, no link).
- [ ] Edit `app/foods/page.tsx` — the import block and the body above `<MyFoods />`:
```tsx
import Link from "next/link";
import FavoritesStrip from "@/components/FavoritesStrip";
import FoodsReference from "@/components/FoodsReference";
import MyFoods from "@/components/MyFoods";
```
```tsx
      <div className="flex items-center justify-between gap-3 px-1">
        <h1 className="ts m-0 text-display-md font-light leading-none tracking-display-md text-charcoal">
          Foods
        </h1>
        <div className="pill inline-flex shrink-0">
          <Link href="/recipes" className="pill-in tap ts flex items-center px-4"
            style={{ height: 44, fontSize: 12, fontWeight: 400, color: "#4A4A4A" }}>
            Recipes
          </Link>
        </div>
      </div>
      <section aria-label="Favorites">
        <FavoritesStrip />
      </section>
      <MyFoods />
```
- [ ] Write `app/recipes/page.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import RecipeSheet from "@/components/RecipeSheet";
import { listRecipes, type RecipeRow } from "@/lib/recipes-client";
import { getFoods } from "@/lib/store";

export default function RecipesPage() {
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [open, setOpen] = useState<RecipeRow | "new" | null>(null);

  async function refresh() {
    setRecipes(await listRecipes());
  }

  useEffect(() => { void refresh(); }, []);

  return (
    <MotionConfig reducedMotion="user">
      <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 pb-8"
        style={{ paddingTop: "calc(var(--safe-top) + 20px)" }}>
        <div className="flex items-center justify-between gap-3 px-1">
          <h1 className="ts m-0 text-display-md font-light leading-none tracking-display-md text-charcoal">
            Recipes
          </h1>
          <div className="pill inline-flex shrink-0">
            <button type="button" onClick={() => setOpen("new")}
              className="pill-in tap ts flex items-center px-4"
              style={{ height: 44, fontSize: 12, fontWeight: 400, color: "#4A4A4A" }}>
              New
            </button>
          </div>
        </div>

        {recipes.length === 0 && (
          <p className="px-1.5" style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
            Nothing saved yet. A recipe is a tray you make often — save it once, log a serving after.
          </p>
        )}

        <div className="flex flex-col gap-3">
          {recipes.map((recipe) => (
            <button key={recipe.id} type="button" onClick={() => setOpen(recipe)}
              className="shell tap w-full text-left">
              <span className="surface flex flex-col gap-1" style={{ padding: "16px 18px" }}>
                <span className="ts" style={{ fontSize: 16, fontWeight: 400, color: "#2B2B2B" }}>
                  {recipe.name}
                </span>
                <span style={{ fontSize: 12, fontWeight: 300, color: "#6B6B6B" }}>
                  {recipe.servings} servings · version {recipe.rev}
                  {Number(recipe.nutrients_per_serving?.energy_kcal ?? 0) > 0 &&
                    ` · ${Math.round(Number(recipe.nutrients_per_serving.energy_kcal))} kcal a serving`}
                </span>
              </span>
            </button>
          ))}
        </div>

        <AnimatePresence>
          {open && (
            <RecipeSheet key="recipe-sheet" mine={getFoods()}
              recipe={open === "new" ? undefined : open}
              onClose={() => setOpen(null)}
              onSaved={() => { setOpen(null); void refresh(); }} />
          )}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}
```
- [ ] Run: `pnpm test tests/recipes/recipes-page.test.tsx` → PASSES.
- [ ] Commit: `git add app/recipes app/foods tests/recipes && git commit -m "feat: add the recipes screen and mount favorites on Foods"`

---

## Task 17 — Export kinds `recipes`, `favorites` and `water`

**Files**
- Modify: `lib/server/export.ts` (line 36 the `*_COLUMNS` block; append the three streams after `streamProgress`)
- Modify: `app/api/export/route.ts` (line 25 `STREAMED`; line 30 `type Kind`; line 33 `SOURCES`; line 122 `streamed()`)
- Modify: `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §3 (two lines; the contract's own rule is that a change lands there first — see the first step below)
- Test: `tests/export/phase3-kinds.test.ts`

**Interfaces**
- Consumes: `escapeCell`, `csvDocument`, `ODBL_NOTICE` from `lib/export/csv.ts`; `HttpError` from `lib/server/auth.ts`; `ExportOpts`, `ExportJson` from `lib/server/export.ts`; `requireUser`, `enforceRateLimit`, `jsonError` (route, unchanged order).
- Produces:
```ts
export const RECIPE_COLUMNS: string[];    // recipe_id name revision_rev created_at servings seq
                                          // food_ref_id description grams energy_kcal protein_g
                                          // carbohydrate_g fat_g fiber_g
export const FAVORITE_COLUMNS: string[];  // kind id name sort added_at
export const WATER_COLUMNS: string[];     // local_date cups goal
export function encodeTextCursor(value: string): string;
export function decodeTextCursor(raw: string): string;
export function recipeRowValues(row: RecipeExportRow): (string | number | null)[];
export function favoriteRowValues(row: FavoriteExportRow): (string | number | null)[];
export function waterRowValues(row: WaterExportRow): (string | number | null)[];
export async function streamRecipes(client, userId, opts): Promise<ExportJson<RecipeExportRow>>;
export async function streamFavorites(client, userId, opts): Promise<ExportJson<FavoriteExportRow>>;
export async function streamWater(client, userId, opts): Promise<ExportJson<WaterExportRow>>;
```
`favoriteRowValues`' `added_at` reads `favorites_foods`/`favorites_recipes`/`favorites_meals.created_at` (Task 1), not `updated_at` — resolves Open question 3.

**Paging and the ODbL notice.** These three follow the Phase 2 streamed shape, not Phase 0's buffered `page=`: `from`/`to`/`limit`/`cursor`, JSON `{ rows, next_cursor, notices }`, CSV through `csvDocument` so `escapeCell` guards `= + - @` and the notices trail as `# …` comment lines. `recipes` pages by recipe id and emits every revision-item of each recipe on the page, so a recipe is never split across a page boundary; `favorites` pages by `${kind}:${id}`; `water` pages by `local_date`. A recipe item whose food came from Open Food Facts puts `ODBL_NOTICE` in `notices`, the same mechanism `streamMeals` already uses. Contracts §3 literally says "ODbL notice column"; the first step below lands the contract-change commit that reconciles that sentence with the Phase 2 `notices[]` mechanism this task actually implements, so the column lists stay exact and the contract stops disagreeing with the shipped code (resolves Open question 4).

**Steps**

- [ ] Commit the contract change first, in `00-contracts.md` §3, reconciling the "ODbL notice column" sentence with the Phase 2 mechanism this task uses:
```
Export attribution for recipes, favorites and water follows the Phase 2 streamed pattern exactly:
a JSON `notices[]` array plus trailing `# …` CSV comment lines, the same mechanism `streamMeals`
already ships — not a literal per-row attribution column. "ODbL notice column" above described the
intent, not the wire shape; this is that reconciliation.
```
  **Already landed in `00-contracts.md` (2026-09-11)** — read the contract section and confirm it says this; do not commit a contract change (docs: phase-3-4 contract change — export attribution is notices[], not a column)
- [ ] Write the failing test `tests/export/phase3-kinds.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { csvDocument } from "@/lib/export/csv";
import { decodeTextCursor, encodeTextCursor, FAVORITE_COLUMNS, favoriteRowValues,
  RECIPE_COLUMNS, recipeRowValues, WATER_COLUMNS, waterRowValues } from "@/lib/server/export";

describe("phase 3 export columns", () => {
  it("names the recipe columns the contract names, in order", () => {
    expect(RECIPE_COLUMNS).toEqual(["recipe_id", "name", "revision_rev", "created_at", "servings",
      "seq", "food_ref_id", "description", "grams", "energy_kcal", "protein_g",
      "carbohydrate_g", "fat_g", "fiber_g"]);
    expect(FAVORITE_COLUMNS).toEqual(["kind", "id", "name", "sort", "added_at"]);
    expect(WATER_COLUMNS).toEqual(["local_date", "cups", "goal"]);
  });

  it("maps a row into column order and leaves an unmeasured nutrient null", () => {
    const values = recipeRowValues({ recipe_id: "r1", name: "Rice tray", revision_rev: 2,
      created_at: "2026-09-19T10:00:00.000Z", servings: 4, seq: 1, food_ref_id: "ref",
      description: "Rice, white, cooked", grams: 400, energy_kcal: 130, protein_g: 2.7,
      carbohydrate_g: 28, fat_g: 0.3, fiber_g: null });
    expect(values.at(0)).toBe("r1");
    expect(values.at(-1)).toBeNull();
  });

  it("guards a formula-leading favorite name and trails the ODbL notice", () => {
    const csv = csvDocument(FAVORITE_COLUMNS,
      [favoriteRowValues({ kind: "food", id: "f1", name: "=cmd|calc", sort: 1,
        added_at: "2026-09-19T10:00:00.000Z" })],
      ["Data from Open Food Facts, licensed under the Open Database License (ODbL)."]);
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain("# Data from Open Food Facts");
  });

  it("round-trips a text cursor and refuses a malformed one", () => {
    expect(decodeTextCursor(encodeTextCursor("food:f1"))).toBe("food:f1");
    expect(() => decodeTextCursor("%%%")).toThrow();
  });

  it("reports water with the goal alongside the count", () => {
    expect(waterRowValues({ local_date: "2026-09-19", cups: 5, goal: 8 }))
      .toEqual(["2026-09-19", 5, 8]);
  });
});
```
- [ ] Run: `pnpm test tests/export/phase3-kinds.test.ts` → FAILS (`RECIPE_COLUMNS` is not exported).
- [ ] Append to `lib/server/export.ts`:
```ts
export type RecipeExportRow = Nutr & { recipe_id: string; name: string; revision_rev: number;
  created_at: string; servings: number; seq: number; food_ref_id: string; description: string;
  grams: number };
export type FavoriteExportRow = { kind: string; id: string; name: string; sort: number;
  added_at: string };
export type WaterExportRow = { local_date: string; cups: number; goal: number };

export const RECIPE_COLUMNS = ["recipe_id", "name", "revision_rev", "created_at", "servings",
  "seq", "food_ref_id", "description", "grams", "energy_kcal", "protein_g", "carbohydrate_g",
  "fat_g", "fiber_g"];
export const FAVORITE_COLUMNS = ["kind", "id", "name", "sort", "added_at"];
export const WATER_COLUMNS = ["local_date", "cups", "goal"];

/** These three page by one opaque string (a recipe id, a `kind:id` pair, a date), not by the
 *  (local_date, eaten_at, id) triple the log needs. */
export function encodeTextCursor(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeTextCursor(raw: string): string {
  const value = Buffer.from(raw, "base64url").toString("utf8");
  if (value.length === 0) throw new HttpError(422, "bad_request", "malformed cursor");
  return value;
}

function values(columns: string[], row: object): (string | number | null)[] {
  return columns.map((c) => (row as Record<string, string | number | null>)[c] ?? null);
}

export function recipeRowValues(row: RecipeExportRow) { return values(RECIPE_COLUMNS, row); }
export function favoriteRowValues(row: FavoriteExportRow) { return values(FAVORITE_COLUMNS, row); }
export function waterRowValues(row: WaterExportRow) { return values(WATER_COLUMNS, row); }

/** food_ref_id → the food's display name and the source it came from (for the ODbL notice). */
async function refDetails(client: SupabaseClient, refIds: string[]) {
  const out = new Map<string, { description: string; source: string }>();
  if (refIds.length === 0) return out;
  const refs = await client.from("food_refs")
    .select("id, catalog_food_id, user_food_id, user_foods(name)").in("id", refIds);
  if (refs.error) throw refs.error;
  const catalogIds = (refs.data ?? []).map((r) => r.catalog_food_id as number | null)
    .filter((v): v is number => v != null);
  const byId = new Map<number, { description: string; source: string }>();
  if (catalogIds.length > 0) {
    const [revs, foods] = await Promise.all([
      client.from("catalog_food_revisions").select("catalog_food_id, description")
        .in("catalog_food_id", catalogIds).eq("is_active", true),
      client.from("catalog_foods").select("id, source").in("id", catalogIds),
    ]);
    if (revs.error) throw revs.error;
    if (foods.error) throw foods.error;
    const sources = new Map((foods.data ?? []).map((f) => [f.id as number, f.source as string]));
    for (const r of revs.data ?? []) {
      byId.set(r.catalog_food_id as number, { description: r.description as string,
        source: sources.get(r.catalog_food_id as number) ?? "" });
    }
  }
  for (const ref of refs.data ?? []) {
    const own = (ref as unknown as { user_foods?: { name: string } | null }).user_foods;
    const cat = ref.catalog_food_id == null ? undefined : byId.get(ref.catalog_food_id as number);
    out.set(ref.id as string, { description: own?.name ?? cat?.description ?? "(unknown food)",
      source: own ? "user" : cat?.source ?? "" });
  }
  return out;
}

/** One row per revision item, every revision, so an edit's history exports with it. */
export async function streamRecipes(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<RecipeExportRow>> {
  let query = client.from("recipes")
    .select("id, name, servings, recipe_revisions(id, rev, created_at, nutrients_per_serving, " +
      "recipe_items(seq, grams, food_ref_id))")
    .eq("user_id", userId).is("deleted_at", null);
  if (opts.cursor) query = query.gt("id", decodeTextCursor(opts.cursor));
  const { data, error } = await query.order("id", { ascending: true }).limit(opts.limit + 1);
  if (error) throw error;

  type Rev = { rev: number; created_at: string; nutrients_per_serving: Record<string, number | null>;
    recipe_items: { seq: number; grams: number; food_ref_id: string }[] };
  type Recipe = { id: string; name: string; servings: number; recipe_revisions: Rev[] };
  const all = (data ?? []) as unknown as Recipe[];
  const hasMore = all.length > opts.limit;
  const page = hasMore ? all.slice(0, opts.limit) : all;
  const details = await refDetails(client, [...new Set(page.flatMap((r) =>
    r.recipe_revisions.flatMap((v) => v.recipe_items.map((i) => i.food_ref_id))))]);

  const rows: RecipeExportRow[] = [];
  const notices = new Set<string>();
  for (const recipe of page) {
    for (const revision of [...recipe.recipe_revisions].sort((a, b) => a.rev - b.rev)) {
      const n = revision.nutrients_per_serving ?? {};
      for (const item of [...revision.recipe_items].sort((a, b) => a.seq - b.seq)) {
        const detail = details.get(item.food_ref_id);
        if (detail?.source === "off") notices.add(ODBL_NOTICE);
        rows.push({ recipe_id: recipe.id, name: recipe.name, revision_rev: revision.rev,
          created_at: revision.created_at, servings: Number(recipe.servings), seq: item.seq,
          food_ref_id: item.food_ref_id, description: detail?.description ?? "(unknown food)",
          grams: Number(item.grams),
          energy_kcal: n.energy_kcal ?? null, protein_g: n.protein ?? null,
          carbohydrate_g: n.carbohydrate ?? null, fat_g: n.fat_total ?? null,
          fiber_g: n.fiber_total ?? null });
      }
    }
  }
  const last = page.at(-1);
  return { rows, notices: [...notices],
    next_cursor: hasMore && last ? encodeTextCursor(last.id) : null };
}

export async function streamFavorites(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<FavoriteExportRow>> {
  // added_at reads created_at, not updated_at: a re-sort touches updated_at on every one of these
  // rows, and "date added" must not move just because she reordered the strip (contracts §3).
  const [foods, recipes, meals] = await Promise.all([
    client.from("favorites_foods").select("food_ref_id, sort, created_at")
      .eq("user_id", userId).is("deleted_at", null),
    client.from("favorites_recipes").select("recipe_id, sort, created_at, recipes(name)")
      .eq("user_id", userId).is("deleted_at", null),
    client.from("favorites_meals").select("id, name, sort, created_at")
      .eq("user_id", userId).is("deleted_at", null),
  ]);
  for (const result of [foods, recipes, meals]) if (result.error) throw result.error;

  const details = await refDetails(client,
    (foods.data ?? []).map((f) => f.food_ref_id as string));
  const notices = new Set<string>();
  const all: FavoriteExportRow[] = [
    ...(foods.data ?? []).map((f) => {
      const detail = details.get(f.food_ref_id as string);
      if (detail?.source === "off") notices.add(ODBL_NOTICE);
      return { kind: "food", id: f.food_ref_id as string,
        name: detail?.description ?? "(unknown food)", sort: Number(f.sort),
        added_at: f.created_at as string };
    }),
    ...(recipes.data ?? []).map((r) => ({ kind: "recipe", id: r.recipe_id as string,
      name: (r as unknown as { recipes?: { name: string } | null }).recipes?.name ?? "(recipe)",
      sort: Number(r.sort), added_at: r.created_at as string })),
    ...(meals.data ?? []).map((m) => ({ kind: "meal", id: m.id as string, name: m.name as string,
      sort: Number(m.sort), added_at: m.created_at as string })),
  ].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));

  const after = opts.cursor ? decodeTextCursor(opts.cursor) : "";
  const remaining = all.filter((row) => `${row.kind}:${row.id}` > after);
  const hasMore = remaining.length > opts.limit;
  const rows = remaining.slice(0, opts.limit);
  const last = rows.at(-1);
  return { rows, notices: [...notices],
    next_cursor: hasMore && last ? encodeTextCursor(`${last.kind}:${last.id}`) : null };
}

export async function streamWater(
  client: SupabaseClient, userId: string, opts: ExportOpts,
): Promise<ExportJson<WaterExportRow>> {
  let query = client.from("water_log").select("local_date, cups").eq("user_id", userId);
  if (opts.from) query = query.gte("local_date", opts.from);
  if (opts.to) query = query.lte("local_date", opts.to);
  if (opts.cursor) query = query.gt("local_date", decodeTextCursor(opts.cursor));
  const [days, settings] = await Promise.all([
    query.order("local_date", { ascending: true }).limit(opts.limit + 1),
    client.from("user_settings").select("water_goal_cups").eq("user_id", userId).maybeSingle(),
  ]);
  if (days.error) throw days.error;
  if (settings.error) throw settings.error;

  const all = (days.data ?? []) as { local_date: string; cups: number }[];
  const hasMore = all.length > opts.limit;
  const page = hasMore ? all.slice(0, opts.limit) : all;
  const goal = Number(settings.data?.water_goal_cups ?? 8);
  const rows = page.map((d) => ({ local_date: d.local_date, cups: Number(d.cups), goal }));
  const last = page.at(-1);
  return { rows, notices: [],
    next_cursor: hasMore && last ? encodeTextCursor(last.local_date) : null };
}
```
- [ ] Edit `app/api/export/route.ts`. Replace the `STREAMED`/`Kind`/`SOURCES` block (lines 25–68) with:
```ts
const STREAMED = new Set(["meals", "progress", "recipes", "favorites", "water"]);
type StreamKind = "meals" | "progress" | "recipes" | "favorites" | "water";

// The buffered `page=` map keeps only the two kinds that are still Phase 0 shaped. `recipes`,
// `favorites` and `water` move to the streamed path above (contracts §3: "same paging").
type Kind = "meals" | "weight";

const SOURCES: Record<
  Kind,
  { from: string; select: string; order: string; columns: string[]; tombstoned?: boolean }
> = {
  meals: {
    from: "log_entries",
    select: "id, local_date, tz, eaten_at, slot, method, note, deleted_at, " +
      "log_items(seq, qty, unit, grams, food_ref_id, snapshot)",
    order: "eaten_at", tombstoned: true,
    columns: ["id", "local_date", "tz", "eaten_at", "slot", "method", "note", "seq", "qty",
      "unit", "grams", "food_ref_id", "energy_kcal", "protein_g", "carbohydrate_g", "fat_g"],
  },
  weight: {
    // weigh_ins (architecture.md §2.1) has no tz column.
    from: "weigh_ins", select: "id, local_date, start_time, value, unit", order: "start_time",
    columns: ["id", "local_date", "start_time", "value", "unit"],
  },
};
```
- [ ] Replace `streamed()` (lines 122–142) with:
```ts
async function streamed(kind: StreamKind, client: SupabaseClient, userId: string,
  url: URL): Promise<Response> {
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "csv" && format !== "json") {
    throw new HttpError(400, "bad_request", "unknown format");
  }
  const opts: ExportOpts = { from: dateParam(url, "from"), to: dateParam(url, "to"),
    limit: limitParam(url), cursor: url.searchParams.get("cursor") ?? undefined };

  if (kind === "meals") {
    const page = await streamMeals(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, MEAL_COLUMNS, page.rows.map(mealRowValues), page.notices);
  }
  if (kind === "recipes") {
    const page = await streamRecipes(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, RECIPE_COLUMNS, page.rows.map(recipeRowValues), page.notices);
  }
  if (kind === "favorites") {
    const page = await streamFavorites(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, FAVORITE_COLUMNS, page.rows.map(favoriteRowValues), page.notices);
  }
  if (kind === "water") {
    const page = await streamWater(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, WATER_COLUMNS, page.rows.map(waterRowValues), page.notices);
  }
  const page = await streamProgress(client, userId, opts);
  if (format === "json") return Response.json(page);
  return csvResponse(kind, opts, PROGRESS_COLUMNS, page.rows.map(progressRowValues), page.notices);
}
```
- [ ] Widen the dispatch inside `GET` (line 153) and the import list (line 15):
```ts
import { FAVORITE_COLUMNS, favoriteRowValues, MEAL_COLUMNS, mealRowValues, PROGRESS_COLUMNS,
  progressRowValues, RECIPE_COLUMNS, recipeRowValues, streamFavorites, streamMeals,
  streamProgress, streamRecipes, streamWater, WATER_COLUMNS, waterRowValues,
  type ExportOpts } from "@/lib/server/export";
```
```ts
    if (STREAMED.has(kind)) {
      return await streamed(kind as StreamKind, client, userId, url);
    }
```
- [ ] Run: `pnpm test tests/export/phase3-kinds.test.ts` → PASSES (5 tests).
- [ ] Add the route case to `tests/export/phase3-kinds.test.ts` **[needs branch]**: sign in as user a (`createTestUsers`, `sessionCookieFor`, `pointRequestClientAtBranch`), seed a recipe through `apply_sync_op`, `GET /api/export?kind=recipes&format=csv` via the exported `GET`, and assert the header line equals `RECIPE_COLUMNS.join(",")` and that user b's identical request returns no rows.
- [ ] Run **[needs branch]**: `pnpm test:integration tests/export/` → PASSES.
- [ ] Commit: `git add lib/server/export.ts app/api/export tests/export && git commit -m "feat: export recipes, favorites and water"`

---

## Lane exit gate

Run once, in this order, before opening the PR (never the full suite twice — `AGENTS.md`):

1. `pnpm lint` and `pnpm exec tsc --noEmit` — clean.
2. `pnpm test lib/sync tests/recipes tests/favorites tests/water tests/export` — the lane's own unit files, green.
3. **[needs branch]** `pnpm db:push && pnpm test:integration tests/sync/ tests/export/` — green. Skip condition: `SUPABASE_TEST_URL` unset.
4. `pnpm build` — clean (`/recipes` appears in the route list).
5. Evidence for the PR body, quoted from the runs above: AC 7 (rev + 1, old revision byte-identical), AC 8 (coverage < 1, never 0), AC 9 (favorites union), AC 10 (water settles on 5), AC 11 (cross-user denial on `recipes`, `recipe_revisions`, `recipe_items`, all three favorites tables, `favorites_meal_items`, `user_settings`), AC 12 (the three export kinds with the ODbL notice and `'`-guarded cells).
6. Rollback rehearsal on the branch: apply `down/…090300`, then `down/…090200`, then `down/…090000`, and confirm `apply_sync_op` answers `unknown_entity` for `recipes` and that a `log_entries` op still applies. Re-push the migrations afterwards.
7. `~/bin/zs-land` — the repo's own policy; one squashed commit on `main`.

## Hand-off to integration

Two mounts, both in files this lane never touches. Apply them on `feat/p3-4-integration` after K, L, M and N land.

**`app/page.tsx`** — mount the card and retire the localStorage water write (12 lines):
```tsx
// 1. with the other component imports
import WaterCard from "@/components/WaterCard";
import { addCups } from "@/lib/water-client";

// 2. replace the body of logWater() (app/page.tsx line 313)
  async function logWater() {
    await addCups(viewedDate, 1);
    refresh();
  }

// 3. above <LoggedExtras …/> (app/page.tsx line 510)
        <WaterCard localDate={viewedDate} />
```

**`components/LogFoodSheet.tsx`** — the strip above the search box (15 lines):
```tsx
// 1. with the other component imports
import FavoritesStrip from "@/components/FavoritesStrip";

// 2. immediately above <CatalogSearch mine={mine} autoFocus onPick={pickCatalogRow} /> (line 757)
        {useCatalog && (
          <FavoritesStrip
            onPick={(fav) => {
              if (fav.kind === "recipe") {
                // No lane resolves a recipe's food_ref_id to a loggable pick from here yet
                // (recipeFoodRefId exists but nothing computes a portion/snapshot from a
                // per-serving recipe row) — send her to the recipe instead of a dead tap.
                window.location.href = "/recipes";
                return;
              }
              if (fav.catalogFoodId == null) return;
              void pickCatalogRow({ key: `fav:${fav.id}`, catalogFoodId: fav.catalogFoodId,
                revisionId: fav.revisionId ?? null, description: fav.name, brand: null,
                sourceTile: "USDA", prefStatus: null, qualityFlags: [], offPlan: [],
                offline: false, score: 1 } as CatalogRow);
            }}
          />
        )}
```
`pickCatalogRow` is the sheet's existing pick-a-food path, unchanged: it resolves the food ref, caches the revision and opens the portion step. A favorite with no cached `catalogFoodId` (starred on another device and never opened here) is inert until that device's revision arrives — the chip still renders, so nothing disappears. `score: 1` is a placeholder rank for a favorites-sourced synthetic row, which has no catalog search score to carry — `CatalogRow.score` (`lib/catalog-client.ts`) is a required field and the literal fails `tsc --noEmit` without it. A favorited **recipe** is never routed into `pickCatalogRow` at all: it is not a catalog pick and has no revision to cache, so this hand-off only gets her to the recipe screen, not a logged serving — quick-logging a recipe serving from a favorite chip is not built anywhere yet and needs its own follow-up ticket.

## Open questions

1. **Coverage is the strictest macro.** A recipe whose foods carry no fiber value at all reports `coverage: 0` beside a full kcal number, because fiber's coverage is 0 and the scalar is the minimum across the five tracked macros. That is literally true and reads alarming. Confirm Devin wants the minimum rather than the mean across the five. (Contracts §3 says "items with a value ÷ items"; the lane brief fixes the aggregation as the minimum — this plan implements the brief.)
2. **"Total grams" for the recipe's `user_foods.per_100g`** is read as `yield_grams` when she gave one and the summed item grams otherwise. That is the only reading under which `grams = servingGrams × servings eaten` reproduces the per-serving numbers exactly, which contracts §3 requires; the phrase itself is ambiguous. Confirm.
3. ~~**`favorites.added_at` is `updated_at`.**~~ — **resolved 2026-09-11**: Phase 0 gave the favorites tables no `created_at`, and re-sorting a favorite touches `updated_at`, so the export's `added_at` was silently rewriting "date added" on every reorder. Task 1 now lands `docs: phase-3-4 contract change — favorites gain a real created_at` and adds the column (populated once at insert, never touched by `_sync_upsert`'s on-conflict path); Task 17's `streamFavorites` reads `created_at`, not `updated_at`.
4. ~~**The ODbL notice travels in `notices`, not a column.**~~ — **resolved 2026-09-11**: contracts §3 said "ODbL notice column", but the Phase 2 streamed export the same sentence tells this lane to follow puts notices in the JSON `notices[]` and trailing `# …` CSV lines, with no room in the column lists for one. Task 17 now lands `docs: phase-3-4 contract change — export attribution is notices[], not a column` before implementing, so 00-contracts.md and the Phase-2-consistent code it ships agree.
5. **`FavoriteRow` carries two optional extras.** `catalogFoodId` and `revisionId` join the five fields the brief names, because the hand-off diff cannot reach `LogFoodSheet`'s existing pick path from a `food_ref_id` alone. They are optional and absent for a favorite this device has never opened.
6. **Spec open question 4 (recipe yield) and 5 (favorites ceiling)** are implemented on the spec's own proposals — `yield_grams` optional, 12 pinned plus **All**. Neither is confirmed.
7. **`toggleFavorite('meal', …)` starts from an existing saved meal.** Creating one is the meal builder's job, and no lane owns that this wave; the function throws rather than writing a nameless `favorites_meals` row.
