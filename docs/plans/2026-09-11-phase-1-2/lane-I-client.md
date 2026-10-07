# Lane I — Client (Phases 1 + 2 UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Every step below is a checkbox; do them in order, one commit per task.

**Goal:** Put the real catalog in front of Sasha. She types into the log sheet and sees ranked catalog
hits with a source tile and her own Eats/Avoid state; she picks a portion or types grams; a live
kcal/protein/carbs/fat/fibre strip updates as she does; the entry commits through
`POST /api/log/commit` carrying grams and a frozen snapshot. Today then reports fibre against her
20–25 g band and a micronutrient coverage pill built from those snapshots, and Settings can export the
whole log. With `NEXT_PUBLIC_CATALOG_SEARCH` unset the app behaves exactly as it did at the end of
Phase 0.

**Architecture:** Three layers, each testable on its own. (1) **Transport** — `lib/catalog-client.ts`
(one `AbortController` per keystroke, 200 ms debounce, `503`/offline → the bundled `lib/food-db.ts`
marked "offline results"), `lib/log-client.ts` (builds a `LogCommitRequest`, posts it, or enqueues the
same payload through the Phase 0 outbox when offline). (2) **Cache** — `lib/db/catalog-cache.ts`, a
`catalog_revisions` object store inside the Phase 0 `smc` IndexedDB database, so a food she has touched
computes its snapshot offline and a cache miss with no network *blocks* that food instead of zeroing
it. (3) **Surface** — `CatalogSearch`, `FoodDetailSheet`, the rewritten search/portion/grams area of
`LogFoodSheet`, `NutrientBreakdown`, `DayNutrients`, `LoggedExtras`, `ExportCard`, all styled with the
Lane E utilities in `app/globals.css` and nothing else. Store and totals change underneath:
`lib/store.ts` extras carry `items[]` with grams + snapshot, `lib/resolve.ts` totals a day from those
snapshots when they exist and from the legacy `macros` when they do not — which is the whole of the
`MacroRings` change (its props and its look are untouched).

**Tech Stack:** Next.js 16.3.4 (App Router, client components), React 19, TypeScript 5 strict,
Tailwind 4 (`@theme` tokens from `app/design-tokens.css`), `idb` 8, `motion` 13, vitest 5 with
`environment: "node"` and `include: ["**/*.test.ts"]`, `fake-indexeddb` 6, pnpm 11.25.0, Node 22.

**Spec paths:**
- `docs/plans/2026-09-11-phase-1-2/00-contracts.md` (frozen; §3 search wire types, §4 logging wire
  types, §5 client contracts, §6 env, §8 conventions)
- `docs/plans/2026-09-10-phase-0/00-contracts.md` §2–§6 (`requireUser`, `enforceRateLimit`, `readJson`,
  `jsonError`, `adminClient`, `withTokenUser`, `SyncOp`/`OpResult`, entity keys)
- `docs/specs/phase-1-catalog.md` (API changes, Client changes, Engines)
- `docs/specs/phase-2-real-logging.md` (API changes, Client changes, Engines)
- `docs/architecture.md` §3.1, §3.3, §4.1, §4.6, §5, §7
- `AGENTS.md`, `DESIGN.md`, and the mockups `~/Desktop/Sasha app/07-design/neuform-mockup/LogMeal.dc.html`
  (log sheet) and `Main.dc.html` (gauge card, olive panel, the place `DayNutrients` sits)

**Phase 0 is assumed landed but is not on this checkout.** `lib/server/auth.ts`, `lib/supabase/client.ts`,
`lib/sync/idb.ts`, `lib/sync/outbox.ts`, `lib/sync/types.ts` do not exist in the working tree today; this
lane codes against the Phase 0 contract signatures quoted in each task's **Interfaces** block. Likewise
`app/globals.css` still carries the pre-Lane-E dark tokens; every class name used here
(`.shell .surface .pill .pill-in .well .olive-panel .ts .tap`) is the Lane E set from
`docs/plans/2026-09-10-phase-0/lane-E-theme.md` Task 1. Branch from the `main` that has both.

## Global Constraints

Phase 0 contracts §8, in force:
- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, no AI
  attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` is never read from a request body. Errors are `{ error, message }`, never echo the body.
- Every route: `enforceRateLimit` first, then identity, then body parse with `readJson`. (Lane I calls
  routes; it writes none.)
- Files < 400 lines; functions < 50 lines.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the full
  suite twice.

Phase 1–2 contracts §8, in force:
- Every SQL function that reads user rows is either `security invoker` or `security definer` with
  `p_user_id` first and execute revoked from `authenticated` — never both, never neither. Lane I's one
  direct RPC call (`get_or_create_food_ref`, Task 6) goes through the browser client and relies on the
  Phase 0 grant; it never passes a `p_user_id` it did not read from the live session.

Lane I additions:
- **Owned files only.** `lib/catalog-client.ts`, `lib/db/catalog-cache.ts`, `lib/log-client.ts`,
  `components/CatalogSearch.tsx`, `FoodDetailSheet.tsx`, `NutrientBreakdown.tsx`, `DayNutrients.tsx`,
  `ExportCard.tsx`, `LogFoodSheet.tsx`, `LoggedExtras.tsx`, `MacroRings.tsx`, `app/page.tsx`,
  `app/settings/page.tsx`, `lib/store.ts`, `lib/resolve.ts`, `tests/client/**`. `lib/types.ts` and
  `lib/sync/idb.ts` are **not** edited on this branch: neither is in contracts §1's Lane I row, and
  neither is in the shared list with a carve-out for this lane, so contracts §1's contract-change
  mechanism (which amends *text* in `00-contracts.md`) cannot authorise editing them either — both
  moves land on the integration branch instead (**Hand-off** items 1 and 3). Task 1's only edit
  outside this list is the contract-change commit to `docs/plans/2026-09-11-phase-1-2/00-contracts.md`
  itself, which contracts §1's own procedure exists to authorise.
- **No new dependencies.** `@testing-library/react` is not installed and is not added. Tests cover pure
  helpers only; every component is gated by a written manual phone check.
- **Styling comes from Lane E.** No new colour, radius or shadow value is written in this lane; only
  `app/globals.css` utility classes and `@theme` token names.
- **Flag both ways.** Every task that touches the log sheet or Today is verified with
  `NEXT_PUBLIC_CATALOG_SEARCH=1` and with it unset.
- Branch `feat/p2-client`.

## File structure

| File | Responsibility |
|---|---|
| `docs/plans/2026-09-11-phase-1-2/00-contracts.md` | **Modify (Task 1 only), text only.** Contract change: the target shape once the integration branch bumps `smc` to v2 with a `catalog_revisions` store; `SnapshotMeta`'s shape; two named exports Lane I consumes from Lane H. |
| `lib/sync/idb.ts` | **Not edited by this lane.** `DB_VERSION` 1 → 2 and `CATALOG_STORE` land on the integration branch after all four lanes merge (Hand-off item 1) — `lib/sync/idb.ts` has no carve-out in contracts §1's shared list. Task 2's import of `CATALOG_STORE` is red on this branch until that rebase. |
| `lib/db/catalog-cache.ts` | **Create.** `getRevision` / `putRevision` / `evictOlderThan` over the `catalog_revisions` store of the Phase 0 `smc` database. |
| `lib/db/catalog-cache.test.ts` | **Create.** `fake-indexeddb`: round-trip, overwrite, eviction by age. |
| `lib/catalog-client.ts` | **Create.** `catalogSearchEnabled()`, `searchFoods`, `createSearchController` (200 ms debounce, one `AbortController` per keystroke), `toRows`, `getFoodDetail`, `cacheDetail`. Falls back to `lib/food-db.ts` on `503` or a failed fetch and marks the result offline. |
| `lib/catalog-client.test.ts` | **Create.** Fake `fetch`: parsing, `503` → offline, abort, `toRows` mapping. |
| `lib/log-client.ts` | **Create.** `resolveFoodRef`, `buildCommitRequest`, `liveStrip`, `commitLogEntry` (online → `/api/log/commit`, offline → Phase 0 outbox), `pendingEntryIds`. |
| `lib/log-client.test.ts` | **Create.** `buildCommitRequest` shape, `liveStrip` numbers, `commitLogEntry` offline path, `pendingEntryIds`. |
| `lib/types.ts` | **Not edited by this lane.** Phase 0 contracts §1 listed it shared; Phase 1–2 contracts §1 neither lists it in Lane I's row nor carries it forward on the shared list, so no lane has authority to edit it here. The new `LoggedItem` type and `LoggedFood.items?: LoggedFood[]` → `LoggedItem[]` widening (a superset that keeps every field `NoteSheet`, `app/api/mcp/route.ts` and `app/page.tsx` already read; nothing renamed, nothing removed) land on the integration branch instead (**Hand-off** item 3). Task 7's `migrateExtraItems` imports `LoggedItem` from `./types` before it exists there. |
| `lib/store.ts` | **Modify.** `migrateExtraItems` backfills the Phase 2 half of every legacy meal item; `normalizeStore` runs it; the Phase 0 outbox emission in `addExtra` / `updateExtra` / `removeExtra` is left exactly where it is. |
| `lib/store.test.ts` | **Create.** `migrateExtraItems` is idempotent, fills `seq`/`unit`/`food_ref_id`/`snapshot`, leaves a Phase 2 item alone. |
| `lib/resolve.ts` | **Modify.** `snapshotMacros`, `entryMacros`, `dayNutrientTotals`; `resolveDay` totals extras through `entryMacros`. |
| `lib/resolve.test.ts` | **Modify.** Add: a snapshot entry totals from its snapshot, a legacy entry totals from `macros`, a mixed day sums both. |
| `components/CatalogSearch.tsx` | **Create.** Well input, hit rows with a USDA/MINE source tile, Eats/Avoid pill, amber `energy_mismatch` pill, score order, "offline results" label, empty and error states. |
| `components/FoodDetailSheet.tsx` | **Create.** Per-100 g table (`—` for `null`), portion list, source + attribution line. Read-only. |
| `components/LogFoodSheet.tsx` | **Modify.** Rewrite of the search / portion / grams area only: `CatalogSearch` behind the flag, portion picker from `catalog_portions`, qty stepper, direct grams entry, live macro strip, cache-miss block, commit through `lib/log-client.ts`. Meal mode, note field and "type it from the label" are untouched. |
| `components/NutrientBreakdown.tsx` | **Create.** Every nutrient of one entry: amount, unit, `—` when unmeasured, source and source version at the foot. |
| `components/DayNutrients.tsx` | **Create.** Under the gauge card: fibre against the 20–25 g band, a coverage pill "*n* of 12 nutrients have data today", an expandable list with amount and % DRI. Informational: no rings, no targets, no red states. |
| `components/LoggedExtras.tsx` | **Modify.** Grams + kcal per entry, tap opens `NutrientBreakdown`, a pending dot while the entry is still in the outbox. |
| `components/MacroRings.tsx` | **Not edited.** Its `consumed` prop now carries snapshot-derived totals because `lib/resolve.ts` changed. Claimed by contracts §1 so the lane is recorded as its owner; the working tree diff for this file is empty by design. |
| `components/ExportCard.tsx` | **Create.** Meals and progress buttons with an optional date range, hitting `/api/export` with the session cookie. |
| `app/page.tsx` | **Modify.** Mount `DayNutrients` under `MacroRings`; pass `pendingIds` to `LoggedExtras`; open `NutrientBreakdown` inside the entry sheet. |
| `app/settings/page.tsx` | **Modify.** Mount `ExportCard` above `IcsSubscribe`. |
| `tests/client/catalog-flow.test.ts` | **Create.** Search → cache → commit wired end to end over fakes, both flag states. |
| `docs/screenshots/phase-2/*.png` | **Create.** Log sheet (search, portion, grams), Today with `DayNutrients` collapsed and expanded, a nutrient breakdown, the export card. |

---

## Task 1 — Contract change: `SnapshotMeta` and two Lane H exports

Lane I needs three names it does not own, documented in the contract before it relies on them.
Contracts §1 says a contract change lands in the contracts file first — this task does exactly that,
**and nothing else**. It does not also edit `lib/sync/idb.ts`: contracts §1's contract-change
mechanism amends *text* in `00-contracts.md`, and §1 lists `lib/sync/**` under "Shared, nobody edits
on a lane branch" with no carve-out for this lane, so the mechanism grants no permission to edit that
file. The `DB_VERSION` 1 → 2 / `CATALOG_STORE` bump is therefore not this task's to make — see
**Hand-off** item 1: it lands on the integration branch, the same cut-over pattern Phase 0 lane D used
for a shared file it could not edit itself (`docs/plans/2026-09-10-phase-0/lane-D-data-ops.md`:
"import the real path and let `tsc` fail until the integration branch rebases"). Task 2 of this lane
imports `CATALOG_STORE` before it exists on this branch for exactly that reason, and is red until the
integration branch rebases it.

**Files** — Modify: `docs/plans/2026-09-11-phase-1-2/00-contracts.md`. No other file.

**Interfaces**

Consumes (Phase 0, `lib/sync/idb.ts`, `DB_VERSION` 1 — unchanged on this branch):
```ts
export const DB_NAME: "smc"; export const DB_VERSION: 1;
export const OUTBOX_STORE: "outbox"; export const META_STORE: "meta";
export function openSmcDb(): Promise<IDBPDatabase>;
export function closeSmcDb(): Promise<void>;
export function allOps(): Promise<OutboxOp[]>;
```

Names this task documents in the contract (each produced elsewhere, consumed here):
```ts
// lib/sync/idb.ts — lands on the integration branch, not this one (Hand-off item 1)
export const DB_VERSION = 2;
export const CATALOG_STORE = "catalog_revisions";
// lib/nutrients/codes.ts  (Lane H adds; Lane I imports)
export const NUTRIENT_UNITS: Readonly<Record<NutrientCode, string>>;
// lib/nutrients/dri.ts    (Lane H adds; Lane I imports)
export const DRI_FEMALE_19_30: readonly DriRow[];   // the 12 rows of …090300_phase2_catalog_dri_seed.sql
// lib/nutrients/snapshot.ts  (Lane H's actual Task 3 shape — units is optional and partial,
// not required-and-full: `computeSnapshot` falls back to NUTRIENT_UNITS[code] per nutrient when
// a code is missing from `units` or `units` itself is omitted, so a caller need not build a full
// record. lib/log-client.ts's snapshotFor always passes the full NUTRIENT_UNITS anyway, so it
// satisfies this shape unchanged.)
export type SnapshotMeta = { source: string; source_version: string;
  revision_id: number | null; units?: Partial<Record<NutrientCode, string>> };
```

- [ ] Record the contract change in `docs/plans/2026-09-11-phase-1-2/00-contracts.md`. In §5, replace
      the first bullet's opening clause with `IndexedDB store catalog_revisions in the Phase 0 smc
      database (bumped to v2 on the integration branch; store name exported as CATALOG_STORE, keyPath
      revision_id, index by_cached_at)`; in §4, append the `SnapshotMeta` line above, matching Lane H's
      Task 3 shape exactly (`units` optional and partial) rather than a stricter shape this lane does
      not need; in §2, after the
      `TRACKED_MICROS` sentence, add `NUTRIENT_UNITS (lib/nutrients/codes.ts) maps every code to its
      unit; DRI_FEMALE_19_30 (lib/nutrients/dri.ts) carries the twelve seeded DriRow values. Both are
      Lane H exports; Lane I is their only Phase 2 consumer.`
- [ ] Commit.
  ```bash
  git add docs/plans/2026-09-11-phase-1-2/00-contracts.md \
    && git commit -m "docs: phase-1-2 contract change — SnapshotMeta, NUTRIENT_UNITS and DRI_FEMALE_19_30"
  ```

---

## Task 2 — `lib/db/catalog-cache.ts`: the offline catalog

**Files** — Create: `lib/db/catalog-cache.ts`. Test path: `lib/db/catalog-cache.test.ts`.

**Interfaces**

Consumes: `openSmcDb`, `CATALOG_STORE` from `@/lib/sync/idb` — the integration branch's `DB_VERSION`
2 bump (Hand-off item 1), not a Task 1 edit. This import is red on Lane I's own branch until that
rebase lands; that is expected, the same pattern Phase 0 lane D used for a shared file it could not
edit itself.

Produces:
```ts
// lib/db/catalog-cache.ts
export type CachedPortion = { id: number; description: string; gramWeight: number; isDefault: boolean };
export type CachedRevision = {
  revision_id: number; catalog_food_id: number; description: string; brand: string | null;
  source: string; version_label: string;
  per_100g: Record<string, number | null>;      // nutrient_code → amount, null = not measured
  portions: CachedPortion[]; cached_at: string; // ISO
};
export function getRevision(id: number): Promise<CachedRevision | undefined>;
export function putRevision(row: CachedRevision): Promise<void>;
export function evictOlderThan(days: number, now?: number): Promise<number>;  // rows removed
```

- [ ] Write the failing test.
  ```ts
  // lib/db/catalog-cache.test.ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { beforeEach, describe, expect, it } from "vitest";
  import { closeSmcDb } from "@/lib/sync/idb";
  import { evictOlderThan, getRevision, putRevision, type CachedRevision } from "./catalog-cache";

  function row(id: number, cachedAt: string): CachedRevision {
    return {
      revision_id: id, catalog_food_id: id * 10, description: "Chicken breast, roasted",
      brand: null, source: "fdc_sr_legacy", version_label: "2026-04",
      per_100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: null },
      portions: [{ id: 1, description: "3 oz", gramWeight: 85, isDefault: true }],
      cached_at: cachedAt,
    };
  }

  beforeEach(async () => {
    await closeSmcDb();
    globalThis.indexedDB = new IDBFactory();
  });

  describe("the catalog revision cache", () => {
    it("round-trips a revision keyed by revision_id", async () => {
      await putRevision(row(7, "2026-09-11T10:00:00.000Z"));
      const back = await getRevision(7);
      expect(back?.description).toBe("Chicken breast, roasted");
      expect(back?.per_100g.fiber_total).toBeNull();
      expect(back?.portions[0].gramWeight).toBe(85);
    });

    it("returns undefined for a revision it has never seen", async () => {
      await expect(getRevision(404)).resolves.toBeUndefined();
    });

    it("overwrites a revision it already holds", async () => {
      await putRevision(row(7, "2026-09-11T10:00:00.000Z"));
      await putRevision({ ...row(7, "2026-09-12T10:00:00.000Z"), description: "Chicken breast, grilled" });
      expect(await getRevision(7)).toMatchObject({ description: "Chicken breast, grilled" });
    });

    it("evicts only rows older than the cut-off and reports how many went", async () => {
      const now = Date.parse("2026-09-20T00:00:00.000Z");
      await putRevision(row(1, "2026-08-01T00:00:00.000Z"));  // 50 days
      await putRevision(row(2, "2026-09-18T00:00:00.000Z"));  // 2 days
      await expect(evictOlderThan(30, now)).resolves.toBe(1);
      await expect(getRevision(1)).resolves.toBeUndefined();
      await expect(getRevision(2)).resolves.toBeDefined();
    });
  });
  ```
- [ ] Run it. Expected failure:
      `Error: Failed to load url ./catalog-cache (resolved id: …/lib/db/catalog-cache)`.
  ```bash
  pnpm test lib/db/catalog-cache.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/db/catalog-cache.ts
  /**
   * Every catalog revision she has touched, cached on the phone — contracts §5.
   *
   * The point is the offline rule in phase-2-real-logging.md: with no signal the sheet computes the
   * same snapshot the server would from this row, and a MISS blocks that food with a message rather
   * than logging a zeroed item. Nothing here is authoritative: the server snapshot wins on sync.
   *
   * It lives in the Phase 0 `smc` database (contracts §5, v2) so there is one connection, one
   * upgrade path and one place to clear.
   */
  import { CATALOG_STORE, openSmcDb } from "@/lib/sync/idb";

  export type CachedPortion = {
    id: number; description: string; gramWeight: number; isDefault: boolean;
  };

  export type CachedRevision = {
    revision_id: number;
    catalog_food_id: number;
    description: string;
    brand: string | null;
    source: string;
    version_label: string;
    /** nutrient_code → amount per 100 g. `null` means the source did not measure it. */
    per_100g: Record<string, number | null>;
    portions: CachedPortion[];
    cached_at: string;
  };

  export async function getRevision(id: number): Promise<CachedRevision | undefined> {
    return (await openSmcDb()).get(CATALOG_STORE, id) as Promise<CachedRevision | undefined>;
  }

  export async function putRevision(row: CachedRevision): Promise<void> {
    await (await openSmcDb()).put(CATALOG_STORE, row);
  }

  /** Drop revisions last cached more than `days` ago. Returns how many were removed. */
  export async function evictOlderThan(days: number, now: number = Date.now()): Promise<number> {
    const cutoff = now - days * 86_400_000;
    const db = await openSmcDb();
    const tx = db.transaction(CATALOG_STORE, "readwrite");
    const rows = (await tx.store.getAll()) as CachedRevision[];
    let removed = 0;
    for (const row of rows) {
      if (Date.parse(row.cached_at) < cutoff) {
        await tx.store.delete(row.revision_id);
        removed += 1;
      }
    }
    await tx.done;
    return removed;
  }
  ```
- [ ] Run it. Expected: `Tests  4 passed (4)`.
  ```bash
  pnpm test lib/db/catalog-cache.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/db/catalog-cache.ts lib/db/catalog-cache.test.ts \
    && git commit -m "feat(catalog): cache catalog revisions in the smc database"
  ```

---

## Task 3 — `lib/catalog-client.ts`: one search, and the offline fallback

**Files** — Create: `lib/catalog-client.ts`. Test path: `lib/catalog-client.test.ts`.

**Interfaces**

Consumes: `FoodSearchHit`, `FoodSearchResponse`, `CatalogSource`, `PrepState`, `QualityClass` from
`@/lib/server/catalog` (Lane G, contracts §3 — type-only imports, so no server code reaches the
bundle); `searchFoods as searchBundledFoods`, `type SearchHit` from `@/lib/food-db`; `type Food` from
`@/lib/foods`.

Produces:
```ts
// lib/catalog-client.ts
export const SEARCH_DEBOUNCE_MS = 200;          // phase-1-catalog.md, Client changes
export function catalogSearchEnabled(): boolean; // NEXT_PUBLIC_CATALOG_SEARCH === "1"

export type SearchOptions = {
  brand?: string; prep?: PrepState; limit?: number;
  mine?: Record<string, Food>;                  // her own list, for the offline tier
  signal?: AbortSignal; fetchImpl?: typeof fetch;
};
export type SearchResult =
  | { kind: "empty" }
  | { kind: "online"; hits: FoodSearchHit[]; queryClass: "branded" | "generic";
      autoResolve: { revisionId: number; score: number; margin: number } | null;
      catalogVersion: string }
  | { kind: "offline"; hits: SearchHit[]; reason: "no_catalog" | "network" };

export type CatalogRow = {
  key: string; catalogFoodId: number | null; revisionId: number | null;
  description: string; brand: string | null; sourceTile: "USDA" | "MINE" | "OFF";
  qualityFlags: string[]; prefStatus: "eats" | "avoid" | null; score: number;
  offline: boolean; offlineFoodId?: string; offlineSource?: "db" | "mine";
};

export async function searchFoods(q: string, opts?: SearchOptions): Promise<SearchResult>;
export function toRows(result: SearchResult): CatalogRow[];
```

- [ ] Write the failing test.
  ```ts
  // lib/catalog-client.test.ts
  import { describe, expect, it, vi } from "vitest";
  import { searchFoods, toRows } from "./catalog-client";

  const HIT = {
    catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted", brand: null,
    source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
    score: 0.8123, prefStatus: "eats",
  };

  function jsonFetch(status: number, body: unknown): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
  }

  describe("searchFoods", () => {
    it("returns empty for a blank query and never calls the network", async () => {
      const fetchImpl = jsonFetch(200, {});
      await expect(searchFoods("   ", { fetchImpl })).resolves.toEqual({ kind: "empty" });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("parses a 200 into hits, query class, auto-resolve and catalog version", async () => {
      const fetchImpl = jsonFetch(200, {
        hits: [HIT], queryClass: "generic",
        autoResolve: { revisionId: 910, score: 0.8123, margin: 0.21 }, catalogVersion: "2026-04",
      });
      const r = await searchFoods("chicken breast", { fetchImpl, limit: 10 });
      expect(r).toMatchObject({ kind: "online", queryClass: "generic", catalogVersion: "2026-04" });
      expect(r.kind === "online" && r.hits[0].description).toBe("Chicken breast, roasted");
      const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
      expect(url).toBe("/api/foods/search?q=chicken+breast&limit=10");
    });

    it("puts brand and prep on the query string only when they are set", async () => {
      const fetchImpl = jsonFetch(200, { hits: [], queryClass: "branded", autoResolve: null, catalogVersion: "x" });
      await searchFoods("rx bar", { fetchImpl, brand: "RXBAR", prep: "raw" });
      const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
      expect(url).toBe("/api/foods/search?q=rx+bar&limit=25&brand=RXBAR&prep=raw");
    });

    it("falls back to the bundled database on a 503 and says why", async () => {
      const r = await searchFoods("banana", { fetchImpl: jsonFetch(503, { error: "no_catalog" }) });
      expect(r.kind).toBe("offline");
      expect(r.kind === "offline" && r.reason).toBe("no_catalog");
      expect(r.kind === "offline" && r.hits.length).toBeGreaterThan(0);
    });

    it("falls back to the bundled database when the fetch itself throws", async () => {
      const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
      const r = await searchFoods("banana", { fetchImpl });
      expect(r).toMatchObject({ kind: "offline", reason: "network" });
    });

    it("lets an abort propagate instead of falling back", async () => {
      const ac = new AbortController();
      ac.abort();
      const fetchImpl = vi.fn(async () => { throw new DOMException("Aborted", "AbortError"); }) as unknown as typeof fetch;
      await expect(searchFoods("banana", { fetchImpl, signal: ac.signal })).rejects.toThrow(/Aborted/);
    });
  });

  describe("toRows", () => {
    it("maps an online hit to a USDA tile and keeps the score order the server sent", () => {
      const rows = toRows({
        kind: "online", queryClass: "generic", autoResolve: null, catalogVersion: "2026-04",
        hits: [HIT as never, { ...HIT, catalogFoodId: 42, revisionId: 911, score: 0.4, prefStatus: null } as never],
      });
      expect(rows.map((r) => r.score)).toEqual([0.8123, 0.4]);
      expect(rows[0]).toMatchObject({ sourceTile: "USDA", prefStatus: "eats", offline: false, revisionId: 910 });
    });

    it("maps an off-sourced hit to the OFF tile", () => {
      const rows = toRows({
        kind: "online", queryClass: "branded", autoResolve: null, catalogVersion: "2026-04",
        hits: [{ ...HIT, source: "off" } as never],
      });
      expect(rows[0].sourceTile).toBe("OFF");
    });

    it("marks offline rows and tiles her own foods MINE", () => {
      const rows = toRows({
        kind: "offline", reason: "network",
        hits: [
          { id: "chicken-breast", name: "Chicken breast", source: "db", flags: [], score: 900 },
          { id: "my-shake", name: "Her shake", source: "mine", flags: [], score: 950 },
        ],
      });
      expect(rows.every((r) => r.offline)).toBe(true);
      expect(rows.map((r) => r.sourceTile)).toEqual(["USDA", "MINE"]);
      expect(rows[1].offlineFoodId).toBe("my-shake");
    });

    it("returns no rows for an empty result", () => {
      expect(toRows({ kind: "empty" })).toEqual([]);
    });
  });
  ```
- [ ] Run it. Expected failure:
      `Error: Failed to load url ./catalog-client (resolved id: …/lib/catalog-client)`.
  ```bash
  pnpm test lib/catalog-client.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/catalog-client.ts
  /**
   * Browser side of the Phase 1 catalog — phase-1-catalog.md "Client changes".
   *
   * Two tiers, never mixed. Online: GET /api/foods/search, the §4.1 ranking, her prefs and log
   * counts already folded into the score by the RPC. Offline (a failed fetch, or a 503 meaning no
   * catalog version is active): the bundled lib/food-db.json, labelled "offline results" by the UI.
   * An abort is not a failure — it propagates so a superseded keystroke does not paint stale rows.
   */
  import type { Food } from "@/lib/foods";
  import { searchFoods as searchBundledFoods, type SearchHit } from "@/lib/food-db";
  import type { CatalogSource, FoodSearchHit, PrepState } from "@/lib/server/catalog";

  /** phase-1-catalog.md, Client changes: "one AbortController per keystroke, 200 ms debounce". */
  export const SEARCH_DEBOUNCE_MS = 200;

  /**
   * Read through `process.env` on every call, never captured in a module const: Next inlines the
   * member expression at build time, and a function keeps the value readable in vitest too.
   */
  export function catalogSearchEnabled(): boolean {
    return process.env.NEXT_PUBLIC_CATALOG_SEARCH === "1";
  }

  export type SearchOptions = {
    brand?: string;
    prep?: PrepState;
    limit?: number;
    mine?: Record<string, Food>;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  };

  export type SearchResult =
    | { kind: "empty" }
    | {
        kind: "online"; hits: FoodSearchHit[]; queryClass: "branded" | "generic";
        autoResolve: { revisionId: number; score: number; margin: number } | null;
        catalogVersion: string;
      }
    | { kind: "offline"; hits: SearchHit[]; reason: "no_catalog" | "network" };

  export type CatalogRow = {
    key: string;
    catalogFoodId: number | null;
    revisionId: number | null;
    description: string;
    brand: string | null;
    sourceTile: "USDA" | "MINE" | "OFF";
    qualityFlags: string[];
    prefStatus: "eats" | "avoid" | null;
    score: number;
    offline: boolean;
    offlineFoodId?: string;
    offlineSource?: "db" | "mine";
  };

  function searchUrl(q: string, opts: SearchOptions): string {
    const params = new URLSearchParams({ q, limit: String(opts.limit ?? 25) });
    if (opts.brand) params.set("brand", opts.brand);
    if (opts.prep) params.set("prep", opts.prep);
    return `/api/foods/search?${params.toString()}`;
  }

  function offline(q: string, reason: "no_catalog" | "network", mine: Record<string, Food>): SearchResult {
    return { kind: "offline", reason, hits: searchBundledFoods(q, mine) };
  }

  export async function searchFoods(q: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const query = q.trim();
    if (!query) return { kind: "empty" };
    const doFetch = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(searchUrl(query, opts), { signal: opts.signal, headers: { accept: "application/json" } });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      return offline(query, "network", opts.mine ?? {});
    }
    if (res.status === 503) return offline(query, "no_catalog", opts.mine ?? {});
    if (!res.ok) return offline(query, "network", opts.mine ?? {});
    const body = (await res.json()) as {
      hits: FoodSearchHit[]; queryClass: "branded" | "generic";
      autoResolve: { revisionId: number; score: number; margin: number } | null;
      catalogVersion: string;
    };
    return {
      kind: "online", hits: body.hits ?? [], queryClass: body.queryClass,
      autoResolve: body.autoResolve ?? null, catalogVersion: body.catalogVersion,
    };
  }

  function tileFor(source: CatalogSource): "USDA" | "OFF" {
    return source === "off" ? "OFF" : "USDA";
  }

  /** One row shape for both tiers, so CatalogSearch renders a single list. Order is never changed. */
  export function toRows(result: SearchResult): CatalogRow[] {
    if (result.kind === "empty") return [];
    if (result.kind === "offline") {
      return result.hits.map((h) => ({
        key: `offline:${h.source}:${h.id}`,
        catalogFoodId: null, revisionId: null, description: h.name, brand: null,
        sourceTile: h.source === "mine" ? "MINE" : "USDA",
        qualityFlags: h.flags, prefStatus: null, score: h.score,
        offline: true, offlineFoodId: h.id, offlineSource: h.source,
      }));
    }
    return result.hits.map((h) => ({
      key: `catalog:${h.revisionId}`,
      catalogFoodId: h.catalogFoodId, revisionId: h.revisionId, description: h.description,
      brand: h.brand, sourceTile: tileFor(h.source), qualityFlags: h.qualityFlags,
      prefStatus: h.prefStatus, score: h.score, offline: false,
    }));
  }
  ```
- [ ] Run it. Expected: `Tests  10 passed (10)`.
  ```bash
  pnpm test lib/catalog-client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/catalog-client.ts lib/catalog-client.test.ts \
    && git commit -m "feat(catalog): browser search with a bundled offline fallback"
  ```

---

## Task 4 — `createSearchController`: 200 ms debounce, one abort per keystroke

**Files** — Modify: `lib/catalog-client.ts`, `lib/catalog-client.test.ts`. Test path:
`lib/catalog-client.test.ts`.

**Interfaces**

Consumes: `searchFoods`, `SearchOptions`, `SearchResult`, `SEARCH_DEBOUNCE_MS` from this file.

Produces:
```ts
export type SearchController = {
  /** Resolves `null` when a later keystroke superseded this one. */
  search(q: string, opts?: SearchOptions): Promise<SearchResult | null>;
  cancel(): void;
};
export function createSearchController(opts?: { debounceMs?: number }): SearchController;
```

- [ ] Write the failing test. Append to `lib/catalog-client.test.ts`:
  ```ts
  import { afterEach, beforeEach } from "vitest";
  import { createSearchController, SEARCH_DEBOUNCE_MS } from "./catalog-client";

  describe("createSearchController", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("waits the debounce before it calls the network", async () => {
      const fetchImpl = jsonFetch(200, { hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" });
      const c = createSearchController();
      const p = c.search("chi", { fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await p;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("a second keystroke inside the window replaces the first, which resolves null", async () => {
      const fetchImpl = jsonFetch(200, { hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" });
      const c = createSearchController();
      const first = c.search("chi", { fetchImpl });
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS / 2);
      const second = c.search("chick", { fetchImpl });
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await expect(first).resolves.toBeNull();
      expect((await second)?.kind).toBe("online");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("aborts an in-flight request when the next keystroke arrives", async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return new Response("{}", { status: 503 });
      }) as unknown as typeof fetch;
      const c = createSearchController();
      const first = c.search("chi", { fetchImpl });
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      const second = c.search("chick", { fetchImpl });
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      await Promise.all([first, second]);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
    });

    it("cancel() drops a pending keystroke without a fetch", async () => {
      const fetchImpl = jsonFetch(200, { hits: [], queryClass: "generic", autoResolve: null, catalogVersion: "v" });
      const c = createSearchController();
      const p = c.search("chi", { fetchImpl });
      c.cancel();
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
      await expect(p).resolves.toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
  ```
- [ ] Run it. Expected failure:
      `SyntaxError: The requested module './catalog-client' does not provide an export named 'createSearchController'`.
  ```bash
  pnpm test lib/catalog-client.test.ts
  ```
- [ ] Write the implementation. Append to `lib/catalog-client.ts`:
  ```ts
  export type SearchController = {
    search(q: string, opts?: SearchOptions): Promise<SearchResult | null>;
    cancel(): void;
  };

  /**
   * One controller per open sheet. Each keystroke supersedes the one before it: the pending timer is
   * cleared, the in-flight request is aborted, and the superseded promise resolves `null` so the
   * caller can `if (r === null) return;` instead of racing setState calls.
   */
  export function createSearchController(opts: { debounceMs?: number } = {}): SearchController {
    const wait = opts.debounceMs ?? SEARCH_DEBOUNCE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;
    let generation = 0;

    function stop(): void {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      inFlight?.abort();
      inFlight = null;
    }

    return {
      cancel(): void { generation += 1; stop(); },
      search(q, searchOpts = {}): Promise<SearchResult | null> {
        generation += 1;
        const mine = generation;
        stop();
        return new Promise<SearchResult | null>((resolve, reject) => {
          timer = setTimeout(() => {
            timer = null;
            if (mine !== generation) { resolve(null); return; }
            const ac = new AbortController();
            inFlight = ac;
            searchFoods(q, { ...searchOpts, signal: ac.signal }).then(
              (r) => resolve(mine === generation ? r : null),
              (e) => {
                if (mine !== generation) { resolve(null); return; }
                if (e instanceof DOMException && e.name === "AbortError") { resolve(null); return; }
                reject(e);
              }
            );
          }, wait);
        });
      },
    };
  }
  ```
- [ ] Run it. Expected: `Tests  14 passed (14)`.
  ```bash
  pnpm test lib/catalog-client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/catalog-client.ts lib/catalog-client.test.ts \
    && git commit -m "feat(catalog): debounce keystrokes and abort the superseded request"
  ```

---

## Task 5 — `getFoodDetail` and the cache write-through

**Files** — Modify: `lib/catalog-client.ts`, `lib/catalog-client.test.ts`. Test path:
`lib/catalog-client.test.ts`.

**Interfaces**

Consumes: `FoodDetail` from `@/lib/server/catalog` (Lane G, contracts §3); `putRevision`,
`getRevision`, `type CachedRevision` from `@/lib/db/catalog-cache`.

Produces:
```ts
export type DetailResult =
  | { kind: "ok"; detail: FoodDetail }
  | { kind: "cached"; revision: CachedRevision }   // no network, but we have seen this food
  | { kind: "blocked" }                            // no network and no cached copy
  | { kind: "not_found" };
export async function getFoodDetail(catalogFoodId: number,
  opts?: { revisionId?: number; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<DetailResult>;
export function toCachedRevision(detail: FoodDetail, now?: number): CachedRevision;
export async function cacheDetail(detail: FoodDetail, now?: number): Promise<CachedRevision>;
```

- [ ] Write the failing test. Append to `lib/catalog-client.test.ts`:
  ```ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { closeSmcDb } from "@/lib/sync/idb";
  import { putRevision } from "@/lib/db/catalog-cache";
  import { cacheDetail, getFoodDetail, toCachedRevision } from "./catalog-client";

  const DETAIL = {
    catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted", brand: null,
    source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
    score: 0, prefStatus: null, category: "Poultry Products", catalogVersion: "2026-04",
    attribution: "USDA SR Legacy 2026-04",
    per100g: {
      energy_kcal: { amount: 165, unit: "kcal" }, protein: { amount: 31, unit: "g" },
      carbohydrate: { amount: 0, unit: "g" }, fat_total: { amount: 3.6, unit: "g" },
      fiber_total: { amount: null, unit: "g" },
    },
    portions: [{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }],
    ingredients: [],
  };

  describe("getFoodDetail", () => {
    beforeEach(async () => { await closeSmcDb(); globalThis.indexedDB = new IDBFactory(); });

    it("returns the detail on a 200", async () => {
      const fetchImpl = jsonFetch(200, DETAIL);
      const r = await getFoodDetail(41, { fetchImpl });
      expect(r).toMatchObject({ kind: "ok" });
      const url = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
      expect(url).toBe("/api/foods/41");
    });

    it("returns not_found on a 404", async () => {
      await expect(getFoodDetail(41, { fetchImpl: jsonFetch(404, { error: "not_found" }) }))
        .resolves.toEqual({ kind: "not_found" });
    });

    it("serves the cached revision when the network is gone and we have seen the food", async () => {
      await putRevision(toCachedRevision(DETAIL as never, Date.parse("2026-09-11T10:00:00.000Z")));
      const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
      const r = await getFoodDetail(41, { revisionId: 910, fetchImpl });
      expect(r.kind).toBe("cached");
      expect(r.kind === "cached" && r.revision.per_100g.protein).toBe(31);
    });

    it("blocks the food when the network is gone and nothing is cached", async () => {
      const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
      await expect(getFoodDetail(41, { revisionId: 910, fetchImpl })).resolves.toEqual({ kind: "blocked" });
    });
  });

  describe("toCachedRevision", () => {
    it("keeps a measured zero and a null apart, and copies the portions", () => {
      const row = toCachedRevision(DETAIL as never, Date.parse("2026-09-11T10:00:00.000Z"));
      expect(row.per_100g.carbohydrate).toBe(0);
      expect(row.per_100g.fiber_total).toBeNull();
      expect(row.version_label).toBe("2026-04");
      expect(row.portions).toEqual([{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }]);
      expect(row.cached_at).toBe("2026-09-11T10:00:00.000Z");
    });
  });

  describe("cacheDetail", () => {
    beforeEach(async () => { await closeSmcDb(); globalThis.indexedDB = new IDBFactory(); });
    it("writes the revision through to IndexedDB", async () => {
      await cacheDetail(DETAIL as never, Date.parse("2026-09-11T10:00:00.000Z"));
      const { getRevision } = await import("@/lib/db/catalog-cache");
      await expect(getRevision(910)).resolves.toMatchObject({ description: "Chicken breast, roasted" });
    });
  });
  ```
- [ ] Run it. Expected failure:
      `SyntaxError: The requested module './catalog-client' does not provide an export named 'getFoodDetail'`.
  ```bash
  pnpm test lib/catalog-client.test.ts
  ```
- [ ] Write the implementation. Append to `lib/catalog-client.ts`:
  ```ts
  import { getRevision, putRevision, type CachedRevision } from "@/lib/db/catalog-cache";
  import type { FoodDetail } from "@/lib/server/catalog";

  export type DetailResult =
    | { kind: "ok"; detail: FoodDetail }
    | { kind: "cached"; revision: CachedRevision }
    | { kind: "blocked" }
    | { kind: "not_found" };

  /** The wire detail, flattened to what an offline snapshot needs. `null` stays `null`; `0` stays `0`. */
  export function toCachedRevision(detail: FoodDetail, now: number = Date.now()): CachedRevision {
    const per100g: Record<string, number | null> = {};
    for (const [code, value] of Object.entries(detail.per100g)) per100g[code] = value.amount;
    return {
      revision_id: detail.revisionId,
      catalog_food_id: detail.catalogFoodId,
      description: detail.description,
      brand: detail.brand,
      source: detail.source,
      version_label: detail.catalogVersion,
      per_100g: per100g,
      portions: detail.portions.map((p) => ({
        id: p.id, description: p.description, gramWeight: p.gramWeight, isDefault: p.isDefault,
      })),
      cached_at: new Date(now).toISOString(),
    };
  }

  export async function cacheDetail(detail: FoodDetail, now?: number): Promise<CachedRevision> {
    const row = toCachedRevision(detail, now);
    await putRevision(row);
    return row;
  }

  /**
   * phase-2-real-logging.md, Offline: "A cache miss with no network blocks that food and says so,
   * never a zeroed item." That is the `blocked` arm — the sheet refuses the food rather than logging
   * an entry whose every nutrient would read 0.
   */
  export async function getFoodDetail(
    catalogFoodId: number,
    opts: { revisionId?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
  ): Promise<DetailResult> {
    const doFetch = opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`/api/foods/${catalogFoodId}`, {
        signal: opts.signal, headers: { accept: "application/json" },
      });
      if (res.status === 404) return { kind: "not_found" };
      if (res.ok) {
        const detail = (await res.json()) as FoodDetail;
        await cacheDetail(detail);
        return { kind: "ok", detail };
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
    }
    const cached = opts.revisionId === undefined ? undefined : await getRevision(opts.revisionId);
    return cached ? { kind: "cached", revision: cached } : { kind: "blocked" };
  }
  ```
- [ ] Run it. Expected: `Tests  20 passed (20)`.
  ```bash
  pnpm test lib/catalog-client.test.ts
  ```
- [ ] Check the file budget (contracts §8, files < 400 lines).
  ```bash
  wc -l lib/catalog-client.ts lib/db/catalog-cache.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/catalog-client.ts lib/catalog-client.test.ts \
    && git commit -m "feat(catalog): food detail read with a cache write-through and offline block"
  ```

---

## Task 6 — `lib/log-client.ts`: food refs, the live strip, and the commit

**Files** — Create: `lib/log-client.ts`. Test path: `lib/log-client.test.ts`.

**Interfaces**

Consumes: `LogCommitRequest`, `LogCommitResponse`, `LogCommitFailure`, `LogItemInput` from
`@/lib/log/contract` (Lane H, contracts §4); `computeSnapshot`, `type Snapshot`, `type SnapshotMeta`
from `@/lib/nutrients/snapshot`; `MACRO_CODES`, `NUTRIENT_UNITS` from `@/lib/nutrients/codes`;
`gramsForPortion` from `@/lib/log/grams`; `type CachedRevision`, `type CachedPortion` from
`@/lib/db/catalog-cache`; `enqueue` from `@/lib/sync/outbox` and `allOps` from `@/lib/sync/idb`
(Phase 0); `createBrowserClient`-backed client from `@/lib/supabase/client` (Lane B).

Produces:
```ts
// lib/log-client.ts
export type MacroStrip = { kcal: number; protein: number; carbs: number; fat: number; fiber: number };
export function snapshotFor(revision: CachedRevision, grams: number): Snapshot;
export function liveStrip(revision: CachedRevision, grams: number): MacroStrip;
export function buildCommitRequest(args: {
  entryId: string; eatenAt: Date; tz: string; slot: SlotId; note?: string; baseRev?: number;
  items: { id: string; foodRefId: string; revision: CachedRevision; grams: number;
           qty: number; unit: string; portionId?: number | null; wasEdited?: boolean }[];
}): LogCommitRequest;
export function localDateOf(at: Date): string;                       // YYYY-MM-DD, local
export async function resolveFoodRef(catalogFoodId: number): Promise<string | null>;
export async function commitLogEntry(req: LogCommitRequest,
  opts?: { fetchImpl?: typeof fetch }): Promise<LogCommitResponse | LogCommitFailure | { status: "queued" }>;
export async function pendingEntryIds(): Promise<Set<string>>;
```

- [ ] Write the failing test.
  ```ts
  // lib/log-client.test.ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { beforeEach, describe, expect, it, vi } from "vitest";
  import { closeSmcDb } from "@/lib/sync/idb";
  import type { CachedRevision } from "@/lib/db/catalog-cache";
  import { buildCommitRequest, commitLogEntry, liveStrip, localDateOf, pendingEntryIds, snapshotFor } from "./log-client";

  const REV: CachedRevision = {
    revision_id: 910, catalog_food_id: 41, description: "Chicken breast, roasted", brand: null,
    source: "fdc_sr_legacy", version_label: "2026-04",
    per_100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: null, iron: 1.04 },
    portions: [{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }],
    cached_at: "2026-09-11T10:00:00.000Z",
  };

  beforeEach(async () => { await closeSmcDb(); globalThis.indexedDB = new IDBFactory(); });

  describe("snapshotFor", () => {
    it("scales per-100 g values by grams and keeps the source on every nutrient", () => {
      const s = snapshotFor(REV, 140);
      expect(s.protein.amount).toBeCloseTo(43.4, 4);
      expect(s.protein.unit).toBe("g");
      expect(s.protein.basis).toBe("per_100g");
      expect(s.protein.source).toBe("fdc_sr_legacy");
      expect(s.protein.source_version).toBe("2026-04");
      expect(s.protein.revision_id).toBe(910);
    });

    it("keeps a measured zero at 0 and an unmeasured nutrient at null", () => {
      const s = snapshotFor(REV, 140);
      expect(s.carbohydrate.amount).toBe(0);
      expect(s.fiber_total.amount).toBeNull();
    });
  });

  describe("liveStrip", () => {
    it("reads the five strip numbers off the snapshot", () => {
      expect(liveStrip(REV, 140)).toEqual({ kcal: 231, protein: 43.4, carbs: 0, fat: 5, fiber: 0 });
    });
    it("is zero at zero grams", () => {
      expect(liveStrip(REV, 0)).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
    });
  });

  describe("buildCommitRequest", () => {
    it("emits the snake_case wire shape with method 'search' and no base_rev on a create", () => {
      const req = buildCommitRequest({
        entryId: "11111111-1111-4111-8111-111111111111",
        eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "America/New_York", slot: "meal-2",
        items: [{ id: "22222222-2222-4222-8222-222222222222", foodRefId: "33333333-3333-4333-8333-333333333333",
                  revision: REV, grams: 140, qty: 140, unit: "g", portionId: null }],
      });
      expect(req.method).toBe("search");
      expect(req).not.toHaveProperty("base_rev");
      expect(req.items[0]).toMatchObject({
        seq: 1, food_ref_id: "33333333-3333-4333-8333-333333333333",
        grams: 140, qty: 140, unit: "g", food_revision_id: 910, portion_id: null, was_edited: false,
      });
      expect(req.local_date).toBe(localDateOf(new Date("2026-09-11T18:30:00.000Z")));
    });

    it("numbers items from 1 and carries base_rev on an edit", () => {
      const req = buildCommitRequest({
        entryId: "e", eatenAt: new Date(), tz: "UTC", slot: "meal-1", baseRev: 4,
        items: [
          { id: "a", foodRefId: "fa", revision: REV, grams: 100, qty: 1, unit: "portion", portionId: 3, wasEdited: true },
          { id: "b", foodRefId: "fb", revision: REV, grams: 50, qty: 50, unit: "g" },
        ],
      });
      expect(req.base_rev).toBe(4);
      expect(req.items.map((i) => i.seq)).toEqual([1, 2]);
      expect(req.items[0].was_edited).toBe(true);
    });
  });

  describe("commitLogEntry", () => {
    const REQ = buildCommitRequest({
      entryId: "44444444-4444-4444-8444-444444444444", eatenAt: new Date("2026-09-11T18:30:00.000Z"),
      tz: "UTC", slot: "meal-2",
      items: [{ id: "i1", foodRefId: "f1", revision: REV, grams: 140, qty: 140, unit: "g" }],
    });

    it("returns the server response on a 200", async () => {
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ status: "ok", entry_id: REQ.entry_id, rev: 1, items: [], totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;
      await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toMatchObject({ status: "ok", rev: 1 });
    });

    it("returns the failure body on a 409 without queuing anything", async () => {
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ status: "conflict", current_rev: 7, entity: {} }),
        { status: 409, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;
      await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toMatchObject({ status: "conflict", current_rev: 7 });
      await expect(pendingEntryIds()).resolves.toEqual(new Set());
    });

    it("queues the same payload through the outbox when the network is gone", async () => {
      const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
      await expect(commitLogEntry(REQ, { fetchImpl })).resolves.toEqual({ status: "queued" });
      await expect(pendingEntryIds()).resolves.toEqual(new Set([REQ.entry_id]));
    });
  });
  ```
- [ ] Run it. Expected failure:
      `Error: Failed to load url ./log-client (resolved id: …/lib/log-client)`.
  ```bash
  pnpm test lib/log-client.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/log-client.ts
  /**
   * The client half of POST /api/log/commit — contracts §4, phase-2-real-logging.md.
   *
   * One rule holds this file together: the client and the server compute the SAME snapshot from the
   * SAME per-100 g values, and the server's copy wins on sync. So the sheet can show real numbers
   * with no signal, the outbox can carry the identical payload, and nothing diverges.
   */
  import { getBrowserClient } from "@/lib/supabase/client";
  import { MACRO_CODES, NUTRIENT_UNITS } from "@/lib/nutrients/codes";
  import { computeSnapshot, type Snapshot } from "@/lib/nutrients/snapshot";
  import type { LogCommitFailure, LogCommitRequest, LogCommitResponse, LogItemInput } from "@/lib/log/contract";
  import type { CachedRevision } from "@/lib/db/catalog-cache";
  import { allOps } from "@/lib/sync/idb";
  import { enqueue } from "@/lib/sync/outbox";
  import type { SlotId } from "@/lib/types";

  export type MacroStrip = { kcal: number; protein: number; carbs: number; fat: number; fiber: number };

  export function snapshotFor(revision: CachedRevision, grams: number): Snapshot {
    return computeSnapshot(revision.per_100g, grams, {
      source: revision.source,
      source_version: revision.version_label,
      revision_id: revision.revision_id,
      units: NUTRIENT_UNITS,
    });
  }

  function round1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  /** The five numbers on the sheet's live strip. An unmeasured nutrient reads 0 here, not "—". */
  export function liveStrip(revision: CachedRevision, grams: number): MacroStrip {
    const s = snapshotFor(revision, grams);
    const at = (code: string): number => s[code]?.amount ?? 0;
    return {
      kcal: Math.round(at(MACRO_CODES.kcal)),
      protein: round1(at(MACRO_CODES.protein)),
      carbs: round1(at(MACRO_CODES.carbs)),
      fat: round1(at(MACRO_CODES.fat)),
      fiber: round1(at(MACRO_CODES.fiber)),
    };
  }

  /** Local calendar date of an instant — the same UTC-midnight-avoiding shape lib/plan.ts uses. */
  export function localDateOf(at: Date): string {
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  }

  export function buildCommitRequest(args: {
    entryId: string; eatenAt: Date; tz: string; slot: SlotId; note?: string; baseRev?: number;
    items: {
      id: string; foodRefId: string; revision: CachedRevision; grams: number;
      qty: number; unit: string; portionId?: number | null; wasEdited?: boolean;
    }[];
  }): LogCommitRequest {
    const items: LogItemInput[] = args.items.map((item, i) => ({
      id: item.id, seq: i + 1, food_ref_id: item.foodRefId,
      qty: item.qty, unit: item.unit, grams: item.grams,
      portion_id: item.portionId ?? null,
      food_revision_id: item.revision.revision_id,
      was_edited: item.wasEdited ?? false,
    }));
    const req: LogCommitRequest = {
      entry_id: args.entryId, eaten_at: args.eatenAt.toISOString(), tz: args.tz,
      local_date: localDateOf(args.eatenAt), slot: args.slot, method: "search", items,
    };
    if (args.baseRev !== undefined) req.base_rev = args.baseRev;
    if (args.note?.trim()) req.note = args.note.trim();
    return req;
  }

  // ---------------------------------------------------------------- food refs

  const REF_KEY = "meal-companion:food-refs";
  const refCache = new Map<string, string>();

  function readRefs(): Record<string, string> {
    try { return JSON.parse(window.localStorage.getItem(REF_KEY) ?? "{}") as Record<string, string>; }
    catch { return {}; }
  }

  function writeRef(key: string, id: string): void {
    try { window.localStorage.setItem(REF_KEY, JSON.stringify({ ...readRefs(), [key]: id })); }
    catch { /* private browsing — the in-memory cache still holds for this session */ }
  }

  /**
   * catalog_food_id → food_refs.id. The registry row is shared and permanent (architecture §3.2), so
   * once resolved it is cached in localStorage and works offline for every later log of that food.
   */
  export async function resolveFoodRef(catalogFoodId: number): Promise<string | null> {
    const key = `catalog:${catalogFoodId}`;
    const memo = refCache.get(key) ?? readRefs()[key];
    if (memo) { refCache.set(key, memo); return memo; }
    const supabase = getBrowserClient();
    const { data: claims } = await supabase.auth.getClaims();
    const userId = claims?.claims?.sub;
    if (!userId) return null;
    const { data, error } = await supabase.rpc("get_or_create_food_ref", {
      p_user_id: userId, p_kind: "catalog", p_catalog_food_id: catalogFoodId, p_user_food_id: null,
    });
    if (error || typeof data !== "string") return null;
    refCache.set(key, data);
    writeRef(key, data);
    return data;
  }

  // ------------------------------------------------------------------ commit

  export async function commitLogEntry(
    req: LogCommitRequest,
    opts: { fetchImpl?: typeof fetch } = {}
  ): Promise<LogCommitResponse | LogCommitFailure | { status: "queued" }> {
    const doFetch = opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch("/api/log/commit", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(req),
      });
      if (res.status >= 500) return queue(req);
      return (await res.json()) as LogCommitResponse | LogCommitFailure;
    } catch {
      return queue(req);
    }
  }

  /**
   * The offline path of contracts §4: the same payload as a `log_entries` op, applied later by
   * /api/sync/ops, which calls compute_item_snapshot in SQL. Both paths reach applyLogEntry.
   */
  async function queue(req: LogCommitRequest): Promise<{ status: "queued" }> {
    await enqueue({
      op_id: crypto.randomUUID(),
      entity: "log_entries",
      entity_id: req.entry_id,
      kind: req.base_rev === undefined ? "create" : "update",
      base_rev: req.base_rev ?? null,
      payload: req as unknown as Record<string, unknown>,
      client_ts: new Date().toISOString(),
    });
    return { status: "queued" };
  }

  /** Entry ids still sitting in the outbox — LoggedExtras draws a pending dot for each. */
  export async function pendingEntryIds(): Promise<Set<string>> {
    const ops = await allOps();
    return new Set(ops.filter((o) => o.entity === "log_entries").map((o) => o.entity_id));
  }
  ```
- [ ] Run it. Expected: `Tests  8 passed (8)`.
  ```bash
  pnpm test lib/log-client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/log-client.ts lib/log-client.test.ts \
    && git commit -m "feat(log): build, commit and queue log entries from the client"
  ```

---

## Task 7 — `lib/store.ts`: extras carry `items[]`

**Files** — Modify: `lib/store.ts`. Create: `lib/store.test.ts`. Test path: `lib/store.test.ts`.
`lib/types.ts` is **not** edited by this task — it is not in Lane I's contracts §1 row and carries no
shared-list carve-out either, so the `LoggedItem` type and the `LoggedFood.items` widening land on the
integration branch instead (Hand-off item 3). This task's import of `LoggedItem` from `./types` is
therefore red — `pnpm exec tsc --noEmit` fails — until that rebase; that is expected, the same pattern
Task 1 documents for `lib/sync/idb.ts`.

**Interfaces**

Consumes: `type Snapshot` from `@/lib/nutrients/snapshot`; `type LoggedItem` from `@/lib/types` — the
integration branch's addition (Hand-off item 3), shown here for reference:
```ts
// lib/types.ts (additive, landed by the integration branch, not this task)
export type LoggedItem = {
  id: string; seq: number; food_ref_id: string; grams: number; qty: number; unit: string;
  snapshot: Snapshot;
  /** Display half, kept so a legacy logged meal renders exactly as it did. */
  name: string; portionLabel: string; macros: Macros;
};
// LoggedFood.items?: LoggedFood[]  →  LoggedFood.items?: LoggedItem[]
```

Produces:
```ts
// lib/store.ts
export function migrateExtraItems(extras: LoggedFood[]): { extras: LoggedFood[]; changed: boolean };
```

- [ ] Write the failing test.
  ```ts
  // lib/store.test.ts
  import { describe, expect, it } from "vitest";
  import { migrateExtraItems } from "./store";
  import type { LoggedFood } from "./types";

  const legacyMeal = {
    id: "m1", foodId: "meal", name: "Chipotle bowl", portionLabel: "2 items", qty: 1, grams: 400,
    macros: { kcal: 700, protein: 40, carbs: 80, fat: 20 }, at: "2026-09-11T18:00:00.000Z",
    items: [
      { id: "a", foodId: "rice", name: "White rice", portionLabel: "1 cup", qty: 1, grams: 180,
        macros: { kcal: 234, protein: 5, carbs: 51, fat: 0 }, at: "2026-09-11T18:00:00.000Z" },
      { id: "b", foodId: "chicken", name: "Chicken", portionLabel: "3 oz", qty: 2, grams: 170,
        macros: { kcal: 280, protein: 52, carbs: 0, fat: 6 }, at: "2026-09-11T18:00:00.000Z" },
    ],
  } as unknown as LoggedFood;

  describe("migrateExtraItems", () => {
    it("backfills the Phase 2 half of every legacy meal item and keeps the display half", () => {
      const { extras, changed } = migrateExtraItems([legacyMeal]);
      expect(changed).toBe(true);
      const items = extras[0].items!;
      expect(items.map((i) => i.seq)).toEqual([1, 2]);
      expect(items[0]).toMatchObject({
        food_ref_id: "local:rice", unit: "portion", grams: 180,
        name: "White rice", portionLabel: "1 cup",
      });
      expect(items[0].snapshot).toEqual({});
      expect(items[0].macros.kcal).toBe(234);
    });

    it("is idempotent — a second pass changes nothing", () => {
      const once = migrateExtraItems([legacyMeal]);
      const twice = migrateExtraItems(once.extras);
      expect(twice.changed).toBe(false);
      expect(twice.extras).toEqual(once.extras);
    });

    it("leaves a Phase 2 entry alone", () => {
      const modern = {
        id: "e1", foodId: "catalog:41", name: "Chicken breast", portionLabel: "140 g", qty: 140,
        grams: 140, macros: { kcal: 231, protein: 43.4, carbs: 0, fat: 5 }, at: "2026-09-11T18:00:00.000Z",
        items: [{ id: "i1", seq: 1, food_ref_id: "uuid-1", grams: 140, qty: 140, unit: "g",
                  snapshot: { protein: { amount: 43.4, unit: "g", basis: "per_100g",
                              source: "fdc_sr_legacy", source_version: "2026-04", revision_id: 910 } },
                  name: "Chicken breast", portionLabel: "140 g",
                  macros: { kcal: 231, protein: 43.4, carbs: 0, fat: 5 } }],
      } as unknown as LoggedFood;
      const { extras, changed } = migrateExtraItems([modern]);
      expect(changed).toBe(false);
      expect(extras[0].items![0].food_ref_id).toBe("uuid-1");
    });

    it("leaves a single-food extra with no items alone", () => {
      const single = { id: "s", foodId: "banana", name: "Banana", portionLabel: "1 medium", qty: 1,
        grams: 118, macros: { kcal: 105, protein: 1, carbs: 27, fat: 0 }, at: "2026-09-11T08:00:00.000Z" } as LoggedFood;
      const { extras, changed } = migrateExtraItems([single]);
      expect(changed).toBe(false);
      expect(extras[0].items).toBeUndefined();
    });
  });
  ```
- [ ] Run it. Expected failure:
      `SyntaxError: The requested module './store' does not provide an export named 'migrateExtraItems'`.
  ```bash
  pnpm test lib/store.test.ts
  ```
- [ ] Confirm `lib/types.ts` still carries only the Phase 0 shape on this branch (it is not this
      task's to widen — Hand-off item 3):
  ```bash
  git diff --stat main -- lib/types.ts
  ```
  Expected: empty. The type the integration branch will add there is:
  ```ts
  /**
   * One item of a logged entry — contracts §5. The first seven fields are the Phase 2 wire half
   * (`log_items`); the last three are the display half a legacy logged meal already carried, kept so
   * `NoteSheet`, `LoggedExtras` and MCP `get_day` render unchanged through the migration.
   * An empty `snapshot` means "no nutrient data" — `lib/resolve.ts` then totals from `macros`.
   */
  export type LoggedItem = {
    id: string;
    seq: number;
    food_ref_id: string;
    grams: number;
    qty: number;
    unit: string;
    snapshot: import("./nutrients/snapshot").Snapshot;
    name: string;
    portionLabel: string;
    macros: Macros;
  };
  ```
  and the one changed line inside `LoggedFood`:
  ```ts
    /** A logged MEAL: its foods. `macros` is their sum. */
    items?: LoggedItem[];
  ```
- [ ] Add the migration to `lib/store.ts`, above `normalizeStore`:
  ```ts
  /**
   * Legacy logged meals stored their foods as nested `LoggedFood`s. Contracts §5 gives every item the
   * Phase 2 fields; this fills them in place the first time a phone loads after the upgrade. The
   * discriminator is `food_ref_id`: an item that has one has already been migrated (or was written by
   * Phase 2 in the first place). Synthesised refs are namespaced `local:` so they can never collide
   * with a `food_refs` UUID.
   */
  export function migrateExtraItems(extras: LoggedFood[]): { extras: LoggedFood[]; changed: boolean } {
    let changed = false;
    const next = extras.map((entry) => {
      const items = entry.items;
      if (!items || items.length === 0) return entry;
      if (items.every((i) => typeof i.food_ref_id === "string" && i.food_ref_id.length > 0)) return entry;
      changed = true;
      return {
        ...entry,
        items: items.map((item, i) => {
          const legacy = item as unknown as { foodId?: string };
          return {
            id: item.id,
            seq: item.seq ?? i + 1,
            food_ref_id: item.food_ref_id ?? `local:${legacy.foodId ?? item.id}`,
            grams: item.grams,
            qty: item.qty,
            unit: item.unit ?? "portion",
            snapshot: item.snapshot ?? {},
            name: item.name,
            portionLabel: item.portionLabel,
            macros: item.macros,
          };
        }),
      };
    });
    return { extras: next, changed };
  }
  ```
  and call it from `normalizeStore`, immediately after the `REMOVED_SEED` loop, before the return:
  ```ts
    for (const [date, day] of Object.entries(days)) {
      if (!day.extras?.length) continue;
      const result = migrateExtraItems(day.extras);
      if (result.changed) {
        days[date] = { ...day, extras: result.extras };
        migrated = true;
      }
    }
  ```
  Add `LoggedItem` to the `lib/types.ts` import list at the top of the file. Nothing else in
  `lib/store.ts` changes: `addExtra`, `updateExtra`, `removeExtra`, `updateDay` and the Phase 0 outbox
  emission that the Phase 0 integration branch added inside them stay exactly where they are.
- [ ] Run it. Expected once the integration branch has landed `LoggedItem` (Hand-off item 3):
      `Tests  4 passed (4)`. Until then this is red at the import, the same expected-red state as
      Task 1.
  ```bash
  pnpm test lib/store.test.ts
  ```
- [ ] Confirm nothing else broke, once `LoggedItem` exists on this branch.
  ```bash
  pnpm exec tsc --noEmit
  ```
- [ ] Commit.
  ```bash
  git add lib/store.ts lib/store.test.ts \
    && git commit -m "feat(log): logged extras carry grams and a nutrient snapshot per item"
  ```

---

## Task 8 — `lib/resolve.ts`: totals from snapshots, falling back to macros

This is the whole of the `MacroRings` change. `components/MacroRings.tsx` is not edited: its props and
its Lane E styling stay as they are, and its `consumed` values change because this file changed.

**Files** — Modify: `lib/resolve.ts`, `lib/resolve.test.ts`. Test path: `lib/resolve.test.ts`.

**Interfaces**

Consumes: `totalsFor`, `type NutrientTotal` from `@/lib/nutrients/totals`; `MACRO_CODES`,
`TRACKED_MICROS` from `@/lib/nutrients/codes`; `type LoggedFood`, `type LoggedItem`, `type Macros`,
`type ResolvedDay` from `./types`.

Produces:
```ts
export function snapshotMacros(items: LoggedItem[] | undefined): Macros | null;  // null = nothing measured
export function entryMacros(entry: LoggedFood): Macros;
export function dayNutrientTotals(day: ResolvedDay): Map<string, NutrientTotal>;
```

- [ ] Write the failing test. Append to `lib/resolve.test.ts`:
  ```ts
  import { dayNutrientTotals, entryMacros, snapshotMacros } from "./resolve";
  import type { LoggedFood } from "./types";

  function value(amount: number | null, unit: string) {
    return { amount, unit, basis: "per_100g" as const, source: "fdc_sr_legacy",
             source_version: "2026-04", revision_id: 910 };
  }

  const snapshotEntry = {
    id: "e1", foodId: "catalog:41", name: "Chicken breast", portionLabel: "140 g", qty: 140,
    grams: 140, macros: { kcal: 9999, protein: 9999, carbs: 9999, fat: 9999 },
    at: "2026-09-11T18:00:00.000Z",
    items: [{
      id: "i1", seq: 1, food_ref_id: "uuid-1", grams: 140, qty: 140, unit: "g",
      name: "Chicken breast", portionLabel: "140 g",
      macros: { kcal: 9999, protein: 9999, carbs: 9999, fat: 9999 },
      snapshot: {
        energy_kcal: value(231, "kcal"), protein: value(43.4, "g"),
        carbohydrate: value(0, "g"), fat_total: value(5, "g"),
        fiber_total: value(null, "g"), iron: value(1.5, "mg"),
      },
    }],
  } as unknown as LoggedFood;

  const legacyEntry = {
    id: "e2", foodId: "banana", name: "Banana", portionLabel: "1 medium", qty: 1, grams: 118,
    macros: { kcal: 105, protein: 1, carbs: 27, fat: 0 }, at: "2026-09-11T08:00:00.000Z",
  } as LoggedFood;

  describe("snapshot totals", () => {
    it("prefers the snapshot over the stored macros when one exists", () => {
      expect(snapshotMacros(snapshotEntry.items)).toEqual({ kcal: 231, protein: 43.4, carbs: 0, fat: 5 });
      expect(entryMacros(snapshotEntry)).toEqual({ kcal: 231, protein: 43.4, carbs: 0, fat: 5 });
    });

    it("falls back to the stored macros for an entry with no items", () => {
      expect(snapshotMacros(undefined)).toBeNull();
      expect(entryMacros(legacyEntry)).toEqual({ kcal: 105, protein: 1, carbs: 27, fat: 0 });
    });

    it("falls back when every item carries an empty snapshot", () => {
      const migrated = { ...snapshotEntry, items: snapshotEntry.items!.map((i) => ({ ...i, snapshot: {} })) };
      expect(snapshotMacros(migrated.items)).toBeNull();
      expect(entryMacros(migrated).kcal).toBe(9999);
    });

    it("a day mixing both sums each entry by its own rule", () => {
      const store = storeWith();
      store.days[MONDAY] = { date: MONDAY, extras: [snapshotEntry, legacyEntry] };
      const day = resolveDay(store, MONDAY);
      expect(day.consumed.kcal).toBe(336);          // 231 + 105
      expect(day.consumed.protein).toBe(44);        // 43.4 + 1, rounded
    });
  });

  describe("dayNutrientTotals", () => {
    it("totals every nutrient across snapshot entries and counts coverage", () => {
      const store = storeWith();
      store.days[MONDAY] = { date: MONDAY, extras: [snapshotEntry, legacyEntry] };
      const totals = dayNutrientTotals(resolveDay(store, MONDAY));
      expect(totals.get("iron")?.amount).toBe(1.5);
      expect(totals.get("iron")?.itemsWithValue).toBe(1);
      expect(totals.get("fiber_total")?.itemsWithValue).toBe(0);
      expect(totals.get("energy_kcal")?.amount).toBe(231);
    });
  });
  ```
- [ ] Run it. Expected failure:
      `SyntaxError: The requested module './resolve' does not provide an export named 'snapshotMacros'`.
  ```bash
  pnpm test lib/resolve.test.ts
  ```
- [ ] Write the implementation. Add to `lib/resolve.ts`:
  ```ts
  import { MACRO_CODES } from "./nutrients/codes";
  import { totalsFor, type NutrientTotal } from "./nutrients/totals";
  import type { LoggedFood, LoggedItem } from "./types";

  /**
   * Phase 2 acceptance 5: the rings read from logged snapshots. `null` means this entry has nothing
   * measured — a pre-Phase-2 extra, or a migrated legacy meal item — and the caller uses the stored
   * `macros` instead, so an old log keeps totalling exactly as it did.
   */
  export function snapshotMacros(items: LoggedItem[] | undefined): Macros | null {
    const measured = (items ?? []).filter((i) => Object.keys(i.snapshot ?? {}).length > 0);
    if (measured.length === 0) return null;
    const totals = totalsFor(measured);
    const at = (code: string): number => totals.get(code)?.amount ?? 0;
    return {
      kcal: at(MACRO_CODES.kcal),
      protein: at(MACRO_CODES.protein),
      carbs: at(MACRO_CODES.carbs),
      fat: at(MACRO_CODES.fat),
    };
  }

  export function entryMacros(entry: LoggedFood): Macros {
    return snapshotMacros(entry.items) ?? entry.macros;
  }

  /** Every nutrient logged on this day, with the item counts DayNutrients needs for coverage. */
  export function dayNutrientTotals(day: ResolvedDay): Map<string, NutrientTotal> {
    return totalsFor(day.extras.flatMap((e) => e.items ?? []));
  }
  ```
  and change the one line in `resolveDay` that sums extras:
  ```ts
    const raw = extras.reduce((acc, e) => add(acc, entryMacros(e)), fromSlots);
  ```
- [ ] Run it. Expected: `Tests  7 passed (7)`.
  ```bash
  pnpm test lib/resolve.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/resolve.ts lib/resolve.test.ts \
    && git commit -m "feat(log): total the day from logged snapshots, falling back to stored macros"
  ```

---

## Task 9 — `components/CatalogSearch.tsx`

**Files** — Create: `components/CatalogSearch.tsx`. Test path: manual gate (see the checklist below);
`@testing-library/react` is not installed and is not added.

**Interfaces**

Consumes: `createSearchController`, `toRows`, `type CatalogRow`, `type SearchResult` from
`@/lib/catalog-client`; `type Food` from `@/lib/foods`; Lane E utilities `.well .row .pill .pill-in .ts .tap`
and the `@theme` token names from `app/globals.css`.

Produces:
```ts
export default function CatalogSearch(props: {
  mine: Record<string, Food>;
  autoFocus?: boolean;
  onPick: (row: CatalogRow) => void;
}): JSX.Element;
```

- [ ] Write the component. Values and structure are the hit rows of
      `~/Desktop/Sasha app/07-design/neuform-mockup/LogMeal.dc.html`: a 48 px inset well with a search
      glyph, then 16 px-radius `.row` cards each carrying a 36 px source tile, two lines of text, and
      an optional pill on the right.
  ```tsx
  "use client";

  import { useEffect, useMemo, useRef, useState } from "react";
  import { createSearchController, toRows, type CatalogRow, type SearchResult } from "@/lib/catalog-client";
  import type { Food } from "@/lib/foods";

  function SearchIcon() {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
    );
  }

  /** USDA / MINE / OFF, the 36 px tile from LogMeal.dc.html. MINE is the light tile, the rest olive. */
  function SourceTile({ tile }: { tile: CatalogRow["sourceTile"] }) {
    const olive = tile !== "MINE";
    return (
      <span
        aria-hidden="true"
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] text-tiny tracking-[0.04em] ${
          olive ? "olive-panel text-[color:var(--color-on-olive)]" : "surface text-graphite"
        }`}
      >
        {tile}
      </span>
    );
  }

  function Flags({ row }: { row: CatalogRow }) {
    if (row.prefStatus === null && !row.qualityFlags.includes("energy_mismatch")) return null;
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        {row.prefStatus && (
          <span className="pill">
            <span className="pill-in flex h-[30px] items-center px-2.5 text-tiny text-graphite ts">
              {row.prefStatus === "eats" ? "Eats" : "Avoid"}
            </span>
          </span>
        )}
        {row.qualityFlags.includes("energy_mismatch") && (
          <span className="pill" title="The source's calories and its macros disagree by more than 10%">
            <span className="pill-in flex h-[30px] items-center px-2.5 text-tiny text-amber ts">Check kcal</span>
          </span>
        )}
      </span>
    );
  }

  /**
   * The Phase 1 search surface. One list for both tiers: catalog hits in the server's score order, or
   * the bundled database with one "offline results" line above it. Never both at once — a mixed list
   * would let an offline row look like a catalog row.
   */
  export default function CatalogSearch({
    mine, autoFocus, onPick,
  }: {
    mine: Record<string, Food>;
    autoFocus?: boolean;
    onPick: (row: CatalogRow) => void;
  }) {
    const [query, setQuery] = useState("");
    const [result, setResult] = useState<SearchResult>({ kind: "empty" });
    const [failed, setFailed] = useState(false);
    const controller = useMemo(() => createSearchController(), []);
    const latest = useRef(mine);
    latest.current = mine;

    useEffect(() => () => controller.cancel(), [controller]);

    function onChange(next: string) {
      setQuery(next);
      setFailed(false);
      controller.search(next, { mine: latest.current }).then(
        (r) => { if (r !== null) setResult(r); },
        () => setFailed(true)
      );
    }

    const rows = toRows(result);

    return (
      <div className="flex flex-col gap-3">
        <div className="well flex h-12 items-center gap-2.5 px-4 text-muted">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => onChange(e.target.value)}
            placeholder="e.g. chicken breast, jasmine rice"
            autoFocus={autoFocus}
            inputMode="search"
            aria-label="Search foods"
            className="min-w-0 flex-1 bg-transparent text-body-sm font-light text-charcoal outline-none placeholder:text-faint"
          />
        </div>

        {result.kind === "offline" && (
          <p className="px-1.5 text-tiny text-muted" role="status">
            Offline results — from the foods built into the app.
            {result.reason === "no_catalog" && " The catalog is not available right now."}
          </p>
        )}

        {failed && (
          <p className="px-1.5 text-tiny text-alert" role="status">
            Search did not answer. Try again, or type it from the label.
          </p>
        )}

        {query.trim() !== "" && rows.length === 0 && !failed && (
          <p className="px-1.5 text-tiny text-muted" role="status">
            Nothing matches. Try fewer words, or type it from the label below.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <button
              key={row.key}
              type="button"
              onClick={() => onPick(row)}
              className="row tap flex w-full items-center gap-3 px-3.5 py-3 text-left"
            >
              <SourceTile tile={row.sourceTile} />
              <span className="flex min-w-0 flex-grow flex-col gap-0.5">
                <span className="ts truncate text-caption font-normal text-charcoal">{row.description}</span>
                <span className="truncate text-tiny font-light text-muted">
                  {row.brand ? `${row.brand} · ` : ""}
                  {row.offline ? (row.offlineSource === "mine" ? "Your food" : "Built in") : "per 100 g"}
                </span>
              </span>
              <Flags row={row} />
            </button>
          ))}
        </div>
      </div>
    );
  }
  ```
- [ ] Type-check and lint the new file.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/CatalogSearch.tsx \
    && git commit -m "feat(catalog): search surface with source tiles and an offline label"
  ```

---

## Task 10 — `components/FoodDetailSheet.tsx`

**Files** — Create: `components/FoodDetailSheet.tsx`. Test path: manual gate.

**Interfaces**

Consumes: `type FoodDetail` from `@/lib/server/catalog`; `formatAmount` from `@/lib/nutrients/format`
(Lane H — `null` renders `—`, never `0`); `Sheet` from `@/components/Sheet`.

Produces:
```ts
export default function FoodDetailSheet(props: {
  detail: FoodDetail;
  onUse?: (portionId: number | null) => void;
  onClose: () => void;
}): JSX.Element;
```

- [ ] Write the component.
  ```tsx
  "use client";

  import Sheet from "@/components/Sheet";
  import { formatAmount } from "@/lib/nutrients/format";
  import type { FoodDetail } from "@/lib/server/catalog";

  /**
   * Read-only food detail — phase-1-catalog.md. Every number is per 100 g and `—` means the source
   * did not measure that nutrient, which is not the same as zero (architecture §3.1). The attribution
   * line is required for `off` rows (ODbL) and is shown for every source so the provenance is never
   * a special case.
   */
  export default function FoodDetailSheet({
    detail, onUse, onClose,
  }: {
    detail: FoodDetail;
    onUse?: (portionId: number | null) => void;
    onClose: () => void;
  }) {
    const codes = Object.keys(detail.per100g);
    return (
      <Sheet
        title={detail.description}
        subtitle={detail.brand ?? detail.category ?? undefined}
        onClose={onClose}
        footer={
          onUse ? (
            <button
              type="button"
              onClick={() => onUse(detail.portions.find((p) => p.isDefault)?.id ?? null)}
              className="tap w-full rounded-[12px] border border-black/20 bg-[linear-gradient(180deg,#2A2A2A_0%,#111111_100%)] px-4 py-3.5 text-body-sm text-white"
            >
              Use this food
            </button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4 px-1">
          <section className="surface rounded-[16px] p-4">
            <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Per 100 g</p>
            <dl className="flex flex-col gap-1.5">
              {codes.map((code) => (
                <div key={code} className="flex items-baseline justify-between gap-3">
                  <dt className="truncate text-caption font-light text-graphite">{code.replace(/_/g, " ")}</dt>
                  <dd className="shrink-0 text-caption tabular-nums text-charcoal ts">
                    {formatAmount(code, detail.per100g[code].amount, detail.per100g[code].unit)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {detail.portions.length > 0 && (
            <section className="surface rounded-[16px] p-4">
              <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Portions</p>
              <ul className="flex flex-col gap-1.5">
                {detail.portions.map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-3">
                    <span className="truncate text-caption font-light text-graphite">{p.description}</span>
                    <span className="shrink-0 text-caption tabular-nums text-charcoal ts">{p.gramWeight} g</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.ingredients.length > 0 && (
            <section className="surface rounded-[16px] p-4">
              <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Ingredients</p>
              <p className="text-caption font-light text-graphite">
                {detail.ingredients.map((i) => i.name).join(", ")}
              </p>
            </section>
          )}

          <p className="px-1 text-tiny font-light text-faint">
            {detail.attribution} · catalog {detail.catalogVersion}
          </p>
        </div>
      </Sheet>
    );
  }
  ```
- [ ] Type-check and lint.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/FoodDetailSheet.tsx \
    && git commit -m "feat(catalog): food detail sheet with per-100 g values and attribution"
  ```

---

## Task 11 — `components/LogFoodSheet.tsx`: the search, portion and grams rewrite

Only the single-food search and portion views change. Meal mode, the note field, "type it from the
label" and every `onAdd` / `onClose` prop stay as they are, so `app/page.tsx` keeps compiling while
Task 13 wires the rest.

**Files** — Modify: `components/LogFoodSheet.tsx`. Test path:
`tests/client/catalog-flow.test.ts` (Task 15) plus the manual gate below.

**Interfaces**

Consumes: `catalogSearchEnabled`, `getFoodDetail`, `toCachedRevision`, `type CatalogRow` from
`@/lib/catalog-client`; `type CachedRevision`, `type CachedPortion` from `@/lib/db/catalog-cache`;
`liveStrip`, `resolveFoodRef`, `buildCommitRequest`, `commitLogEntry`, `snapshotFor` from
`@/lib/log-client`; `gramsForPortion` from `@/lib/log/grams`; `Sheet`, `Pill` from `@/components/Sheet`;
`CatalogSearch` from `@/components/CatalogSearch`; the existing `searchFoods`, `dbFood`, `mineAsDb`,
`portionsFor`, `macrosForGrams` from `@/lib/food-db` for the flag-off path.

Produces: the same default export and the same props. New internal state only.

- [ ] Add the catalog branch of the **search** view. Keep the whole existing `search` view as the
      `else`; the flag picks between them:
  ```tsx
  const useCatalog = catalogSearchEnabled();
  ```
  ```tsx
  // inside the search view's <Sheet> body, replacing only the <input> + hit list:
  {useCatalog ? (
    <CatalogSearch mine={mine} autoFocus onPick={pickCatalogRow} />
  ) : (
    <>{/* the existing bundled input and hit list, unchanged */}</>
  )}
  ```
- [ ] Add the pick handler. A cache miss with no network blocks the food and says so — it never logs a
      zeroed item (phase-2-real-logging.md, Offline).
  ```tsx
  const [revision, setRevision] = useState<CachedRevision | null>(null);
  const [portion, setPortion] = useState<CachedPortion | null>(null);
  const [grams, setGrams] = useState(100);
  const [gramsText, setGramsText] = useState("100");
  const [blocked, setBlocked] = useState<string | null>(null);
  const [foodRefId, setFoodRefId] = useState<string | null>(null);

  async function pickCatalogRow(row: CatalogRow) {
    setBlocked(null);
    if (row.offline || row.catalogFoodId === null) {
      // Offline tier: the bundled database has no revision, so the Phase 0 path logs it.
      pick(row.offlineFoodId!, row.offlineSource ?? "db");
      return;
    }
    const result = await getFoodDetail(row.catalogFoodId, { revisionId: row.revisionId ?? undefined });
    if (result.kind === "not_found") { setBlocked("That food is no longer in the catalog."); return; }
    if (result.kind === "blocked") {
      setBlocked("No signal, and this food is not saved on the phone yet. Pick another, or log it when you are back online.");
      return;
    }
    const rev = result.kind === "ok" ? toCachedRevision(result.detail) : result.revision;
    const preferred = rev.portions.find((p) => p.isDefault) ?? rev.portions[0] ?? null;
    setRevision(rev);
    setPortion(preferred);
    setQty(1);
    const startGrams = preferred ? gramsForPortion({ gramWeight: preferred.gramWeight }, 1) : 100;
    setGrams(startGrams);
    setGramsText(String(startGrams));
    setFoodRefId(await resolveFoodRef(rev.catalog_food_id));
    setView("portion");
  }
  ```
- [ ] Add the catalog **portion / grams** view. Grams is the resolved truth on screen: picking a
      portion or stepping the qty writes grams, and typing grams clears the portion so the two never
      disagree.
  ```tsx
  if (view === "portion" && revision) {
    const strip = liveStrip(revision, grams);
    function setPortionQty(nextQty: number) {
      const q = Math.max(0.25, Math.round(nextQty * 4) / 4);
      setQty(q);
      if (!portion) return;
      const g = Math.round(gramsForPortion({ gramWeight: portion.gramWeight }, q) * 10) / 10;
      setGrams(g);
      setGramsText(String(g));
    }
    function typeGrams(text: string) {
      setGramsText(text);
      const n = Number(text);
      if (Number.isFinite(n) && n >= 0) { setGrams(n); setPortion(null); }
    }
    return (
      <Sheet
        title={revision.description}
        subtitle={revision.brand ?? undefined}
        onClose={onClose}
        footer={
          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={grams <= 0 || foodRefId === null}
              onClick={confirmCatalogPortion}
              className="tap w-full rounded-[12px] border border-black/20 bg-[linear-gradient(180deg,#2A2A2A_0%,#111111_100%)] px-4 py-3.5 text-body-sm text-white disabled:opacity-40"
            >
              {mode === "meal" ? "Add to meal" : "Log it"} · {grams} g · {strip.kcal} kcal
            </button>
            <button type="button" onClick={() => setView("search")} className="tap w-full rounded-[12px] surface px-4 py-2.5 text-caption text-graphite">
              Back to search
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 px-1">
          {revision.portions.length > 0 && (
            <div>
              <p className="pb-1.5 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Portion</p>
              <div className="flex flex-wrap gap-1.5">
                {revision.portions.map((p) => (
                  <Pill
                    key={p.id}
                    active={portion?.id === p.id}
                    onClick={() => { setPortion(p); setPortionQty(qty || 1); }}
                  >
                    {p.description} · {p.gramWeight} g
                  </Pill>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="pb-1.5 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">How many</p>
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Less" onClick={() => setPortionQty(qty - 0.25)} className="pill tap"><span className="pill-in flex h-11 w-11 items-center justify-center text-subheading font-light text-graphite">−</span></button>
              <span className="min-w-16 text-center text-subheading tabular-nums text-charcoal ts">{fmt(qty)}</span>
              <button type="button" aria-label="More" onClick={() => setPortionQty(qty + 0.25)} className="pill tap"><span className="pill-in flex h-11 w-11 items-center justify-center text-subheading font-light text-graphite">+</span></button>
            </div>
          </div>

          <div>
            <p className="pb-1.5 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Grams</p>
            <div className="well flex h-12 items-center gap-2 px-4">
              <input
                value={gramsText}
                onChange={(e) => typeGrams(e.target.value)}
                inputMode="decimal"
                aria-label="Grams"
                className="min-w-0 flex-1 bg-transparent text-body-sm tabular-nums text-charcoal outline-none"
              />
              <span className="text-caption text-muted">g</span>
            </div>
          </div>

          <section className="surface rounded-[16px] p-4">
            <p className="text-subheading tabular-nums text-charcoal ts">{strip.kcal} kcal</p>
            <p className="text-caption tabular-nums text-graphite">
              {fmt(strip.protein)} P · {fmt(strip.carbs)} C · {fmt(strip.fat)} F · {fmt(strip.fiber)} g fibre
            </p>
            <p className="mt-1 text-tiny font-light text-faint">
              {revision.source} · catalog {revision.version_label}
            </p>
          </section>
        </div>
      </Sheet>
    );
  }
  ```
- [ ] Add the commit. The entry lands in the local store first (offline-first, PRD §8) and the commit
      or the outbox follows; `onAdd` keeps its existing signature so `app/page.tsx` is unchanged here.
  ```tsx
  async function confirmCatalogPortion() {
    if (!revision || !foodRefId) return;
    const at = new Date();
    const entryId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const strip = liveStrip(revision, grams);
    const item = {
      id: itemId, seq: 1, food_ref_id: foodRefId, grams, qty: portion ? qty : grams,
      unit: portion ? "portion" : "g", snapshot: snapshotFor(revision, grams),
      name: revision.description,
      portionLabel: portion ? `${qty} × ${portion.description}` : `${grams} g`,
      macros: { kcal: strip.kcal, protein: strip.protein, carbs: strip.carbs, fat: strip.fat },
    };
    const entry: LoggedFood = {
      id: entryId, foodId: `catalog:${revision.catalog_food_id}`, name: revision.description,
      portionLabel: item.portionLabel, qty: item.qty, grams,
      macros: item.macros, items: [item], at: at.toISOString(),
    };
    if (mode === "meal") { setItems((list) => [...list, entry]); setQuery(""); setView("meal"); return; }
    onAdd(entry);
    await commitLogEntry(buildCommitRequest({
      entryId, eatenAt: at, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, slot,
      items: [{ id: itemId, foodRefId, revision, grams, qty: item.qty, unit: item.unit,
                portionId: portion?.id ?? null }],
    }));
  }
  ```
  The sheet gains one prop for this: `slot: SlotId` (which slot the entry belongs to), defaulted by
  `app/page.tsx` to the slot nearest the current time. Add it to the props type and to the call site in
  Task 13.
- [ ] Render the block message above the search field when `blocked !== null`:
  ```tsx
  {blocked && (
    <p className="mb-2 rounded-[16px] olive-panel px-4 py-3 text-caption text-[color:var(--color-on-olive)]" role="status">
      {blocked}
    </p>
  )}
  ```
- [ ] Check the file budget and types.
  ```bash
  wc -l components/LogFoodSheet.tsx && pnpm exec tsc --noEmit && pnpm lint
  ```
  If the file is over 400 lines, lift the catalog portion view into
  `components/LogFoodSheet.Portion.tsx` — a Lane I file — rather than trimming comments.
- [ ] Commit.
  ```bash
  git add components/LogFoodSheet.tsx \
    && git commit -m "feat(log): grams-first logging from the catalog in the log sheet"
  ```

---

## Task 12 — `components/NutrientBreakdown.tsx`

**Files** — Create: `components/NutrientBreakdown.tsx`. Test path: manual gate.

**Interfaces**

Consumes: `totalsFor` from `@/lib/nutrients/totals`; `formatAmount` from `@/lib/nutrients/format`;
`type LoggedFood` from `@/lib/types`.

Produces:
```ts
export default function NutrientBreakdown(props: { entry: LoggedFood }): JSX.Element | null;
```

- [ ] Write the component.
  ```tsx
  "use client";

  import { formatAmount } from "@/lib/nutrients/format";
  import { totalsFor } from "@/lib/nutrients/totals";
  import type { LoggedFood } from "@/lib/types";

  /**
   * Every nutrient of one logged entry — phase-2-real-logging.md, Client changes. A `—` means the
   * source measured nothing; a `0` means it measured zero. The source and its version sit at the
   * foot so Devin's fdc.nal.usda.gov check is a comparison, not a hunt.
   */
  export default function NutrientBreakdown({ entry }: { entry: LoggedFood }) {
    const items = entry.items ?? [];
    const totals = totalsFor(items.filter((i) => Object.keys(i.snapshot ?? {}).length > 0));
    if (totals.size === 0) return null;

    const first = items.find((i) => Object.keys(i.snapshot ?? {}).length > 0)!;
    const anyValue = Object.values(first.snapshot)[0];

    return (
      <section className="surface rounded-[16px] p-4" aria-label={`Nutrients in ${entry.name}`}>
        <p className="pb-2 text-eyebrow-sm uppercase tracking-[0.2em] text-muted">
          {entry.grams} g · {items.length} item{items.length === 1 ? "" : "s"}
        </p>
        <dl className="flex flex-col gap-1.5">
          {[...totals.values()].map((t) => (
            <div key={t.code} className="flex items-baseline justify-between gap-3">
              <dt className="truncate text-caption font-light text-graphite">{t.code.replace(/_/g, " ")}</dt>
              <dd className="shrink-0 text-caption tabular-nums text-charcoal ts">
                {formatAmount(t.code, t.itemsWithValue === 0 ? null : t.amount, t.unit)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 border-t border-black/[0.06] pt-2 text-tiny font-light text-faint">
          {anyValue.source} · {anyValue.source_version}
        </p>
      </section>
    );
  }
  ```
- [ ] Type-check and lint.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/NutrientBreakdown.tsx \
    && git commit -m "feat(log): per-entry nutrient breakdown with source and version"
  ```

---

## Task 13 — `components/DayNutrients.tsx` and the Today mount

**Files** — Create: `components/DayNutrients.tsx`. Modify: `app/page.tsx`. Test path: manual gate.

**Interfaces**

Consumes: `dayNutrientTotals` from `@/lib/resolve`; `TRACKED_MICROS`, `MACRO_CODES`, `FIBER_BAND_G`
from `@/lib/nutrients/codes`; `microCoverage` from `@/lib/nutrients/totals`; `percentDri`,
`fiberBandState`, `DRI_FEMALE_19_30` from `@/lib/nutrients/dri` (Task 1's contract change);
`formatAmount` from `@/lib/nutrients/format`; `type ResolvedDay` from `@/lib/types`.

Produces:
```ts
export default function DayNutrients(props: { day: ResolvedDay }): JSX.Element | null;
```

- [ ] Write the component. It sits directly under the gauge card, in the olive-panel + glass-card
      vocabulary of `Main.dc.html`: a fibre line, a coverage pill, and a disclosure that opens the
      twelve tracked micros. Informational only — no rings, no targets, no red states (architecture
      §3.1, spec Open question 3).
  ```tsx
  "use client";

  import { useState } from "react";
  import { FIBER_BAND_G, MACRO_CODES, TRACKED_MICROS } from "@/lib/nutrients/codes";
  import { DRI_FEMALE_19_30, fiberBandState, percentDri } from "@/lib/nutrients/dri";
  import { formatAmount } from "@/lib/nutrients/format";
  import { microCoverage } from "@/lib/nutrients/totals";
  import { dayNutrientTotals } from "@/lib/resolve";
  import type { ResolvedDay } from "@/lib/types";

  const BAND_COPY = {
    under: `Under your ${FIBER_BAND_G.min}–${FIBER_BAND_G.max} g band`,
    "in-band": `In your ${FIBER_BAND_G.min}–${FIBER_BAND_G.max} g band`,
    over: `Over your ${FIBER_BAND_G.min}–${FIBER_BAND_G.max} g band`,
    unknown: "No fibre logged yet",
  } as const;

  const DRI_BY_CODE = new Map(DRI_FEMALE_19_30.map((row) => [row.code, row]));

  /**
   * Micronutrients on Today — phase-2-real-logging.md, Client changes. Fibre reads against her
   * 20–25 g band, which targets.md sets BELOW the 25 g AI; the band wins on her screen and the DRI
   * row exists for export. Coverage is items-with-a-value ÷ all items (architecture §3.3), so a
   * partial day never reads as a complete one.
   */
  export default function DayNutrients({ day }: { day: ResolvedDay }) {
    const [open, setOpen] = useState(false);
    const totals = dayNutrientTotals(day);
    if (totals.size === 0) return null;

    const fiber = totals.get(MACRO_CODES.fiber);
    const fiberG = fiber && fiber.itemsWithValue > 0 ? fiber.amount : null;
    const band = fiberBandState(fiberG);
    const coverage = microCoverage(totals, TRACKED_MICROS);

    return (
      <section className="shell" aria-label="Nutrients today">
        <div className="inner flex flex-col gap-3 p-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-eyebrow-sm uppercase tracking-[0.2em] text-muted">Fibre</span>
            <span className="text-subheading tabular-nums text-charcoal ts">
              {formatAmount(MACRO_CODES.fiber, fiberG, "g")}
            </span>
          </div>
          <p className="text-caption font-light text-graphite">{BAND_COPY[band]}</p>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="pill tap self-start"
          >
            <span className="pill-in flex h-11 items-center px-4 text-caption text-graphite ts">
              {coverage.covered} of {coverage.tracked} nutrients have data today
            </span>
          </button>

          {open && (
            <dl className="flex flex-col gap-1.5 border-t border-black/[0.06] pt-3">
              {TRACKED_MICROS.map((code) => {
                const total = totals.get(code);
                const measured = total && total.itemsWithValue > 0;
                const pct = percentDri(total, DRI_BY_CODE.get(code));
                return (
                  <div key={code} className="flex items-baseline justify-between gap-3">
                    <dt className="truncate text-caption font-light text-graphite">{code.replace(/_/g, " ")}</dt>
                    <dd className="shrink-0 text-caption tabular-nums text-charcoal ts">
                      {formatAmount(code, measured ? total.amount : null, total?.unit ?? "")}
                      {pct !== null && measured && (
                        <span className="pl-2 font-light text-faint">{Math.round(pct)}% DRI</span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}

          <p className="text-tiny font-light text-faint">
            Information only. These are reference values, not targets.
          </p>
        </div>
      </section>
    );
  }
  ```
- [ ] Mount it in `app/page.tsx`, directly after the `MacroRings` line (which is where `Main.dc.html`
      puts the first card below the gauge):
  ```tsx
  import DayNutrients from "@/components/DayNutrients";
  ```
  ```tsx
          <MacroRings targets={resolved.targets} consumed={resolved.consumed} />

          <DayNutrients day={resolved} />
  ```
- [ ] Type-check and lint.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/DayNutrients.tsx app/page.tsx \
    && git commit -m "feat(today): fibre band and micronutrient coverage under the gauge"
  ```

---

## Task 14 — `LoggedExtras`, the pending dot, and the breakdown tap

**Files** — Modify: `components/LoggedExtras.tsx`, `app/page.tsx`. Test path: manual gate plus the
`pendingEntryIds` coverage already in `lib/log-client.test.ts`.

**Interfaces**

Consumes: `entryMacros` from `@/lib/resolve`; `pendingEntryIds` from `@/lib/log-client`;
`NutrientBreakdown` from `@/components/NutrientBreakdown`; `type LoggedFood` from `@/lib/types`.

Produces:
```ts
export default function LoggedExtras(props: {
  extras: LoggedFood[]; waterCups: number; pendingIds: Set<string>;
  onOpen: (id: string) => void;
}): JSX.Element | null;
```

- [ ] Change the line that renders an entry's second row so it leads with grams and kcal, and add the
      pending dot:
  ```tsx
  import { entryMacros } from "@/lib/resolve";
  ```
  ```tsx
        {extras.map((e) => {
          const m = entryMacros(e);
          const pending = pendingIds.has(e.id);
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onOpen(e.id)}
              className="row tap flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <p className="ts flex items-center gap-1.5 truncate text-caption text-charcoal">
                  {pending && (
                    <span
                      aria-label="Not synced yet"
                      title="Not synced yet"
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber"
                    />
                  )}
                  {e.name}
                </p>
                <p className="truncate text-tiny font-light tabular-nums text-muted">
                  {fmt(e.grams)} g · {m.kcal} kcal · {fmt(m.protein)}P {fmt(m.carbs)}C {fmt(m.fat)}F
                  {e.flags?.length ? <span className="text-alert"> · off-plan</span> : null}
                </p>
                {e.note && <p className="mt-0.5 truncate text-tiny font-light italic text-graphite">“{e.note}”</p>}
              </div>
              <span className="shrink-0 text-tiny text-muted">Details</span>
            </button>
          );
        })}
  ```
  and change the total line at the top to `extras.reduce((a, e) => a + entryMacros(e).kcal, 0)`.
- [ ] Add `pendingIds` to the props type and default it to an empty set at the call site.
- [ ] Load the pending ids in `app/page.tsx` and pass them, refreshing on the same `SYNCED_EVENT` the
      page already listens to:
  ```tsx
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    const read = () => { void pendingEntryIds().then((s) => { if (live) setPendingIds(s); }); };
    read();
    window.addEventListener(SYNCED_EVENT, read);
    return () => { live = false; window.removeEventListener(SYNCED_EVENT, read); };
  }, []);
  ```
  ```tsx
  <LoggedExtras extras={resolved.extras} waterCups={resolved.waterCups} pendingIds={pendingIds} onOpen={setOpenEntry} />
  ```
- [ ] Render the breakdown inside the entry sheet `app/page.tsx` already opens, above the note field,
      by passing it as a child of `NoteSheet`'s existing `entry` block — change the `openEntry` branch
      to render `<NutrientBreakdown entry={e} />` between `NoteSheet`'s summary section and its
      textarea. `NoteSheet.tsx` is Lane E's file: do not edit it. Instead render the breakdown as a
      sibling by giving `NoteSheet` the entry it already takes and adding the breakdown to the sheet's
      `children` through a new optional `extra?: ReactNode` prop — if Lane E has not shipped that prop,
      open the breakdown in its own `Sheet` from `app/page.tsx` instead, which needs no Lane E change:
  ```tsx
  {openEntry && (() => {
    const e = resolved.extras.find((x) => x.id === openEntry);
    if (!e) return null;
    return (
      <NoteSheet
        key={`entry-${openEntry}`}
        title={e.name}
        subtitle={`${fmtQty(e.grams)} g · ${entryMacros(e).kcal} kcal`}
        note={e.note ?? ""}
        entry={e}
        onSave={(n) => noteEntry(openEntry, n)}
        onRemove={() => unlogFood(openEntry)}
        onClose={() => setOpenEntry(null)}
      />
    );
  })()}
  {openEntry && breakdownOpen && (() => {
    const e = resolved.extras.find((x) => x.id === openEntry);
    return e ? (
      <Sheet key={`breakdown-${openEntry}`} title={`${e.name} · nutrients`} onClose={() => setBreakdownOpen(false)}>
        <NutrientBreakdown entry={e} />
      </Sheet>
    ) : null;
  })()}
  ```
  Pick the second form unless `NoteSheet` already accepts `extra`. Record which one shipped in the
  hand-off.
- [ ] Type-check and lint.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/LoggedExtras.tsx app/page.tsx \
    && git commit -m "feat(today): grams, kcal, a pending dot and a nutrient breakdown per entry"
  ```

---

## Task 15 — `components/ExportCard.tsx` and the Settings mount

**Files** — Create: `components/ExportCard.tsx`. Modify: `app/settings/page.tsx`. Test path: manual gate.

**Interfaces**

Consumes: `/api/export?kind=meals|progress&format=csv&from=&to=` (Lane H). The session cookie carries
identity; nothing is added to the query string but the four documented parameters.

Produces:
```ts
export default function ExportCard(): JSX.Element;
```

- [ ] Write the component. The browser's own download is used — the route already sets
      `content-disposition` — so the card is two links and two date wells, not a fetch-and-blob.
  ```tsx
  "use client";

  import { useState } from "react";

  function exportHref(kind: "meals" | "progress", from: string, to: string): string {
    const params = new URLSearchParams({ kind, format: "csv" });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/api/export?${params.toString()}`;
  }

  /**
   * CSV export — architecture §4.6, phase-2-real-logging.md. `kind=meals` is one row per logged item
   * with grams, source and source version; `kind=progress` is one row per day with totals, the kcal
   * target and micro coverage. The dates are optional and inclusive; empty means the whole log.
   */
  export default function ExportCard() {
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");

    return (
      <section className="shell" aria-label="Export">
        <div className="inner flex flex-col gap-3 p-5">
          <h2 className="text-heading-sm text-charcoal ts">Export</h2>
          <p className="text-caption font-light text-graphite">
            Everything you have logged, as a spreadsheet. Leave the dates empty for the whole log.
          </p>

          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-eyebrow-sm uppercase tracking-[0.2em] text-muted">From</span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                     className="well tap px-3 text-caption text-charcoal" />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-eyebrow-sm uppercase tracking-[0.2em] text-muted">To</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                     className="well tap px-3 text-caption text-charcoal" />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <a href={exportHref("meals", from, to)}
               className="tap flex items-center justify-center rounded-[12px] border border-black/20 bg-[linear-gradient(180deg,#2A2A2A_0%,#111111_100%)] px-4 py-3.5 text-body-sm text-white">
              Download meals CSV
            </a>
            <a href={exportHref("progress", from, to)}
               className="tap surface flex items-center justify-center rounded-[12px] px-4 py-3 text-caption text-graphite">
              Download daily progress CSV
            </a>
          </div>
        </div>
      </section>
    );
  }
  ```
- [ ] Mount it in `app/settings/page.tsx`, immediately above the existing `<IcsSubscribe …/>` line:
  ```tsx
  import ExportCard from "@/components/ExportCard";
  ```
  ```tsx
        <ExportCard />
  ```
- [ ] Type-check and lint.
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/ExportCard.tsx app/settings/page.tsx \
    && git commit -m "feat(settings): export the log as meals and progress CSV"
  ```

---

## Task 16 — Flag-off regression, the wired flow test, and the phone gates

**Files** — Create: `tests/client/catalog-flow.test.ts`, `docs/screenshots/phase-2/*.png`. Test path:
`tests/client/catalog-flow.test.ts`.

**Interfaces**

Consumes: everything this lane built. Produces: the lane's proof.

- [ ] Write the failing test. It is the one place both flag states and all three layers meet.
  ```ts
  // tests/client/catalog-flow.test.ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import { catalogSearchEnabled, getFoodDetail, searchFoods, toRows } from "@/lib/catalog-client";
  import { getRevision } from "@/lib/db/catalog-cache";
  import { buildCommitRequest, commitLogEntry, liveStrip, pendingEntryIds } from "@/lib/log-client";
  import { closeSmcDb } from "@/lib/sync/idb";

  const DETAIL = {
    catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted", brand: null,
    source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: "roasted",
    score: 0, prefStatus: "eats", category: "Poultry Products", catalogVersion: "2026-04",
    attribution: "USDA SR Legacy 2026-04",
    per100g: {
      energy_kcal: { amount: 165, unit: "kcal" }, protein: { amount: 31, unit: "g" },
      carbohydrate: { amount: 0, unit: "g" }, fat_total: { amount: 3.6, unit: "g" },
      fiber_total: { amount: null, unit: "g" },
    },
    portions: [{ id: 3, description: "3 oz", gramWeight: 85, isDefault: true }],
    ingredients: [],
  };

  function router(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
    return vi.fn(async (url: string) => {
      const key = Object.keys(routes).find((k) => String(url).startsWith(k));
      if (!key) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(routes[key].body), {
        status: routes[key].status, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  beforeEach(async () => { await closeSmcDb(); globalThis.indexedDB = new IDBFactory(); });
  afterEach(() => vi.unstubAllEnvs());

  describe("the flag", () => {
    it("is off when NEXT_PUBLIC_CATALOG_SEARCH is unset", () => {
      vi.stubEnv("NEXT_PUBLIC_CATALOG_SEARCH", "");
      expect(catalogSearchEnabled()).toBe(false);
    });
    it("is on only for the exact value 1", () => {
      vi.stubEnv("NEXT_PUBLIC_CATALOG_SEARCH", "1");
      expect(catalogSearchEnabled()).toBe(true);
      vi.stubEnv("NEXT_PUBLIC_CATALOG_SEARCH", "true");
      expect(catalogSearchEnabled()).toBe(false);
    });
  });

  describe("search → detail → cache → commit", () => {
    it("carries one food all the way to a committed entry", async () => {
      const fetchImpl = router({
        "/api/foods/search": { status: 200, body: {
          hits: [{ catalogFoodId: 41, revisionId: 910, description: "Chicken breast, roasted",
                   brand: null, source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [],
                   prepState: "roasted", score: 0.81, prefStatus: "eats" }],
          queryClass: "generic", autoResolve: null, catalogVersion: "2026-04" } },
        "/api/foods/41": { status: 200, body: DETAIL },
        "/api/log/commit": { status: 200, body: {
          status: "ok", entry_id: "e1", rev: 1, items: [],
          totals: { local_date: "2026-09-11", nutrients: [], micro_coverage_pct: 0 } } },
      });

      const rows = toRows(await searchFoods("chicken breast", { fetchImpl }));
      expect(rows[0]).toMatchObject({ sourceTile: "USDA", prefStatus: "eats", catalogFoodId: 41 });

      const detail = await getFoodDetail(41, { fetchImpl });
      expect(detail.kind).toBe("ok");
      const cached = await getRevision(910);
      expect(cached?.per_100g.protein).toBe(31);

      expect(liveStrip(cached!, 140)).toMatchObject({ kcal: 231, protein: 43.4 });

      const req = buildCommitRequest({
        entryId: "e1", eatenAt: new Date("2026-09-11T18:30:00.000Z"), tz: "UTC", slot: "meal-2",
        items: [{ id: "i1", foodRefId: "f1", revision: cached!, grams: 140, qty: 140, unit: "g" }],
      });
      await expect(commitLogEntry(req, { fetchImpl })).resolves.toMatchObject({ status: "ok" });
      await expect(pendingEntryIds()).resolves.toEqual(new Set());
    });

    it("with no catalog version the search goes offline and the detail blocks an unseen food", async () => {
      const fetchImpl = router({
        "/api/foods/search": { status: 503, body: { error: "no_catalog" } },
        "/api/foods/41": { status: 503, body: { error: "no_catalog" } },
      });
      const result = await searchFoods("banana", { fetchImpl });
      expect(result).toMatchObject({ kind: "offline", reason: "no_catalog" });
      expect(toRows(result).every((r) => r.offline)).toBe(true);
      await expect(getFoodDetail(41, { revisionId: 910, fetchImpl })).resolves.toEqual({ kind: "blocked" });
    });
  });
  ```
- [ ] Run it. Expected failure: the first flag assertion fails only if `catalogSearchEnabled` captured
      the value at import; otherwise the file fails to load until every import above exists. Either way
      the run is red before the earlier tasks land.
  ```bash
  pnpm test tests/client/catalog-flow.test.ts
  ```
- [ ] Run it again after Tasks 1–15. Expected: `Tests  4 passed (4)`.
  ```bash
  pnpm test tests/client/catalog-flow.test.ts
  ```
- [ ] Run every Lane I test file once, together — not the full suite (AGENTS.md, "CI and branches").
  ```bash
  pnpm test lib/catalog-client.test.ts lib/db/catalog-cache.test.ts lib/log-client.test.ts \
    lib/store.test.ts lib/resolve.test.ts tests/client/catalog-flow.test.ts
  ```
  Expected: `Test Files  6 passed (6)`.
- [ ] Prove the flag-off path is byte-for-byte Phase 0 behaviour (Phase 1 acceptance 11): the bundled
      food database test is untouched and green.
  ```bash
  git diff --stat main -- lib/food-db.ts lib/food-db.json lib/food-db.test.ts
  pnpm test lib/food-db.test.ts
  ```
  Expected: an empty diff, and `Tests 6 passed (6)`.
- [ ] Build both flag states. **[needs network]** — the build resolves the Next.js toolchain.
  ```bash
  NEXT_PUBLIC_CATALOG_SEARCH= pnpm build && NEXT_PUBLIC_CATALOG_SEARCH=1 pnpm build
  ```
- [ ] Capture the screenshots into `docs/screenshots/phase-2/`. Start the dev server with the flag on,
      open `http://localhost:3000` in Chrome device mode at 390 × 844, and capture:
      `log-sheet-search.png`, `log-sheet-portion-grams.png`, `log-sheet-blocked-offline.png`,
      `today-daynutrients-collapsed.png`, `today-daynutrients-expanded.png`,
      `logged-extras-pending.png`, `nutrient-breakdown.png`, `settings-export.png`.
  ```bash
  NEXT_PUBLIC_CATALOG_SEARCH=1 pnpm dev
  ```
- [ ] **Manual gate, Devin, on her phone. [needs branch] [needs network]** Deploy the Vercel preview of
      this branch against a Supabase branch carrying Lane F's import and Lane H's migrations, then:
  1. Search each of *chicken breast, sirloin, ahi tuna, white rice, sweet potato, butternut, banana,
     avocado, almond butter, olive oil*. Each is the top hit, each shows a USDA tile, and the ones on
     her list carry the Eats pill.
  2. Open three of them and check per-100 g protein, carbohydrate and fat against `fdc.nal.usda.gov`
     for the same source and version. All three match within display rounding.
  3. Log 140 g of chicken breast: the live strip reads before the tap, Today's rings move by the same
     kcal and protein, and the entry's breakdown lists iron and potassium with a `—` where the source
     measured nothing.
  4. Switch the portion picker to `3 oz`, step the qty to 2, then type `170` into grams — the portion
     pill clears and the strip follows the typed number.
  5. Turn airplane mode on, search again: results appear under an "offline results" line. Pick a food
     she has already logged — it opens from the cache. Pick one she has not — it is **blocked** with
     the message, and nothing is logged.
  6. Log one entry offline: it appears on Today at once with a pending dot; turn the radio back on and
     the dot clears and the displayed numbers become the server's.
  7. Today reads fibre in grams with its band state and a pill of the form "*n* of 12 nutrients have
     data today"; expanding shows amounts and a muted % DRI, with no colour state and no target.
  8. Settings → Export → *Download meals CSV*: it opens in Numbers with grams, source and source
     version matching what the phone showed.
  9. Redeploy with `NEXT_PUBLIC_CATALOG_SEARCH` unset and log one food: the Phase 0 sheet returns,
     nothing errors, and the entry lands exactly as it did before this lane.
- [ ] Commit the screenshots.
  ```bash
  git add tests/client/catalog-flow.test.ts docs/screenshots/phase-2 \
    && git commit -m "test(client): wire the catalog search, cache and commit flow end to end"
  ```

---

## Lane exit gate

| # | Command / check | Expected |
|---|---|---|
| 1 | `pnpm lint` | clean |
| 2 | `pnpm exec tsc --noEmit` | clean |
| 3 | `pnpm test lib/catalog-client.test.ts lib/db/catalog-cache.test.ts lib/log-client.test.ts lib/store.test.ts lib/resolve.test.ts tests/client/catalog-flow.test.ts` | `Test Files  6 passed (6)` |
| 4 | `pnpm test lib/food-db.test.ts` | `Tests 6 passed (6)` — Phase 1 acceptance 11 |
| 5 | `git diff --stat main -- lib/sync/idb.ts lib/sync/idb.test.ts lib/types.ts` | empty — both are the integration branch's to change (Hand-off items 1 and 3) |
| 6 | `git diff --stat main -- lib/food-db.ts lib/food-db.json lib/food-db.test.ts` | empty |
| 7 | `wc -l lib/catalog-client.ts lib/log-client.ts lib/db/catalog-cache.ts components/*.tsx` | every file under 400 lines |
| 8 | `git diff --stat main -- components/MacroRings.tsx app/globals.css DESIGN.md` | empty — Lane E owns the look |
| 9 | `NEXT_PUBLIC_CATALOG_SEARCH= pnpm build` **[needs network]** | succeeds |
| 10 | `NEXT_PUBLIC_CATALOG_SEARCH=1 pnpm build` **[needs network]** | succeeds |
| 11 | `ls docs/screenshots/phase-2` | the eight files named in Task 16 |
| 12 | The nine-step phone gate above **[needs branch] [needs network]** | every step passes, Devin signs off |

Do not run `pnpm test` with no path: the merge queue runs the full suite on the PR.

## Hand-off to integration

1. **`lib/sync/idb.ts`'s `DB_VERSION` bump is the integration branch's edit, not this lane's.**
   `lib/sync/**` is on contracts §1's shared list with no carve-out for Lane I, so Task 1 lands only
   the contract-change commit naming the target shape (`DB_VERSION = 2`, `CATALOG_STORE`) in
   `00-contracts.md`; the code edit itself — `lib/sync/idb.ts`'s three lines plus widening Lane C's
   `lib/sync/idb.test.ts` store assertion to include `catalog_revisions` — happens on the integration
   branch after all four lanes merge, the cut-over pattern Phase 0 lane D used for shared files it
   could not edit (`docs/plans/2026-09-10-phase-0/lane-D-data-ops.md`: "import the real path and let
   `tsc` fail until the integration branch rebases"). Until then, `lib/db/catalog-cache.ts` (Task 2)
   imports `CATALOG_STORE` from a file that does not yet export it — `pnpm test
   lib/db/catalog-cache.test.ts` and `pnpm exec tsc --noEmit` are expected **red** on this branch
   until the integration branch rebases it; that is not a Lane I bug to chase. The integration branch
   must confirm the bump is on `main` before any other lane rebases, and that no phone can meet a v1
   build after a v2 build (IndexedDB refuses to open a v2 database at v1; the app would throw on
   boot). A rollback of the client therefore needs the `DB_VERSION = 2` line kept — the store is
   additive and harmless to a build that ignores it.
2. **Three Lane H exports are consumed here and nowhere else:** `NUTRIENT_UNITS`
   (`lib/nutrients/codes.ts`), `DRI_FEMALE_19_30` (`lib/nutrients/dri.ts`) and the `SnapshotMeta`
   shape (`lib/nutrients/snapshot.ts`, Task 3: `units?: Partial<Record<NutrientCode, string>>`).
   Task 1's contract text is written to match Lane H's Task 3 shape exactly — an earlier draft of
   this contract change carried a required, full `units: Readonly<Record<NutrientCode, string>>`
   that Lane H never implemented; that mismatch is corrected before this lane's branch starts, not
   left for integration to discover. `lib/log-client.ts`'s `snapshotFor` always supplies the full
   `NUTRIENT_UNITS` record, so it satisfies the real (optional, partial) shape unchanged and needs no
   adaptation. If a future Lane H edit narrows or widens `SnapshotMeta` again, `snapshotFor` is the
   single call site to revisit.
3. **`lib/types.ts` is the integration branch's edit, not this lane's.** Phase 0 contracts §1 listed
   it shared; Phase 1–2 contracts §1 neither lists it in Lane I's row nor carries it forward on the
   shared list, so no lane has standing to edit it on its own branch here — the same reasoning as
   item 1. The `LoggedItem` type and the `LoggedFood.items` widening to a superset land on the
   integration branch instead; the edit stays additive there too (`components/NoteSheet.tsx` and
   `app/api/mcp/route.ts:140` both keep compiling because the display half of `LoggedItem` is
   preserved). Task 7's `migrateExtraItems` and its test import `LoggedItem` from `./types` before it
   exists there — `pnpm exec tsc --noEmit` is red on this branch until the integration branch rebases
   it, the same expected-red state as item 1.
4. **`food_ref_id` is resolved in the browser.** `lib/log-client.ts` `resolveFoodRef` calls
   `get_or_create_food_ref` through the Phase 0 browser client, because no Phase 1 route returns a
   `food_refs.id` and `LogItemInput.food_ref_id` is required. A `catalog_food_id` accepted directly by
   `/api/log/commit` would remove the round trip and the client-side trust; that is a Lane H change,
   not a Lane I one.
5. **The entry sheet.** Task 14 ships either a `NoteSheet extra?: ReactNode` prop (Lane E's file — only
   if Lane E has already added it) or a second `Sheet` opened from `app/page.tsx`. Whichever shipped is
   recorded in the commit body; the second form needs nothing from Lane E.
6. **`components/MacroRings.tsx` has an empty diff.** Contracts §1 assigns it to this lane; the change
   it describes landed in `lib/resolve.ts`. Do not read the empty diff as unfinished work.
7. **`lib/sync.ts` is still imported by `app/page.tsx` for `SYNCED_EVENT`.** Task 14 adds one more
   listener on that event. When release B deletes the legacy module, repoint the import at
   `@/lib/sync/client`, which exports the same `"sasha:synced"` string (Lane C hand-off item 3).

## Open questions

1. **Debounce: 200 ms or 250 ms?** `docs/specs/phase-1-catalog.md` (Client changes) says 200 ms; the
   lane brief for this plan said 250 ms. The authority order in contracts (architecture > spec >
   contracts file > lane plan) makes 200 ms binding, so `SEARCH_DEBOUNCE_MS = 200` ships. One constant
   changes it if Devin prefers the slower window on her phone.
2. **`LoggedFood.items` carries two meanings.** Contracts §5 freezes the field name for the Phase 2
   item shape, but the field already held the foods of a legacy logged meal. Task 7 resolves it with a
   superset type and a one-time in-place migration rather than a rename. If a rename is preferred, it
   is a contract change and every consumer in §Hand-off item 3 moves with it.
3. **Micro coverage is item-counted, not grams-weighted.** Phase 2 spec Open question 1: a 5 g sprinkle
   of an uncharacterised spice costs as much coverage as a 200 g main. `DayNutrients` follows the
   architecture as written. If the pill reads wrong on her real log after a week, the fix is an
   architecture amendment, not a client change.
4. **The tracked micro set is not confirmed.** Phase 2 spec Open question 2 asks Devin to confirm the
   twelve codes before the DRI seed lands, and the set defines the coverage denominator on her screen.
   `DayNutrients` renders whatever `TRACKED_MICROS` holds, so a change costs nothing here — but the
   copy "*n* of 12" is generated from `coverage.tracked`, not hard-coded, for exactly that reason.
5. **Which slot does a logged food belong to?** `LogFoodSheet` gains a `slot` prop in Task 11 because
   `LogCommitRequest.slot` is required. `app/page.tsx` passes the slot nearest the current time, which
   is what the Today screen already computes for its focus card. A food logged at 4 pm on a rest day
   therefore lands on `meal-3`; if she wants to choose, that is a picker the spec does not ask for.
6. **The pending dot is a snapshot, not a subscription.** `pendingEntryIds()` is read on mount and on
   `SYNCED_EVENT`. Phase 0's outbox has no "queue changed" event, so an entry queued while the sheet is
   open shows its dot on the next sync or the next mount. One event dispatched from
   `lib/sync/outbox.ts` `enqueue` would close the gap — a Lane C file, so not this lane's to add.
