# Lane H — Logging server: snapshots, totals, commit, export

**For agentic workers:** execute this plan with **superpowers:subagent-driven-development**. One task
per subagent, in order. Each task is a closed TDD loop: write the failing test, run it, see the named
failure, write the minimal implementation, run it, see PASS, commit. Do not start a task before the
previous one is committed.

## Goal

Make every logged item carry real grams and a frozen nutrient snapshot computed by the database, so
Today reports calories, macros, fiber and micronutrient coverage from measured values instead of
authored meal estimates. Deliver the four Phase 2 migrations, the pure nutrient engines, the single
writer `applyLogEntry`, `POST /api/log/commit`, the streaming `meals` and `progress` exports, and MCP
`get_day` on real nutrients. No UI ships in this lane — Lane I consumes everything here through
`lib/log/contract.ts` and `lib/nutrients/*`.

The measure of success: the server snapshot for a fixture catalog food equals the client snapshot to
4 dp; a replayed commit creates no second entry; a stale `base_rev` returns 409 with the full entity
and writes nothing; a second user reading `daily_totals`, `/api/log/commit` or `/api/export` gets
zero rows or a 4xx.

## Architecture

Four slices, one rule: **pure math in `lib/nutrients` and `lib/log`, I/O in `lib/server` and
`app/api`, authority in SQL.**

1. **SQL is the authority on snapshots.** `compute_item_snapshot(food_ref_id, grams)` is the only
   place a snapshot is minted on the server. `_sync_upsert` calls it for every `log_items` row it
   writes, so the commit route and the Phase 0 sync applier cannot diverge — both reach the table
   through `apply_sync_op`, never through a direct insert. A snapshot is **frozen**: an item whose
   `grams` and `food_ref_id` are unchanged keeps the snapshot it was written with, so a quarterly
   catalog import never rewrites her history. `scripts/verify-snapshots.ts --repair` is the one way
   to force a recompute, through an explicit `recompute_snapshots` payload flag.
2. **TypeScript mirrors SQL, it does not lead it.** `lib/nutrients/snapshot.ts` reproduces
   `compute_item_snapshot` exactly (same 4 dp rounding, same `null`-versus-`0` rule) for offline
   display; `snapshotsEqual` is the parity assertion. Everything in `lib/nutrients` is pure and has
   no import outside `lib/nutrients`.
3. **One writer.** `applyLogEntry(client, userId, req)` validates with zod, resolves `food_refs`,
   rejects a superseded `food_revision_id`, builds one `apply_sync_op` op whose `op_id` is a uuid v5
   derived from `(entry_id, base_rev)`, and reads the day back out of `daily_totals`. A replay hits
   `change_log`'s `op_id` unique index, comes back `duplicate`, and returns the stored entry — the
   idempotency the spec requires costs no extra table.
4. **Export streams, it does not buffer.** `streamMeals` / `streamProgress` page with a keyset cursor
   over `(local_date, eaten_at, id)`; the route wraps the page in a `ReadableStream` so a 12,000-row
   log leaves as CSV without a 12,000-row array in memory at the route boundary.

**Phase 0 files this lane does not have on the checkout.** `lib/server/auth.ts`,
`lib/server/admin.ts`, `lib/server/privileged.ts`, `lib/server/ratelimit.ts`, `lib/server/http.ts`,
`lib/export/csv.ts`, `app/api/export/route.ts`, `tests/helpers/supabase.ts` and
`supabase/migrations/*` land on `main` from Phase 0 lanes A, B and D. This lane codes against the
Phase 0 contract signatures (`00-contracts.md` §2, §4, §5, §6) and imports the real paths. If a task
runs before Phase 0 has merged, stub nothing — let `tsc` fail until the branch rebases.

## Tech Stack

Next.js 16.3.4 (App Router, `runtime = "nodejs"`, `dynamic = "force-dynamic"`), React 19,
TypeScript 5 strict, Tailwind 4, pnpm 11.25.0, Node 22, vitest 5 (`environment: "node"`,
`include: ["**/*.test.ts"]`, `@/` → repo root), Supabase Postgres 17 (project `fivatgdpuenszxxnijpc`),
`@supabase/supabase-js` 2.116, `zod` 4.5.4, Vercel. No new npm dependency (contracts §7): uuid v5 is
built by hand on `node:crypto`'s sha1, because adding `uuid` would be a `package.json` edit this lane
may not make.

## Spec paths

`docs/specs/phase-2-real-logging.md` (spec of record for this lane) and
`docs/specs/phase-1-catalog.md` (the catalog tables this lane reads). Authority order:
`docs/architecture.md` v2.1 (§3.1, §3.3, §4.1, §4.6, §5, §7) >
`docs/specs/phase-2-real-logging.md` > `docs/plans/2026-09-11-phase-1-2/00-contracts.md` >
`docs/plans/2026-09-10-phase-0/00-contracts.md` > this file.

## Global Constraints

Copied from Phase 0 contracts §8:

- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, no AI
  attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` never read from a request body. Errors are `{ error, message }`, never echo the body.
- Every route: `enforceRateLimit` first, then identity, then body parse with `readJson`.
- Files < 400 lines; functions < 50 lines.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the
  full suite twice.

Copied from Phase 1–2 contracts §8:

- Phase 0 §8 applies. Add: every SQL function that reads user rows is either `security invoker`
  (browser path) or `security definer` with `p_user_id` first and execute revoked from
  `authenticated` (privileged path) — never both, never neither.

**Lane-local additions.**

- Branch `feat/p2-logging-server`. Create or modify only the files in Phase 1–2 contracts §1 row H.
- `lib/sync/**`, `lib/server/auth.ts`, `lib/server/privileged.ts`, `lib/server/admin.ts`,
  `lib/types.ts`, `lib/store.ts`, `DESIGN.md`, `app/globals.css`, `package.json` are **read-only**.
- Names in Phase 1–2 contracts §4 are frozen: `LogItemInput`, `LogCommitRequest`,
  `LogCommitResponse`, `LogCommitFailure`, `Snapshot`, `NutrientValue`, `computeSnapshot`,
  `totalsFor`, `microCoverage`, `percentDri`, `fiberBandState`, `formatAmount`, `gramsForPortion`,
  `gramsFromUnit`, `applyLogEntry`, `DayTotals`. Do not rename one.
- `[needs branch]` marks a step that needs a Supabase branch. Skip condition for every such step:
  `SUPABASE_TEST_URL` unset. Every `tests/**` suite guards itself with `HAS_BRANCH` from
  `tests/helpers/supabase.ts`, so CI stays green with no branch.
- `[needs network]` marks a step that downloads. This lane has none: every fixture row is inserted by
  `tests/log/fixtures.ts`, never fetched from USDA.

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260918090000_phase2_log_item_guards.sql` | **Create.** RLS policy pair on `log_items` bound through the parent entry; `log_items_entry` and `log_entries_export` indexes. |
| `supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql` | **Create.** `compute_item_snapshot(uuid, numeric)`; `create or replace` of Lane A's `_sync_upsert` so the `log_entries` branch mints snapshots and freezes unchanged ones. |
| `supabase/migrations/20260918090200_phase2_daily_totals.sql` | **Create.** `daily_totals` view (`security_invoker`) and `get_daily_totals(uuid, date)` (`security definer`, revoked from every client role). |
| `supabase/migrations/20260918090300_phase2_catalog_dri_seed.sql` | **Create.** The unique key on `catalog_dri` and the twelve NASEM rows for female 19–30. |
| `supabase/migrations/20260918090400_phase2_down.sql` | **Create.** Drops `get_daily_totals`, `daily_totals`, `compute_item_snapshot`; keeps DRI rows, indexes and every `log_items.snapshot`. Never applied by `db:reset`; applied by hand on a rollback. |
| `lib/nutrients/codes.ts` | **Create.** `NutrientCode` union, `NUTRIENT_UNITS`, `MACRO_CODES`, `TRACKED_MICROS` (12), `FIBER_BAND_G`. |
| `lib/nutrients/codes.test.ts` | **Create.** The union matches contracts §2; `TRACKED_MICROS` is 12 codes and every one has a unit. |
| `lib/nutrients/snapshot.ts` | **Create.** `round4`, `computeSnapshot`, `snapshotValue`, `snapshotsEqual`. Mirrors `compute_item_snapshot`. |
| `lib/nutrients/snapshot.test.ts` | **Create.** Scaling, 4 dp rounding, `null` versus measured `0`, unit passthrough, equality epsilon. |
| `lib/nutrients/totals.ts` | **Create.** `NutrientTotal`, `totalsFor`, `microCoverage`. |
| `lib/nutrients/totals.test.ts` | **Create.** Sums skip `null` but count it against coverage; coverage denominator is all items. |
| `lib/nutrients/dri.ts` | **Create.** `DriRow`, `percentDri`, `fiberBandState`. |
| `lib/nutrients/dri.test.ts` | **Create.** % DRI, unit conversion, `null` on a missing row, band edges 19.9 / 20 / 25 / 25.1. |
| `lib/nutrients/format.ts` | **Create.** `formatAmount` — `null` → `—`, kcal to 1, macros to 0.1 g, micros to their unit. |
| `lib/nutrients/format.test.ts` | **Create.** `null` versus `0`, each unit's decimals. |
| `lib/log/grams.ts` | **Create.** `LOG_UNITS`, `LogUnit`, `gramsForPortion`, `gramsFromUnit`. |
| `lib/log/grams.test.ts` | **Create.** Portion × qty, ounces, a unit that needs a portion, negative qty. |
| `lib/log/contract.ts` | **Create.** The frozen wire types, their zod schemas, `localDateFor`, `opIdFor`. |
| `lib/log/contract.test.ts` | **Create.** Duplicate `seq`, negative grams, `local_date` disagreeing with `eaten_at`, `draft_id` rules, `opIdFor` stability. |
| `lib/server/log.ts` | **Create.** `applyLogEntry` — the single writer behind the commit route and the sync applier. |
| `app/api/log/commit/route.ts` | **Create.** `POST`, 60/min/user, `requireUser`, `readJson` 64 KB, `applyLogEntry`, `jsonError`. |
| `lib/export/csv.ts` | **Modify.** Add `csvDocument` and `ODBL_NOTICE`; keep Phase 0's `escapeCell` and `toCsv` unchanged. |
| `lib/export/csv.test.ts` | **Modify.** Add the `csvDocument` and notice cases; keep Phase 0's cases. |
| `lib/server/export.ts` | **Create.** `encodeCursor`, `decodeCursor`, `streamMeals`, `streamProgress`. |
| `app/api/export/route.ts` | **Modify.** `meals` and `progress` take the streaming path with `from`/`to`/`cursor`/`limit`; the other kinds keep Phase 0 behaviour; limits become 60/day and 10/hour per user. |
| `app/api/mcp/route.ts` | **Modify.** `get_day` gains `nutrients[]` and `micro_coverage_pct` from `get_daily_totals`. That tool's body only. |
| `scripts/verify-snapshots.ts` | **Create.** Prints one date's items with grams, revision and per-100 g values; `--repair <from> <to>` forces a recompute through `apply_sync_op`. |
| `tests/log/fixtures.ts` | **Create.** Seeds a fixture catalog version, nutrients, foods, revisions, portions and one `user_foods` row; returns their `food_refs` ids. |
| `tests/log/commit.test.ts` | **Create.** `[needs branch]` create, replay, conflict, gone, stale_revision, invalid. |
| `tests/log/snapshot-parity.test.ts` | **Create.** `[needs branch]` SQL snapshot equals `computeSnapshot` for every fixture row. |
| `tests/log/daily-totals.test.ts` | **Create.** `[needs branch]` totals, coverage, the grams-edit difference. |
| `tests/log/cross-user.test.ts` | **Create.** `[needs branch]` user B gets zero rows or 4xx on the view, the RPC and the route. |
| `tests/export/cursor.test.ts` | **Create.** Cursor round-trip and a malformed cursor. |
| `tests/export/streams.test.ts` | **Create.** `[needs branch]` meals and progress CSV shape, the `'=` prefix and the ODbL notice. |

---

## Task 1 — Migration 090000: `log_items` policy pair and the two indexes

**Files**
- Create: `supabase/migrations/20260918090000_phase2_log_item_guards.sql`
- Test: psql assertions in the steps (`[needs branch]`).

**Interfaces**
- Consumes: Phase 0 tables `log_entries`, `log_items` (architecture §3.3).
- Produces: policy `log_items_rw` on `log_items`; indexes `log_items_entry (entry_id)` and
  `log_entries_export (user_id, local_date, eaten_at, id)`.

**Steps**

- [ ] Write the failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_indexes where indexname = 'log_entries_export';"
  ```
  Expected failure: prints `0`.

- [ ] Minimal implementation. Create `supabase/migrations/20260918090000_phase2_log_item_guards.sql`:
  ```sql
  -- Phase 2, spec "Data changes". log_items has no user_id, so the §2.1 policy pair binds through
  -- its parent entry. Dropped by name first, so this is a no-op where Phase 0 already shipped it.
  alter table log_items enable row level security;
  drop policy if exists log_items_rw on log_items;
  create policy log_items_rw on log_items for all to authenticated
    using (exists (select 1 from log_entries le
                    where le.id = log_items.entry_id and le.user_id = (select auth.uid())))
    with check (exists (select 1 from log_entries le
                    where le.id = log_items.entry_id and le.user_id = (select auth.uid())));
  create index if not exists log_items_entry on log_items (entry_id);
  create index if not exists log_entries_export on log_entries (user_id, local_date, eaten_at, id);
  ```

- [ ] Run it — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from pg_indexes where indexname in ('log_items_entry','log_entries_export');" \
    -c "select polname from pg_policy where polrelid = 'log_items'::regclass;"
  ```
  Expected: `2`, then `log_items_rw`.

- [ ] Commit:
  `git add supabase/migrations/20260918090000_phase2_log_item_guards.sql && git commit -m "feat(db): bind log_items RLS through its parent entry and index the export key"`

---

## Task 2 — `lib/nutrients/codes.ts`

**Files**
- Create: `lib/nutrients/codes.ts`
- Test: `lib/nutrients/codes.test.ts`

**Interfaces**
- Consumes: nothing. The code list is Phase 1–2 contracts §2, transcribed.
- Produces:
  ```ts
  export const NUTRIENT_CODES: readonly NutrientCode[];
  export type NutrientCode = "energy_kcal" | "energy_kcal_calc" | "protein" | "carbohydrate"
    | "fat_total" | "fiber_total" | "sugars_total" | "sodium" | "potassium" | "calcium" | "iron"
    | "magnesium" | "zinc" | "vitamin_c" | "vitamin_d" | "vitamin_b12" | "folate_dfe"
    | "vitamin_a_rae" | "saturated_fat" | "cholesterol";
  export const NUTRIENT_UNITS: Record<NutrientCode, string>;
  export const MACRO_CODES: { kcal: "energy_kcal"; protein: "protein"; carbs: "carbohydrate";
    fat: "fat_total"; fiber: "fiber_total" };
  export const TRACKED_MICROS: readonly NutrientCode[];   // 12
  export const FIBER_BAND_G: { min: 20; max: 25 };
  export function isNutrientCode(value: string): value is NutrientCode;
  ```

**Steps**

- [ ] Write the failing test. Create `lib/nutrients/codes.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { FIBER_BAND_G, isNutrientCode, MACRO_CODES, NUTRIENT_CODES, NUTRIENT_UNITS,
    TRACKED_MICROS } from "./codes";

  describe("nutrient codes", () => {
    it("carries the twenty canonical codes of contracts §2, in order", () => {
      expect(NUTRIENT_CODES).toEqual([
        "energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total", "fiber_total",
        "sugars_total", "sodium", "potassium", "calcium", "iron", "magnesium", "zinc", "vitamin_c",
        "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "saturated_fat", "cholesterol",
      ]);
    });

    it("gives every code a unit from the four the catalog uses", () => {
      for (const code of NUTRIENT_CODES) {
        expect(["kcal", "g", "mg", "µg"]).toContain(NUTRIENT_UNITS[code]);
      }
    });

    it("tracks exactly the twelve micros the DRI migration seeds", () => {
      expect(TRACKED_MICROS).toEqual([
        "fiber_total", "iron", "calcium", "potassium", "magnesium", "zinc", "vitamin_c",
        "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "sodium",
      ]);
      expect(TRACKED_MICROS).toHaveLength(12);
    });

    it("names the five macro codes Today's rings and fiber line read", () => {
      expect(MACRO_CODES).toEqual({ kcal: "energy_kcal", protein: "protein",
        carbs: "carbohydrate", fat: "fat_total", fiber: "fiber_total" });
    });

    it("holds her band, not the 25 g AI", () => {
      expect(FIBER_BAND_G).toEqual({ min: 20, max: 25 });
    });

    it("narrows an unknown string", () => {
      expect(isNutrientCode("protein")).toBe(true);
      expect(isNutrientCode("vitamin_k")).toBe(false);
    });
  });
  ```

- [ ] Run it: `pnpm test lib/nutrients/codes.test.ts`
  Expected failure: `Failed to load url ./codes` / `Cannot find module './codes'`.

- [ ] Minimal implementation. Create `lib/nutrients/codes.ts`:
  ```ts
  /**
   * The canonical nutrient vocabulary. Phase 1–2 contracts §2 freezes both the codes and their
   * units; catalog_nutrients on the database side carries the same pairs, and the import worker
   * (Lane F) agrees with this file. Pure data, no imports.
   */

  export const NUTRIENT_CODES = [
    "energy_kcal", "energy_kcal_calc", "protein", "carbohydrate", "fat_total", "fiber_total",
    "sugars_total", "sodium", "potassium", "calcium", "iron", "magnesium", "zinc", "vitamin_c",
    "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "saturated_fat", "cholesterol",
  ] as const;

  export type NutrientCode = (typeof NUTRIENT_CODES)[number];

  /** Units are kcal, g, mg and µg — contracts §2. The snapshot passes the DB unit through; this
   *  table is the offline fallback when a cached catalog row carries no unit of its own. */
  export const NUTRIENT_UNITS: Record<NutrientCode, string> = {
    energy_kcal: "kcal", energy_kcal_calc: "kcal", protein: "g", carbohydrate: "g",
    fat_total: "g", fiber_total: "g", sugars_total: "g", saturated_fat: "g",
    sodium: "mg", potassium: "mg", calcium: "mg", iron: "mg", magnesium: "mg", zinc: "mg",
    vitamin_c: "mg", cholesterol: "mg",
    vitamin_d: "µg", vitamin_b12: "µg", folate_dfe: "µg", vitamin_a_rae: "µg",
  };

  export const MACRO_CODES = {
    kcal: "energy_kcal", protein: "protein", carbs: "carbohydrate",
    fat: "fat_total", fiber: "fiber_total",
  } as const;

  /** The twelve codes seeded in 20260918090300 and counted by the Today coverage pill. */
  export const TRACKED_MICROS: readonly NutrientCode[] = [
    "fiber_total", "iron", "calcium", "potassium", "magnesium", "zinc", "vitamin_c",
    "vitamin_d", "vitamin_b12", "folate_dfe", "vitamin_a_rae", "sodium",
  ];

  /** targets.md, not the DRI: 20–25 g/day soluble-dominant. The band wins on her screen. */
  export const FIBER_BAND_G = { min: 20, max: 25 } as const;

  const CODE_SET: ReadonlySet<string> = new Set(NUTRIENT_CODES);

  export function isNutrientCode(value: string): value is NutrientCode {
    return CODE_SET.has(value);
  }
  ```

- [ ] Run it: `pnpm test lib/nutrients/codes.test.ts` → expected **PASS**, 6 tests.

- [ ] Commit:
  `git add lib/nutrients/codes.ts lib/nutrients/codes.test.ts && git commit -m "feat(nutrients): freeze the canonical nutrient codes, units and tracked micro set"`

---

## Task 3 — `lib/nutrients/snapshot.ts`

**Files**
- Create: `lib/nutrients/snapshot.ts`
- Test: `lib/nutrients/snapshot.test.ts`

**Interfaces**
- Consumes: `NutrientCode`, `NUTRIENT_UNITS`, `isNutrientCode` from `./codes`.
- Produces:
  ```ts
  export type NutrientValue = { amount: number | null; unit: string; basis: "per_100g";
    source: string; source_version: string; revision_id: number | null };
  export type Snapshot = Record<NutrientCode, NutrientValue>;
  export type SnapshotMeta = { source: string; source_version: string; revision_id: number | null;
    units?: Partial<Record<NutrientCode, string>> };
  export function round4(value: number): number;
  export function computeSnapshot(per100g: Record<NutrientCode, number | null>, grams: number,
    meta: SnapshotMeta): Snapshot;
  export function snapshotValue(snapshot: Snapshot, code: NutrientCode): NutrientValue | undefined;
  export function snapshotsEqual(a: Snapshot, b: Snapshot, epsilon?: number): boolean;
  ```
  `Snapshot` is the spec's `Record<NutrientCode, NutrientValue>` verbatim, so it is not renamed —
  but a real snapshot holds only the codes the source measured. Read it with `snapshotValue`, which
  returns `undefined` for an absent code; never index it directly.

  `SnapshotMeta.units` is optional and `Partial` on purpose: `computeSnapshot` falls back to
  `NUTRIENT_UNITS[code]` per nutrient (see the implementation below), so a caller supplies only the
  units a cached row actually overrides. This is the shape Lane I's Task 1 contract-change commit
  documents in contracts §4 — keep the two in sync if this type changes; do not let a stricter
  required-and-full `units` land here without updating that contract text in the same commit.

**Steps**

- [ ] Write the failing test. Create `lib/nutrients/snapshot.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import type { NutrientCode } from "./codes";
  import { computeSnapshot, round4, snapshotsEqual, snapshotValue, type SnapshotMeta } from "./snapshot";

  const meta: SnapshotMeta = { source: "fdc_sr_legacy", source_version: "2026-04", revision_id: 41 };

  function per100(over: Partial<Record<NutrientCode, number | null>>) {
    return over as Record<NutrientCode, number | null>;
  }

  describe("round4", () => {
    it("rounds half away from zero at the fourth decimal, like Postgres numeric", () => {
      expect(round4(0.55355)).toBe(0.5536);
      expect(round4(0.55354)).toBe(0.5535);
      expect(round4(1.00005)).toBe(1.0001);
      expect(round4(12)).toBe(12);
    });
  });

  describe("computeSnapshot", () => {
    it("scales per-100 g values by grams and rounds to 4 dp", () => {
      const snap = computeSnapshot(per100({ protein: 23.1, energy_kcal: 179 }), 140, meta);
      expect(snapshotValue(snap, "protein")).toEqual({ amount: 32.34, unit: "g",
        basis: "per_100g", source: "fdc_sr_legacy", source_version: "2026-04", revision_id: 41 });
      expect(snapshotValue(snap, "energy_kcal")?.amount).toBe(250.6);
    });

    it("keeps null as null and a measured zero as zero", () => {
      const snap = computeSnapshot(per100({ iron: null, sugars_total: 0 }), 200, meta);
      expect(snapshotValue(snap, "iron")?.amount).toBeNull();
      expect(snapshotValue(snap, "sugars_total")?.amount).toBe(0);
    });

    it("writes no entry for a code the source does not carry", () => {
      const snap = computeSnapshot(per100({ protein: 10 }), 100, meta);
      expect(snapshotValue(snap, "zinc")).toBeUndefined();
      expect(Object.keys(snap)).toEqual(["protein"]);
    });

    it("passes a supplied unit through and falls back to the canonical one", () => {
      const snap = computeSnapshot(per100({ vitamin_d: 1.2, calcium: 30 }), 50,
        { ...meta, units: { vitamin_d: "IU" } });
      expect(snapshotValue(snap, "vitamin_d")?.unit).toBe("IU");
      expect(snapshotValue(snap, "calcium")?.unit).toBe("mg");
    });

    it("returns an empty snapshot for zero grams with every amount at zero, not null", () => {
      const snap = computeSnapshot(per100({ protein: 23.1 }), 0, meta);
      expect(snapshotValue(snap, "protein")?.amount).toBe(0);
    });

    it("rejects negative grams", () => {
      expect(() => computeSnapshot(per100({ protein: 1 }), -1, meta)).toThrow(/grams/);
    });
  });

  describe("snapshotsEqual", () => {
    const a = computeSnapshot(per100({ protein: 23.1, iron: null }), 140, meta);

    it("is true for the same amounts and units from a different source revision", () => {
      const b = computeSnapshot(per100({ protein: 23.1, iron: null }), 140,
        { source: "fdc_sr_legacy", source_version: "2026-07", revision_id: 99 });
      expect(snapshotsEqual(a, b)).toBe(true);
    });

    it("is false when one side measured a nutrient the other did not", () => {
      const b = computeSnapshot(per100({ protein: 23.1, iron: 1.2 }), 140, meta);
      expect(snapshotsEqual(a, b)).toBe(false);
    });

    it("is false on a different code set", () => {
      const b = computeSnapshot(per100({ protein: 23.1 }), 140, meta);
      expect(snapshotsEqual(a, b)).toBe(false);
    });

    it("tolerates a difference inside epsilon and rejects one outside", () => {
      const near = computeSnapshot(per100({ protein: 23.1001, iron: null }), 140, meta);
      expect(snapshotsEqual(a, near, 0.02)).toBe(true);
      expect(snapshotsEqual(a, near, 0.0001)).toBe(false);
    });
  });
  ```

- [ ] Run it: `pnpm test lib/nutrients/snapshot.test.ts`
  Expected failure: `Failed to load url ./snapshot` / `Cannot find module './snapshot'`.

- [ ] Minimal implementation. Create `lib/nutrients/snapshot.ts`:
  ```ts
  /**
   * The client half of compute_item_snapshot (migration 20260918090100).
   *
   * Same inputs, same rounding, same null rule, so an offline entry shows the numbers the server
   * will store and `snapshotsEqual` is a real assertion rather than a hope. architecture.md §3.3:
   * `amount` is the item's contribution in the nutrient's own unit with grams already applied;
   * `null` means the source did not measure the nutrient, `0` means it measured zero.
   *
   * Pure. No I/O.
   */

  import { isNutrientCode, NUTRIENT_UNITS, type NutrientCode } from "./codes";

  export type NutrientValue = {
    amount: number | null;
    unit: string;
    basis: "per_100g";
    source: string;
    source_version: string;
    revision_id: number | null;
  };

  /** Spec shape (contracts §4). Only the codes the source carries are present — read with
   *  `snapshotValue`, never by direct index. */
  export type Snapshot = Record<NutrientCode, NutrientValue>;

  export type SnapshotMeta = {
    source: string;
    source_version: string;
    revision_id: number | null;
    /** catalog_nutrients.unit by code, when the cached row carries one. */
    units?: Partial<Record<NutrientCode, string>>;
  };

  /**
   * Postgres `round(numeric, 4)` rounds half away from zero on an exact decimal. Every nutrient
   * amount is >= 0 (grams >= 0, per-100 g >= 0), so half-away-from-zero is half-up here, and the
   * 1e-9 slack pulls a binary-short 0.49999999996 back onto the .5 boundary.
   */
  export function round4(value: number): number {
    const scaled = value * 1e4;
    const floor = Math.floor(scaled);
    return (scaled - floor > 0.5 - 1e-9 ? floor + 1 : floor) / 1e4;
  }

  export function computeSnapshot(
    per100g: Record<NutrientCode, number | null>,
    grams: number,
    meta: SnapshotMeta
  ): Snapshot {
    if (!Number.isFinite(grams) || grams < 0) {
      throw new RangeError(`grams must be a finite number >= 0, got ${grams}`);
    }
    const out: Partial<Record<NutrientCode, NutrientValue>> = {};
    for (const [key, per100] of Object.entries(per100g)) {
      if (!isNutrientCode(key)) continue;
      if (per100 === undefined) continue;
      out[key] = {
        amount: per100 === null ? null : round4((per100 * grams) / 100),
        unit: meta.units?.[key] ?? NUTRIENT_UNITS[key],
        basis: "per_100g",
        source: meta.source,
        source_version: meta.source_version,
        revision_id: meta.revision_id,
      };
    }
    return out as Snapshot;
  }

  export function snapshotValue(snapshot: Snapshot, code: NutrientCode): NutrientValue | undefined {
    return (snapshot as Partial<Record<NutrientCode, NutrientValue>>)[code];
  }

  /**
   * Amount and unit only. Provenance (source, source_version, revision_id) is deliberately not
   * compared: the offline client writes the cached revision's label and the server writes the
   * active one, and the parity test asserts those separately.
   */
  export function snapshotsEqual(a: Snapshot, b: Snapshot, epsilon = 1e-4): boolean {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i += 1) if (keysA[i] !== keysB[i]) return false;
    for (const key of keysA) {
      if (!isNutrientCode(key)) return false;
      const left = snapshotValue(a, key);
      const right = snapshotValue(b, key);
      if (!left || !right) return false;
      if (left.unit !== right.unit) return false;
      if (left.amount === null || right.amount === null) {
        if (left.amount !== right.amount) return false;
        continue;
      }
      if (Math.abs(left.amount - right.amount) > epsilon) return false;
    }
    return true;
  }
  ```

- [ ] Run it: `pnpm test lib/nutrients/snapshot.test.ts` → expected **PASS**, 11 tests.

- [ ] Commit:
  `git add lib/nutrients/snapshot.ts lib/nutrients/snapshot.test.ts && git commit -m "feat(nutrients): mirror compute_item_snapshot in TypeScript with 4 dp parity"`

---

## Task 4 — `lib/nutrients/totals.ts`

**Files**
- Create: `lib/nutrients/totals.ts`
- Test: `lib/nutrients/totals.test.ts`

**Interfaces**
- Consumes: `NutrientCode`, `NUTRIENT_UNITS`, `TRACKED_MICROS`, `isNutrientCode` from `./codes`;
  `Snapshot`, `round4`, `snapshotValue` from `./snapshot`.
- Produces:
  ```ts
  export type NutrientTotal = { code: NutrientCode; amount: number; unit: string;
    itemsWithValue: number; itemsTotal: number; coverage: number };
  export function totalsFor(items: { snapshot: Snapshot }[]): Map<NutrientCode, NutrientTotal>;
  export function microCoverage(totals: Map<NutrientCode, NutrientTotal>,
    codes?: readonly NutrientCode[]): { covered: number; tracked: number; pct: number };
  ```

**Steps**

- [ ] Write the failing test. Create `lib/nutrients/totals.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import type { NutrientCode } from "./codes";
  import { computeSnapshot, type SnapshotMeta } from "./snapshot";
  import { microCoverage, totalsFor } from "./totals";

  const meta: SnapshotMeta = { source: "fdc_foundation", source_version: "2026-04", revision_id: 7 };

  function item(per100: Partial<Record<NutrientCode, number | null>>, grams: number) {
    return { snapshot: computeSnapshot(per100 as Record<NutrientCode, number | null>, grams, meta) };
  }

  describe("totalsFor", () => {
    it("sums measured amounts and carries the unit", () => {
      const totals = totalsFor([item({ protein: 23.1 }, 140), item({ protein: 7.5 }, 200)]);
      expect(totals.get("protein")).toEqual({ code: "protein", amount: 47.34, unit: "g",
        itemsWithValue: 2, itemsTotal: 2, coverage: 1 });
    });

    it("skips a null amount in the sum but counts it against coverage", () => {
      const totals = totalsFor([item({ iron: 2.5 }, 100), item({ iron: null }, 100)]);
      expect(totals.get("iron")).toEqual({ code: "iron", amount: 2.5, unit: "mg",
        itemsWithValue: 1, itemsTotal: 2, coverage: 0.5 });
    });

    it("counts every item of the day in the denominator, not only the ones carrying the code", () => {
      const totals = totalsFor([item({ zinc: 1.2 }, 100), item({ protein: 4 }, 100),
        item({ protein: 4 }, 100), item({ protein: 4 }, 100)]);
      expect(totals.get("zinc")).toMatchObject({ itemsWithValue: 1, itemsTotal: 4, coverage: 0.25 });
    });

    it("keeps a measured zero as a covered value", () => {
      const totals = totalsFor([item({ sugars_total: 0 }, 250)]);
      expect(totals.get("sugars_total")).toMatchObject({ amount: 0, itemsWithValue: 1, coverage: 1 });
    });

    it("is empty for no items", () => {
      expect(totalsFor([]).size).toBe(0);
    });
  });

  describe("microCoverage", () => {
    it("counts a tracked micro as covered only when an item measured it", () => {
      const totals = totalsFor([item({ iron: 2.5, calcium: null, protein: 10 }, 100)]);
      expect(microCoverage(totals)).toEqual({ covered: 1, tracked: 12, pct: 8 });
    });

    it("reports 7 of 12 as 58 percent", () => {
      const totals = totalsFor([item({ fiber_total: 4, iron: 1, calcium: 20, potassium: 100,
        magnesium: 12, zinc: 1, vitamin_c: 3 }, 100)]);
      expect(microCoverage(totals)).toEqual({ covered: 7, tracked: 12, pct: 58 });
    });

    it("takes a narrower code list when one is given", () => {
      const totals = totalsFor([item({ iron: 2.5 }, 100)]);
      expect(microCoverage(totals, ["iron", "zinc"])).toEqual({ covered: 1, tracked: 2, pct: 50 });
    });

    it("is zero percent, never NaN, for an empty tracked list", () => {
      expect(microCoverage(new Map(), [])).toEqual({ covered: 0, tracked: 0, pct: 0 });
    });
  });
  ```

- [ ] Run it: `pnpm test lib/nutrients/totals.test.ts`
  Expected failure: `Failed to load url ./totals` / `Cannot find module './totals'`.

- [ ] Minimal implementation. Create `lib/nutrients/totals.ts`:
  ```ts
  /**
   * The client half of the daily_totals view (migration 20260918090200).
   *
   * Coverage is items-carrying-a-value / all items that day — architecture.md §3.3 — so a 5 g
   * sprinkle of an uncharacterised spice costs the same coverage as a 200 g main. That is the
   * architecture's rule, and the spec's open question 1 names it; do not weight by grams here
   * without amending architecture.md first.
   *
   * Pure. No I/O.
   */

  import { isNutrientCode, NUTRIENT_UNITS, TRACKED_MICROS, type NutrientCode } from "./codes";
  import { round4, snapshotValue, type Snapshot } from "./snapshot";

  export type NutrientTotal = {
    code: NutrientCode;
    amount: number;
    unit: string;
    itemsWithValue: number;
    itemsTotal: number;
    coverage: number;
  };

  export function totalsFor(items: { snapshot: Snapshot }[]): Map<NutrientCode, NutrientTotal> {
    const itemsTotal = items.length;
    const out = new Map<NutrientCode, NutrientTotal>();
    if (itemsTotal === 0) return out;

    for (const { snapshot } of items) {
      for (const key of Object.keys(snapshot)) {
        if (!isNutrientCode(key)) continue;
        const value = snapshotValue(snapshot, key);
        if (!value) continue;
        const row = out.get(key) ?? { code: key, amount: 0, unit: value.unit ?? NUTRIENT_UNITS[key],
          itemsWithValue: 0, itemsTotal, coverage: 0 };
        if (value.amount !== null) {
          row.amount = round4(row.amount + value.amount);
          row.itemsWithValue += 1;
        }
        out.set(key, row);
      }
    }
    for (const row of out.values()) row.coverage = round4(row.itemsWithValue / itemsTotal);
    return out;
  }

  export function microCoverage(
    totals: Map<NutrientCode, NutrientTotal>,
    codes: readonly NutrientCode[] = TRACKED_MICROS
  ): { covered: number; tracked: number; pct: number } {
    const tracked = codes.length;
    let covered = 0;
    for (const code of codes) if ((totals.get(code)?.itemsWithValue ?? 0) > 0) covered += 1;
    return { covered, tracked, pct: tracked === 0 ? 0 : Math.round((covered / tracked) * 100) };
  }
  ```

- [ ] Run it: `pnpm test lib/nutrients/totals.test.ts` → expected **PASS**, 9 tests.

- [ ] Commit:
  `git add lib/nutrients/totals.ts lib/nutrients/totals.test.ts && git commit -m "feat(nutrients): sum snapshots into per-code totals with an items-based coverage"`

---

## Task 5 — `lib/nutrients/dri.ts` and `lib/nutrients/format.ts`

**Files**
- Create: `lib/nutrients/dri.ts`, `lib/nutrients/format.ts`
- Test: `lib/nutrients/dri.test.ts`, `lib/nutrients/format.test.ts`

**Interfaces**
- Consumes: `NutrientCode`, `NUTRIENT_UNITS`, `FIBER_BAND_G` from `./codes`; `NutrientTotal` from
  `./totals`.
- Produces:
  ```ts
  // lib/nutrients/dri.ts
  export type DriRow = { code: NutrientCode; refType: "RDA" | "AI" | "UL" | "EAR";
    value: number; unit: string };
  export function percentDri(total: NutrientTotal | undefined, dri: DriRow | undefined): number | null;
  export function fiberBandState(fiberG: number | null): "under" | "in-band" | "over" | "unknown";
  export const DRI_FEMALE_19_30: readonly DriRow[];   // contracts §2 — the 12 rows of
                                                       // …090300_phase2_catalog_dri_seed.sql, mirrored
  // lib/nutrients/format.ts
  export function formatAmount(code: NutrientCode, amount: number | null, unit: string): string;
  ```
  `DRI_FEMALE_19_30` is contracts §2's Lane H export (Lane I Task 1's contract change); Lane I's
  `DayNutrients` (Task 13) is its only Phase 2 consumer. It is written here, by hand, against the same
  twelve `(nutrient_code, value, unit, ref_type)` tuples Task 10 seeds in SQL — Task 10's step below
  proves the two agree so the seed can never drift from the TS mirror unnoticed.

**Steps**

- [ ] Write the failing tests. Create `lib/nutrients/dri.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { TRACKED_MICROS } from "./codes";
  import { DRI_FEMALE_19_30, fiberBandState, percentDri, type DriRow } from "./dri";
  import type { NutrientTotal } from "./totals";

  function total(over: Partial<NutrientTotal>): NutrientTotal {
    return { code: "iron", amount: 9, unit: "mg", itemsWithValue: 2, itemsTotal: 2,
      coverage: 1, ...over };
  }
  const iron: DriRow = { code: "iron", refType: "RDA", value: 18, unit: "mg" };

  describe("percentDri", () => {
    it("reports the percentage to one decimal", () => {
      expect(percentDri(total({ amount: 9 }), iron)).toBe(50);
      expect(percentDri(total({ amount: 9.9 }), iron)).toBe(55);
      expect(percentDri(total({ amount: 4 }), iron)).toBe(22.2);
    });

    it("converts inside the mass family before dividing", () => {
      expect(percentDri(total({ code: "vitamin_d", amount: 0.0075, unit: "mg" }),
        { code: "vitamin_d", refType: "RDA", value: 15, unit: "µg" })).toBe(50);
    });

    it("is null with no total, no DRI row, a zero DRI or an unconvertible unit", () => {
      expect(percentDri(undefined, iron)).toBeNull();
      expect(percentDri(total({}), undefined)).toBeNull();
      expect(percentDri(total({}), { ...iron, value: 0 })).toBeNull();
      expect(percentDri(total({ unit: "kcal" }), iron)).toBeNull();
    });

    it("is null when nothing measured the nutrient", () => {
      expect(percentDri(total({ itemsWithValue: 0, amount: 0 }), iron)).toBeNull();
    });
  });

  describe("fiberBandState", () => {
    it("puts 19.9 under, 20 and 25 in band, 25.1 over", () => {
      expect(fiberBandState(19.9)).toBe("under");
      expect(fiberBandState(20)).toBe("in-band");
      expect(fiberBandState(25)).toBe("in-band");
      expect(fiberBandState(25.1)).toBe("over");
    });

    it("is unknown for null, and under for a logged zero", () => {
      expect(fiberBandState(null)).toBe("unknown");
      expect(fiberBandState(0)).toBe("under");
    });
  });

  describe("DRI_FEMALE_19_30", () => {
    it("carries exactly the twelve tracked-micro codes, once each", () => {
      const codes = DRI_FEMALE_19_30.map((r) => r.code).sort();
      expect(codes).toEqual([...TRACKED_MICROS].sort());
      expect(new Set(codes).size).toBe(12);
    });

    it("matches the seeded row for iron — value, unit and ref type", () => {
      const iron = DRI_FEMALE_19_30.find((r) => r.code === "iron");
      expect(iron).toEqual({ code: "iron", refType: "RDA", value: 18, unit: "mg" });
    });
  });
  ```
  Create `lib/nutrients/format.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { formatAmount } from "./format";

  describe("formatAmount", () => {
    it("renders an unmeasured nutrient as an em dash, never as zero", () => {
      expect(formatAmount("iron", null, "mg")).toBe("—");
      expect(formatAmount("energy_kcal", null, "kcal")).toBe("—");
    });

    it("renders a measured zero as zero", () => {
      expect(formatAmount("sugars_total", 0, "g")).toBe("0.0 g");
      expect(formatAmount("energy_kcal", 0, "kcal")).toBe("0 kcal");
    });

    it("rounds kcal to the nearest whole calorie", () => {
      expect(formatAmount("energy_kcal", 250.64, "kcal")).toBe("251 kcal");
      expect(formatAmount("energy_kcal_calc", 1999.4, "kcal")).toBe("1999 kcal");
    });

    it("rounds a macro to a tenth of a gram", () => {
      expect(formatAmount("protein", 32.34, "g")).toBe("32.3 g");
      expect(formatAmount("fiber_total", 18.05, "g")).toBe("18.1 g");
    });

    it("renders a micro to one decimal in its own unit", () => {
      expect(formatAmount("sodium", 1240.25, "mg")).toBe("1240.3 mg");
      expect(formatAmount("vitamin_d", 1.2, "µg")).toBe("1.2 µg");
    });

    it("falls back to the canonical unit when the snapshot carries none", () => {
      expect(formatAmount("calcium", 30, "")).toBe("30.0 mg");
    });
  });
  ```

- [ ] Run them: `pnpm test lib/nutrients/dri.test.ts lib/nutrients/format.test.ts`
  Expected failure: `Failed to load url ./dri` / `Cannot find module './dri'`.

- [ ] Minimal implementation. Create `lib/nutrients/dri.ts`:
  ```ts
  /**
   * Informational micronutrient context. architecture.md §3.1: micros have no rings, no targets
   * and no red states — amount first, percentage muted. Fiber is shown against her 20–25 g band
   * (targets.md), not against the 25 g AI, which is why fiberBandState does not read a DriRow.
   *
   * Pure. No I/O.
   */

  import { FIBER_BAND_G, type NutrientCode } from "./codes";
  import type { NutrientTotal } from "./totals";

  export type DriRow = {
    code: NutrientCode;
    refType: "RDA" | "AI" | "UL" | "EAR";
    value: number;
    unit: string;
  };

  /** Grams per one of the unit. Only the mass family converts; kcal never does. */
  const GRAMS_PER_UNIT: Record<string, number> = { g: 1, mg: 1e-3, "µg": 1e-6, ug: 1e-6 };

  export function percentDri(
    total: NutrientTotal | undefined,
    dri: DriRow | undefined
  ): number | null {
    if (!total || !dri) return null;
    if (total.itemsWithValue === 0) return null;
    if (!(dri.value > 0)) return null;
    const from = GRAMS_PER_UNIT[total.unit];
    const to = GRAMS_PER_UNIT[dri.unit];
    if (from === undefined || to === undefined) return null;
    const amountInDriUnit = (total.amount * from) / to;
    return Math.round((amountInDriUnit / dri.value) * 1000) / 10;
  }

  export function fiberBandState(fiberG: number | null): "under" | "in-band" | "over" | "unknown" {
    if (fiberG === null || !Number.isFinite(fiberG)) return "unknown";
    if (fiberG < FIBER_BAND_G.min) return "under";
    if (fiberG > FIBER_BAND_G.max) return "over";
    return "in-band";
  }

  /**
   * contracts §2 (Lane I Task 1's contract change) — Lane I's `DayNutrients` is the only Phase 2
   * consumer. A hand-written mirror of the twelve rows migration …090300_phase2_catalog_dri_seed.sql
   * seeds into `catalog_dri`; Task 10's psql assertion checks the two agree so this can never drift
   * from the seed unnoticed.
   */
  export const DRI_FEMALE_19_30: readonly DriRow[] = [
    { code: "fiber_total", refType: "AI", value: 25, unit: "g" },
    { code: "iron", refType: "RDA", value: 18, unit: "mg" },
    { code: "calcium", refType: "RDA", value: 1000, unit: "mg" },
    { code: "potassium", refType: "AI", value: 2600, unit: "mg" },
    { code: "magnesium", refType: "RDA", value: 310, unit: "mg" },
    { code: "zinc", refType: "RDA", value: 8, unit: "mg" },
    { code: "vitamin_c", refType: "RDA", value: 75, unit: "mg" },
    { code: "vitamin_d", refType: "RDA", value: 15, unit: "µg" },
    { code: "vitamin_b12", refType: "RDA", value: 2.4, unit: "µg" },
    { code: "folate_dfe", refType: "RDA", value: 400, unit: "µg" },
    { code: "vitamin_a_rae", refType: "RDA", value: 700, unit: "µg" },
    { code: "sodium", refType: "AI", value: 1500, unit: "mg" },
  ];
  ```
  Create `lib/nutrients/format.ts`:
  ```ts
  /**
   * One display rule for every nutrient, so `—` and `0` never trade places.
   * Spec: null → "—", never "0"; kcal to 1, macros to 0.1 g, micros to their unit.
   *
   * Pure. No I/O.
   */

  import { NUTRIENT_UNITS, type NutrientCode } from "./codes";

  const DECIMALS: Record<string, number> = { kcal: 0, g: 1, mg: 1, "µg": 1, ug: 1 };

  export function formatAmount(code: NutrientCode, amount: number | null, unit: string): string {
    if (amount === null || !Number.isFinite(amount)) return "—";
    const shown = unit || NUTRIENT_UNITS[code];
    const decimals = DECIMALS[shown] ?? 1;
    return `${amount.toFixed(decimals)} ${shown}`;
  }
  ```

- [ ] Run them: `pnpm test lib/nutrients/dri.test.ts lib/nutrients/format.test.ts` → expected
  **PASS**, 14 tests.

- [ ] Commit:
  `git add lib/nutrients/dri.ts lib/nutrients/dri.test.ts lib/nutrients/format.ts lib/nutrients/format.test.ts && git commit -m "feat(nutrients): add percent-DRI, the fiber band state and the display formatter"`

---

## Task 6 — `lib/log/grams.ts`

**Files**
- Create: `lib/log/grams.ts`
- Test: `lib/log/grams.test.ts`

**Interfaces**
- Consumes: nothing.
- Produces:
  ```ts
  export const LOG_UNITS: readonly ["g", "oz", "portion", "each"];
  export type LogUnit = (typeof LOG_UNITS)[number];
  export function isLogUnit(value: string): value is LogUnit;
  export function gramsForPortion(portion: { gramWeight: number }, qty: number): number;
  export function gramsFromUnit(qty: number, unit: LogUnit): number | null;
  ```

**Steps**

- [ ] Write the failing test. Create `lib/log/grams.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { gramsForPortion, gramsFromUnit, isLogUnit, LOG_UNITS } from "./grams";

  describe("gramsForPortion", () => {
    it("multiplies the portion's gram weight by the quantity, to a tenth", () => {
      expect(gramsForPortion({ gramWeight: 85 }, 2)).toBe(170);
      expect(gramsForPortion({ gramWeight: 158 }, 0.5)).toBe(79);
      expect(gramsForPortion({ gramWeight: 28.35 }, 1.5)).toBe(42.5);
    });

    it("returns zero for a zero quantity and refuses a negative one", () => {
      expect(gramsForPortion({ gramWeight: 85 }, 0)).toBe(0);
      expect(() => gramsForPortion({ gramWeight: 85 }, -1)).toThrow(/qty/);
    });

    it("refuses a portion with no positive gram weight", () => {
      expect(() => gramsForPortion({ gramWeight: 0 }, 1)).toThrow(/gramWeight/);
    });
  });

  describe("gramsFromUnit", () => {
    it("passes grams through", () => {
      expect(gramsFromUnit(140, "g")).toBe(140);
    });

    it("converts ounces at 28.349523125 g", () => {
      expect(gramsFromUnit(1, "oz")).toBe(28.3);
      expect(gramsFromUnit(6, "oz")).toBe(170.1);
    });

    it("returns null for a unit that needs a portion", () => {
      expect(gramsFromUnit(1, "portion")).toBeNull();
      expect(gramsFromUnit(2, "each")).toBeNull();
    });

    it("refuses a negative quantity", () => {
      expect(() => gramsFromUnit(-1, "g")).toThrow(/qty/);
    });
  });

  describe("LOG_UNITS", () => {
    it("is the four units Phase 2 writes, per the spec's open question 4", () => {
      expect(LOG_UNITS).toEqual(["g", "oz", "portion", "each"]);
      expect(isLogUnit("cup")).toBe(false);
      expect(isLogUnit("oz")).toBe(true);
    });
  });
  ```

- [ ] Run it: `pnpm test lib/log/grams.test.ts`
  Expected failure: `Failed to load url ./grams` / `Cannot find module './grams'`.

- [ ] Minimal implementation. Create `lib/log/grams.ts`:
  ```ts
  /**
   * Grams are the only quantity the snapshot understands. Everything the sheet offers resolves to
   * grams here or not at all — a unit that needs a catalog portion returns null rather than a
   * guess, so the sheet blocks the food and says so instead of storing a zeroed item.
   *
   * `log_items.unit` stays free text in Phase 2 (spec, open question 4); these are the four values
   * Phase 2 writes. Pure. No I/O.
   */

  export const LOG_UNITS = ["g", "oz", "portion", "each"] as const;
  export type LogUnit = (typeof LOG_UNITS)[number];

  const GRAMS_PER_OZ = 28.349523125;
  const UNIT_SET: ReadonlySet<string> = new Set(LOG_UNITS);

  export function isLogUnit(value: string): value is LogUnit {
    return UNIT_SET.has(value);
  }

  function round1(value: number): number {
    return Math.round(value * 10) / 10;
  }

  function assertQty(qty: number): void {
    if (!Number.isFinite(qty) || qty < 0) {
      throw new RangeError(`qty must be a finite number >= 0, got ${qty}`);
    }
  }

  export function gramsForPortion(portion: { gramWeight: number }, qty: number): number {
    assertQty(qty);
    if (!Number.isFinite(portion.gramWeight) || portion.gramWeight <= 0) {
      throw new RangeError(`gramWeight must be a finite number > 0, got ${portion.gramWeight}`);
    }
    return round1(portion.gramWeight * qty);
  }

  export function gramsFromUnit(qty: number, unit: LogUnit): number | null {
    assertQty(qty);
    if (unit === "g") return round1(qty);
    if (unit === "oz") return round1(qty * GRAMS_PER_OZ);
    return null;
  }
  ```

- [ ] Run it: `pnpm test lib/log/grams.test.ts` → expected **PASS**, 8 tests.

- [ ] Commit:
  `git add lib/log/grams.ts lib/log/grams.test.ts && git commit -m "feat(log): resolve portions and units to grams, or to null when a portion is needed"`

---

## Task 7 — `lib/log/contract.ts`

**Files**
- Create: `lib/log/contract.ts`
- Test: `lib/log/contract.test.ts`

**Interfaces**
- Consumes: `SlotId` from `@/lib/types`; `Snapshot` from `@/lib/nutrients/snapshot`;
  `NutrientTotal` from `@/lib/nutrients/totals`; `zod` 4.
- Produces the frozen wire types of Phase 1–2 contracts §4, plus their runtime schemas:
  ```ts
  export type LogItemInput = { id: string; seq: number; food_ref_id: string;
    qty: number; unit: string; grams: number;
    portion_id?: number | null; food_revision_id?: number | null; was_edited?: boolean };
  export type LogCommitRequest = { entry_id: string; base_rev?: number;
    eaten_at: string; tz: string; local_date: string; slot: SlotId;
    method: "search" | "plan" | "text" | "voice" | "label" | "photo";
    draft_id?: string; save_label_as_food?: boolean;
    note?: string; items: LogItemInput[] };
  export type DayTotals = { local_date: string; nutrients: NutrientTotal[];
    micro_coverage_pct: number };
  export type LogEntity = Record<string, unknown>;
  export type LogCommitResponse = { status: "ok"; entry_id: string; rev: number;
    user_food_id?: string; items: { id: string; grams: number; snapshot: Snapshot }[];
    totals: DayTotals };
  export type LogCommitFailure =
    | { status: "conflict"; current_rev: number; entity: LogEntity }
    | { status: "deleted"; deleted_at: string }
    | { status: "gone" }
    | { status: "stale_revision"; food_ref_id: string; revision_id: number }
    | { status: "invalid"; issues: { path: string; message: string }[] };
  export const logItemInputSchema: z.ZodType<LogItemInput>;
  export const logCommitRequestSchema: z.ZodType<LogCommitRequest>;
  export function localDateFor(eatenAt: string, tz: string): string | null;
  export function opIdFor(entryId: string, baseRev: number | undefined): string;
  export function issuesFrom(error: z.ZodError): { path: string; message: string }[];
  ```
  `LogEntity` is the full current `log_entries` row with its `items[]`, as `_sync_current` returns
  it (Phase 0 lane A) — the spec writes `entity: LogEntry`; the row shape is owned by SQL, so this
  lane carries it as an opaque record and never re-declares the column list.

**Steps**

- [ ] Write the failing test. Create `lib/log/contract.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { issuesFrom, localDateFor, logCommitRequestSchema, opIdFor } from "./contract";

  const ITEM = { id: "3f1c5a2e-9b7d-4a61-8c2f-0d5e6a7b8c90", seq: 1,
    food_ref_id: "7a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071", qty: 1, unit: "g", grams: 140 };

  function body(over: Record<string, unknown> = {}) {
    return { entry_id: "11111111-2222-4333-8444-555555555555",
      eaten_at: "2026-09-18T02:30:00.000Z", tz: "America/Los_Angeles",
      local_date: "2026-09-17", slot: "meal-3", method: "search", items: [ITEM], ...over };
  }

  describe("logCommitRequestSchema", () => {
    it("accepts a well-formed create", () => {
      expect(logCommitRequestSchema.safeParse(body()).success).toBe(true);
    });

    it("rejects negative grams at the item path", () => {
      const parsed = logCommitRequestSchema.safeParse(
        body({ items: [{ ...ITEM, grams: -1 }] }));
      expect(parsed.success).toBe(false);
      expect(issuesFrom(parsed.error!)).toContainEqual(
        { path: "items.0.grams", message: expect.stringContaining("greater than or equal to 0") });
    });

    it("rejects a duplicate seq", () => {
      const parsed = logCommitRequestSchema.safeParse(body({
        items: [ITEM, { ...ITEM, id: "9f1c5a2e-9b7d-4a61-8c2f-0d5e6a7b8c91" }] }));
      expect(parsed.success).toBe(false);
      expect(issuesFrom(parsed.error!)).toContainEqual(
        { path: "items", message: "seq must be unique within an entry" });
    });

    it("rejects a local_date that disagrees with eaten_at in tz", () => {
      const parsed = logCommitRequestSchema.safeParse(body({ local_date: "2026-09-18" }));
      expect(parsed.success).toBe(false);
      expect(issuesFrom(parsed.error!)).toContainEqual(
        { path: "local_date", message: "local_date does not match eaten_at in tz" });
    });

    it("requires draft_id for voice, label and photo and not for search", () => {
      expect(logCommitRequestSchema.safeParse(body({ method: "voice" })).success).toBe(false);
      expect(logCommitRequestSchema.safeParse(
        body({ method: "voice", draft_id: "22222222-3333-4444-8555-666666666666" }))
        .success).toBe(true);
      expect(logCommitRequestSchema.safeParse(body({ method: "search" })).success).toBe(true);
    });

    it("allows save_label_as_food only with method label", () => {
      const parsed = logCommitRequestSchema.safeParse(
        body({ method: "search", save_label_as_food: true }));
      expect(issuesFrom(parsed.error!)).toContainEqual(
        { path: "save_label_as_food", message: "save_label_as_food needs method 'label'" });
    });

    it("rejects an empty item list and one over thirty items", () => {
      expect(logCommitRequestSchema.safeParse(body({ items: [] })).success).toBe(false);
      const many = Array.from({ length: 31 }, (_, i) => ({ ...ITEM, seq: i + 1,
        id: `1111111${i % 10}-2222-4333-8444-55555555555${i % 10}` }));
      expect(logCommitRequestSchema.safeParse(body({ items: many })).success).toBe(false);
    });

    it("rejects an unknown slot", () => {
      expect(logCommitRequestSchema.safeParse(body({ slot: "brunch" })).success).toBe(false);
    });
  });

  describe("localDateFor", () => {
    it("puts a 23:30 Los Angeles meal on the day she ate it", () => {
      expect(localDateFor("2026-09-18T06:30:00.000Z", "America/Los_Angeles")).toBe("2026-09-17");
    });

    it("survives the DST change day", () => {
      expect(localDateFor("2026-11-01T08:30:00.000Z", "America/Los_Angeles")).toBe("2026-11-01");
    });

    it("is null for an unknown zone", () => {
      expect(localDateFor("2026-09-18T06:30:00.000Z", "Mars/Olympus")).toBeNull();
    });
  });

  describe("opIdFor", () => {
    it("is stable for the same entry and base_rev, and a valid v5 uuid", () => {
      const a = opIdFor("11111111-2222-4333-8444-555555555555", undefined);
      expect(a).toBe(opIdFor("11111111-2222-4333-8444-555555555555", undefined));
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("differs per base_rev, so an edit is a new op and a replay is the same op", () => {
      expect(opIdFor("11111111-2222-4333-8444-555555555555", 1))
        .not.toBe(opIdFor("11111111-2222-4333-8444-555555555555", 2));
      expect(opIdFor("11111111-2222-4333-8444-555555555555", 1))
        .toBe(opIdFor("11111111-2222-4333-8444-555555555555", 1));
    });
  });
  ```

- [ ] Run it: `pnpm test lib/log/contract.test.ts`
  Expected failure: `Failed to load url ./contract` / `Cannot find module './contract'`.

- [ ] Minimal implementation. Create `lib/log/contract.ts`:
  ```ts
  /**
   * The one canonical commit contract — Phase 2 spec, "API changes". It supersedes
   * phase-4-ai-capture.md's camelCase CommitRequest: every field in log_entries is snake_case on
   * the wire, matching the Phase 0 sync envelope, and Phase 4's calls travel this same shape.
   *
   * Shared by client and server: the browser builds a request here, the server validates the same
   * schema in applyLogEntry, and the outbox derives the same op_id so an offline replay and an
   * online retry collapse onto one change_log row.
   *
   * Pure. No I/O, no Supabase import.
   */

  import { createHash } from "node:crypto";
  import { z } from "zod";
  import type { Snapshot } from "@/lib/nutrients/snapshot";
  import type { NutrientTotal } from "@/lib/nutrients/totals";
  import type { SlotId } from "@/lib/types";

  const SLOT_IDS = ["coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3",
    "hot-chocolate"] as const satisfies readonly SlotId[];
  const METHODS = ["search", "plan", "text", "voice", "label", "photo"] as const;
  const DRAFT_METHODS: readonly string[] = ["voice", "label", "photo"];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

  export type LogItemInput = {
    id: string; seq: number; food_ref_id: string;
    qty: number; unit: string; grams: number;
    portion_id?: number | null; food_revision_id?: number | null; was_edited?: boolean;
  };

  export type LogCommitRequest = {
    entry_id: string; base_rev?: number;
    eaten_at: string; tz: string; local_date: string; slot: SlotId;
    method: (typeof METHODS)[number];
    draft_id?: string; save_label_as_food?: boolean;
    note?: string; items: LogItemInput[];
  };

  export type DayTotals = {
    local_date: string; nutrients: NutrientTotal[]; micro_coverage_pct: number;
  };

  /** The full log_entries row with items[] inline, exactly as _sync_current returns it. */
  export type LogEntity = Record<string, unknown>;

  export type LogCommitResponse = {
    status: "ok"; entry_id: string; rev: number; user_food_id?: string;
    items: { id: string; grams: number; snapshot: Snapshot }[];
    totals: DayTotals;
  };

  export type LogCommitFailure =
    | { status: "conflict"; current_rev: number; entity: LogEntity }
    | { status: "deleted"; deleted_at: string }
    | { status: "gone" }
    | { status: "stale_revision"; food_ref_id: string; revision_id: number }
    | { status: "invalid"; issues: { path: string; message: string }[] };

  export const logItemInputSchema: z.ZodType<LogItemInput> = z.object({
    id: z.string().regex(UUID, "must be a uuid"),
    seq: z.number().int().min(0),
    food_ref_id: z.string().regex(UUID, "must be a uuid"),
    qty: z.number().min(0),
    unit: z.string().min(1).max(32),
    grams: z.number().min(0),
    portion_id: z.number().int().nullish(),
    food_revision_id: z.number().int().nullish(),
    was_edited: z.boolean().optional(),
  });

  /** The calendar day `eatenAt` fell on in `tz`; null when the zone is unknown. */
  export function localDateFor(eatenAt: string, tz: string): string | null {
    const at = new Date(eatenAt);
    if (Number.isNaN(at.getTime())) return null;
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit",
        day: "2-digit" }).format(at);
    } catch {
      return null;
    }
  }

  export const logCommitRequestSchema: z.ZodType<LogCommitRequest> = z
    .object({
      entry_id: z.string().regex(UUID, "must be a uuid"),
      base_rev: z.number().int().min(1).optional(),
      eaten_at: z.string().regex(ISO_INSTANT, "must be an ISO 8601 instant with an offset"),
      tz: z.string().min(1).max(64),
      local_date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD"),
      slot: z.enum(SLOT_IDS),
      method: z.enum(METHODS),
      draft_id: z.string().regex(UUID, "must be a uuid").optional(),
      save_label_as_food: z.boolean().optional(),
      note: z.string().max(2000).optional(),
      items: z.array(logItemInputSchema).min(1).max(30),
    })
    .superRefine((value, ctx) => {
      const seen = new Set<number>();
      for (const item of value.items) {
        if (seen.has(item.seq)) {
          ctx.addIssue({ code: "custom", path: ["items"],
            message: "seq must be unique within an entry" });
          break;
        }
        seen.add(item.seq);
      }
      const resolved = localDateFor(value.eaten_at, value.tz);
      if (resolved === null) {
        ctx.addIssue({ code: "custom", path: ["tz"], message: "unknown time zone" });
      } else if (resolved !== value.local_date) {
        ctx.addIssue({ code: "custom", path: ["local_date"],
          message: "local_date does not match eaten_at in tz" });
      }
      if (DRAFT_METHODS.includes(value.method) && !value.draft_id) {
        ctx.addIssue({ code: "custom", path: ["draft_id"],
          message: `method '${value.method}' needs a draft_id` });
      }
      if (value.save_label_as_food && value.method !== "label") {
        ctx.addIssue({ code: "custom", path: ["save_label_as_food"],
          message: "save_label_as_food needs method 'label'" });
      }
    }) as z.ZodType<LogCommitRequest>;

  export function issuesFrom(error: z.ZodError): { path: string; message: string }[] {
    return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  }

  /** RFC 4122 §4.3 name-based uuid, sha1. No `uuid` dependency: contracts §7 bars package.json edits. */
  const OP_NAMESPACE = "6f3c0f27-0e4a-41e8-9a64-2b0e0d6c9a11";

  function uuidV5(name: string, namespace: string): string {
    const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
    const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * The change_log op_id for this commit. Derived from entry_id and base_rev, so a replay of the
   * same create (or the same edit) is the same op and apply_sync_op answers 'duplicate'; a later
   * edit carries a higher base_rev and is a new op.
   */
  export function opIdFor(entryId: string, baseRev: number | undefined): string {
    return uuidV5(`log_entries:${entryId.toLowerCase()}:${baseRev ?? 0}`, OP_NAMESPACE);
  }
  ```

- [ ] Run it: `pnpm test lib/log/contract.test.ts` → expected **PASS**, 13 tests.

- [ ] Commit:
  `git add lib/log/contract.ts lib/log/contract.test.ts && git commit -m "feat(log): add the canonical commit contract, its zod schema and the derived op_id"`

---

## Task 8 — Migration 090100: `compute_item_snapshot` and the snapshot-minting `_sync_upsert`

**Files**
- Create: `supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql`
- Test: psql assertions in the steps (`[needs branch]`); the behavioural gate is Task 13.

**Interfaces**
- Consumes: Phase 0 `food_refs`, `user_foods`, `log_entries`, `log_items`, `_sync_current`,
  `_sync_assert_key`; Phase 1 `catalog_food_revisions`, `catalog_versions`,
  `catalog_food_nutrients`, `catalog_nutrients`.
- Produces:
  ```sql
  create or replace function compute_item_snapshot(p_food_ref_id uuid, p_grams numeric) returns jsonb;
  create or replace function _sync_upsert(p_user_id uuid, p_entity text, p_key text,
                                          p_payload jsonb, p_rev integer) returns jsonb;
  ```

**Design note — why `_sync_upsert` is replaced rather than trigger-wrapped.** The snapshot must be
**frozen**: an item whose `grams` and `food_ref_id` did not change keeps the numbers it was logged
with, so a quarterly catalog import never rewrites her history (spec acceptance 3 only recomputes on
a grams edit). `_sync_upsert` replaces a `log_entries`' items wholesale — delete then insert — so a
`before insert` trigger on `log_items` cannot see the previous row and cannot tell an unchanged item
from a new one. Capturing the previous items into a local `jsonb` before the delete is the only place
that knowledge exists. Everything below except the `log_entries` branch is Lane A's
`20260911000600_rpc.sql` body verbatim; the lane exit gate re-diffs the two.

**Steps**

- [ ] Write the failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select compute_item_snapshot('00000000-0000-4000-8000-000000000001'::uuid, 100);"
  ```
  Expected failure: `ERROR:  function compute_item_snapshot(uuid, integer) does not exist`.

- [ ] Minimal implementation. Create
  `supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql`:
  ```sql
  -- Phase 2 spec, "Data changes". `amount` is the item's contribution in the nutrient's own unit
  -- with grams already applied; `basis` records the per-100 g source, so a grams edit recomputes
  -- the snapshot. null = the source did not measure it; 0 = it measured zero (architecture §3.3).
  create or replace function compute_item_snapshot(p_food_ref_id uuid, p_grams numeric)
  returns jsonb language sql stable as $$
    with ref as (select * from food_refs where id = p_food_ref_id),
    rev as (select r.id, v.source, v.version_label from catalog_food_revisions r
              join catalog_versions v on v.id = r.catalog_version_id
              join ref on ref.catalog_food_id = r.catalog_food_id where r.is_active),
    catalog_vals as (select n.nutrient_code as code, n.amount_per_100g as per100, c.unit,
             rev.source, rev.version_label, rev.id as revision_id from rev
        join catalog_food_nutrients n on n.food_revision_id = rev.id
        join catalog_nutrients c on c.code = n.nutrient_code),
    user_vals as (select kv.key as code, nullif(kv.value, 'null'::jsonb)::numeric as per100, c.unit,
             'user'::text as source, uf.rev::text as version_label, null::bigint as revision_id
        from ref join user_foods uf on uf.id = ref.user_food_id
        cross join lateral jsonb_each(uf.per_100g) kv join catalog_nutrients c on c.code = kv.key),
    vals as (select * from catalog_vals union all select * from user_vals)
    select coalesce(jsonb_object_agg(code, jsonb_build_object(
             'amount', case when per100 is null then null else round(per100*p_grams/100.0, 4) end,
             'unit', unit, 'basis', 'per_100g', 'source', source,
             'source_version', version_label, 'revision_id', revision_id)), '{}'::jsonb) from vals;
  $$;
  grant execute on function compute_item_snapshot(uuid, numeric) to authenticated;

  -- Lane A's _sync_upsert (20260911000600_rpc.sql), unchanged except the log_entries branch, which
  -- now mints the snapshot in SQL. Freezing rule: an item keeps its previous snapshot when its id,
  -- grams and food_ref_id are all unchanged and that snapshot is non-empty. A payload carrying
  -- "recompute_snapshots": true forces a recompute — scripts/verify-snapshots.ts --repair.
  create or replace function _sync_upsert(p_user_id uuid, p_entity text, p_key text,
                                          p_payload jsonb, p_rev integer) returns jsonb
    language plpgsql security definer set search_path = public as $$
  declare
    v_prior jsonb := '{}'::jsonb;
    v_force boolean := coalesce((p_payload->>'recompute_snapshots')::boolean, false);
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
        rev = excluded.rev;
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
        slot = excluded.slot, method = excluded.method, rev = excluded.rev;

      -- Phase 2: remember what was there before the wholesale replace, so an untouched item keeps
      -- the snapshot it was logged with.
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
    elsif p_entity = 'water_log' then
      insert into water_log (user_id, local_date, cups, rev)
      values (p_user_id, p_key::date, coalesce((p_payload->>'cups')::integer, 0), p_rev)
      on conflict (user_id, local_date) do update set cups = excluded.cups, rev = excluded.rev;
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
      insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                                 rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                                 shift_minutes, changed_at, rev)
      values (p_user_id, coalesce((p_payload->>'first_opened_at')::timestamptz, now()),
              coalesce((p_payload->>'scale_warning_dismissed')::boolean, false),
              (p_payload->>'training_kcal')::integer, (p_payload->>'rest_kcal')::integer,
              (p_payload->>'protein_g')::numeric,
              coalesce((p_payload->>'protein_locked')::boolean, true),
              (p_payload->>'ramp_override')::smallint,
              coalesce(p_payload->'slot_times', '{}'::jsonb),
              coalesce((p_payload->>'shift_minutes')::integer, 0),
              (p_payload->>'changed_at')::timestamptz, p_rev)
      on conflict (user_id) do update set first_opened_at = excluded.first_opened_at,
        scale_warning_dismissed = excluded.scale_warning_dismissed,
        training_kcal = excluded.training_kcal, rest_kcal = excluded.rest_kcal,
        protein_g = excluded.protein_g, protein_locked = excluded.protein_locked,
        ramp_override = excluded.ramp_override, slot_times = excluded.slot_times,
        shift_minutes = excluded.shift_minutes, changed_at = excluded.changed_at, rev = excluded.rev;
    elsif p_entity = 'gut_log' then
      insert into gut_log (id, user_id, local_date, tz, state, note, rev, deleted_at)
      values (p_key::uuid, p_user_id, (p_payload->>'local_date')::date, p_payload->>'tz',
              p_payload->>'state', p_payload->>'note', p_rev, null)
      on conflict (id) do update set local_date = excluded.local_date, tz = excluded.tz,
        state = excluded.state, note = excluded.note, rev = excluded.rev;
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
        rev = excluded.rev;
    end if;
    return _sync_current(p_user_id, p_entity, p_key);
  end; $$;
  revoke execute on function _sync_upsert(uuid, text, text, jsonb, integer) from public, anon;
  ```

- [ ] Run it — **[needs branch]**, expect PASS. Seeds one fixture catalog food, logs 140 g of it
  through `apply_sync_op`, and asserts the stored snapshot:
  ```bash
  pnpm db:reset
  UID=$(node --experimental-strip-types --input-type=module \
    -e "import {ensureUser} from './tests/helpers/supabase.ts'; console.log((await ensureUser('a')).id)")
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "insert into catalog_nutrients (code, name, unit, derivation) values
          ('protein','Protein','g','measured'), ('iron','Iron','mg','measured')
        on conflict do nothing;" \
    -c "insert into catalog_versions (source, version_label, is_active)
          values ('fdc_sr_legacy','test-1', true) returning id;" \
    -c "insert into catalog_foods (source, source_id) values ('fdc_sr_legacy','t1') returning id;" \
    -c "insert into catalog_food_revisions (description, catalog_food_id, catalog_version_id,
          quality_class, content_hash, is_active)
        select 'Chicken thigh, roasted', f.id, v.id, 'analytical', 'h1', true
          from catalog_foods f, catalog_versions v
         where f.source_id='t1' and v.version_label='test-1' returning id;" \
    -c "insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
        select r.id, x.code, x.amount from catalog_food_revisions r,
          (values ('protein', 23.1::numeric), ('iron', null::numeric)) as x(code, amount)
         where r.content_hash='h1';" \
    -c "select get_or_create_food_ref('$UID'::uuid,'catalog',
          (select id from catalog_foods where source_id='t1'), null);" \
    -c "select apply_sync_op('$UID'::uuid, jsonb_build_object(
          'op_id', gen_random_uuid(), 'entity','log_entries',
          'entity_id','11111111-2222-4333-8444-555555555555','kind','create','base_rev', null,
          'payload', jsonb_build_object('eaten_at', now(), 'tz','America/Los_Angeles',
            'local_date', current_date, 'slot','meal-3','method','search',
            'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'seq', 1,
              'qty', 1, 'unit','g', 'grams', 140,
              'food_ref_id', (select id from food_refs
                 where catalog_food_id = (select id from catalog_foods where source_id='t1'))))),
          'client_ts', now()))->>'status';" \
    -c "select snapshot->'protein'->>'amount', snapshot->'iron'->>'amount' is null,
               snapshot->'protein'->>'unit', snapshot->'protein'->>'source_version'
          from log_items where entry_id = '11111111-2222-4333-8444-555555555555';"
  ```
  Expected: `applied`, then `32.3400|t|g|test-1`.

- [ ] Commit:
  `git add supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql && git commit -m "feat(db): compute log item snapshots in SQL and freeze them across unrelated edits"`

---

## Task 9 — Migration 090200: `daily_totals` and `get_daily_totals`

**Files**
- Create: `supabase/migrations/20260918090200_phase2_daily_totals.sql`
- Test: psql assertions in the steps (`[needs branch]`); the behavioural gate is Task 13.

**Interfaces**
- Consumes: `log_entries`, `log_items`.
- Produces:
  ```sql
  create view daily_totals with (security_invoker = true);   -- user_id, local_date, nutrient_code,
                                                             -- amount, items_with_value, items_total, coverage
  create or replace function get_daily_totals(p_user_id uuid, p_local_date date)
    returns table (nutrient_code text, amount numeric, items_with_value int,
                   items_total int, coverage numeric);
  ```

**Steps**

- [ ] Write the failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At -c "select count(*) from daily_totals;"
  ```
  Expected failure: `ERROR:  relation "daily_totals" does not exist`.

- [ ] Minimal implementation. Create `supabase/migrations/20260918090200_phase2_daily_totals.sql`:
  ```sql
  -- One row per user, local date and nutrient code. Coverage is items carrying a value ÷ all items
  -- that day (architecture §3.3), so a partial day never reads as a complete one.
  create view daily_totals with (security_invoker = true) as
  with item_nutrients as (
    select le.user_id, le.local_date, kv.key as code, (kv.value->>'amount')::numeric as amount
      from log_entries le join log_items li on li.entry_id = le.id
      cross join lateral jsonb_each(li.snapshot) kv where le.deleted_at is null),
  day_items as (
    select le.user_id, le.local_date, count(*)::int as items_total
      from log_entries le join log_items li on li.entry_id = le.id
     where le.deleted_at is null group by 1, 2)
  select n.user_id, n.local_date, n.code as nutrient_code, sum(n.amount) as amount,
         count(n.amount)::int as items_with_value, d.items_total,
         round(count(n.amount)::numeric / nullif(d.items_total, 0), 4) as coverage
    from item_nutrients n
    join day_items d on d.user_id = n.user_id and d.local_date = n.local_date
   group by n.user_id, n.local_date, n.code, d.items_total;
  grant select on daily_totals to authenticated;

  -- Privileged boundary only (§2.2 rule 3): user-scoped, never granted to authenticated. The MCP
  -- boundary has no auth.uid() and binds the tenant with p_user_id.
  create or replace function get_daily_totals(p_user_id uuid, p_local_date date)
  returns table (nutrient_code text, amount numeric, items_with_value int,
                 items_total int, coverage numeric)
  language sql security definer set search_path = public, pg_temp as $$
    select nutrient_code, amount, items_with_value, items_total, coverage
      from daily_totals where user_id = p_user_id and local_date = p_local_date;
  $$;
  revoke execute on function get_daily_totals(uuid, date) from public, authenticated, anon;
  ```

- [ ] Run it — **[needs branch]**, expect PASS (the Task 8 entry is still in the branch):
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select nutrient_code, amount, items_with_value, items_total, coverage
          from daily_totals order by nutrient_code;" \
    -c "select count(*) from information_schema.role_routine_grants
         where routine_name = 'get_daily_totals' and grantee in ('authenticated','anon','PUBLIC');"
  ```
  Expected: `iron|||1|0.0000` and `protein|32.3400|1|1|1.0000`, then `0`.

- [ ] Commit:
  `git add supabase/migrations/20260918090200_phase2_daily_totals.sql && git commit -m "feat(db): add the daily_totals view and its privileged per-user reader"`

---

## Task 10 — Migration 090300: the DRI seed, and 090400: the down migration

**Files**
- Create: `supabase/migrations/20260918090300_phase2_catalog_dri_seed.sql`,
  `supabase/migrations/20260918090400_phase2_down.sql`
- Test: psql assertions in the steps (`[needs branch]`).

**Interfaces**
- Consumes: the Phase 0 `catalog_dri` shell (architecture §3.1).
- Produces: twelve `catalog_dri` rows, `authority = 'NASEM'`, `sex = 'female'`, ages 19–30,
  `life_stage = 'none'`; a unique key so a re-run is a no-op; and a hand-applied down migration.

**Steps**

- [ ] Write the failing test — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from catalog_dri where authority = 'NASEM';"
  ```
  Expected failure: prints `0`.

- [ ] Minimal implementation. Create `supabase/migrations/20260918090300_phase2_catalog_dri_seed.sql`:
  ```sql
  -- Reference values for the tracked micro set, female 19–30, NASEM DRI tables. The unique key
  -- makes `on conflict do nothing` mean something on a branch reset; without it the spec's
  -- conflict clause matches no constraint and a re-run duplicates every row.
  create unique index if not exists catalog_dri_key on catalog_dri
    (nutrient_code, authority, ref_type, sex, age_min, age_max, life_stage);

  insert into catalog_dri (nutrient_code, authority, ref_type, sex, age_min, age_max,
                           life_stage, value, unit, effective_date) values
    ('fiber_total','NASEM','AI','female',19,30,'none',25,'g','2005-01-01'),
    ('iron','NASEM','RDA','female',19,30,'none',18,'mg','2001-01-01'),
    ('calcium','NASEM','RDA','female',19,30,'none',1000,'mg','2011-01-01'),
    ('potassium','NASEM','AI','female',19,30,'none',2600,'mg','2019-01-01'),
    ('magnesium','NASEM','RDA','female',19,30,'none',310,'mg','1997-01-01'),
    ('zinc','NASEM','RDA','female',19,30,'none',8,'mg','2001-01-01'),
    ('vitamin_c','NASEM','RDA','female',19,30,'none',75,'mg','2000-01-01'),
    ('vitamin_d','NASEM','RDA','female',19,30,'none',15,'µg','2011-01-01'),
    ('vitamin_b12','NASEM','RDA','female',19,30,'none',2.4,'µg','1998-01-01'),
    ('folate_dfe','NASEM','RDA','female',19,30,'none',400,'µg','1998-01-01'),
    ('vitamin_a_rae','NASEM','RDA','female',19,30,'none',700,'µg','2001-01-01'),
    ('sodium','NASEM','AI','female',19,30,'none',1500,'mg','2019-01-01')
  on conflict do nothing;

  -- Fiber is seeded for export and for later users, and is NOT shown against the DRI on her screen:
  -- targets.md sets her band at 20–25 g/day, soluble-dominant, below the 25 g AI. The band wins.
  ```
  Create `supabase/migrations/20260918090400_phase2_down.sql`:
  ```sql
  -- Rollback for Phase 2. NOT applied by db:reset or by a deploy — run by hand, after reverting the
  -- app commit, when Today must fall back to Phase 0 behaviour. Logged data is never dropped: the
  -- DRI rows, both indexes and every log_items.snapshot survive.
  drop function if exists get_daily_totals(uuid, date);
  drop view if exists daily_totals;
  drop function if exists compute_item_snapshot(uuid, numeric);
  -- _sync_upsert is deliberately left in place: dropping it would take the sync writer with it.
  -- Re-apply Lane A's 20260911000600_rpc.sql definition to restore the Phase 0 body.
  ```

- [ ] Run it — **[needs branch]**, expect PASS:
  ```bash
  pnpm db:reset
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select count(*) from catalog_dri where authority = 'NASEM';" \
    -c "select value, unit, ref_type from catalog_dri where nutrient_code = 'iron';" \
    -c "select count(*) from catalog_dri where nutrient_code = 'fiber_total';"
  ```
  Expected: `12`, then `18|mg|RDA`, then `1`.

- [ ] Prove `DRI_FEMALE_19_30` (Task 5) and this seed cannot drift apart unnoticed — **[needs branch]**:
  ```bash
  psql "$SUPABASE_TEST_DB_URL" -v ON_ERROR_STOP=1 -At \
    -c "select nutrient_code || '|' || ref_type || '|' || value || '|' || unit
        from catalog_dri where authority = 'NASEM' order by nutrient_code;" \
    > /tmp/catalog_dri_seed.txt
  pnpm exec tsx -e '
    import { DRI_FEMALE_19_30 } from "./lib/nutrients/dri";
    for (const r of [...DRI_FEMALE_19_30].sort((a, b) => a.code.localeCompare(b.code))) {
      console.log(`${r.code}|${r.refType}|${r.value}|${r.unit}`);
    }
  ' > /tmp/catalog_dri_ts.txt
  diff /tmp/catalog_dri_seed.txt /tmp/catalog_dri_ts.txt && echo "AGREE"
  ```
  Expected: no diff output, then `AGREE`. A future edit to either the seed or the TS mirror without
  the other fails this step loudly instead of surfacing as a silent mismatch at Lane I's Task 13.

- [ ] Commit:
  `git add supabase/migrations/20260918090300_phase2_catalog_dri_seed.sql supabase/migrations/20260918090400_phase2_down.sql && git commit -m "feat(db): seed the tracked-micro DRI rows and add the phase 2 down migration"`

---

## Task 11 — `lib/server/log.ts`: `applyLogEntry`, the single writer

**Files**
- Create: `lib/server/log.ts`
- Test: `tests/log/fixtures.ts` (created here, used by Tasks 12–14) plus the `[needs branch]` suites
  in Tasks 12 and 13. `lib/server/log.ts` has no pure branch worth a unit test of its own — every
  behaviour it adds is a database interaction.

**Interfaces**
- Consumes: `SupabaseClient` from `@supabase/supabase-js`; `logCommitRequestSchema`, `issuesFrom`,
  `opIdFor`, and the frozen types from `@/lib/log/contract`; `NUTRIENT_UNITS`, `isNutrientCode`,
  `type NutrientCode` from `@/lib/nutrients/codes`; `microCoverage`, `type NutrientTotal` from
  `@/lib/nutrients/totals`; `type Snapshot` from `@/lib/nutrients/snapshot`. Phase 0 RPC
  `apply_sync_op(p_user_id uuid, p_op jsonb)`.
- Produces:
  ```ts
  export async function applyLogEntry(client: SupabaseClient, userId: string,
    body: unknown): Promise<LogCommitResponse | LogCommitFailure>;
  export async function dayTotals(client: SupabaseClient, userId: string,
    localDate: string): Promise<DayTotals>;
  ```
  `body` is `unknown` on purpose: the route hands over the parsed JSON and this function owns the
  only zod pass, so the commit route and the sync applier cannot validate differently.

**Steps**

- [ ] Write the failing test. Create `tests/log/fixtures.ts`:
  ```ts
  /**
   * Fixture catalog rows for the Phase 2 branch suites. Lane F's import is not a dependency: these
   * rows are inserted with the admin client and are enough to exercise snapshots, totals and
   * export. Nutrient codes and units match lib/nutrients/codes.ts.
   */
  import type { SupabaseClient } from "@supabase/supabase-js";

  export type Fixture = {
    versionId: number; foodId: number; revisionId: number; foodRefId: string;
    per100g: Record<string, number | null>; description: string; versionLabel: string;
    source: string;
  };

  const NUTRIENTS = [
    { code: "energy_kcal", name: "Energy", unit: "kcal", derivation: "measured" },
    { code: "protein", name: "Protein", unit: "g", derivation: "measured" },
    { code: "carbohydrate", name: "Carbohydrate", unit: "g", derivation: "measured" },
    { code: "fat_total", name: "Total fat", unit: "g", derivation: "measured" },
    { code: "fiber_total", name: "Fiber", unit: "g", derivation: "measured" },
    { code: "sugars_total", name: "Sugars", unit: "g", derivation: "measured" },
    { code: "iron", name: "Iron", unit: "mg", derivation: "measured" },
    { code: "calcium", name: "Calcium", unit: "mg", derivation: "measured" },
    { code: "potassium", name: "Potassium", unit: "mg", derivation: "measured" },
    { code: "sodium", name: "Sodium", unit: "mg", derivation: "measured" },
    { code: "vitamin_d", name: "Vitamin D", unit: "µg", derivation: "measured" },
  ];

  export async function seedNutrients(admin: SupabaseClient): Promise<void> {
    const { error } = await admin.from("catalog_nutrients").upsert(NUTRIENTS, { onConflict: "code" });
    if (error) throw error;
  }

  /** One active catalog food with the given per-100 g values, plus its food_refs row. */
  export async function seedCatalogFood(admin: SupabaseClient, userId: string, args: {
    sourceId: string; description: string; brand?: string | null; source?: string;
    versionLabel?: string; per100g: Record<string, number | null>;
    portions?: { description: string; gram_weight: number; is_default: boolean; seq: number }[];
  }): Promise<Fixture> {
    await seedNutrients(admin);
    const source = args.source ?? "fdc_sr_legacy";
    const versionLabel = args.versionLabel ?? "test-1";

    const version = await admin.from("catalog_versions")
      .upsert({ source, version_label: versionLabel, is_active: true },
        { onConflict: "source,version_label" }).select("id").single();
    if (version.error) throw version.error;

    const food = await admin.from("catalog_foods")
      .upsert({ source, source_id: args.sourceId }, { onConflict: "source,source_id" })
      .select("id").single();
    if (food.error) throw food.error;

    const revision = await admin.from("catalog_food_revisions").upsert({
      description: args.description, brand: args.brand ?? null, catalog_food_id: food.data.id,
      catalog_version_id: version.data.id, quality_class: "analytical",
      content_hash: `h-${args.sourceId}`, is_active: true,
    }, { onConflict: "catalog_food_id,catalog_version_id" }).select("id").single();
    if (revision.error) throw revision.error;

    const rows = Object.entries(args.per100g).map(([nutrient_code, amount_per_100g]) => ({
      food_revision_id: revision.data.id, nutrient_code, amount_per_100g }));
    const nutrients = await admin.from("catalog_food_nutrients")
      .upsert(rows, { onConflict: "food_revision_id,nutrient_code" });
    if (nutrients.error) throw nutrients.error;

    if (args.portions?.length) {
      const p = await admin.from("catalog_portions")
        .insert(args.portions.map((x) => ({ ...x, food_revision_id: revision.data.id })));
      if (p.error) throw p.error;
    }

    const ref = await admin.rpc("get_or_create_food_ref", { p_user_id: userId, p_kind: "catalog",
      p_catalog_food_id: food.data.id, p_user_food_id: null });
    if (ref.error) throw ref.error;

    return { versionId: version.data.id, foodId: food.data.id, revisionId: revision.data.id,
      foodRefId: ref.data as string, per100g: args.per100g, description: args.description,
      versionLabel, source };
  }

  /** One of her own foods, so the user_vals branch of compute_item_snapshot is exercised too. */
  export async function seedUserFood(admin: SupabaseClient, userId: string, args: {
    name: string; per100g: Record<string, number | null>;
  }): Promise<Fixture> {
    await seedNutrients(admin);
    const food = await admin.from("user_foods").insert({ user_id: userId, name: args.name,
      kind: "custom", per_100g: args.per100g }).select("id, rev").single();
    if (food.error) throw food.error;
    const ref = await admin.rpc("get_or_create_food_ref", { p_user_id: userId, p_kind: "user",
      p_catalog_food_id: null, p_user_food_id: food.data.id });
    if (ref.error) throw ref.error;
    return { versionId: 0, foodId: 0, revisionId: 0, foodRefId: ref.data as string,
      per100g: args.per100g, description: args.name, versionLabel: String(food.data.rev),
      source: "user" };
  }

  export function uuid(n: number): string {
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  }
  ```
  Then run the type gate, which fails while `lib/server/log.ts` does not exist:
  `node -e "require('node:fs').accessSync('lib/server/log.ts')"`
  Expected failure: `ENOENT: no such file or directory, access 'lib/server/log.ts'`.

- [ ] Minimal implementation. Create `lib/server/log.ts`:
  ```ts
  /**
   * The single writer for log entries. The commit route calls it; the sync applier calls it; both
   * reach log_items through apply_sync_op, so the snapshot rule cannot diverge between the online
   * and the offline path (Phase 2 spec, "API changes").
   *
   * Idempotency costs no table: op_id is a uuid v5 of (entry_id, base_rev), so a replay lands on
   * change_log's op_id unique index, comes back 'duplicate', and this function returns the stored
   * entry. architecture.md §3.7.
   */

  import "server-only";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { issuesFrom, logCommitRequestSchema, opIdFor, type DayTotals, type LogCommitFailure,
    type LogCommitRequest, type LogCommitResponse } from "@/lib/log/contract";
  import { isNutrientCode, NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";
  import type { Snapshot } from "@/lib/nutrients/snapshot";
  import { microCoverage, type NutrientTotal } from "@/lib/nutrients/totals";

  type OpResult = { status: string; rev?: number; current_rev?: number;
    current?: Record<string, unknown>; deleted_at?: string };

  /** Every food_ref the items name must exist and be visible to this caller. */
  async function unknownRefIssues(client: SupabaseClient, req: LogCommitRequest) {
    const ids = [...new Set(req.items.map((i) => i.food_ref_id))];
    const { data, error } = await client.from("food_refs").select("id").in("id", ids);
    if (error) throw error;
    const known = new Set((data ?? []).map((r) => r.id as string));
    return req.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !known.has(item.food_ref_id))
      .map(({ index }) => ({ path: `items.${index}.food_ref_id`, message: "unknown food_ref_id" }));
  }

  /** A draft item pinned to a revision that is no longer active is refused, never silently moved. */
  async function staleRevision(client: SupabaseClient, req: LogCommitRequest) {
    const pinned = req.items.filter((i) => i.food_revision_id != null);
    if (pinned.length === 0) return null;
    const { data, error } = await client.from("catalog_food_revisions")
      .select("id, is_active").in("id", pinned.map((i) => i.food_revision_id as number));
    if (error) throw error;
    const active = new Set((data ?? []).filter((r) => r.is_active).map((r) => r.id as number));
    const bad = pinned.find((i) => !active.has(i.food_revision_id as number));
    return bad
      ? { status: "stale_revision" as const, food_ref_id: bad.food_ref_id,
          revision_id: bad.food_revision_id as number }
      : null;
  }

  function opFor(userId: string, req: LogCommitRequest) {
    return {
      op_id: opIdFor(req.entry_id, req.base_rev),
      entity: "log_entries",
      entity_id: req.entry_id.toLowerCase(),
      kind: req.base_rev === undefined ? "create" : "update",
      base_rev: req.base_rev ?? null,
      client_ts: new Date().toISOString(),
      payload: {
        note: req.note ?? null, media_ref: null, eaten_at: req.eaten_at, tz: req.tz,
        local_date: req.local_date, slot: req.slot, method: req.method,
        items: req.items.map((i) => ({ id: i.id, seq: i.seq, qty: i.qty, unit: i.unit,
          food_ref_id: i.food_ref_id, grams: i.grams, snapshot: null,
          food_revision_id: i.food_revision_id ?? null, portion_id: i.portion_id ?? null,
          was_edited: i.was_edited ?? false, confidence: null })),
      },
    };
  }

  async function storedItems(client: SupabaseClient, entryId: string) {
    const { data, error } = await client.from("log_items")
      .select("id, grams, snapshot").eq("entry_id", entryId).order("seq", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((r) => ({ id: r.id as string, grams: Number(r.grams),
      snapshot: (r.snapshot ?? {}) as Snapshot }));
  }

  export async function dayTotals(
    client: SupabaseClient, userId: string, localDate: string
  ): Promise<DayTotals> {
    const { data, error } = await client.from("daily_totals")
      .select("nutrient_code, amount, items_with_value, items_total, coverage")
      .eq("user_id", userId).eq("local_date", localDate);
    if (error) throw error;
    const totals = new Map<NutrientCode, NutrientTotal>();
    for (const row of data ?? []) {
      const code = row.nutrient_code as string;
      if (!isNutrientCode(code)) continue;
      totals.set(code, { code, amount: Number(row.amount ?? 0), unit: NUTRIENT_UNITS[code],
        itemsWithValue: Number(row.items_with_value ?? 0),
        itemsTotal: Number(row.items_total ?? 0), coverage: Number(row.coverage ?? 0) });
    }
    return { local_date: localDate, nutrients: [...totals.values()],
      micro_coverage_pct: microCoverage(totals).pct };
  }

  async function ok(
    client: SupabaseClient, userId: string, req: LogCommitRequest, rev: number
  ): Promise<LogCommitResponse> {
    return { status: "ok", entry_id: req.entry_id, rev,
      items: await storedItems(client, req.entry_id),
      totals: await dayTotals(client, userId, req.local_date) };
  }

  export async function applyLogEntry(
    client: SupabaseClient, userId: string, body: unknown
  ): Promise<LogCommitResponse | LogCommitFailure> {
    const parsed = logCommitRequestSchema.safeParse(body);
    if (!parsed.success) return { status: "invalid", issues: issuesFrom(parsed.error) };
    const req = parsed.data;

    const issues = await unknownRefIssues(client, req);
    if (issues.length > 0) return { status: "invalid", issues };

    const stale = await staleRevision(client, req);
    if (stale) return stale;

    const { data, error } = await client.rpc("apply_sync_op",
      { p_user_id: userId, p_op: opFor(userId, req) });
    if (error) throw error;
    const result = data as OpResult;

    if (result.status === "applied") return ok(client, userId, req, result.rev as number);
    if (result.status === "duplicate") {
      const { data: row, error: readError } = await client.from("log_entries")
        .select("rev").eq("id", req.entry_id).maybeSingle();
      if (readError) throw readError;
      if (!row) return { status: "gone" };
      return ok(client, userId, req, Number(row.rev));
    }
    if (result.status === "conflict") {
      return { status: "conflict", current_rev: result.current_rev as number,
        entity: (result.current ?? {}) as Record<string, unknown> };
    }
    if (result.status === "deleted") {
      return { status: "deleted", deleted_at: result.deleted_at as string };
    }
    if (result.status === "gone") return { status: "gone" };
    return { status: "invalid",
      issues: [{ path: "entry_id", message: `sync refused the op: ${result.status}` }] };
  }
  ```

  **`save_label_as_food` is validated here and written in Phase 4.** The schema accepts it only with
  `method: "label"`, which also requires a `draft_id`; Phase 2 has no caller that sends either
  (spec, Scope). `LogCommitResponse.user_food_id` is therefore never set by this lane, and Phase 4
  adds the `user_foods` write inside this same function rather than a second writer.

- [ ] Run it: `pnpm exec tsc --noEmit && pnpm lint` → expected **PASS** (no errors).

- [ ] Commit:
  `git add lib/server/log.ts tests/log/fixtures.ts && git commit -m "feat(log): add applyLogEntry, the single writer behind the commit route and the sync applier"`

---

## Task 12 — `POST /api/log/commit`

**Files**
- Create: `app/api/log/commit/route.ts`
- Test: `tests/log/commit.test.ts`

**Interfaces**
- Consumes: `enforceRateLimit` from `@/lib/server/ratelimit`; `requireUser`, `HttpError` from
  `@/lib/server/auth`; `jsonError`, `readJson` from `@/lib/server/http`; `applyLogEntry` from
  `@/lib/server/log`; `createTestUsers`, `HAS_BRANCH` from `tests/helpers/supabase`;
  `seedCatalogFood`, `uuid` from `tests/log/fixtures`.
- Produces: `export async function POST(req: Request): Promise<Response>`;
  `export const runtime = "nodejs"`; `export const dynamic = "force-dynamic"`.
  Status map: `ok` → 200; `conflict` and `deleted` and `stale_revision` → 409; `gone` → 410;
  `invalid` → 422; plus 401, 413 and 429 from the Phase 0 helpers.

**Steps**

- [ ] Write the failing test. Create `tests/log/commit.test.ts`:
  ```ts
  /**
   * Phase 2 acceptance 8 and the 4xx half of the spec's error table, at the HTTP layer.
   * [needs branch] — skipped when SUPABASE_TEST_URL is unset.
   */
  import { beforeAll, describe, expect, it } from "vitest";
  import { POST } from "../../app/api/log/commit/route";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import { seedCatalogFood, uuid, type Fixture } from "./fixtures";

  const run = HAS_BRANCH ? describe : describe.skip;

  function post(body: unknown, token?: string): Request {
    return new Request("https://app.test/api/log/commit", { method: "POST",
      headers: { "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body) });
  }

  run("POST /api/log/commit", () => {
    let token = "";
    let userId = "";
    let chicken: Fixture;

    beforeAll(async () => {
      const { a, admin } = await createTestUsers();
      userId = a.userId;
      chicken = await seedCatalogFood(admin, a.userId, { sourceId: "commit-1",
        description: "Chicken thigh, roasted",
        per100g: { energy_kcal: 179, protein: 23.1, fat_total: 9.3, carbohydrate: 0,
          fiber_total: 0, iron: null } });
      const session = await a.client.auth.getSession();
      token = session.data.session!.access_token;
    });

    function body(over: Record<string, unknown> = {}, entry = uuid(11)) {
      return { entry_id: entry, eaten_at: "2026-09-18T02:30:00.000Z",
        tz: "America/Los_Angeles", local_date: "2026-09-17", slot: "meal-3", method: "search",
        items: [{ id: uuid(21), seq: 1, food_ref_id: chicken.foodRefId, qty: 1, unit: "g",
          grams: 140 }], ...over };
    }

    it("401s with no session", async () => {
      expect((await POST(post(body()))).status).toBe(401);
    });

    it("creates the entry, stores the server snapshot and returns the day's totals", async () => {
      const res = await POST(post(body(), uuid(101)), token);
      expect(res.status).toBe(200);
      const out = await res.json();
      expect(out).toMatchObject({ status: "ok", entry_id: uuid(101), rev: 1 });
      expect(out.items[0].snapshot.protein.amount).toBe(32.34);
      expect(out.items[0].snapshot.iron.amount).toBeNull();
      expect(out.totals.local_date).toBe("2026-09-17");
      expect(out.totals.nutrients.find((n: { code: string }) => n.code === "protein"))
        .toMatchObject({ amount: 32.34, itemsWithValue: 1, itemsTotal: 1, coverage: 1 });
      expect(out.totals.micro_coverage_pct).toBe(8);
    });

    it("returns the first result on a replay and creates no second entry", async () => {
      const first = await (await POST(post(body(), uuid(102)), token)).json();
      const second = await (await POST(post(body(), uuid(102)), token)).json();
      expect(second).toMatchObject({ status: "ok", rev: first.rev, entry_id: uuid(102) });
      expect(second.items).toHaveLength(1);
      expect(second.totals.nutrients.find((n: { code: string }) => n.code === "protein").amount)
        .toBe(first.totals.nutrients.find((n: { code: string }) => n.code === "protein").amount);
    });

    it("409s a stale base_rev with the full current entity and writes nothing", async () => {
      await POST(post(body(), uuid(103)), token);
      const res = await POST(post({ base_rev: 7, note: "should not land" }, uuid(103)), token);
      expect(res.status).toBe(409);
      const out = await res.json();
      expect(out.status).toBe("conflict");
      expect(out.current_rev).toBe(1);
      expect(out.entity.id).toBe(uuid(103));
      expect(out.entity.note).toBeNull();
      expect(out.entity.items).toHaveLength(1);
    });

    it("410s an update to an entry that was never created", async () => {
      const res = await POST(post({ base_rev: 1 }, uuid(104)), token);
      expect(res.status).toBe(410);
      await expect(res.json()).resolves.toMatchObject({ status: "gone" });
    });

    it("409s an item pinned to a revision that is no longer active", async () => {
      const res = await POST(post({ items: [{ id: uuid(22), seq: 1,
        food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: 140,
        food_revision_id: 999_999 }] }, uuid(105)), token);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ status: "stale_revision",
        food_ref_id: chicken.foodRefId, revision_id: 999_999 });
    });

    it("422s negative grams, a duplicate seq and a local_date that disagrees with tz", async () => {
      const negative = await POST(post({ items: [{ id: uuid(23), seq: 1,
        food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: -5 }] }, uuid(106)), token);
      expect(negative.status).toBe(422);
      expect((await negative.json()).issues[0].path).toBe("items.0.grams");

      const wrongDay = await POST(post({ local_date: "2026-09-18" }, uuid(107)), token);
      expect(wrongDay.status).toBe(422);
      expect((await wrongDay.json()).issues).toContainEqual({ path: "local_date",
        message: "local_date does not match eaten_at in tz" });
    });

    it("422s an unknown food_ref_id", async () => {
      const res = await POST(post({ items: [{ id: uuid(24), seq: 1, food_ref_id: uuid(999),
        qty: 1, unit: "g", grams: 100 }] }, uuid(108)), token);
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({ status: "invalid",
        issues: [{ path: "items.0.food_ref_id", message: "unknown food_ref_id" }] });
    });

    it("413s a body over 64 KB", async () => {
      const res = await POST(post({ note: "x".repeat(70_000) }, uuid(109)), token);
      expect(res.status).toBe(413);
    });
  });
  ```

- [ ] Run it: `pnpm test tests/log/commit.test.ts`
  Expected failure without the route: `Failed to load url ../../app/api/log/commit/route`.

- [ ] Minimal implementation. Create `app/api/log/commit/route.ts`:
  ```ts
  /**
   * POST /api/log/commit — JWT, 64 KB, 60/min/user, idempotent on entry_id.
   *
   * The route decides nothing about logging: it enforces the §5 matrix row, hands the parsed body
   * to applyLogEntry, and maps that result onto a status code. Contracts §8 order: rate limit,
   * then identity, then body.
   */

  import { z } from "zod";
  import { applyLogEntry } from "@/lib/server/log";
  import { requireUser } from "@/lib/server/auth";
  import { jsonError, readJson } from "@/lib/server/http";
  import { enforceRateLimit } from "@/lib/server/ratelimit";

  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";

  const MAX_BYTES = 64 * 1024;

  /** Shape is applyLogEntry's business; readJson only guards the size and the JSON-ness. */
  const envelope = z.record(z.string(), z.unknown());

  const STATUS: Record<string, number> = { ok: 200, conflict: 409, deleted: 409,
    stale_revision: 409, gone: 410, invalid: 422 };

  export async function POST(req: Request): Promise<Response> {
    try {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      await enforceRateLimit(`log:commit:ip:${ip}`, 60, 60);
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`log:commit:user:${userId}`, 60, 60);

      const body = await readJson(req, envelope, MAX_BYTES);
      const result = await applyLogEntry(client, userId, body);
      return Response.json(result, { status: STATUS[result.status] ?? 500 });
    } catch (e) {
      return jsonError(e);
    }
  }
  ```

- [ ] Run it: `pnpm test tests/log/commit.test.ts`
  Expected without a branch: `9 skipped`, 0 failed. **[needs branch]** with `SUPABASE_TEST_URL`,
  `SUPABASE_TEST_ANON_KEY` and `SUPABASE_TEST_SERVICE_ROLE_KEY` set: `Tests  9 passed (9)`.

- [ ] Commit:
  `git add app/api/log/commit/route.ts tests/log/commit.test.ts && git commit -m "feat(log): add the idempotent commit route over applyLogEntry"`

---

## Task 13 — Branch suites: snapshot parity, daily totals, cross-user denial

**Files**
- Create: `tests/log/snapshot-parity.test.ts`, `tests/log/daily-totals.test.ts`,
  `tests/log/cross-user.test.ts`
- Test: these three files are the test.

**Interfaces**
- Consumes: `createTestUsers`, `HAS_BRANCH` from `tests/helpers/supabase`; `seedCatalogFood`,
  `seedUserFood`, `uuid` from `tests/log/fixtures`; `computeSnapshot`, `snapshotsEqual` from
  `@/lib/nutrients/snapshot`; `applyLogEntry`, `dayTotals` from `@/lib/server/log`; `POST` from
  `app/api/log/commit/route`.
- Produces: no exports. Covers spec acceptance 1–4, 8 and 11.

**Steps**

- [ ] Write the failing tests. Create `tests/log/snapshot-parity.test.ts`:
  ```ts
  /**
   * Acceptance 1 and 2: the stored snapshot equals compute_item_snapshot, and the TypeScript mirror
   * agrees with it to 4 dp for catalog rows and for one of her own foods. [needs branch]
   */
  import { beforeAll, describe, expect, it } from "vitest";
  import { computeSnapshot, snapshotsEqual, type Snapshot } from "@/lib/nutrients/snapshot";
  import type { NutrientCode } from "@/lib/nutrients/codes";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import { seedCatalogFood, seedUserFood, type Fixture } from "./fixtures";

  const run = HAS_BRANCH ? describe : describe.skip;

  const SHAPES: { sourceId: string; description: string;
    per100g: Record<string, number | null> }[] = Array.from({ length: 20 }, (_, i) => ({
      sourceId: `parity-${i}`,
      description: `Parity fixture ${i}`,
      per100g: { energy_kcal: 50 + i * 7.3, protein: 1.1 + i * 0.37,
        carbohydrate: i % 3 === 0 ? 0 : 4.55 + i, fat_total: 0.25 * i,
        fiber_total: i % 4 === 0 ? null : 1.2 + i * 0.11,
        iron: i % 5 === 0 ? null : 0.33 + i * 0.017, sodium: i * 13 },
    }));

  run("server snapshot equals the client snapshot", () => {
    let admin: Awaited<ReturnType<typeof createTestUsers>>["admin"];
    let userId = "";
    const fixtures: Fixture[] = [];

    beforeAll(async () => {
      const users = await createTestUsers();
      admin = users.admin;
      userId = users.a.userId;
      for (const shape of SHAPES) fixtures.push(await seedCatalogFood(admin, userId, shape));
      fixtures.push(await seedUserFood(admin, userId, { name: "Her bone broth",
        per100g: { energy_kcal: 12, protein: 2.4, sodium: 330, iron: null } }));
      fixtures.push(await seedUserFood(admin, userId, { name: "Her rice porridge",
        per100g: { energy_kcal: 71.5, protein: 1.35, carbohydrate: 15.9 } }));
      fixtures.push(await seedUserFood(admin, userId, { name: "Her collagen scoop",
        per100g: { protein: 90, energy_kcal: 360, calcium: 0 } }));
    });

    it("agrees for every fixture at three gram weights", async () => {
      for (const fixture of fixtures) {
        for (const grams of [37, 140, 212.5]) {
          const { data, error } = await admin.rpc("compute_item_snapshot",
            { p_food_ref_id: fixture.foodRefId, p_grams: grams });
          expect(error).toBeNull();
          const server = data as Snapshot;
          const client = computeSnapshot(
            fixture.per100g as Record<NutrientCode, number | null>, grams,
            { source: fixture.source, source_version: fixture.versionLabel,
              revision_id: fixture.revisionId || null });
          expect(snapshotsEqual(server, client, 1e-4),
            `${fixture.description} @ ${grams} g`).toBe(true);
        }
      }
    });

    it("carries the source and source version the export must report", async () => {
      const fixture = fixtures[0];
      const { data } = await admin.rpc("compute_item_snapshot",
        { p_food_ref_id: fixture.foodRefId, p_grams: 100 });
      expect((data as Snapshot).protein).toMatchObject({ basis: "per_100g",
        source: fixture.source, source_version: fixture.versionLabel,
        revision_id: fixture.revisionId });
    });
  });
  ```
  Create `tests/log/daily-totals.test.ts`:
  ```ts
  /** Acceptance 3 and 4: a grams edit moves the day by exactly the difference, and an unmeasured
   *  value lowers coverage without lowering the total. [needs branch] */
  import { beforeAll, describe, expect, it } from "vitest";
  import { applyLogEntry, dayTotals } from "@/lib/server/log";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import { seedCatalogFood, uuid, type Fixture } from "./fixtures";
  import type { SupabaseClient } from "@supabase/supabase-js";

  const run = HAS_BRANCH ? describe : describe.skip;
  const DATE = "2026-09-19";

  run("daily_totals", () => {
    let client: SupabaseClient;
    let userId = "";
    let chicken: Fixture;
    let spice: Fixture;

    beforeAll(async () => {
      const { a, admin } = await createTestUsers();
      client = a.client;
      userId = a.userId;
      chicken = await seedCatalogFood(admin, userId, { sourceId: "totals-1",
        description: "Chicken thigh, roasted",
        per100g: { energy_kcal: 179, protein: 23.1, iron: 1.1, fiber_total: 0 } });
      spice = await seedCatalogFood(admin, userId, { sourceId: "totals-2",
        description: "Cumin, ground", per100g: { energy_kcal: 375, protein: 17.8, iron: null } });
    });

    function entry(entryId: string, items: Record<string, unknown>[], baseRev?: number) {
      return { entry_id: entryId, base_rev: baseRev, eaten_at: `${DATE}T19:00:00.000Z`,
        tz: "UTC", local_date: DATE, slot: "meal-2", method: "search", items };
    }

    it("sums the day, and an unmeasured iron lowers coverage but not the total", async () => {
      await applyLogEntry(client, userId, entry(uuid(201), [{ id: uuid(211), seq: 1,
        food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: 100 }]));
      await applyLogEntry(client, userId, entry(uuid(202), [{ id: uuid(212), seq: 1,
        food_ref_id: spice.foodRefId, qty: 1, unit: "g", grams: 5 }]));

      const totals = await dayTotals(client, userId, DATE);
      const iron = totals.nutrients.find((n) => n.code === "iron")!;
      expect(iron).toMatchObject({ amount: 1.1, itemsWithValue: 1, itemsTotal: 2, coverage: 0.5 });
      const protein = totals.nutrients.find((n) => n.code === "protein")!;
      expect(protein.amount).toBe(23.99);
      expect(totals.nutrients.find((n) => n.code === "fiber_total"))
        .toMatchObject({ amount: 0, itemsWithValue: 1, coverage: 0.5 });
    });

    it("moves the day by exactly the difference when grams are edited", async () => {
      const before = await dayTotals(client, userId, DATE);
      const beforeProtein = before.nutrients.find((n) => n.code === "protein")!.amount;

      const edited = await applyLogEntry(client, userId, entry(uuid(201), [{ id: uuid(211), seq: 1,
        food_ref_id: chicken.foodRefId, qty: 1, unit: "g", grams: 200, was_edited: true }], 1));
      expect(edited.status).toBe("ok");

      const after = await dayTotals(client, userId, DATE);
      const afterProtein = after.nutrients.find((n) => n.code === "protein")!.amount;
      expect(Math.round((afterProtein - beforeProtein) * 100) / 100).toBe(23.1);
    });

    it("leaves an untouched item's snapshot frozen when only the note changes", async () => {
      const before = await dayTotals(client, userId, DATE);
      const noteOnly = await applyLogEntry(client, userId, {
        ...entry(uuid(202), [{ id: uuid(212), seq: 1, food_ref_id: spice.foodRefId, qty: 1,
          unit: "g", grams: 5 }], 1), note: "a pinch" });
      expect(noteOnly.status).toBe("ok");
      const after = await dayTotals(client, userId, DATE);
      expect(after.nutrients.find((n) => n.code === "protein")!.amount)
        .toBe(before.nutrients.find((n) => n.code === "protein")!.amount);
    });

    it("drops a tombstoned entry out of the day", async () => {
      const { error } = await client.rpc("apply_sync_op", { p_user_id: userId, p_op: {
        op_id: uuid(301), entity: "log_entries", entity_id: uuid(202), kind: "delete",
        base_rev: 2, payload: {}, client_ts: new Date().toISOString() } });
      expect(error).toBeNull();
      const after = await dayTotals(client, userId, DATE);
      expect(after.nutrients.find((n) => n.code === "iron")!.itemsTotal).toBe(1);
    });
  });
  ```
  Create `tests/log/cross-user.test.ts`:
  ```ts
  /** Acceptance 11: a second user reading the view, the privileged RPC, the route or a log_items
   *  row whose parent belongs to user A gets zero rows or a 4xx. [needs branch] */
  import { beforeAll, describe, expect, it } from "vitest";
  import { POST } from "../../app/api/log/commit/route";
  import { applyLogEntry } from "@/lib/server/log";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import { seedCatalogFood, uuid, type Fixture } from "./fixtures";
  import type { SupabaseClient } from "@supabase/supabase-js";

  const run = HAS_BRANCH ? describe : describe.skip;
  const DATE = "2026-09-20";

  run("cross-user denial on the Phase 2 surfaces", () => {
    let bClient: SupabaseClient;
    let bToken = "";
    let aUserId = "";
    let chicken: Fixture;

    beforeAll(async () => {
      const { a, b, admin } = await createTestUsers();
      aUserId = a.userId;
      bClient = b.client;
      chicken = await seedCatalogFood(admin, a.userId, { sourceId: "xuser-1",
        description: "Chicken thigh, roasted", per100g: { protein: 23.1, energy_kcal: 179 } });
      await applyLogEntry(a.client, a.userId, { entry_id: uuid(401),
        eaten_at: `${DATE}T19:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
        method: "search", items: [{ id: uuid(411), seq: 1, food_ref_id: chicken.foodRefId,
          qty: 1, unit: "g", grams: 140 }] });
      bToken = (await b.client.auth.getSession()).data.session!.access_token;
    });

    it("gives user B zero rows from daily_totals", async () => {
      const { data, error } = await bClient.from("daily_totals").select("*").eq("local_date", DATE);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("refuses user B the privileged get_daily_totals", async () => {
      const { error } = await bClient.rpc("get_daily_totals",
        { p_user_id: aUserId, p_local_date: DATE });
      expect(error).not.toBeNull();
    });

    it("gives user B zero log_items for user A's entry", async () => {
      const { data } = await bClient.from("log_items").select("id").eq("entry_id", uuid(401));
      expect(data).toEqual([]);
    });

    it("does not let user B write against user A's entry_id", async () => {
      const res = await POST(new Request("https://app.test/api/log/commit", { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bToken}` },
        body: JSON.stringify({ entry_id: uuid(401), base_rev: 1,
          eaten_at: `${DATE}T19:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
          method: "search", items: [{ id: uuid(411), seq: 1, food_ref_id: chicken.foodRefId,
            qty: 1, unit: "g", grams: 999 }] }) }));
      expect(res.status).toBe(410);
      const stillHers = await bClient.from("log_items").select("grams").eq("entry_id", uuid(401));
      expect(stillHers.data).toEqual([]);
    });
  });
  ```

- [ ] Run them: `pnpm test tests/log/`
  Expected without a branch: `all skipped`, 0 failed. **[needs branch]**: `Tests  18 passed (18)`
  across the four files.

- [ ] Commit:
  `git add tests/log/snapshot-parity.test.ts tests/log/daily-totals.test.ts tests/log/cross-user.test.ts && git commit -m "test(log): prove snapshot parity, totals arithmetic and cross-user denial on a branch"`

---

## Task 14 — `csvDocument`, `ODBL_NOTICE`, and `lib/server/export.ts`

**Files**
- Modify: `lib/export/csv.ts`, `lib/export/csv.test.ts`
- Create: `lib/server/export.ts`, `tests/export/cursor.test.ts`

**Interfaces**
- Consumes: `escapeCell`, `toCsv` (Phase 0, unchanged); `NUTRIENT_UNITS`, `isNutrientCode` from
  `@/lib/nutrients/codes`; `snapshotValue`, `type Snapshot` from `@/lib/nutrients/snapshot`;
  `totalsFor` is not used here — the progress rows come from `daily_totals`; `microCoverage` from
  `@/lib/nutrients/totals`; `dayTypeFor`, `rampStageFor` from `@/lib/plan`; `resolveTargets` from
  `@/lib/targets`; `HttpError` from `@/lib/server/auth`; `type DayType` from `@/lib/types`.
- Produces:
  ```ts
  // lib/export/csv.ts (added)
  export const ODBL_NOTICE = "Data from Open Food Facts, licensed under the Open Database License (ODbL).";
  export function csvDocument(header: string[], rows: readonly (string | number | null)[][],
    notices?: readonly string[]): string;
  // lib/server/export.ts
  export type Nutr = { energy_kcal: number | null; protein_g: number | null;
    carbohydrate_g: number | null; fat_g: number | null; fiber_g: number | null };
  export type MealExportRow = Nutr & { local_date: string; eaten_at: string; tz: string;
    slot: string; entry_id: string; item_seq: number; food_name: string; brand: string | null;
    source: string; source_version: string; food_revision_id: number | null;
    qty: number; unit: string; grams: number; note: string | null };
  export type ProgressExportRow = Nutr & { local_date: string; day_type: DayType;
    kcal_target: number; micro_coverage_pct: number; items_logged: number };
  export type ExportJson<T> = { rows: T[]; next_cursor: string | null; notices: string[] };
  export type ExportCursor = { local_date: string; eaten_at: string; id: string };
  export type ExportOpts = { from?: string; to?: string; limit: number; cursor?: string };
  export const MEAL_COLUMNS: string[];
  export const PROGRESS_COLUMNS: string[];
  export function encodeCursor(cursor: ExportCursor): string;
  export function decodeCursor(raw: string): ExportCursor;
  export function mealRowValues(row: MealExportRow): (string | number | null)[];
  export function progressRowValues(row: ProgressExportRow): (string | number | null)[];
  export async function streamMeals(client: SupabaseClient, userId: string,
    opts: ExportOpts): Promise<ExportJson<MealExportRow>>;
  export async function streamProgress(client: SupabaseClient, userId: string,
    opts: ExportOpts): Promise<ExportJson<ProgressExportRow>>;
  ```

**Steps**

- [ ] Write the failing tests. Append to `lib/export/csv.test.ts` (keep every Phase 0 case):
  ```ts
  import { csvDocument, ODBL_NOTICE } from "./csv";

  describe("csvDocument", () => {
    it("writes the header then one line per row, CRLF, in column order", () => {
      expect(csvDocument(["a", "b"], [[1, "x"], [2, null]]))
        .toBe("a,b\r\n1,x\r\n2,\r\n");
    });

    it("prefixes a leading formula character in a row cell", () => {
      expect(csvDocument(["food_name"], [["=SUM(A1)"]]))
        .toBe("food_name\r\n'=SUM(A1)\r\n");
    });

    it("appends each notice as a trailing comment line", () => {
      expect(csvDocument(["a"], [["x"]], [ODBL_NOTICE]))
        .toBe(`a\r\nx\r\n# ${ODBL_NOTICE}\r\n`);
    });

    it("emits a header-only document for no rows", () => {
      expect(csvDocument(["a", "b"], [])).toBe("a,b\r\n");
    });
  });
  ```
  Create `tests/export/cursor.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { decodeCursor, encodeCursor } from "@/lib/server/export";

  describe("export cursor", () => {
    it("round-trips the keyset triple", () => {
      const cursor = { local_date: "2026-09-17", eaten_at: "2026-09-18T02:30:00.000Z",
        id: "00000000-0000-4000-8000-000000000011" };
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it("is url-safe", () => {
      const encoded = encodeCursor({ local_date: "2026-09-17",
        eaten_at: "2026-09-18T02:30:00.000Z", id: "00000000-0000-4000-8000-000000000011" });
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("throws a 422 on a malformed cursor", () => {
      expect(() => decodeCursor("not-base64-json")).toThrow(/cursor/);
      expect(() => decodeCursor(Buffer.from('{"local_date":1}').toString("base64url")))
        .toThrow(/cursor/);
    });
  });
  ```

- [ ] Run them: `pnpm test lib/export/csv.test.ts tests/export/cursor.test.ts`
  Expected failure: `"csvDocument" is not exported by "lib/export/csv.ts"`, then
  `Failed to load url @/lib/server/export`.

- [ ] Minimal implementation. Append to `lib/export/csv.ts` (Phase 0's `escapeCell` and `toCsv`
  stay exactly as they are):
  ```ts
  /**
   * OFF data is ODbL (architecture §3.1): any export of an OFF-derived row carries the notice, in
   * the JSON `notices` array and as a trailing CSV comment line.
   */
  export const ODBL_NOTICE =
    "Data from Open Food Facts, licensed under the Open Database License (ODbL).";

  /**
   * Positional sibling of `toCsv`: the streaming export already has its rows as arrays in column
   * order, so it never builds a keyed object per row just to serialise it.
   */
  export function csvDocument(
    header: string[],
    rows: readonly (string | number | null)[][],
    notices: readonly string[] = []
  ): string {
    const lines = [header.map(escapeCell).join(",")];
    for (const row of rows) lines.push(row.map(escapeCell).join(","));
    for (const notice of notices) lines.push(`# ${notice}`);
    return `${lines.join("\r\n")}\r\n`;
  }
  ```
  Create `lib/server/export.ts`:
  ```ts
  /**
   * Streaming, user-scoped export for kind=meals and kind=progress (Phase 2 spec, "API changes";
   * architecture §4.6). RLS does the tenancy work on a session client; the user_id filter is kept
   * anyway so the same function is safe under an admin client.
   *
   * Paging is keyset over (local_date, eaten_at, id), not offset, so a 12,000-row log exports with
   * no gap and no duplicate while she keeps logging.
   */

  import "server-only";
  import type { SupabaseClient } from "@supabase/supabase-js";
  import { HttpError } from "@/lib/server/auth";
  import { ODBL_NOTICE } from "@/lib/export/csv";
  import { isNutrientCode, NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";
  import { snapshotValue, type Snapshot } from "@/lib/nutrients/snapshot";
  import { microCoverage, type NutrientTotal } from "@/lib/nutrients/totals";
  import { dayTypeFor, rampStageFor } from "@/lib/plan";
  import { resolveTargets } from "@/lib/targets";
  import type { DayType, RampStage, Settings } from "@/lib/types";

  export type Nutr = { energy_kcal: number | null; protein_g: number | null;
    carbohydrate_g: number | null; fat_g: number | null; fiber_g: number | null };

  export type MealExportRow = Nutr & { local_date: string; eaten_at: string; tz: string;
    slot: string; entry_id: string; item_seq: number; food_name: string; brand: string | null;
    source: string; source_version: string; food_revision_id: number | null;
    qty: number; unit: string; grams: number; note: string | null };

  export type ProgressExportRow = Nutr & { local_date: string; day_type: DayType;
    kcal_target: number; micro_coverage_pct: number; items_logged: number };

  export type ExportJson<T> = { rows: T[]; next_cursor: string | null; notices: string[] };
  export type ExportCursor = { local_date: string; eaten_at: string; id: string };
  export type ExportOpts = { from?: string; to?: string; limit: number; cursor?: string };

  export const MEAL_COLUMNS = ["local_date", "eaten_at", "tz", "slot", "entry_id", "item_seq",
    "food_name", "brand", "source", "source_version", "food_revision_id", "qty", "unit", "grams",
    "energy_kcal", "protein_g", "carbohydrate_g", "fat_g", "fiber_g", "note"];

  export const PROGRESS_COLUMNS = ["local_date", "day_type", "kcal_target", "energy_kcal",
    "protein_g", "carbohydrate_g", "fat_g", "fiber_g", "micro_coverage_pct", "items_logged"];

  export function encodeCursor(cursor: ExportCursor): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  export function decodeCursor(raw: string): ExportCursor {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
      throw new HttpError(422, "bad_request", "malformed cursor");
    }
    const c = parsed as Partial<ExportCursor>;
    if (typeof c?.local_date !== "string" || typeof c?.eaten_at !== "string"
      || typeof c?.id !== "string") {
      throw new HttpError(422, "bad_request", "malformed cursor");
    }
    return { local_date: c.local_date, eaten_at: c.eaten_at, id: c.id };
  }

  export function mealRowValues(row: MealExportRow): (string | number | null)[] {
    return MEAL_COLUMNS.map((c) => (row as unknown as Record<string, string | number | null>)[c]);
  }

  export function progressRowValues(row: ProgressExportRow): (string | number | null)[] {
    return PROGRESS_COLUMNS.map((c) =>
      (row as unknown as Record<string, string | number | null>)[c]);
  }

  function amount(snapshot: Snapshot, code: NutrientCode): number | null {
    return snapshotValue(snapshot, code)?.amount ?? null;
  }

  function provenance(snapshot: Snapshot): { source: string; source_version: string } {
    for (const key of Object.keys(snapshot)) {
      if (!isNutrientCode(key)) continue;
      const value = snapshotValue(snapshot, key);
      if (value) return { source: value.source, source_version: value.source_version };
    }
    return { source: "", source_version: "" };
  }
  ```
  Append the two readers to `lib/server/export.ts`:
  ```ts
  type EntryRow = { id: string; local_date: string; eaten_at: string; tz: string; slot: string;
    note: string | null; log_items: { seq: number; qty: number; unit: string; grams: number;
      food_ref_id: string; food_revision_id: number | null; snapshot: Snapshot }[] };

  function applyWindow<T>(q: T, opts: ExportOpts): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = q as any;
    if (opts.from) query = query.gte("local_date", opts.from);
    if (opts.to) query = query.lte("local_date", opts.to);
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      query = query.or([`local_date.gt.${c.local_date}`,
        `and(local_date.eq.${c.local_date},eaten_at.gt.${c.eaten_at})`,
        `and(local_date.eq.${c.local_date},eaten_at.eq.${c.eaten_at},id.gt.${c.id})`].join(","));
    }
    return query as T;
  }

  /** food_ref_id → display name and brand, for the page's refs only. */
  async function namesFor(client: SupabaseClient, refIds: string[]) {
    const names = new Map<string, { food_name: string; brand: string | null }>();
    if (refIds.length === 0) return names;
    const refs = await client.from("food_refs")
      .select("id, catalog_food_id, user_food_id, user_foods(name, brand)").in("id", refIds);
    if (refs.error) throw refs.error;

    const catalogIds = (refs.data ?? []).map((r) => r.catalog_food_id as number | null)
      .filter((v): v is number => v != null);
    const byCatalogId = new Map<number, { description: string; brand: string | null }>();
    if (catalogIds.length > 0) {
      const revs = await client.from("catalog_food_revisions")
        .select("catalog_food_id, description, brand").in("catalog_food_id", catalogIds)
        .eq("is_active", true);
      if (revs.error) throw revs.error;
      for (const r of revs.data ?? []) {
        byCatalogId.set(r.catalog_food_id as number,
          { description: r.description as string, brand: (r.brand as string | null) ?? null });
      }
    }
    for (const ref of refs.data ?? []) {
      const own = (ref as { user_foods?: { name: string; brand: string | null } | null }).user_foods;
      const cat = ref.catalog_food_id == null
        ? undefined : byCatalogId.get(ref.catalog_food_id as number);
      names.set(ref.id as string, {
        food_name: own?.name ?? cat?.description ?? "(unknown food)",
        brand: own?.brand ?? cat?.brand ?? null });
    }
    return names;
  }

  export async function streamMeals(
    client: SupabaseClient, userId: string, opts: ExportOpts
  ): Promise<ExportJson<MealExportRow>> {
    const base = client.from("log_entries")
      .select("id, local_date, eaten_at, tz, slot, note, " +
        "log_items(seq, qty, unit, grams, food_ref_id, food_revision_id, snapshot)")
      .eq("user_id", userId).is("deleted_at", null);
    const { data, error } = await applyWindow(base, opts)
      .order("local_date", { ascending: true }).order("eaten_at", { ascending: true })
      .order("id", { ascending: true }).limit(opts.limit + 1);
    if (error) throw error;

    const entries = (data ?? []) as unknown as EntryRow[];
    const hasMore = entries.length > opts.limit;
    const page = hasMore ? entries.slice(0, opts.limit) : entries;
    const names = await namesFor(client,
      [...new Set(page.flatMap((e) => e.log_items.map((i) => i.food_ref_id)))]);

    const rows: MealExportRow[] = [];
    const notices = new Set<string>();
    for (const entry of page) {
      for (const item of [...entry.log_items].sort((a, b) => a.seq - b.seq)) {
        const snapshot = (item.snapshot ?? {}) as Snapshot;
        const { source, source_version } = provenance(snapshot);
        if (source === "off") notices.add(ODBL_NOTICE);
        const name = names.get(item.food_ref_id);
        rows.push({ local_date: entry.local_date, eaten_at: entry.eaten_at, tz: entry.tz,
          slot: entry.slot, entry_id: entry.id, item_seq: item.seq,
          food_name: name?.food_name ?? "(unknown food)", brand: name?.brand ?? null,
          source, source_version, food_revision_id: item.food_revision_id,
          qty: Number(item.qty), unit: item.unit, grams: Number(item.grams),
          energy_kcal: amount(snapshot, "energy_kcal"), protein_g: amount(snapshot, "protein"),
          carbohydrate_g: amount(snapshot, "carbohydrate"), fat_g: amount(snapshot, "fat_total"),
          fiber_g: amount(snapshot, "fiber_total"), note: entry.note });
      }
    }
    const last = page.at(-1);
    return { rows, notices: [...notices],
      next_cursor: hasMore && last
        ? encodeCursor({ local_date: last.local_date, eaten_at: last.eaten_at, id: last.id })
        : null };
  }
  ```
  Append `streamProgress` to `lib/server/export.ts`:
  ```ts
  type TotalRow = { local_date: string; nutrient_code: string; amount: number | null;
    items_with_value: number; items_total: number; coverage: number };

  function targetFor(localDate: string, settings: Settings, firstOpenedAt: string,
    override: DayType | undefined): { day_type: DayType; kcal_target: number } {
    const day_type = dayTypeFor(localDate, override);
    const stage: RampStage = rampStageFor(firstOpenedAt, localDate, settings.rampOverride);
    return { day_type, kcal_target: resolveTargets(day_type, stage, settings).macros.kcal };
  }

  /** One row per local date: the day's totals against the day's target. */
  export async function streamProgress(
    client: SupabaseClient, userId: string, opts: ExportOpts
  ): Promise<ExportJson<ProgressExportRow>> {
    const base = client.from("daily_totals")
      .select("local_date, nutrient_code, amount, items_with_value, items_total, coverage")
      .eq("user_id", userId);
    let query = base;
    if (opts.from) query = query.gte("local_date", opts.from);
    if (opts.to) query = query.lte("local_date", opts.to);
    if (opts.cursor) query = query.gt("local_date", decodeCursor(opts.cursor).local_date);
    const { data, error } = await query.order("local_date", { ascending: true });
    if (error) throw error;

    const byDate = new Map<string, Map<NutrientCode, NutrientTotal>>();
    const itemsByDate = new Map<string, number>();
    for (const row of (data ?? []) as TotalRow[]) {
      const code = row.nutrient_code;
      itemsByDate.set(row.local_date, row.items_total);
      if (!isNutrientCode(code)) continue;
      const day = byDate.get(row.local_date) ?? new Map<NutrientCode, NutrientTotal>();
      day.set(code, { code, amount: Number(row.amount ?? 0), unit: NUTRIENT_UNITS[code],
        itemsWithValue: row.items_with_value, itemsTotal: row.items_total,
        coverage: Number(row.coverage) });
      byDate.set(row.local_date, day);
    }

    const settingsRow = await client.from("user_settings")
      .select("first_opened_at, training_kcal, rest_kcal, protein_g, protein_locked, " +
        "ramp_override, slot_times, shift_minutes, changed_at").eq("user_id", userId).maybeSingle();
    if (settingsRow.error) throw settingsRow.error;
    const settings: Settings = {
      trainingKcal: settingsRow.data?.training_kcal ?? null,
      restKcal: settingsRow.data?.rest_kcal ?? null,
      proteinG: settingsRow.data?.protein_g ?? null,
      proteinLocked: settingsRow.data?.protein_locked ?? true,
      rampOverride: (settingsRow.data?.ramp_override ?? null) as RampStage | null,
      slotTimes: (settingsRow.data?.slot_times ?? {}) as Settings["slotTimes"],
      shiftMinutes: settingsRow.data?.shift_minutes ?? 0,
      changedAt: settingsRow.data?.changed_at ?? null,
    };
    const firstOpenedAt = settingsRow.data?.first_opened_at ?? new Date().toISOString();

    const dates = [...byDate.keys()].sort();
    const overrides = await client.from("plan_days")
      .select("local_date, day_type_override").eq("user_id", userId).in("local_date", dates);
    if (overrides.error) throw overrides.error;
    const overrideByDate = new Map((overrides.data ?? [])
      .map((r) => [r.local_date as string, (r.day_type_override ?? undefined) as DayType | undefined]));

    const page = dates.slice(0, opts.limit);
    const rows: ProgressExportRow[] = page.map((local_date) => {
      const totals = byDate.get(local_date)!;
      const { day_type, kcal_target } =
        targetFor(local_date, settings, firstOpenedAt, overrideByDate.get(local_date));
      const get = (code: NutrientCode) => totals.get(code)?.amount ?? null;
      return { local_date, day_type, kcal_target,
        energy_kcal: get("energy_kcal"), protein_g: get("protein"),
        carbohydrate_g: get("carbohydrate"), fat_g: get("fat_total"), fiber_g: get("fiber_total"),
        micro_coverage_pct: microCoverage(totals).pct,
        items_logged: itemsByDate.get(local_date) ?? 0 };
    });
    const last = page.at(-1);
    return { rows, notices: [],
      next_cursor: dates.length > opts.limit && last
        ? encodeCursor({ local_date: last, eaten_at: "", id: "" }) : null };
  }
  ```

- [ ] Run them: `pnpm test lib/export/csv.test.ts tests/export/cursor.test.ts` → expected **PASS**,
  11 CSV tests (7 from Phase 0 plus 4) and 3 cursor tests. Then `pnpm exec tsc --noEmit && pnpm lint`
  → no errors.

- [ ] Commit:
  `git add lib/export/csv.ts lib/export/csv.test.ts lib/server/export.ts tests/export/cursor.test.ts && git commit -m "feat(export): add positional CSV, the ODbL notice and the keyset meal and progress readers"`

---

## Task 15 — `GET /api/export` for `kind=meals|progress`, renaming Phase 0's weigh-ins export to `weight`

**Files**
- Modify: `app/api/export/route.ts`
- Test: `tests/export/streams.test.ts`

**Interfaces**
- Consumes: `enforceRateLimit`, `requireUser`, `HttpError`, `jsonError` (Phase 0); `toCsv` and the
  new `csvDocument`, `ODBL_NOTICE` from `@/lib/export/csv`; `streamMeals`, `streamProgress`,
  `MEAL_COLUMNS`, `PROGRESS_COLUMNS`, `mealRowValues`, `progressRowValues` from
  `@/lib/server/export`.
- Produces: the same `export async function GET(req: Request): Promise<Response>`. `meals` and
  `progress` take the streaming path with `from`, `to`, `cursor` and `limit` (default and max 5000);
  `recipes`, `favorites` and `water` keep the Phase 0 paged behaviour untouched; Phase 0's `progress`
  (body-weight CSV, `weigh_ins`) is renamed to `weight` and keeps that same paged behaviour too —
  `kind=progress` no longer reaches it. Limits become 60/day and 10/hour per user (architecture §5).
  Errors: 400 unknown `kind` or `format`; 401; 422 malformed date, cursor or limit; 429.

**Steps**

- [ ] Write the failing test. Create `tests/export/streams.test.ts`:
  ```ts
  /** Acceptance 9 and 10, plus the CSV-injection guard on a real food name. [needs branch] */
  import { beforeAll, describe, expect, it } from "vitest";
  import { GET } from "../../app/api/export/route";
  import { applyLogEntry } from "@/lib/server/log";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import { seedCatalogFood, uuid } from "../log/fixtures";

  const run = HAS_BRANCH ? describe : describe.skip;
  const DATE = "2026-09-21";

  function get(query: string, token: string): Request {
    return new Request(`https://app.test/api/export?${query}`,
      { headers: { authorization: `Bearer ${token}` } });
  }

  run("GET /api/export streaming kinds", () => {
    let token = "";

    beforeAll(async () => {
      const { a, admin } = await createTestUsers();
      const chicken = await seedCatalogFood(admin, a.userId, { sourceId: "export-1",
        description: "Chicken thigh, roasted", brand: "Store brand",
        per100g: { energy_kcal: 179, protein: 23.1, carbohydrate: 0, fat_total: 9.3,
          fiber_total: 0 } });
      const formula = await seedCatalogFood(admin, a.userId, { sourceId: "export-2",
        description: "=SUM(A1) salad mix", per100g: { energy_kcal: 20, protein: 1.5,
          fiber_total: 1.8 } });
      await applyLogEntry(a.client, a.userId, { entry_id: uuid(501),
        eaten_at: `${DATE}T18:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
        method: "search", note: "after the gym",
        items: [{ id: uuid(511), seq: 1, food_ref_id: chicken.foodRefId, qty: 1, unit: "g",
          grams: 140 }, { id: uuid(512), seq: 2, food_ref_id: formula.foodRefId, qty: 1,
          unit: "g", grams: 80 }] });
      token = (await a.client.auth.getSession()).data.session!.access_token;
    });

    it("returns one CSV row per logged item with grams, source and source version", async () => {
      const res = await GET(get(`kind=meals&format=csv&from=${DATE}&to=${DATE}`, token));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition"))
        .toBe(`attachment; filename="sasha-meals-${DATE}-${DATE}.csv"`);
      const lines = (await res.text()).trim().split("\r\n");
      expect(lines[0]).toBe("local_date,eaten_at,tz,slot,entry_id,item_seq,food_name,brand," +
        "source,source_version,food_revision_id,qty,unit,grams,energy_kcal,protein_g," +
        "carbohydrate_g,fat_g,fiber_g,note");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain(",fdc_sr_legacy,test-1,");
      expect(lines[1]).toContain(",140,250.6,32.34,0,13.02,0,");
    });

    it("prefixes a food name that starts with an equals sign", async () => {
      const res = await GET(get(`kind=meals&format=csv&from=${DATE}&to=${DATE}`, token));
      expect(await res.text()).toContain(`"'=SUM(A1) salad mix"`);
    });

    it("returns one progress row per local date with the target and coverage", async () => {
      const res = await GET(get(`kind=progress&format=csv&from=${DATE}&to=${DATE}`, token));
      const lines = (await res.text()).trim().split("\r\n");
      expect(lines[0]).toBe("local_date,day_type,kcal_target,energy_kcal,protein_g," +
        "carbohydrate_g,fat_g,fiber_g,micro_coverage_pct,items_logged");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(new RegExp(`^${DATE},(rest|training-10|training-7-fasted),\\d+,`));
      expect(lines[1].endsWith(",2")).toBe(true);
    });

    it("returns json with a cursor field and no notice for non-OFF rows", async () => {
      const res = await GET(get(`kind=meals&format=json&from=${DATE}&to=${DATE}`, token));
      const out = await res.json();
      expect(out.rows).toHaveLength(2);
      expect(out.next_cursor).toBeNull();
      expect(out.notices).toEqual([]);
    });

    it("pages without a gap or a duplicate", async () => {
      const first = await (await GET(get(`kind=meals&format=json&limit=1`, token))).json();
      expect(first.rows).toHaveLength(1);
      const second = await (await GET(
        get(`kind=meals&format=json&limit=1&cursor=${first.next_cursor}`, token))).json();
      expect(second.rows[0]?.entry_id).not.toBe(first.rows[0].entry_id);
    });

    it("400s an unknown kind or format and 422s a bad date, cursor or limit", async () => {
      expect((await GET(get("kind=nonsense&format=json", token))).status).toBe(400);
      expect((await GET(get("kind=meals&format=xml", token))).status).toBe(400);
      expect((await GET(get("kind=meals&format=json&from=17-09-2026", token))).status).toBe(422);
      expect((await GET(get("kind=meals&format=json&cursor=zzz", token))).status).toBe(422);
      expect((await GET(get("kind=meals&format=json&limit=9000", token))).status).toBe(422);
    });

    it("401s with no session", async () => {
      expect((await GET(new Request("https://app.test/api/export?kind=meals"))).status).toBe(401);
    });

    it("serves Phase 0's body-weight export at the renamed kind=weight, not kind=progress", async () => {
      const weight = await GET(get("kind=weight&format=json", token));
      expect(weight.status).toBe(200);
      expect(await weight.json()).toMatchObject({ rows: [], next_page: null });
      // kind=progress is the new nutrient-totals meaning (asserted above), never weigh_ins —
      // the two must never collide again.
      const progress = await GET(get(`kind=progress&format=json&from=${DATE}&to=${DATE}`, token));
      const progressBody = await progress.json();
      expect(progressBody.rows[0]).not.toHaveProperty("value");   // weigh_ins' column, not totals'
      expect(progressBody.rows[0]).toHaveProperty("energy_kcal");
    });
  });
  ```

- [ ] Run it: `pnpm test tests/export/streams.test.ts`
  Expected failure (branch set): `AssertionError: expected 400 to be 200` — the Phase 0 route has
  no `from`, `to`, `cursor` or `limit` and writes a different header line. Without a branch:
  `7 skipped`.

- [ ] Minimal implementation. Modify `app/api/export/route.ts`. Keep `flattenMeals` and the Phase 0
  `recipes` / `favorites` / `water` rows of `SOURCES` exactly as they are; replace the limits; add the
  streaming branch; and **rename the Phase 0 `progress` kind to `weight`** before repurposing
  `progress` for the new meaning. Phase 0's `SOURCES.progress` reads `weigh_ins` (her body-weight
  CSV); this task's `progress` is the new daily-nutrient-totals export — the same query string cannot
  mean both, and `STREAMED.has("progress")` would otherwise route every `kind=progress` request to
  the new meaning while `SOURCES.progress` sat in the file unreachable, silently shadowed. `Kind`
  becomes `"meals" | "weight" | "recipes" | "favorites" | "water"`; `SOURCES.progress` moves to
  `SOURCES.weight`, unchanged apart from the key:
  ```ts
  /**
   * GET /api/export?kind=…&format=…
   *
   * Phase 0 shape for recipes, favorites and water: one page per `page`, buffered.
   * Phase 2 shape for meals and progress: `from`/`to`/`cursor`/`limit`, streamed through a
   * ReadableStream so a 12,000-row log never lands in one array at the route boundary.
   * architecture §4.6, §5 (60/day and 10/hour per user).
   */

  import { csvDocument, ODBL_NOTICE, toCsv } from "@/lib/export/csv";
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { jsonError } from "@/lib/server/http";
  import { enforceRateLimit } from "@/lib/server/ratelimit";
  import { MEAL_COLUMNS, mealRowValues, PROGRESS_COLUMNS, progressRowValues, streamMeals,
    streamProgress, type ExportJson, type ExportOpts } from "@/lib/server/export";
  import type { SupabaseClient } from "@supabase/supabase-js";

  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";

  const PAGE_SIZE = 1000;
  const MAX_LIMIT = 5000;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const STREAMED = new Set(["meals", "progress"]);

  // Phase 0's Kind type gains `weight` in place of `progress`: `progress` now names the streamed
  // nutrient-totals export above, so the buffered SOURCES.progress row (weigh_ins) is renamed to
  // SOURCES.weight — same from/select/order/columns, key only. `meals`, `recipes`, `favorites`,
  // `water`, Row/MealRow and flattenMeals are otherwise the Phase 0 rows and functions, unchanged:
  type Kind = "meals" | "weight" | "recipes" | "favorites" | "water";
  const SOURCES: Record<Kind, { from: string; select: string; order: string; columns: string[] }> = {
    // … meals, recipes, favorites, water: Phase 0's rows, unchanged …
    weight: {
      from: "weigh_ins", select: "id, local_date, start_time, value, unit", order: "start_time",
      columns: ["id", "local_date", "tz", "start_time", "value", "unit"],
    },
  };

  function dateParam(url: URL, name: string): string | undefined {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    if (!LOCAL_DATE.test(raw)) throw new HttpError(422, "bad_request", `malformed ${name}`);
    return raw;
  }

  function limitParam(url: URL): number {
    const raw = url.searchParams.get("limit");
    if (raw === null) return MAX_LIMIT;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
      throw new HttpError(422, "bad_request", `limit must be an integer 1..${MAX_LIMIT}`);
    }
    return value;
  }

  function csvResponse(kind: string, opts: ExportOpts, header: string[],
    rows: readonly (string | number | null)[][], notices: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(csvDocument(header, rows, notices)));
        controller.close();
      },
    });
    const from = opts.from ?? "all";
    const to = opts.to ?? "all";
    return new Response(body, { headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="sasha-${kind}-${from}-${to}.csv"` } });
  }

  async function streamed(kind: "meals" | "progress", client: SupabaseClient, userId: string,
    url: URL): Promise<Response> {
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "csv" && format !== "json") {
      throw new HttpError(400, "bad_request", "unknown format");
    }
    const opts: ExportOpts = { from: dateParam(url, "from"), to: dateParam(url, "to"),
      limit: limitParam(url), cursor: url.searchParams.get("cursor") ?? undefined };

    if (kind === "meals") {
      const page: ExportJson<Awaited<ReturnType<typeof streamMeals>>["rows"][number]> =
        await streamMeals(client, userId, opts);
      if (format === "json") return Response.json(page);
      return csvResponse(kind, opts, MEAL_COLUMNS, page.rows.map(mealRowValues), page.notices);
    }
    const page = await streamProgress(client, userId, opts);
    if (format === "json") return Response.json(page);
    return csvResponse(kind, opts, PROGRESS_COLUMNS, page.rows.map(progressRowValues),
      page.notices);
  }

  export async function GET(req: Request): Promise<Response> {
    try {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      await enforceRateLimit(`export:ip:${ip}`, 60, 3600);
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`export:user:day:${userId}`, 60, 86400);
      await enforceRateLimit(`export:user:hour:${userId}`, 10, 3600);

      const url = new URL(req.url);
      const kind = url.searchParams.get("kind") ?? "";
      if (STREAMED.has(kind)) {
        return await streamed(kind as "meals" | "progress", client, userId, url);
      }
      // … Phase 0's buffered path for recipes | favorites | water, unchanged, ending in toCsv …
    } catch (e) {
      return jsonError(e);
    }
  }
  ```
  `ODBL_NOTICE` is imported for the notice line `csvDocument` writes; `toCsv` stays imported for the
  Phase 0 kinds. Neither import is dropped.

- [ ] Run it: `pnpm test tests/export/streams.test.ts tests/export/cursor.test.ts` and
  `pnpm test tests/export/cross-user.test.ts` (Phase 0's, which must stay green).
  Expected without a branch: all skipped. **[needs branch]**: `Tests  12 passed (12)`.

- [ ] Commit:
  `git add app/api/export/route.ts tests/export/streams.test.ts && git commit -m "feat(export): stream meals and progress with a keyset cursor and the phase 2 rate limits"`

---

## Task 16 — MCP `get_day` nutrients and `scripts/verify-snapshots.ts`

**Files**
- Modify: `app/api/mcp/route.ts` (the `get_day` tool body only)
- Create: `scripts/verify-snapshots.ts`
- Test: `tests/log/mcp-get-day.test.ts`

**Interfaces**
- Consumes: `withTokenUser` and `TokenUser` from `@/lib/server/privileged` (Phase 0 lane B, which
  owns the file and the route's auth wrapper); `adminClient` from `@/lib/server/admin`;
  `isNutrientCode`, `NUTRIENT_UNITS` from `@/lib/nutrients/codes`; `microCoverage`,
  `type NutrientTotal` from `@/lib/nutrients/totals`; RPC `get_daily_totals(p_user_id, p_local_date)`.
- Produces: `get_day`'s JSON gains
  `nutrients: { code: string; amount: number; unit: string; coverage: number }[]` and
  `micro_coverage_pct: number`. No new tool, no new scope. `scripts/verify-snapshots.ts` produces a
  printed report and, with `--repair`, a rewrite through `apply_sync_op`.

**Dependency on Lane B's route shape.** `get_day` needs the `TokenUser` for the current request.
Phase 0 lane B builds the MCP handler inside `withTokenUser`'s callback, so `ctx` and `admin` are in
lexical scope inside every tool body; this task assumes that shape. If lane B instead keeps a
module-level handler, read the same two values from the `AsyncLocalStorage` it installs — the tool
body below changes only in how it obtains `ctx` and `admin`. Confirm before starting (Open question 2).

**Steps**

- [ ] Write the failing test. Create `tests/log/mcp-get-day.test.ts`:
  ```ts
  /** Acceptance 12: MCP get_day returns the kcal, macros, fiber and coverage the phone shows.
   *  The privileged reader is exercised directly — the MCP transport is Lane B's. [needs branch] */
  import { beforeAll, describe, expect, it } from "vitest";
  import { applyLogEntry } from "@/lib/server/log";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import { seedCatalogFood, uuid } from "./fixtures";
  import type { SupabaseClient } from "@supabase/supabase-js";

  const run = HAS_BRANCH ? describe : describe.skip;
  const DATE = "2026-09-22";

  run("get_daily_totals through the privileged boundary", () => {
    let admin: SupabaseClient;
    let userId = "";

    beforeAll(async () => {
      const users = await createTestUsers();
      admin = users.admin;
      userId = users.a.userId;
      const chicken = await seedCatalogFood(admin, userId, { sourceId: "mcp-1",
        description: "Chicken thigh, roasted",
        per100g: { energy_kcal: 179, protein: 23.1, fiber_total: 0, iron: 1.1 } });
      await applyLogEntry(users.a.client, userId, { entry_id: uuid(601),
        eaten_at: `${DATE}T18:00:00.000Z`, tz: "UTC", local_date: DATE, slot: "meal-2",
        method: "search", items: [{ id: uuid(611), seq: 1, food_ref_id: chicken.foodRefId,
          qty: 1, unit: "g", grams: 140 }] });
    });

    it("returns the same numbers the phone shows, bound by p_user_id", async () => {
      const { data, error } = await admin.rpc("get_daily_totals",
        { p_user_id: userId, p_local_date: DATE });
      expect(error).toBeNull();
      const rows = data as { nutrient_code: string; amount: number; coverage: number }[];
      expect(rows.find((r) => r.nutrient_code === "protein")?.amount).toBe(32.34);
      expect(rows.find((r) => r.nutrient_code === "energy_kcal")?.amount).toBe(250.6);
      expect(rows.find((r) => r.nutrient_code === "fiber_total")?.amount).toBe(0);
      expect(rows.find((r) => r.nutrient_code === "iron")?.coverage).toBe(1);
    });

    it("returns nothing for a date she did not log", async () => {
      const { data } = await admin.rpc("get_daily_totals",
        { p_user_id: userId, p_local_date: "2001-01-01" });
      expect(data).toEqual([]);
    });
  });
  ```

- [ ] Run it: `pnpm test tests/log/mcp-get-day.test.ts`
  Expected failure without migration 090200 applied to the branch: `Could not find the function
  public.get_daily_totals`. With Tasks 8–10 applied: PASS, and the route edit below is what makes
  the tool report it.

- [ ] Minimal implementation. In `app/api/mcp/route.ts`, add above the handler:
  ```ts
  import { isNutrientCode, NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";
  import { microCoverage, type NutrientTotal } from "@/lib/nutrients/totals";
  import type { SupabaseClient } from "@supabase/supabase-js";

  type DailyTotalRow = { nutrient_code: string; amount: number | null; items_with_value: number;
    items_total: number; coverage: number | null };

  /** Phase 2: real nutrients for get_day, through the privileged boundary (§2.2 rule 3). */
  async function nutrientsForDay(admin: SupabaseClient, userId: string, date: string) {
    const { data, error } = await admin.rpc("get_daily_totals",
      { p_user_id: userId, p_local_date: date });
    if (error) throw error;
    const totals = new Map<NutrientCode, NutrientTotal>();
    for (const row of (data ?? []) as DailyTotalRow[]) {
      const code = row.nutrient_code;
      if (!isNutrientCode(code)) continue;
      totals.set(code, { code, amount: Number(row.amount ?? 0), unit: NUTRIENT_UNITS[code],
        itemsWithValue: row.items_with_value, itemsTotal: row.items_total,
        coverage: Number(row.coverage ?? 0) });
    }
    return {
      nutrients: [...totals.values()].map((t) => ({ code: t.code, amount: t.amount,
        unit: t.unit, coverage: t.coverage })),
      micro_coverage_pct: microCoverage(totals).pct,
    };
  }
  ```
  and inside the existing `get_day` tool callback, replace the `return json({ … })` with:
  ```ts
        const day = resolveDay(store, date ?? todayIso());
        const measured = await nutrientsForDay(admin, ctx.userId, day.date);
        return json({
          date: day.date,
          dayType: day.dayType,
          rampStage: day.rampStage,
          floorDay: day.isFloorDay,
          targets: day.targets,
          consumed: day.consumed,
          nutrients: measured.nutrients,
          micro_coverage_pct: measured.micro_coverage_pct,
          gut: day.gut,
          weightLb: day.weightLb,
          waterCups: day.waterCups,
          logged: day.extras.map((e) => ({ name: e.name, qty: e.qty, portion: e.portionLabel,
            grams: e.grams, macros: e.macros, flags: e.flags, note: e.note,
            items: e.items?.map((i) => `${i.qty} × ${i.portionLabel} ${i.name}`) })),
          slots: day.slots.map((s) => ({
            time: s.time, slot: s.label, meal: s.meal.name, eaten: s.eaten, note: s.note,
            macros: s.macros,
            portions: s.components.map((c) => `${c.qty} ${c.unit} ${c.name}`),
          })),
        });
  ```
  Every other tool body is untouched.

- [ ] Minimal implementation. Create `scripts/verify-snapshots.ts`:
  ```ts
  /**
   * Devin's USDA check, made a comparison instead of a hunt:
   *
   *   pnpm exec tsx scripts/verify-snapshots.ts <local_date>
   *   pnpm exec tsx scripts/verify-snapshots.ts --repair <from> <to>
   *
   * Print mode lists every item of a date with its grams, source revision and the per-100 g values
   * the snapshot was computed from, so a row can be read straight against fdc.nal.usda.gov.
   * Repair mode recomputes each entry's snapshots from the active revisions through apply_sync_op,
   * which bumps `rev` and appends to change_log, so her other devices pull the correction.
   *
   * Service role, from the Mac. Never runs on Vercel.
   */

  import { randomUUID } from "node:crypto";
  import { adminClient } from "@/lib/server/admin";
  import { formatAmount } from "@/lib/nutrients/format";
  import { isNutrientCode } from "@/lib/nutrients/codes";
  import type { Snapshot } from "@/lib/nutrients/snapshot";
  import { snapshotValue } from "@/lib/nutrients/snapshot";

  type Item = { id: string; seq: number; grams: number; unit: string; qty: number;
    food_ref_id: string; food_revision_id: number | null; snapshot: Snapshot };
  type Entry = { id: string; local_date: string; eaten_at: string; slot: string; rev: number;
    log_items: Item[] };

  const SELECT = "id, local_date, eaten_at, slot, rev, " +
    "log_items(id, seq, qty, unit, grams, food_ref_id, food_revision_id, snapshot)";

  function userId(): string {
    const id = process.env.SASHA_USER_ID;
    if (!id) throw new Error("SASHA_USER_ID is required");
    return id;
  }

  async function entriesBetween(from: string, to: string): Promise<Entry[]> {
    const { data, error } = await adminClient().from("log_entries").select(SELECT)
      .eq("user_id", userId()).is("deleted_at", null)
      .gte("local_date", from).lte("local_date", to)
      .order("local_date", { ascending: true }).order("eaten_at", { ascending: true });
    if (error) throw error;
    return (data ?? []) as unknown as Entry[];
  }

  function printEntry(entry: Entry): void {
    console.log(`\n${entry.local_date} ${entry.slot} (${entry.id}, rev ${entry.rev})`);
    for (const item of [...entry.log_items].sort((a, b) => a.seq - b.seq)) {
      const codes = Object.keys(item.snapshot).filter(isNutrientCode);
      const first = codes.length > 0 ? snapshotValue(item.snapshot, codes[0]) : undefined;
      console.log(`  #${item.seq} ${item.grams} g (${item.qty} ${item.unit}) ` +
        `ref=${item.food_ref_id} revision=${item.food_revision_id ?? "-"} ` +
        `source=${first?.source ?? "-"}@${first?.source_version ?? "-"}`);
      for (const code of codes) {
        const value = snapshotValue(item.snapshot, code)!;
        const per100 = value.amount === null ? null
          : Math.round((value.amount / item.grams) * 100 * 1e4) / 1e4;
        console.log(`     ${code.padEnd(18)} ${formatAmount(code, value.amount, value.unit)
          .padStart(14)}   per 100 g: ${per100 ?? "—"}`);
      }
    }
  }

  async function repair(entry: Entry): Promise<void> {
    const op = { op_id: randomUUID(), entity: "log_entries", entity_id: entry.id, kind: "update",
      base_rev: entry.rev, client_ts: new Date().toISOString(),
      payload: { eaten_at: entry.eaten_at, local_date: entry.local_date, slot: entry.slot,
        recompute_snapshots: true,
        items: entry.log_items.map((i) => ({ id: i.id, seq: i.seq, qty: i.qty, unit: i.unit,
          food_ref_id: i.food_ref_id, grams: i.grams, snapshot: null,
          food_revision_id: i.food_revision_id, portion_id: null, was_edited: false,
          confidence: null })) } };
    const { data, error } = await adminClient().rpc("apply_sync_op",
      { p_user_id: userId(), p_op: op });
    if (error) throw error;
    console.log(`  repaired ${entry.id}: ${(data as { status: string }).status}`);
  }

  async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args[0] === "--repair") {
      const [, from, to] = args;
      if (!from || !to) throw new Error("usage: --repair <from> <to>");
      const entries = await entriesBetween(from, to);
      console.log(`repairing ${entries.length} entries in ${from}..${to}`);
      for (const entry of entries) await repair(entry);
      return;
    }
    const date = args[0];
    if (!date) throw new Error("usage: verify-snapshots.ts <local_date> | --repair <from> <to>");
    const entries = await entriesBetween(date, date);
    if (entries.length === 0) console.log(`no entries on ${date}`);
    for (const entry of entries) printEntry(entry);
  }

  main().catch((e) => { console.error(e); process.exit(1); });
  ```
  **Note on the `payload` a repair sends.** `_sync_upsert` writes `tz`, `note` and `method` from the
  payload; the repair payload above omits them, which would blank those columns. Carry them through:
  add `tz`, `note` and `method` to `SELECT` and to `payload`. Do this in the same edit — the repair
  path must be lossless.

- [ ] Run them: `pnpm test tests/log/mcp-get-day.test.ts` → expected **PASS** (2 tests, or skipped
  with no branch). Then `pnpm exec tsc --noEmit && pnpm lint` → no errors. Then, **[needs branch]**,
  a live read: `SASHA_USER_ID=<branch user a> pnpm exec tsx scripts/verify-snapshots.ts 2026-09-22`
  → prints the entry with `protein  32.3 g   per 100 g: 23.1`.

- [ ] Commit:
  `git add app/api/mcp/route.ts scripts/verify-snapshots.ts tests/log/mcp-get-day.test.ts && git commit -m "feat(mcp): report real nutrients and coverage from get_day, and add the snapshot verifier"`

---

## Lane exit gate

Every item must be green before the lane's PR opens. Run each command once — never the full suite
twice (AGENTS.md).

1. **Unit suites pass with no branch.**
   `pnpm test lib/nutrients lib/log lib/export/csv.test.ts tests/export/cursor.test.ts`
   → all pass; nothing skipped in this set.
2. **Branch suites pass with a branch.** With `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`,
   `SUPABASE_TEST_SERVICE_ROLE_KEY` and `SUPABASE_TEST_DB_URL` exported:
   `pnpm db:reset && pnpm test tests/log tests/export`
   → all pass; `tests/export/cross-user.test.ts` (Phase 0 lane D's) is green too.
3. **Both suites skip cleanly with no branch.** With those env names unset:
   `pnpm test tests/log tests/export` → every branch suite reports `skipped`, 0 failed.
4. **Types and lint.** `pnpm exec tsc --noEmit && pnpm lint` → no errors.
5. **Build.** `pnpm build` → succeeds; `/api/log/commit` and `/api/export` appear as dynamic routes.
6. **`_sync_upsert` has not forked.** Diff this lane's `create or replace` body against Lane A's
   `supabase/migrations/20260911000600_rpc.sql`:
   `diff <(sed -n '/create function _sync_upsert/,/revoke execute on function _sync_upsert/p' supabase/migrations/20260911000600_rpc.sql) <(sed -n '/create or replace function _sync_upsert/,/revoke execute on function _sync_upsert/p' supabase/migrations/20260918090100_phase2_compute_item_snapshot.sql)`
   → the only differences are the function header, the `v_prior` / `v_force` declarations, and the
   `log_entries` items block. Any other difference is a merge accident: fix it before the PR.
7. **The privileged function is unreachable from a browser role.**
   `psql "$SUPABASE_TEST_DB_URL" -At -c "select count(*) from information_schema.role_routine_grants where routine_name in ('get_daily_totals') and grantee in ('authenticated','anon','PUBLIC');"`
   → `0`.
8. **No forbidden file touched.**
   `git diff --name-only main...HEAD` → every path is in Phase 1–2 contracts §1 row H. In particular
   `package.json`, `lib/sync/**`, `lib/server/auth.ts`, `lib/server/privileged.ts`,
   `lib/server/admin.ts`, `lib/types.ts`, `DESIGN.md` and `app/globals.css` are absent.
9. **Acceptance criteria this lane owns are demonstrated by a named test:**
   1 and 2 → `tests/log/snapshot-parity.test.ts`; 3 and 4 → `tests/log/daily-totals.test.ts`;
   8 → `tests/log/commit.test.ts`; 9 and 10 → `tests/export/streams.test.ts`;
   11 → `tests/log/cross-user.test.ts`; 12 → `tests/log/mcp-get-day.test.ts`.
   Criteria 5, 6 and 7 are Lane I's screens and are not claimed here.

## Hand-off to integration

**What Lane I consumes from this lane, and must not re-implement.**

| Import | What Lane I does with it |
|---|---|
| `lib/log/contract.ts` — `LogCommitRequest`, `LogItemInput`, `LogCommitResponse`, `LogCommitFailure`, `logCommitRequestSchema`, `opIdFor` | Builds the commit body in `LogFoodSheet`; uses `opIdFor` for the outbox op so an offline write and its online retry are one op. |
| `lib/nutrients/snapshot.ts` — `computeSnapshot`, `snapshotsEqual`, `Snapshot` | Computes the offline snapshot from the IndexedDB catalog cache; the server value replaces it on sync. |
| `lib/nutrients/totals.ts`, `dri.ts`, `format.ts`, `codes.ts` | `MacroRings` consumed values, `DayNutrients` fiber band and coverage pill, `NutrientBreakdown` rows and dashes. |
| `POST /api/log/commit` status map | 200 ok · 409 conflict / deleted / stale_revision · 410 gone · 422 invalid · 413 · 429. A 409 carries the full entity, so the merge is local and needs no second round trip. |
| `GET /api/export?kind=meals\|progress` | `ExportCard` buttons; `notices` renders the ODbL line when present. |

**What this lane needs from the other lanes before its branch suites are meaningful.**

- **Lane A (Phase 0):** `apply_sync_op`, `_sync_current`, `_sync_upsert`, `get_or_create_food_ref`,
  `change_log`'s `op_id` unique index, `tests/helpers/supabase.ts`, `pnpm db:reset`.
- **Lane B (Phase 0):** `requireUser`, `jsonError`, `readJson`, `enforceRateLimit`, `adminClient`,
  and the MCP route's `withTokenUser` wrapper (see Task 16's dependency note).
- **Lane D (Phase 0):** `lib/export/csv.ts` with `escapeCell` and `toCsv`, and the Phase 0
  `app/api/export/route.ts` this lane extends.
- **Lane F (Phase 1):** the real `catalog_*` tables. This lane never needs Lane F's **import** — its
  suites seed their own rows — but `compute_item_snapshot` will not compile against a missing
  `catalog_food_nutrients`, so Lane F's `20260912090000_catalog_tables.sql` must be applied to the
  branch first. Land order stays **F → G → H → I**.

**Merge notes for the integrator.**

1. Apply the four migrations on a Supabase branch of `fivatgdpuenszxxnijpc`, run
   `pnpm test tests/log tests/export`, then merge the branch before merging the PR. The migrations
   are additive and rewrite no existing row, so deploy and migration may land minutes apart.
2. `20260918090100` replaces `_sync_upsert`. If Lane A patches that function after this lane
   branches, **re-apply the patch here**; exit-gate item 6 is the check.
3. `20260918090400_phase2_down.sql` is never applied automatically. A rollback is: revert the app
   commit, then apply that file by hand, then re-apply Lane A's `_sync_upsert` body.
4. The manual gate (five of her meals against fdc.nal.usda.gov, then the CSV in Numbers) is Devin's
   and runs after the deploy, not in this lane.

## Open questions

1. **`Snapshot` is typed as a total `Record` but is partial at runtime.** Phase 1–2 contracts §4
   freezes the spec's `Record<NutrientCode, NutrientValue>`, so this lane keeps that name and shape
   and adds `snapshotValue()` as the only safe reader. If Lane I would rather have
   `Partial<Record<…>>`, that is a contract change and lands in `00-contracts.md` first, not here.
2. **How `get_day` reaches its `TokenUser`.** Task 16 assumes Lane B builds the MCP handler inside
   `withTokenUser`'s callback, so `ctx` and `admin` are in lexical scope in the tool body. Confirm
   with Lane B before starting Task 16; if lane B keeps a module-level handler plus an
   `AsyncLocalStorage`, only the two lines that obtain `ctx` and `admin` change.
3. **`catalog_dri` has no unique key in the Phase 0 shell.** The spec's seed uses
   `on conflict do nothing`, which matches no constraint without one, so Task 10 adds
   `catalog_dri_key`. Lane F owns the catalog DDL — confirm the index belongs in this lane's
   migration rather than in `20260912090000_catalog_tables.sql`.
4. **The tracked micro set is still Devin's to confirm** (spec open question 2). The twelve codes in
   `TRACKED_MICROS` and in the DRI seed must agree; changing the set changes the coverage
   denominator on her screen and needs both files edited together.
5. **Coverage is items-based, not grams-weighted** (spec open question 1). `totalsFor` and
   `daily_totals` both follow architecture §3.3. A grams-weighted coverage reads truer and needs an
   architecture amendment first.
6. **`progress` paging is over `local_date` only.** The contract calls the cursor "opaque over
   `local_date, eaten_at, id`"; a progress row has no `eaten_at` or `id`, so `streamProgress` writes
   empty strings into those two fields and compares on the date. Flagging it so the integrator does
   not read a progress cursor as a meals cursor — they are not interchangeable.
7. **No phase owns exercise data** (spec open question 5, carried forward unchanged). This lane adds
   no `exercise` export kind and makes no promise about one.
