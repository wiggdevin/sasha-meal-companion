# Lane D — Data ops: backfill, export, backup, AI adapter

**For agentic workers:** execute this plan with **superpowers:subagent-driven-development**. One task
per subagent, in order. Each task is a closed TDD loop: write the failing test, run it, see the named
failure, write the minimal implementation, run it, see PASS, commit. Do not start a task before the
previous one is committed.

## Goal

Move Sasha's data off the single-tenant jsonb store without losing a row, and give Phase 0 the three
data-operations surfaces the rest of the app needs: a pure legacy → v2.1 row mapping with count
assertions and a tested rollback, a user-scoped CSV/JSON export, a nightly backup with a per-day
lock, and a pinned AI adapter with its canary. Nothing here is user-visible. The measure of success
is that the backfill refuses to run when one unit does not resolve, and that the down migration
restores the pre-backfill state exactly.

## Architecture

Four independent slices that share one rule: **pure mapping in `lib/`, I/O in `scripts/` and
`app/api/`.**

1. **Units** (`lib/units.ts`) — pure. Legacy `Food.perUnit` is per household unit. `gramsPerUnit`
   resolves a unit to grams from the household portions already in `lib/food-db.json`;
   `perUnitTo100g` converts to the `user_foods.per_100g` shape with Atwater energy.
2. **Migration** (`lib/migrate/legacy.ts` pure, `scripts/migrate-legacy.ts` I/O). The mapping never
   throws on an unresolved unit — it collects it. The script writes the collected rows to
   `docs/migration-unresolved.csv` and refuses to insert while that file has rows. Insertion goes
   through one `security definer` RPC, `backfill_legacy(p_user_id, p_rows jsonb)`, so every table
   lands in one transaction and the count assertions roll the whole thing back on mismatch.
3. **Export and backup** (`lib/export/csv.ts` pure, two routes). Export is user-scoped and paginated.
   Backup writes a JSON dump of the user tables to a **private Supabase Storage bucket**, because a
   Vercel function cannot write to `~/Backups`. The Mac-side `scripts/backup.sh` produces the real
   `.sql` dump under `~/Backups/supabase/meal-companion/` on a schedule installed separately by
   `scripts/install-backup-timer.sh` (`launchd/com.zs.smc-backup.plist`, daily at 03:15), and
   `scripts/restore-to-branch.sh` restores one into a branch. Acceptance criterion 13 is met by that
   pair together: the bucket dump is the off-machine copy, the Mac dump plus its `launchd` timer is
   the dated `~/Backups/…` artefact with 14-file retention.
4. **AI adapter** (`lib/ai/adapter.ts`, `scripts/ai-canary.ts`). Model IDs are literals. The
   installed `@google/genai` major is asserted (2, contracts §7). Every call writes one `ai_calls`
   row on success and on failure, retries twice with backoff, and trips a module-level circuit
   breaker at 5 failures in 10 minutes. Before each call it sums today's `ai_calls.cost_estimate`
   for the user and refuses over `AI_DAILY_SPEND_CAP_USD` — architecture §6's "daily spend cap per
   user from `ai_calls`", and the only reader of that env name in Phase 0.

**Rollback shape.** A `legacy_backfill_rows(batch_id, table_name, pk)` ledger is written by the RPC
as it inserts. The down migration deletes from each target table by that ledger, so it touches only
backfilled rows and needs **no new column on Lane A's tables**.

## Tech Stack

Next.js 16.3.4 (App Router, `runtime = "nodejs"`), React 19, TypeScript 5 strict, Tailwind 4,
pnpm 11.25.0, Node 22, vitest 5 (`environment: "node"`, `include: ["**/*.test.ts"]`, `@/` → repo
root), Supabase Postgres 17 (project `fivatgdpuenszxxnijpc`), `@supabase/supabase-js` 2.116,
`zod` 4.5.4, `@google/genai` 2.21.x, Vercel.

**No `zod-to-json-schema`.** Contracts §7: "JSON Schema for Gemini `responseSchema` comes from Zod 4's
built-in `z.toJSONSchema(schema)`; do not add `zod-to-json-schema`." Adding it would also be a
`package.json` dependency edit, which contracts §1 bars on a lane branch.

**Scripts run with `pnpm exec tsx`.** `tsx` is a `devDependency` on `main` (contracts §7) and resolves
the `@/` tsconfig alias, so `scripts/migrate-legacy.ts` and `scripts/ai-canary.ts` run as
`pnpm exec tsx scripts/<name>.ts …`. No lane owns `package.json` dependencies, but `tsx` is already
installed — no lane needs to add it.

## Spec path

`docs/specs/phase-0-foundations.md`. Authority order: `docs/architecture.md` (v2.1) >
`docs/specs/phase-0-foundations.md` > `docs/plans/2026-09-10-phase-0/00-contracts.md` > this file.

## Global Constraints (copied from contracts §8)

- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, no AI
  attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazily-created admin client.
- `user_id` never read from a request body. Errors are `{ error, message }`, never echo the body.
- Every route: `enforceRateLimit` first, then identity, then body parse with `readJson`.
- Files < 400 lines; functions < 50 lines.
- Before opening a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the
  full suite twice.

**Lane-local additions.**

- Branch `feat/p0-data-ops`. Create/modify only the files in contracts §1 row D.
- `lib/store.ts`, `lib/sync.ts`, `lib/server/db.ts` and `app/api/sync/route.ts` exist today and are
  **read-only** for this lane. They are deleted on the integration branch at cut-over, not here.
- Lane B's helpers (`requireUser`, `adminClient`, `enforceRateLimit`, `HttpError`, `jsonError`) are
  imported, never re-implemented. If a lane-D task runs before Lane B has merged, stub nothing —
  import the real path and let `tsc` fail until the integration branch rebases.
- `@google/genai` installed on `main` today is **2.21.0**, and contracts §7 pins the SDK major for
  `assertPinnedSdk()` at **2** ("correction: the spec said 1 before install"). The spec's Test plan
  agrees: "the installed `@google/genai` major is 2 (2.21.x installed 2026-09-10)". Task 14 pins 2.
  There is nothing open here — an earlier draft of this plan read the pin off contracts §6, which
  carries model ids, not the SDK major.

## File structure

| File | Responsibility |
|---|---|
| `lib/units.ts` | **Create.** `gramsPerUnit(name, unit)` and `perUnitTo100g(perUnit, gramsPerUnit)`; the name→food-db alias table and the two direct-gram entries the database cannot serve. |
| `lib/units.test.ts` | **Create.** Every unit in the current seed and preset list resolves; unknown foods return `null`; Atwater energy is correct. |
| `lib/export/csv.ts` | **Create.** `escapeCell` (formula prefix + RFC 4180 quoting) and `toCsv(rows, columns)`. |
| `lib/export/csv.test.ts` | **Create.** Formula prefixing, quoting, embedded quotes, null handling, header order. |
| `lib/migrate/legacy.ts` | **Create.** Pure `mapLegacyStore(store, ctx)` → row arrays + unresolved list + counts. No I/O. |
| `lib/migrate/legacy.test.ts` | **Create.** Fixture store → expected rows and counts; an unresolved unit is collected, not thrown. |
| `supabase/migrations/20260911000700_legacy_backfill.sql` | **Create.** `legacy_backfill_rows` ledger, `backup_runs` lock table, the private `backups` storage bucket, the `ai_calls` status columns, and `backfill_legacy(p_user_id, p_rows jsonb)` with the count assertions. |
| `supabase/migrations/20260911000710_legacy_backfill_down.sql` | **Create.** Deletes only the rows named in the ledger for one batch; legacy tables untouched. |
| `supabase/migrations/20260911000800_drop_legacy.sql` | **Create.** `drop table foods, days, settings`. Cut-over release only. |
| `scripts/migrate-legacy.ts` | **Create.** Loads legacy rows with the admin client, runs the mapping, writes `docs/migration-unresolved.csv`, refuses when it is non-empty, otherwise calls `backfill_legacy`. |
| `tests/migrate/rollback.test.ts` | **Create.** Backfill → assert counts → down migration → assert legacy tables intact. Needs a Supabase branch; skipped when the env is unset. |
| `app/api/export/route.ts` | **Create.** `GET`, 10/hour/user, `requireUser`, `kind` ∈ meals\|progress\|recipes\|favorites\|water, `format` ∈ csv\|json, page size 1000, every row carries `tz` and `local_date`. |
| `tests/export/cross-user.test.ts` | **Create.** `[needs branch]` Acceptance criterion 4's route half for `/api/export`: no session → 401; user B → zero of user A's `meals` rows although user A has rows, using Lane A's `createTestUsers()`. |
| `app/api/jobs/backup/route.ts` | **Create.** `POST`, `Bearer $CRON_SECRET`, per-day lock via `backup_runs`, JSON dump of the user tables into the private `backups` bucket, returns `{ ok, bytes }`. |
| `scripts/backup.sh` | **Create.** Mac-side `supabase db dump` into `~/Backups/supabase/meal-companion/<date>.sql`, keeping the last 14. |
| `scripts/restore-to-branch.sh` | **Create.** Restores one dump into a Supabase branch by connection string. |
| `launchd/com.zs.smc-backup.plist` | **Create.** `RunAtLoad` false, `StartCalendarInterval` 03:15 daily, runs `scripts/backup.sh` via `/bin/zsh -lc`, logs to `~/Library/Logs/smc-backup.log`. |
| `scripts/install-backup-timer.sh` | **Create.** Installs the plist into `~/Library/LaunchAgents`, `bootout`s any prior instance, then `bootstrap`s the new one. |
| `lib/ai/adapter.ts` | **Create.** `MODELS`, `assertPinnedSdk`, `generateStructured`, the circuit breaker, the `AI_DAILY_SPEND_CAP_USD` check and the `ai_calls` writer. |
| `lib/ai/adapter.test.ts` | **Create.** Literal model IDs with no `latest`; pinned SDK major (2); circuit opens after 5 failures; the spend cap refuses before a provider is called; `ai_calls` written on success and on failure. |
| `scripts/ai-canary.ts` | **Create.** One live Gemini structured call, one live Nous call; prints model IDs, latency and the Gemini billing verdict; writes `docs/ai-data-handling.md`. |
| `docs/ai-data-handling.md` | **Create (by the canary).** Date, settings verified, Nous retention answer. |

---

## Task 1 — `gramsPerUnit`: dimensional units

**Files**
- Create: `lib/units.ts`
- Test: `lib/units.test.ts`

**Interfaces**
- Consumes: `FoodUnit` from `lib/foods.ts` — `"oz" | "cup" | "tbsp" | "tsp" | "whole" | "pouch" | "can" | "g" | "ml"`.
- Produces: `export function gramsPerUnit(name: string, unit: FoodUnit): number | null` (contracts §6).

**Steps**

- [ ] Write the failing test. Create `lib/units.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gramsPerUnit } from "./units";

describe("gramsPerUnit — dimensional units", () => {
  it("resolves grams, millilitres and ounces without a database lookup", () => {
    expect(gramsPerUnit("Anything at all", "g")).toBe(1);
    expect(gramsPerUnit("Anything at all", "ml")).toBe(1);
    expect(gramsPerUnit("Anything at all", "oz")).toBeCloseTo(28.3495, 4);
  });

  it("returns null for a household unit on a food it cannot find", () => {
    expect(gramsPerUnit("Grandma's stew", "cup")).toBeNull();
    expect(gramsPerUnit("Mystery bar", "whole")).toBeNull();
  });
});
```

- [ ] Run it: `pnpm test lib/units.test.ts`
  Expected failure: `Failed to load url ./units` / `Cannot find module './units'`.

- [ ] Minimal implementation. Create `lib/units.ts`:

```ts
/**
 * Legacy unit → grams, and per-unit macros → per-100 g.
 *
 * Her foods carry macros per household unit ("1 cup of white rice"). The v2.1
 * `user_foods.per_100g` needs a gram weight for that unit. Dimensional units
 * (g, ml, oz) convert without any food knowledge; household units need the
 * food's own portion row, which `lib/food-db.json` already carries.
 *
 * Pure. No I/O. Used by the Phase 0 backfill and by nothing else at runtime.
 */

import { FOOD_DB, type DbFood, type DbPortion } from "./food-db";
import type { Food, FoodUnit } from "./foods";

const GRAMS_PER_OZ = 28.3495;

/** Units whose gram weight does not depend on the food. `ml` assumes water. */
const DIMENSIONAL: Partial<Record<FoodUnit, number>> = { g: 1, ml: 1, oz: GRAMS_PER_OZ };

export function gramsPerUnit(name: string, unit: FoodUnit): number | null {
  const fixed = DIMENSIONAL[unit];
  if (fixed !== undefined) return fixed;
  return null;
}
```

- [ ] Run it: `pnpm test lib/units.test.ts` → expected **PASS**, 2 tests.

- [ ] Commit:
  `git add lib/units.ts lib/units.test.ts && git commit -m "feat(units): resolve dimensional units to grams"`

---

## Task 2 — `gramsPerUnit`: household portions from the food database

**Files**
- Modify: `lib/units.ts`
- Test: `lib/units.test.ts`

**Interfaces**
- Consumes: `FOOD_DB: DbFood[]`, `DbPortion = { label: string; grams: number }` from `lib/food-db.ts`; `SEED_FOODS`, `PRESET_FOODS` from `lib/foods.ts`.
- Produces: the same `gramsPerUnit` signature, now resolving `cup`, `tbsp`, `tsp`, `whole`, `pouch`, `can`.

**Steps**

- [ ] Write the failing test. Append to `lib/units.test.ts`:

```ts
import { PRESET_FOODS, SEED_FOODS } from "./foods";

describe("gramsPerUnit — household portions", () => {
  it("reads the portion row for a cup, a tablespoon and a whole item", () => {
    expect(gramsPerUnit("White rice, cooked", "cup")).toBe(158);
    expect(gramsPerUnit("Olive oil", "tbsp")).toBe(13.5);
    expect(gramsPerUnit("Eggs, large", "whole")).toBe(50);
    expect(gramsPerUnit("Banana, medium", "whole")).toBe(118);
  });

  it("doubles a half-cup portion and skips mashed and pureed labels", () => {
    expect(gramsPerUnit("White potato, peeled & boiled", "cup")).toBe(156);
    expect(gramsPerUnit("Sweet potato, peeled & cooked", "cup")).toBe(200);
  });

  it("resolves the pouch and the two oils the database does not carry", () => {
    expect(gramsPerUnit("Fruit pouch, pear or banana base", "pouch")).toBe(99);
    expect(gramsPerUnit("MCT oil", "tbsp")).toBe(14);
    expect(gramsPerUnit("Duck fat", "tbsp")).toBe(12.8);
  });

  it("resolves every unit in the current seed and preset list", () => {
    const unresolved = [...SEED_FOODS, ...PRESET_FOODS]
      .filter((f) => gramsPerUnit(f.name, f.unit) === null)
      .map((f) => `${f.name} / ${f.unit}`);
    expect(unresolved).toEqual([]);
  });
});
```

- [ ] Run it: `pnpm test lib/units.test.ts`
  Expected failure: `expected null to be 158` on the first case, and the seed list reports 34 unresolved entries.

- [ ] Minimal implementation. Replace the body of `lib/units.ts` below the `DIMENSIONAL` constant:

```ts
/**
 * Her food names are not food-db ids. Where slugifying the name does not land
 * on a row, this table names the row by hand. Each entry is the nearest USDA
 * preparation; a comment marks the two where the preparation differs.
 */
const NAME_TO_DB: Record<string, string> = {
  "chicken breast, cooked": "chicken-breast-roasted",
  "sirloin steak, cooked": "sirloin-steak-broiled",
  "ahi tuna, cooked": "tuna-yellowfin-cooked",
  "canned albacore, drained": "albacore-tuna-canned-in-water",
  "eggs, large": "egg-whole-large",
  "white potato, peeled & boiled": "potato-boiled-peeled",
  "sweet potato, peeled & cooked": "sweet-potato-baked",
  "butternut squash, roasted": "butternut-squash-baked",
  "banana, medium": "banana",
  "melon (cantaloupe)": "cantaloupe",
  "avocado mayo": "avocado-mayo-primal",
  "salmon, cooked": "salmon-atlantic-farmed-cooked",
  "canned salmon, drained": "canned-salmon-pink",
  "cod / white fish, cooked": "cod-cooked",
  "scallops, cooked": "scallops-raw", // raw row; only the oz weight is used
  "sardines, canned": "sardines-canned-in-oil",
  "pork tenderloin, cooked": "pork-tenderloin-roasted",
  "lamb loin, cooked, trimmed": "lamb-chop-broiled",
  "egg whites": "egg-white",
  "pear, peeled, medium": "pear",
  "pumpkin purée": "pumpkin-canned",
  "cassava / yuca, cooked": "cassava-raw", // raw row; cup weight is close enough for the backfill
  "rice cake, plain": "rice-cake",
  "fruit pouch, pear or banana base": "fruit-pouch",
  "sunflower butter": "sunflower-seed-butter",
  "olives, ripe": "olives-black",
};

/** Foods with no database row at all. Values are the standard household weights. */
const DIRECT_GRAMS: Record<string, Partial<Record<FoodUnit, number>>> = {
  "mct oil": { tbsp: 14 },
  "duck fat": { tbsp: 12.8 },
};

const BY_ID = new Map(FOOD_DB.map((f) => [f.id, f]));
const BY_NAME = new Map(FOOD_DB.map((f) => [f.name.toLowerCase(), f]));

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function dbRowForName(name: string): DbFood | null {
  const key = name.trim().toLowerCase();
  const aliased = NAME_TO_DB[key];
  if (aliased) return BY_ID.get(aliased) ?? null;
  return BY_NAME.get(key) ?? BY_ID.get(slugify(key)) ?? null;
}

const CUP_RE = /^(1|0?\.5)\s+cup\b/;
const TBSP_RE = /^1\s+(tbsp|tablespoon)\b/;
const TSP_RE = /^1\s+(tsp|teaspoon)\b/;
const PREP_RE = /mashed|pureed|puree|yield/;
const MEASURE_WORD = /^(cup|cups|tbsp|tablespoon|tsp|teaspoon|oz|ounce|g|gram|ml|nlea|fl)\b/;

function cupGrams(portions: DbPortion[]): number | null {
  const rank = (l: string): number =>
    /^1 cup$/.test(l) ? 0 : /cubes|pieces|chunks/.test(l) ? 1 : /diced|slices|sliced/.test(l) ? 2 : 3;
  const cands = portions
    .map((p) => ({ label: p.label.toLowerCase().trim(), grams: p.grams }))
    .filter((p) => CUP_RE.test(p.label) && !PREP_RE.test(p.label))
    .sort((a, b) => rank(a.label) - rank(b.label));
  if (cands.length === 0) return null;
  return /^0?\.5/.test(cands[0].label) ? cands[0].grams * 2 : cands[0].grams;
}

function spoonGrams(portions: DbPortion[], unit: "tbsp" | "tsp"): number | null {
  const lower = portions.map((p) => ({ label: p.label.toLowerCase().trim(), grams: p.grams }));
  const tbsp = lower.find((p) => TBSP_RE.test(p.label));
  const tsp = lower.find((p) => TSP_RE.test(p.label));
  const cup = cupGrams(portions);
  if (unit === "tbsp") {
    if (tbsp) return tbsp.grams;
    if (tsp) return tsp.grams * 3;
    return cup === null ? null : cup / 16;
  }
  if (tsp) return tsp.grams;
  if (tbsp) return tbsp.grams / 3;
  return cup === null ? null : cup / 48;
}

/** "Eggs, large" wants the large egg, not the medium one: the name picks the size. */
function wholeGrams(name: string, portions: DbPortion[]): number | null {
  const lower = portions.map((p) => ({ label: p.label.toLowerCase().trim(), grams: p.grams }));
  const n = name.toLowerCase();
  for (const size of ["medium", "large", "small"]) {
    if (!n.includes(size)) continue;
    const hit = lower.find((p) => new RegExp(`^1\\s+${size}\\b`).test(p.label));
    if (hit) return hit.grams;
  }
  const named = lower.find((p) => {
    const m = /^1\s+([a-z]+)/.exec(p.label);
    return m !== null && !MEASURE_WORD.test(m[1]);
  });
  return named ? named.grams : null;
}

function labelledGrams(portions: DbPortion[], word: "pouch" | "can"): number | null {
  const hit = portions.find((p) => new RegExp(`^1\\s+${word}\\b`).test(p.label.toLowerCase().trim()));
  return hit ? hit.grams : null;
}

export function gramsPerUnit(name: string, unit: FoodUnit): number | null {
  const fixed = DIMENSIONAL[unit];
  if (fixed !== undefined) return fixed;
  const direct = DIRECT_GRAMS[name.trim().toLowerCase()]?.[unit];
  if (direct !== undefined) return direct;
  const row = dbRowForName(name);
  if (!row) return null;
  if (unit === "cup") return cupGrams(row.portions);
  if (unit === "tbsp" || unit === "tsp") return spoonGrams(row.portions, unit);
  if (unit === "whole") return wholeGrams(name, row.portions);
  if (unit === "pouch" || unit === "can") return labelledGrams(row.portions, unit);
  return null;
}
```

- [ ] Run it: `pnpm test lib/units.test.ts` → expected **PASS**, 6 tests, `unresolved` is `[]`.

- [ ] Commit:
  `git add lib/units.ts lib/units.test.ts && git commit -m "feat(units): resolve household units from the food database portions"`

---

## Task 3 — `perUnitTo100g` with Atwater energy

**Files**
- Modify: `lib/units.ts`
- Test: `lib/units.test.ts`

**Interfaces**
- Consumes: `Food["perUnit"]` = `{ protein: number; carbs: number; fat: number }`; `gramsPerUnit` from Task 2.
- Produces: `export function perUnitTo100g(perUnit: Food["perUnit"], gramsPerUnit: number): Record<string, number>` — keys `protein_g`, `carbohydrate_g`, `fat_g`, `energy_kcal` (contracts §6).

**Steps**

- [ ] Write the failing test. Append to `lib/units.test.ts`:

```ts
import { perUnitTo100g } from "./units";

describe("perUnitTo100g", () => {
  it("scales one cup of white rice to per-100 g with Atwater energy", () => {
    expect(perUnitTo100g({ protein: 4.3, carbs: 44.5, fat: 0.4 }, 158)).toEqual({
      protein_g: 2.7,
      carbohydrate_g: 28.2,
      fat_g: 0.3,
      energy_kcal: 126,
    });
  });

  it("leaves a 100 g unit untouched", () => {
    expect(perUnitTo100g({ protein: 10, carbs: 20, fat: 5 }, 100)).toEqual({
      protein_g: 10,
      carbohydrate_g: 20,
      fat_g: 5,
      energy_kcal: 165,
    });
  });

  it("refuses a non-positive gram weight rather than dividing by zero", () => {
    expect(() => perUnitTo100g({ protein: 1, carbs: 1, fat: 1 }, 0)).toThrow(
      "gramsPerUnit must be greater than zero"
    );
  });
});
```

- [ ] Run it: `pnpm test lib/units.test.ts`
  Expected failure: `"perUnitTo100g" is not exported by "lib/units.ts"`.

- [ ] Minimal implementation. Append to `lib/units.ts`:

```ts
const KCAL_PER_G = { protein: 4, carbohydrate: 4, fat: 9 } as const;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Per-unit macros → the `user_foods.per_100g` map. Energy is Atwater over the
 * rounded macros, so the stored numbers are self-consistent: a reader that
 * re-derives kcal from the three gram values gets the same answer.
 */
export function perUnitTo100g(perUnit: Food["perUnit"], gramsPerUnit: number): Record<string, number> {
  if (!(gramsPerUnit > 0)) throw new Error("gramsPerUnit must be greater than zero");
  const k = 100 / gramsPerUnit;
  const protein_g = round1(perUnit.protein * k);
  const carbohydrate_g = round1(perUnit.carbs * k);
  const fat_g = round1(perUnit.fat * k);
  const energy_kcal = Math.round(
    protein_g * KCAL_PER_G.protein + carbohydrate_g * KCAL_PER_G.carbohydrate + fat_g * KCAL_PER_G.fat
  );
  return { protein_g, carbohydrate_g, fat_g, energy_kcal };
}
```

- [ ] Run it: `pnpm test lib/units.test.ts` → expected **PASS**, 9 tests.

- [ ] Commit:
  `git add lib/units.ts lib/units.test.ts && git commit -m "feat(units): convert per-unit macros to per-100 g with Atwater energy"`

---

## Task 4 — CSV escaping and RFC 4180 serialisation

**Files**
- Create: `lib/export/csv.ts`
- Test: `lib/export/csv.test.ts`

**Interfaces**
- Consumes: nothing.
- Produces: `export function escapeCell(value: unknown): string`; `export function toCsv(rows: Record<string, unknown>[], columns: string[]): string` (contracts §6).

**Steps**

- [ ] Write the failing test. Create `lib/export/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeCell, toCsv } from "./csv";

describe("escapeCell", () => {
  it("prefixes the four formula characters with an apostrophe", () => {
    expect(escapeCell("=1+1")).toBe("'=1+1");
    expect(escapeCell("+44 7700")).toBe("'+44 7700");
    expect(escapeCell("-5")).toBe("'-5");
    expect(escapeCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("quotes a cell holding a comma, a quote or a newline", () => {
    expect(escapeCell("rice, cooked")).toBe('"rice, cooked"');
    expect(escapeCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("quotes a prefixed formula cell that also holds a comma", () => {
    expect(escapeCell("=A1,B1")).toBe("\"'=A1,B1\"");
  });

  it("renders null and undefined as empty and numbers verbatim", () => {
    expect(escapeCell(null)).toBe("");
    expect(escapeCell(undefined)).toBe("");
    expect(escapeCell(0)).toBe("0");
    expect(escapeCell(-5)).toBe("'-5");
    expect(escapeCell(true)).toBe("true");
  });
});

describe("toCsv", () => {
  it("writes the header in column order and CRLF line endings", () => {
    const rows = [
      { local_date: "2026-09-10", tz: "America/Los_Angeles", note: "felt fine" },
      { local_date: "2026-09-11", tz: "America/Los_Angeles", note: "=bad" },
    ];
    expect(toCsv(rows, ["local_date", "tz", "note"])).toBe(
      "local_date,tz,note\r\n" +
        "2026-09-10,America/Los_Angeles,felt fine\r\n" +
        "2026-09-11,America/Los_Angeles,'=bad\r\n"
    );
  });

  it("emits a header-only document for no rows", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b\r\n");
  });

  it("writes an empty cell for a column a row does not carry", () => {
    expect(toCsv([{ a: 1 }], ["a", "b"])).toBe("a,b\r\n1,\r\n");
  });
});
```

- [ ] Run it: `pnpm test lib/export/csv.test.ts`
  Expected failure: `Failed to load url ./csv` / `Cannot find module './csv'`.

- [ ] Minimal implementation. Create `lib/export/csv.ts`:

```ts
/**
 * CSV for the export route. Two concerns, in this order:
 *
 * 1. Formula injection. A cell opening with = + - @ is executed by Excel,
 *    Numbers and Sheets when the file is opened. An apostrophe in front makes
 *    it text. architecture.md §4.6.
 * 2. RFC 4180 quoting. Comma, double quote, CR and LF force quoting; an inner
 *    double quote doubles.
 *
 * Pure. No I/O.
 */

const FORMULA_LEAD = /^[=+\-@]/;
const MUST_QUOTE = /[",\r\n]/;

export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  const guarded = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  if (!MUST_QUOTE.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.map(escapeCell).join(",")];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
```

- [ ] Run it: `pnpm test lib/export/csv.test.ts` → expected **PASS**, 7 tests.

- [ ] Commit:
  `git add lib/export/csv.ts lib/export/csv.test.ts && git commit -m "feat(export): escape CSV cells against formula injection and quote per RFC 4180"`

---

## Task 5 — Legacy mapping: foods → `user_foods`, `food_refs`, `user_food_prefs`

**Files**
- Create: `lib/migrate/legacy.ts`
- Test: `lib/migrate/legacy.test.ts`

**Interfaces**
- Consumes: `Food`, `FoodUnit` from `lib/foods.ts`; `Settings`, `StoredDay`, `SlotId`, `LoggedFood` from `lib/types.ts`; `gramsPerUnit`, `perUnitTo100g` from `lib/units.ts`.
- Produces:

```ts
export type LegacyStore = {
  firstOpenedAt: string;
  scaleWarningDismissed?: boolean;
  settings: Settings;
  days: Record<string, StoredDay>;
  foods: Record<string, Food>;
};
export type MigrateCtx = { userId: string; tz: string; now: string; uuid: () => string };
export type UnresolvedUnit = { food_id: string; name: string; unit: FoodUnit; reason: string };
export type UserFoodRow = { id: string; user_id: string; name: string; kind: "custom";
  per_100g: Record<string, number>; created_at: string };
export type FoodRefRow = { id: string; kind: "user"; user_food_id: string };
export type UserFoodPrefRow = { user_id: string; food_ref_id: string; status: "eats" | "avoid";
  role: "protein" | "carb" | "fat"; no_cook: boolean; note: string | null; updated_at: string };
export function mapFoods(store: LegacyStore, ctx: MigrateCtx):
  { user_foods: UserFoodRow[]; food_refs: FoodRefRow[]; user_food_prefs: UserFoodPrefRow[];
    unresolved: UnresolvedUnit[] };
```

**Steps**

- [ ] Write the failing test. Create `lib/migrate/legacy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Food } from "../foods";
import { defaultSettings } from "../store";
import { mapFoods, type LegacyStore, type MigrateCtx } from "./legacy";

function counterUuid(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

export function ctx(): MigrateCtx {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    tz: "America/Los_Angeles",
    now: "2026-09-11T00:00:00.000Z",
    uuid: counterUuid(),
  };
}

function food(over: Partial<Food>): Food {
  return {
    id: "white-rice",
    name: "White rice, cooked",
    role: "carb",
    unit: "cup",
    perUnit: { protein: 4.3, carbs: 44.5, fat: 0.4 },
    status: "eats",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...over,
  };
}

export function store(over: Partial<LegacyStore> = {}): LegacyStore {
  return {
    firstOpenedAt: "2026-09-01T15:00:00.000Z",
    settings: defaultSettings(),
    days: {},
    foods: { "white-rice": food({}) },
    ...over,
  };
}

describe("mapFoods", () => {
  it("writes one user_food, one food_ref and one pref per legacy food", () => {
    const out = mapFoods(store(), ctx());
    expect(out.unresolved).toEqual([]);
    expect(out.user_foods).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        user_id: "11111111-1111-4111-8111-111111111111",
        name: "White rice, cooked",
        kind: "custom",
        per_100g: { protein_g: 2.7, carbohydrate_g: 28.2, fat_g: 0.3, energy_kcal: 126 },
        created_at: "2026-09-08T00:00:00.000Z",
      },
    ]);
    expect(out.food_refs).toEqual([
      { id: "00000000-0000-4000-8000-000000000002", kind: "user",
        user_food_id: "00000000-0000-4000-8000-000000000001" },
    ]);
    expect(out.user_food_prefs).toEqual([
      { user_id: "11111111-1111-4111-8111-111111111111",
        food_ref_id: "00000000-0000-4000-8000-000000000002",
        status: "eats", role: "carb", no_cook: false, note: null,
        updated_at: "2026-09-08T00:00:00.000Z" },
    ]);
  });

  it("carries an avoid note across, because it is symptom evidence", () => {
    const out = mapFoods(
      store({ foods: { pear: food({ id: "pear", name: "Pear, peeled, medium", unit: "whole",
        status: "avoid", note: "hurt on 9/12", noCook: true }) } }),
      ctx()
    );
    expect(out.user_food_prefs[0].note).toBe("hurt on 9/12");
    expect(out.user_food_prefs[0].status).toBe("avoid");
    expect(out.user_food_prefs[0].no_cook).toBe(true);
  });

  it("collects an unresolved unit instead of throwing, and writes no rows for it", () => {
    const out = mapFoods(
      store({ foods: { stew: food({ id: "stew", name: "Grandma's stew", unit: "cup" }) } }),
      ctx()
    );
    expect(out.unresolved).toEqual([
      { food_id: "stew", name: "Grandma's stew", unit: "cup",
        reason: "no household portion for unit 'cup'" },
    ]);
    expect(out.user_foods).toEqual([]);
    expect(out.food_refs).toEqual([]);
    expect(out.user_food_prefs).toEqual([]);
  });

  it("orders foods by id so two runs produce identical uuids", () => {
    const foods = { zucchini: food({ id: "zucchini", name: "Banana, medium", unit: "whole" }),
      apricot: food({ id: "apricot", name: "Olive oil", unit: "tbsp", role: "fat" }) };
    const out = mapFoods(store({ foods }), ctx());
    expect(out.user_foods.map((f) => f.name)).toEqual(["Olive oil", "Banana, medium"]);
  });
});
```

- [ ] Run it: `pnpm test lib/migrate/legacy.test.ts`
  Expected failure: `Failed to load url ./legacy` / `Cannot find module './legacy'`.

- [ ] Minimal implementation. Create `lib/migrate/legacy.ts`:

```ts
/**
 * Legacy jsonb store → v2.1 row arrays. Pure: no Supabase, no filesystem, no
 * clock. Everything variable is injected through MigrateCtx, so a fixture run
 * and a production run produce the same shapes and the test can pin uuids.
 *
 * An unresolved unit is COLLECTED, never thrown. The caller
 * (scripts/migrate-legacy.ts) writes the collected list to
 * docs/migration-unresolved.csv and refuses to insert while it has rows.
 * phase-0-foundations.md, Data changes.
 */

import type { Food, FoodUnit } from "../foods";
import type { Settings, StoredDay } from "../types";
import { gramsPerUnit, perUnitTo100g } from "../units";

export type LegacyStore = {
  firstOpenedAt: string;
  scaleWarningDismissed?: boolean;
  settings: Settings;
  days: Record<string, StoredDay>;
  foods: Record<string, Food>;
};

export type MigrateCtx = { userId: string; tz: string; now: string; uuid: () => string };

export type UnresolvedUnit = { food_id: string; name: string; unit: FoodUnit; reason: string };

export type UserFoodRow = {
  id: string; user_id: string; name: string; kind: "custom";
  per_100g: Record<string, number>; created_at: string;
};
export type FoodRefRow = { id: string; kind: "user"; user_food_id: string };
export type UserFoodPrefRow = {
  user_id: string; food_ref_id: string; status: "eats" | "avoid";
  role: "protein" | "carb" | "fat"; no_cook: boolean; note: string | null; updated_at: string;
};

export type MappedFoods = {
  user_foods: UserFoodRow[];
  food_refs: FoodRefRow[];
  user_food_prefs: UserFoodPrefRow[];
  unresolved: UnresolvedUnit[];
};

export function mapFoods(store: LegacyStore, ctx: MigrateCtx): MappedFoods {
  const out: MappedFoods = { user_foods: [], food_refs: [], user_food_prefs: [], unresolved: [] };
  const ordered = Object.keys(store.foods).sort();
  for (const key of ordered) {
    const food = store.foods[key];
    const grams = gramsPerUnit(food.name, food.unit);
    if (grams === null) {
      out.unresolved.push({
        food_id: food.id, name: food.name, unit: food.unit,
        reason: `no household portion for unit '${food.unit}'`,
      });
      continue;
    }
    const userFoodId = ctx.uuid();
    const refId = ctx.uuid();
    out.user_foods.push({
      id: userFoodId, user_id: ctx.userId, name: food.name, kind: "custom",
      per_100g: perUnitTo100g(food.perUnit, grams), created_at: food.updatedAt,
    });
    out.food_refs.push({ id: refId, kind: "user", user_food_id: userFoodId });
    out.user_food_prefs.push({
      user_id: ctx.userId, food_ref_id: refId, status: food.status, role: food.role,
      no_cook: food.noCook ?? false, note: food.note ?? null, updated_at: food.updatedAt,
    });
  }
  return out;
}
```

- [ ] Run it: `pnpm test lib/migrate/legacy.test.ts` → expected **PASS**, 4 tests.

- [ ] Commit:
  `git add lib/migrate/legacy.ts lib/migrate/legacy.test.ts && git commit -m "feat(migrate): map legacy foods to user_foods, food_refs and prefs"`

---

## Task 6 — Legacy mapping: days → `log_entries` (+ items inline)

**Files**
- Modify: `lib/migrate/legacy.ts`
- Test: `lib/migrate/legacy.test.ts`

**Interfaces**
- Consumes: `StoredDay`, `LoggedFood`, `SlotId` from `lib/types.ts`; `MappedFoods` from Task 5 (legacy food id → `food_ref_id`).
- Produces:

```ts
export type LogItemRow = { id: string; seq: number; qty: number; unit: string;
  food_ref_id: string | null; grams: number; snapshot: Record<string, unknown>;
  was_edited: boolean };
export type LogEntryRow = { id: string; user_id: string; note: string | null; eaten_at: string;
  tz: string; local_date: string; slot: SlotId;
  method: "search" | "text" | "plan"; items: LogItemRow[] };
export function slotForTime(iso: string): SlotId;
export function mapLogEntries(store: LegacyStore, ctx: MigrateCtx,
  refByFoodId: Map<string, string>): LogEntryRow[];
```

**Steps**

- [ ] Write the failing test. Append to `lib/migrate/legacy.test.ts`:

```ts
import { mapLogEntries, slotForTime } from "./legacy";

describe("slotForTime", () => {
  it("buckets an ISO timestamp into the slot it belongs to", () => {
    expect(slotForTime("2026-09-10T07:15:00.000Z")).toBe("coffee");
    expect(slotForTime("2026-09-10T11:30:00.000Z")).toBe("meal-1");
    expect(slotForTime("2026-09-10T15:00:00.000Z")).toBe("meal-2");
    expect(slotForTime("2026-09-10T19:00:00.000Z")).toBe("meal-3");
    expect(slotForTime("2026-09-10T22:30:00.000Z")).toBe("hot-chocolate");
  });
});

describe("mapLogEntries", () => {
  const refs = new Map([["white-rice", "ref-rice"]]);

  it("turns one logged food into one entry with one item", () => {
    const days = {
      "2026-09-10": {
        date: "2026-09-10",
        extras: [{ id: "e1", foodId: "white-rice", name: "White rice, cooked",
          portionLabel: "1 cup", qty: 2, grams: 316,
          macros: { kcal: 400, protein: 8.6, carbs: 89, fat: 0.8 },
          at: "2026-09-10T19:04:00.000Z" }],
      },
    };
    const entries = mapLogEntries(store({ days }), ctx(), refs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      user_id: "11111111-1111-4111-8111-111111111111",
      local_date: "2026-09-10", slot: "meal-3", method: "search",
      eaten_at: "2026-09-10T19:04:00.000Z", tz: "America/Los_Angeles", note: null,
    });
    expect(entries[0].items).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", seq: 0, qty: 2, unit: "1 cup",
        food_ref_id: "ref-rice", grams: 316, was_edited: false,
        snapshot: { protein_g: 8.6, carbohydrate_g: 89, fat_g: 0.8, energy_kcal: 400 } },
    ]);
  });

  it("expands a logged meal into one entry with an item per food and method 'text'", () => {
    const days = {
      "2026-09-10": {
        date: "2026-09-10",
        extras: [{ id: "m1", foodId: "meal", name: "Dinner out", portionLabel: "1 meal", qty: 1,
          grams: 0, macros: { kcal: 600, protein: 40, carbs: 60, fat: 20 }, note: "felt fine",
          at: "2026-09-10T19:30:00.000Z",
          items: [
            { id: "m1a", foodId: "white-rice", name: "Rice", portionLabel: "1 cup", qty: 1,
              grams: 158, macros: { kcal: 200, protein: 4.3, carbs: 44.5, fat: 0.4 },
              at: "2026-09-10T19:30:00.000Z" },
            { id: "m1b", foodId: "unknown-x", name: "Chicken", portionLabel: "4 oz", qty: 4,
              grams: 113, macros: { kcal: 400, protein: 35.7, carbs: 15.5, fat: 19.6 },
              at: "2026-09-10T19:30:00.000Z" },
          ] }],
      },
    };
    const entries = mapLogEntries(store({ days }), ctx(), refs);
    expect(entries[0].method).toBe("text");
    expect(entries[0].note).toBe("felt fine");
    expect(entries[0].items.map((i) => i.food_ref_id)).toEqual(["ref-rice", null]);
    expect(entries[0].items.map((i) => i.seq)).toEqual([0, 1]);
  });

  it("turns each slot tick into a plan entry carrying the slot note", () => {
    const days = {
      "2026-09-10": {
        date: "2026-09-10",
        eaten: { coffee: "2026-09-10T07:10:00.000Z", "meal-1": "2026-09-10T12:00:00.000Z" },
        notes: { "meal-1": "half portion" },
      },
    };
    const entries = mapLogEntries(store({ days }), ctx(), refs);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => [e.slot, e.method, e.note])).toEqual([
      ["coffee", "plan", null],
      ["meal-1", "plan", "half portion"],
    ]);
    expect(entries.every((e) => e.items.length === 0)).toBe(true);
  });

  it("emits entries in date then slot order so the run is reproducible", () => {
    const days = {
      "2026-09-11": { date: "2026-09-11", eaten: { coffee: "2026-09-11T07:00:00.000Z" } },
      "2026-09-10": { date: "2026-09-10", eaten: { coffee: "2026-09-10T07:00:00.000Z" } },
    };
    const entries = mapLogEntries(store({ days }), ctx(), refs);
    expect(entries.map((e) => e.local_date)).toEqual(["2026-09-10", "2026-09-11"]);
  });
});
```

- [ ] Run it: `pnpm test lib/migrate/legacy.test.ts`
  Expected failure: `"mapLogEntries" is not exported by "lib/migrate/legacy.ts"`.

- [ ] Minimal implementation. Append to `lib/migrate/legacy.ts`:

```ts
import type { LoggedFood, SlotId } from "../types";

export type LogItemRow = {
  id: string; seq: number; qty: number; unit: string; food_ref_id: string | null;
  grams: number; snapshot: Record<string, unknown>; was_edited: boolean;
};
export type LogEntryRow = {
  id: string; user_id: string; note: string | null; eaten_at: string; tz: string;
  local_date: string; slot: SlotId; method: "search" | "text" | "plan"; items: LogItemRow[];
};

/**
 * Legacy extras carry a timestamp, not a slot. The boundaries are the ones the
 * plan already uses (lib/plan.ts slot times), read as UTC hours because the
 * stored timestamps are UTC and she has one timezone.
 */
export function slotForTime(iso: string): SlotId {
  const hour = new Date(iso).getUTCHours();
  if (hour < 10) return "coffee";
  if (hour < 13) return "meal-1";
  if (hour < 17) return "meal-2";
  if (hour < 21) return "meal-3";
  return "hot-chocolate";
}

function snapshotOf(macros: LoggedFood["macros"]): Record<string, unknown> {
  return {
    protein_g: macros.protein, carbohydrate_g: macros.carbs,
    fat_g: macros.fat, energy_kcal: macros.kcal,
  };
}

function itemsOf(entry: LoggedFood, ctx: MigrateCtx, refs: Map<string, string>): LogItemRow[] {
  const sources = entry.items?.length ? entry.items : [entry];
  return sources.map((source, seq) => ({
    id: ctx.uuid(), seq, qty: source.qty, unit: source.portionLabel,
    food_ref_id: refs.get(source.foodId) ?? null, grams: source.grams,
    snapshot: snapshotOf(source.macros), was_edited: false,
  }));
}

export function mapLogEntries(
  store: LegacyStore, ctx: MigrateCtx, refByFoodId: Map<string, string>
): LogEntryRow[] {
  const rows: LogEntryRow[] = [];
  for (const date of Object.keys(store.days).sort()) {
    const day = store.days[date];
    for (const extra of day.extras ?? []) {
      // Items take their uuids FIRST, so the test can pin an item id without
      // pinning the entry id. Object-literal evaluation order would otherwise
      // hand uuid #1 to the entry.
      const items = itemsOf(extra, ctx, refByFoodId);
      rows.push({
        id: ctx.uuid(), user_id: ctx.userId, note: extra.note ?? null, eaten_at: extra.at,
        tz: ctx.tz, local_date: date, slot: slotForTime(extra.at),
        method: extra.items?.length ? "text" : "search", items,
      });
    }
    for (const slot of Object.keys(day.eaten ?? {}).sort() as SlotId[]) {
      rows.push({
        id: ctx.uuid(), user_id: ctx.userId, note: day.notes?.[slot] ?? null,
        eaten_at: day.eaten![slot]!, tz: ctx.tz, local_date: date, slot,
        method: "plan", items: [],
      });
    }
  }
  return rows;
}
```

- [ ] Run it: `pnpm test lib/migrate/legacy.test.ts` → expected **PASS**, 8 tests.

- [ ] Commit:
  `git add lib/migrate/legacy.ts lib/migrate/legacy.test.ts && git commit -m "feat(migrate): map legacy extras and slot ticks to log entries"`

---

## Task 7 — Legacy mapping: water, weight, gut, plan days, settings, counts

**Files**
- Modify: `lib/migrate/legacy.ts`
- Test: `lib/migrate/legacy.test.ts`

**Interfaces**
- Consumes: everything from Tasks 5 and 6.
- Produces:

```ts
export type WaterLogRow = { user_id: string; local_date: string; cups: number };
export type HealthSourceRow = { id: string; user_id: string; kind: "manual";
  device_label: string; created_at: string };
export type HealthSampleRow = { id: string; user_id: string; source_id: string;
  type: "body_mass"; value: number; unit: "lb"; start_time: string; end_time: string; tz: string };
export type GutLogRow = { id: string; user_id: string; local_date: string; tz: string;
  state: "good" | "iffy" | "flare"; note: string | null };
export type PlanDayRow = { user_id: string; local_date: string;
  day_type_override: string | null; floor_day: boolean;
  swaps: Record<string, string>; slot_notes: Record<string, string>; updated_at: string };
export type UserSettingsRow = { user_id: string; first_opened_at: string;
  scale_warning_dismissed: boolean; training_kcal: number | null; rest_kcal: number | null;
  protein_g: number | null; protein_locked: boolean; ramp_override: number | null;
  slot_times: Record<string, string>; shift_minutes: number; changed_at: string | null };
export type BackfillRows = {
  user_foods: UserFoodRow[]; food_refs: FoodRefRow[]; user_food_prefs: UserFoodPrefRow[];
  log_entries: LogEntryRow[]; water_log: WaterLogRow[]; health_sources: HealthSourceRow[];
  health_samples: HealthSampleRow[]; gut_log: GutLogRow[]; plan_days: PlanDayRow[];
  user_settings: UserSettingsRow;
};
export type MigrationCounts = { user_foods: number; food_refs: number; user_food_prefs: number;
  log_entries: number; log_items: number; water_log: number; health_samples: number;
  gut_log: number; plan_days: number; user_settings: number };
export type MigrationResult = { rows: BackfillRows; unresolved: UnresolvedUnit[];
  counts: MigrationCounts };
export function mapLegacyStore(store: LegacyStore, ctx: MigrateCtx): MigrationResult;
```

**Steps**

- [ ] Write the failing test. Append to `lib/migrate/legacy.test.ts`:

```ts
import { mapLegacyStore } from "./legacy";

describe("mapLegacyStore", () => {
  const days = {
    "2026-09-10": {
      date: "2026-09-10", waterMl: 1200, weightLb: 141.2, gut: "iffy" as const,
      floorDay: true, dayTypeOverride: "rest" as const, swaps: { "meal-2": "m-tuna" },
      notes: { "meal-2": "half" }, eaten: { coffee: "2026-09-10T07:00:00.000Z" },
      updatedAt: "2026-09-10T23:00:00.000Z",
    },
    "2026-09-11": { date: "2026-09-11", waterMl: 0, updatedAt: "2026-09-11T23:00:00.000Z" },
  };

  it("rounds water millilitres to cups and skips a day with no water", () => {
    const { rows } = mapLegacyStore(store({ days }), ctx());
    expect(rows.water_log).toEqual([
      { user_id: "11111111-1111-4111-8111-111111111111", local_date: "2026-09-10", cups: 5 },
    ]);
  });

  it("creates exactly one manual health source and a body_mass sample in pounds", () => {
    const { rows } = mapLegacyStore(store({ days }), ctx());
    expect(rows.health_sources).toHaveLength(1);
    expect(rows.health_sources[0].kind).toBe("manual");
    expect(rows.health_samples).toHaveLength(1);
    expect(rows.health_samples[0]).toMatchObject({
      type: "body_mass", value: 141.2, unit: "lb", tz: "America/Los_Angeles",
      source_id: rows.health_sources[0].id, start_time: "2026-09-10T23:00:00.000Z",
    });
  });

  it("creates no health source when she never typed a weight", () => {
    const { rows } = mapLegacyStore(store({ days: { "2026-09-11": days["2026-09-11"] } }), ctx());
    expect(rows.health_sources).toEqual([]);
    expect(rows.health_samples).toEqual([]);
  });

  it("maps the gut check-in", () => {
    const { rows } = mapLegacyStore(store({ days }), ctx());
    expect(rows.gut_log).toHaveLength(1);
    expect(rows.gut_log[0]).toMatchObject({ local_date: "2026-09-10", state: "iffy", note: null });
  });

  it("writes one plan_days row per touched day, defaults included", () => {
    const { rows } = mapLegacyStore(store({ days }), ctx());
    expect(rows.plan_days).toHaveLength(2);
    expect(rows.plan_days[0]).toEqual({
      user_id: "11111111-1111-4111-8111-111111111111", local_date: "2026-09-10",
      day_type_override: "rest", floor_day: true, swaps: { "meal-2": "m-tuna" },
      slot_notes: { "meal-2": "half" }, updated_at: "2026-09-10T23:00:00.000Z",
    });
    expect(rows.plan_days[1]).toEqual({
      user_id: "11111111-1111-4111-8111-111111111111", local_date: "2026-09-11",
      day_type_override: null, floor_day: false, swaps: {}, slot_notes: {},
      updated_at: "2026-09-11T23:00:00.000Z",
    });
  });

  it("maps settings and reports counts that match the row arrays", () => {
    const { rows, counts } = mapLegacyStore(store({ days }), ctx());
    expect(rows.user_settings).toMatchObject({
      user_id: "11111111-1111-4111-8111-111111111111",
      first_opened_at: "2026-09-01T15:00:00.000Z", scale_warning_dismissed: false,
      protein_locked: true, shift_minutes: 0, ramp_override: null,
    });
    expect(counts).toEqual({
      user_foods: 1, food_refs: 1, user_food_prefs: 1, log_entries: 1, log_items: 0,
      water_log: 1, health_samples: 1, gut_log: 1, plan_days: 2, user_settings: 1,
    });
  });

  it("collects unresolved units at the top level without throwing", () => {
    const foods = { stew: { id: "stew", name: "Grandma's stew", role: "carb" as const,
      unit: "cup" as const, perUnit: { protein: 1, carbs: 1, fat: 1 }, status: "eats" as const,
      updatedAt: "2026-09-08T00:00:00.000Z" } };
    const result = mapLegacyStore(store({ foods, days }), ctx());
    expect(result.unresolved.map((u) => u.food_id)).toEqual(["stew"]);
    expect(result.counts.user_foods).toBe(0);
  });
});
```

- [ ] Run it: `pnpm test lib/migrate/legacy.test.ts`
  Expected failure: `"mapLegacyStore" is not exported by "lib/migrate/legacy.ts"`.

- [ ] Minimal implementation. Append to `lib/migrate/legacy.ts`:

```ts
export type WaterLogRow = { user_id: string; local_date: string; cups: number };
export type HealthSourceRow = {
  id: string; user_id: string; kind: "manual"; device_label: string; created_at: string;
};
export type HealthSampleRow = {
  id: string; user_id: string; source_id: string; type: "body_mass"; value: number;
  unit: "lb"; start_time: string; end_time: string; tz: string;
};
export type GutLogRow = {
  id: string; user_id: string; local_date: string; tz: string;
  state: "good" | "iffy" | "flare"; note: string | null;
};
export type PlanDayRow = {
  user_id: string; local_date: string; day_type_override: string | null; floor_day: boolean;
  swaps: Record<string, string>; slot_notes: Record<string, string>; updated_at: string;
};
export type UserSettingsRow = {
  user_id: string; first_opened_at: string; scale_warning_dismissed: boolean;
  training_kcal: number | null; rest_kcal: number | null; protein_g: number | null;
  protein_locked: boolean; ramp_override: number | null; slot_times: Record<string, string>;
  shift_minutes: number; changed_at: string | null;
};

export type BackfillRows = {
  user_foods: UserFoodRow[]; food_refs: FoodRefRow[]; user_food_prefs: UserFoodPrefRow[];
  log_entries: LogEntryRow[]; water_log: WaterLogRow[]; health_sources: HealthSourceRow[];
  health_samples: HealthSampleRow[]; gut_log: GutLogRow[]; plan_days: PlanDayRow[];
  user_settings: UserSettingsRow;
};
export type MigrationCounts = {
  user_foods: number; food_refs: number; user_food_prefs: number; log_entries: number;
  log_items: number; water_log: number; health_samples: number; gut_log: number;
  plan_days: number; user_settings: number;
};
export type MigrationResult = {
  rows: BackfillRows; unresolved: UnresolvedUnit[]; counts: MigrationCounts;
};

const ML_PER_CUP = 240;

function mapSettings(store: LegacyStore, ctx: MigrateCtx): UserSettingsRow {
  const s = store.settings;
  return {
    user_id: ctx.userId, first_opened_at: store.firstOpenedAt,
    scale_warning_dismissed: store.scaleWarningDismissed ?? false,
    training_kcal: s.trainingKcal, rest_kcal: s.restKcal, protein_g: s.proteinG,
    protein_locked: s.proteinLocked, ramp_override: s.rampOverride,
    slot_times: { ...s.slotTimes } as Record<string, string>,
    shift_minutes: s.shiftMinutes, changed_at: s.changedAt,
  };
}

export function mapLegacyStore(store: LegacyStore, ctx: MigrateCtx): MigrationResult {
  const foods = mapFoods(store, ctx);
  const refByFoodId = new Map<string, string>();
  const ordered = Object.keys(store.foods).sort();
  let refIndex = 0;
  for (const key of ordered) {
    const food = store.foods[key];
    if (foods.unresolved.some((u) => u.food_id === food.id)) continue;
    refByFoodId.set(food.id, foods.food_refs[refIndex++].id);
  }

  const log_entries = mapLogEntries(store, ctx, refByFoodId);
  const water_log: WaterLogRow[] = [];
  const health_sources: HealthSourceRow[] = [];
  const health_samples: HealthSampleRow[] = [];
  const gut_log: GutLogRow[] = [];
  const plan_days: PlanDayRow[] = [];

  for (const date of Object.keys(store.days).sort()) {
    const day = store.days[date];
    const at = day.updatedAt ?? `${date}T12:00:00.000Z`;
    if (day.waterMl && day.waterMl > 0) {
      water_log.push({ user_id: ctx.userId, local_date: date,
        cups: Math.round(day.waterMl / ML_PER_CUP) });
    }
    if (typeof day.weightLb === "number") {
      if (health_sources.length === 0) {
        health_sources.push({ id: ctx.uuid(), user_id: ctx.userId, kind: "manual",
          device_label: "Typed on the phone", created_at: ctx.now });
      }
      health_samples.push({ id: ctx.uuid(), user_id: ctx.userId,
        source_id: health_sources[0].id, type: "body_mass", value: day.weightLb, unit: "lb",
        start_time: at, end_time: at, tz: ctx.tz });
    }
    if (day.gut) {
      gut_log.push({ id: ctx.uuid(), user_id: ctx.userId, local_date: date, tz: ctx.tz,
        state: day.gut, note: null });
    }
    plan_days.push({
      user_id: ctx.userId, local_date: date, day_type_override: day.dayTypeOverride ?? null,
      floor_day: day.floorDay ?? false, swaps: { ...(day.swaps ?? {}) } as Record<string, string>,
      slot_notes: { ...(day.notes ?? {}) } as Record<string, string>, updated_at: at,
    });
  }

  const rows: BackfillRows = {
    user_foods: foods.user_foods, food_refs: foods.food_refs,
    user_food_prefs: foods.user_food_prefs, log_entries, water_log, health_sources,
    health_samples, gut_log, plan_days, user_settings: mapSettings(store, ctx),
  };
  const counts: MigrationCounts = {
    user_foods: rows.user_foods.length, food_refs: rows.food_refs.length,
    user_food_prefs: rows.user_food_prefs.length, log_entries: rows.log_entries.length,
    log_items: rows.log_entries.reduce((n, e) => n + e.items.length, 0),
    water_log: rows.water_log.length, health_samples: rows.health_samples.length,
    gut_log: rows.gut_log.length, plan_days: rows.plan_days.length, user_settings: 1,
  };
  return { rows, unresolved: foods.unresolved, counts };
}
```

- [ ] Run it: `pnpm test lib/migrate/legacy.test.ts` → expected **PASS**, 15 tests.

- [ ] Commit:
  `git add lib/migrate/legacy.ts lib/migrate/legacy.test.ts && git commit -m "feat(migrate): map water, weight, gut, plan days and settings with a count summary"`

---

## Task 8 — Backfill migration: ledger, lock table, bucket, `backfill_legacy` RPC

**Files**
- Create: `supabase/migrations/20260911000700_legacy_backfill.sql`
- Test: exercised by Task 11 (`tests/migrate/rollback.test.ts`). No unit test — this file is SQL.

**Interfaces**
- Consumes: every §3.2–3.6 table plus `plan_days`, `user_settings`, `gut_log`, `ai_calls` from Lane A's `…000200`–`…000400`.
- Produces: `backfill_legacy(p_user_id uuid, p_rows jsonb) returns jsonb` — `security definer`, `set search_path = public`, revoked from `anon`/`public`, granted to `service_role`. Returns `{ batch_id, counts }`. Raises on any count mismatch.

**Steps**

- [ ] Write the failing check. There is no vitest for SQL; the gate is applying the file to a branch.
  Run (fails before the file exists):
  `supabase db push --db-url "$SUPABASE_TEST_DB_URL" --include-all`
  Expected failure: `no migration file 20260911000700_legacy_backfill.sql` (or the file is simply
  absent from the applied list). **[needs branch]** Skip condition: when `SUPABASE_TEST_DB_URL` is
  unset, skip this step and rely on Task 11's skip.

- [ ] Minimal implementation. Create `supabase/migrations/20260911000700_legacy_backfill.sql`:

```sql
-- Phase 0 legacy backfill. Lane D owns this file.
--
-- Everything lands in ONE transaction through backfill_legacy(). Count
-- assertions at the end raise, which rolls the whole insert back. A ledger
-- records every inserted primary key under one batch id, so the down migration
-- can delete exactly the backfilled rows and nothing else — no new column on
-- any Lane A table.

create table legacy_backfill_rows (
  batch_id uuid not null,
  table_name text not null,
  pk jsonb not null,
  created_at timestamptz not null default now(),
  primary key (batch_id, table_name, pk));

-- Per-day lock for /api/jobs/backup. One row per local date; a second POST on
-- the same date finds the row and answers 409.
create table backup_runs (
  local_date date primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  bytes bigint,
  status text not null default 'running' check (status in ('running','ok','error')),
  error text);

alter table legacy_backfill_rows enable row level security;
alter table backup_runs enable row level security;   -- service role only; no policy for users

-- ai_calls records a failed call too, so the circuit breaker's history is
-- auditable. Additive; Lane A's create table is untouched.
alter table ai_calls add column if not exists status text not null default 'ok'
  check (status in ('ok','error'));
alter table ai_calls add column if not exists error text;

-- Private bucket for the nightly JSON dump. Vercel cannot write to ~/Backups.
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;

create or replace function backfill_legacy(p_user_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_expected jsonb := p_rows -> 'expected';
  v_entry jsonb;
  v_item jsonb;
  v_counts jsonb;
  n_user_foods int; n_food_refs int; n_prefs int; n_entries int; n_items int;
  n_water int; n_samples int; n_gut int; n_plan int;
begin
  if p_user_id is null then raise exception 'backfill_legacy: p_user_id is required'; end if;

  insert into user_foods (id, user_id, name, kind, per_100g, created_at)
  select (r ->> 'id')::uuid, p_user_id, r ->> 'name', r ->> 'kind',
         r -> 'per_100g', (r ->> 'created_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'user_foods') r;
  get diagnostics n_user_foods = row_count;

  insert into food_refs (id, kind, user_food_id)
  select (r ->> 'id')::uuid, r ->> 'kind', (r ->> 'user_food_id')::uuid
    from jsonb_array_elements(p_rows -> 'food_refs') r;
  get diagnostics n_food_refs = row_count;

  insert into user_food_prefs (user_id, food_ref_id, status, role, no_cook, note, updated_at)
  select p_user_id, (r ->> 'food_ref_id')::uuid, r ->> 'status', r ->> 'role',
         (r ->> 'no_cook')::boolean, r ->> 'note', (r ->> 'updated_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'user_food_prefs') r;
  get diagnostics n_prefs = row_count;

  n_entries := 0; n_items := 0;
  for v_entry in select * from jsonb_array_elements(p_rows -> 'log_entries') loop
    insert into log_entries (id, user_id, note, eaten_at, tz, local_date, slot, method)
    values ((v_entry ->> 'id')::uuid, p_user_id, v_entry ->> 'note',
            (v_entry ->> 'eaten_at')::timestamptz, v_entry ->> 'tz',
            (v_entry ->> 'local_date')::date, v_entry ->> 'slot', v_entry ->> 'method');
    n_entries := n_entries + 1;
    insert into legacy_backfill_rows (batch_id, table_name, pk)
    values (v_batch, 'log_entries', jsonb_build_object('id', v_entry ->> 'id'));

    for v_item in select * from jsonb_array_elements(v_entry -> 'items') loop
      insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot, was_edited)
      values ((v_item ->> 'id')::uuid, (v_entry ->> 'id')::uuid, (v_item ->> 'seq')::int,
              (v_item ->> 'qty')::numeric, v_item ->> 'unit',
              nullif(v_item ->> 'food_ref_id', '')::uuid, (v_item ->> 'grams')::numeric,
              v_item -> 'snapshot', (v_item ->> 'was_edited')::boolean);
      n_items := n_items + 1;
    end loop;
  end loop;

  insert into water_log (user_id, local_date, cups)
  select p_user_id, (r ->> 'local_date')::date, (r ->> 'cups')::int
    from jsonb_array_elements(p_rows -> 'water_log') r;
  get diagnostics n_water = row_count;

  insert into health_sources (id, user_id, kind, device_label, created_at)
  select (r ->> 'id')::uuid, p_user_id, r ->> 'kind', r ->> 'device_label',
         (r ->> 'created_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'health_sources') r;

  insert into health_samples (id, user_id, source_id, type, value, unit, start_time, end_time, tz)
  select (r ->> 'id')::uuid, p_user_id, (r ->> 'source_id')::uuid, r ->> 'type',
         (r ->> 'value')::numeric, r ->> 'unit', (r ->> 'start_time')::timestamptz,
         (r ->> 'end_time')::timestamptz, r ->> 'tz'
    from jsonb_array_elements(p_rows -> 'health_samples') r;
  get diagnostics n_samples = row_count;

  insert into gut_log (id, user_id, local_date, tz, state, note)
  select (r ->> 'id')::uuid, p_user_id, (r ->> 'local_date')::date, r ->> 'tz',
         r ->> 'state', r ->> 'note'
    from jsonb_array_elements(p_rows -> 'gut_log') r;
  get diagnostics n_gut = row_count;

  insert into plan_days (user_id, local_date, day_type_override, floor_day, swaps, slot_notes,
                         updated_at)
  select p_user_id, (r ->> 'local_date')::date, r ->> 'day_type_override',
         (r ->> 'floor_day')::boolean, r -> 'swaps', r -> 'slot_notes',
         (r ->> 'updated_at')::timestamptz
    from jsonb_array_elements(p_rows -> 'plan_days') r;
  get diagnostics n_plan = row_count;

  insert into user_settings (user_id, first_opened_at, scale_warning_dismissed, training_kcal,
                             rest_kcal, protein_g, protein_locked, ramp_override, slot_times,
                             shift_minutes, changed_at)
  select p_user_id, (s ->> 'first_opened_at')::timestamptz,
         (s ->> 'scale_warning_dismissed')::boolean, (s ->> 'training_kcal')::int,
         (s ->> 'rest_kcal')::int, (s ->> 'protein_g')::numeric,
         (s ->> 'protein_locked')::boolean, (s ->> 'ramp_override')::smallint,
         s -> 'slot_times', (s ->> 'shift_minutes')::int, (s ->> 'changed_at')::timestamptz
    from (select p_rows -> 'user_settings' as s) t;

  -- Ledger for every table the down migration must clean.
  insert into legacy_backfill_rows (batch_id, table_name, pk)
  select v_batch, 'user_foods', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'user_foods') r
  union all select v_batch, 'food_refs', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'food_refs') r
  union all select v_batch, 'user_food_prefs',
         jsonb_build_object('user_id', p_user_id, 'food_ref_id', r ->> 'food_ref_id')
    from jsonb_array_elements(p_rows -> 'user_food_prefs') r
  union all select v_batch, 'water_log',
         jsonb_build_object('user_id', p_user_id, 'local_date', r ->> 'local_date')
    from jsonb_array_elements(p_rows -> 'water_log') r
  union all select v_batch, 'health_sources', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'health_sources') r
  union all select v_batch, 'health_samples', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'health_samples') r
  union all select v_batch, 'gut_log', jsonb_build_object('id', r ->> 'id')
    from jsonb_array_elements(p_rows -> 'gut_log') r
  union all select v_batch, 'plan_days',
         jsonb_build_object('user_id', p_user_id, 'local_date', r ->> 'local_date')
    from jsonb_array_elements(p_rows -> 'plan_days') r
  union all select v_batch, 'user_settings', jsonb_build_object('user_id', p_user_id);

  v_counts := jsonb_build_object(
    'user_foods', n_user_foods, 'food_refs', n_food_refs, 'user_food_prefs', n_prefs,
    'log_entries', n_entries, 'log_items', n_items, 'water_log', n_water,
    'health_samples', n_samples, 'gut_log', n_gut, 'plan_days', n_plan, 'user_settings', 1);

  if v_expected is null then
    raise exception 'backfill_legacy: p_rows.expected is required';
  end if;
  if v_counts <> v_expected then
    raise exception 'backfill_legacy: count mismatch. inserted=% expected=%', v_counts, v_expected;
  end if;

  return jsonb_build_object('batch_id', v_batch, 'counts', v_counts);
end;
$$;

revoke execute on function backfill_legacy(uuid, jsonb) from public, anon, authenticated;
grant execute on function backfill_legacy(uuid, jsonb) to service_role;
```

- [ ] Run it: **[needs branch]**
  `supabase db push --db-url "$SUPABASE_TEST_DB_URL" --include-all`
  Expected: `Applying migration 20260911000700_legacy_backfill.sql... Finished`.
  Skip condition for CI: the step is not run in CI; CI's gate is `pnpm lint` + `tsc` + `pnpm test`,
  none of which read `supabase/migrations/`.

- [ ] Commit:
  `git add supabase/migrations/20260911000700_legacy_backfill.sql && git commit -m "feat(db): add the legacy backfill RPC, its ledger, the backup lock and the backups bucket"`

---

## Task 9 — Down migration and the legacy drop

**Files**
- Create: `supabase/migrations/20260911000710_legacy_backfill_down.sql`
- Create: `supabase/migrations/20260911000800_drop_legacy.sql`
- Test: exercised by Task 11.

**Interfaces**
- Consumes: `legacy_backfill_rows` from Task 8.
- Produces: `rollback_legacy_backfill(p_batch_id uuid) returns jsonb` — deletes only the ledgered rows, newest-dependency first; leaves `foods` / `days` / `settings` untouched.

**Steps**

- [ ] Write the failing check. **[needs branch]**
  `psql "$SUPABASE_TEST_DB_URL" -c "select rollback_legacy_backfill('00000000-0000-0000-0000-000000000000')"`
  Expected failure: `ERROR:  function rollback_legacy_backfill(unknown) does not exist`.
  Skip condition for CI: not run in CI.

- [ ] Minimal implementation. Create `supabase/migrations/20260911000710_legacy_backfill_down.sql`:

```sql
-- Rollback for the Phase 0 backfill. Deletes ONLY the rows the ledger names for
-- one batch. foods, days and settings are not touched; they are dropped by
-- 20260911000800_drop_legacy.sql in the cut-over release, after the manual gate.

create or replace function rollback_legacy_backfill(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted jsonb := '{}'::jsonb;
  n int;
begin
  -- log_items cascade from log_entries; delete children of ledgered parents first.
  delete from log_items i using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'log_entries'
     and i.entry_id = (l.pk ->> 'id')::uuid;

  delete from log_entries e using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'log_entries'
     and e.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('log_entries', n);

  delete from user_food_prefs p using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'user_food_prefs'
     and p.user_id = (l.pk ->> 'user_id')::uuid
     and p.food_ref_id = (l.pk ->> 'food_ref_id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('user_food_prefs', n);

  delete from food_refs f using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'food_refs' and f.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('food_refs', n);

  delete from user_foods u using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'user_foods' and u.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('user_foods', n);

  delete from health_samples s using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'health_samples' and s.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('health_samples', n);

  delete from health_sources h using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'health_sources' and h.id = (l.pk ->> 'id')::uuid;

  delete from gut_log g using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'gut_log' and g.id = (l.pk ->> 'id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('gut_log', n);

  delete from water_log w using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'water_log'
     and w.user_id = (l.pk ->> 'user_id')::uuid and w.local_date = (l.pk ->> 'local_date')::date;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('water_log', n);

  delete from plan_days d using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'plan_days'
     and d.user_id = (l.pk ->> 'user_id')::uuid and d.local_date = (l.pk ->> 'local_date')::date;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('plan_days', n);

  delete from user_settings s using legacy_backfill_rows l
   where l.batch_id = p_batch_id and l.table_name = 'user_settings'
     and s.user_id = (l.pk ->> 'user_id')::uuid;
  get diagnostics n = row_count; v_deleted := v_deleted || jsonb_build_object('user_settings', n);

  delete from legacy_backfill_rows where batch_id = p_batch_id;
  return v_deleted;
end;
$$;

revoke execute on function rollback_legacy_backfill(uuid) from public, anon, authenticated;
grant execute on function rollback_legacy_backfill(uuid) to service_role;
```

- [ ] Minimal implementation. Create `supabase/migrations/20260911000800_drop_legacy.sql`:

```sql
-- Cut-over release only (release B). Runs after Devin's manual gate on the
-- migrated data. Past this point the rollback is "restore the step-2 backup",
-- not "run the down migration". phase-0-foundations.md, Rollout and rollback.

drop table if exists foods;
drop table if exists days;
drop table if exists settings;
```

- [ ] Run it: **[needs branch]**
  `supabase db push --db-url "$SUPABASE_TEST_DB_URL" --include-all` then
  `psql "$SUPABASE_TEST_DB_URL" -c "select rollback_legacy_backfill('00000000-0000-0000-0000-000000000000')"`
  Expected: `{"log_entries": 0, "user_food_prefs": 0, ...}` — the function exists and a
  non-existent batch deletes nothing. Skip condition for CI: not run in CI.

- [ ] Commit:
  `git add supabase/migrations/20260911000710_legacy_backfill_down.sql supabase/migrations/20260911000800_drop_legacy.sql && git commit -m "feat(db): add the backfill rollback function and the legacy drop migration"`

---

## Task 10 — `scripts/migrate-legacy.ts`: load, refuse, insert

**Files**
- Create: `scripts/migrate-legacy.ts`
- Test: none of its own; its mapping is covered by Tasks 5–7, its SQL by Task 11.

**Interfaces**
- Consumes: `adminClient()` from `lib/server/admin.ts` (Lane B); `mapLegacyStore`, `MigrationResult` from `lib/migrate/legacy.ts`; `toCsv` from `lib/export/csv.ts`; `Food`, `Settings`, `StoredDay` shapes as written by `lib/server/db.ts` (`foods(id, data, updated_at)`, `days(date, data, updated_at)`, `settings(id='sasha', data, updated_at)`).
- Produces: a CLI. `pnpm exec tsx scripts/migrate-legacy.ts --dry-run` and `… --apply`. Exit 1 on any unresolved unit or any count mismatch.

This script runs with `pnpm exec tsx` (contracts §7): `tsx` is a devDependency on `main` and resolves
the `@/` tsconfig alias, so imports may use `@/…` or stay relative with the `.ts` extension.

**Steps**

- [ ] Write the failing check (the script's own contract, run by hand):
  `pnpm exec tsx scripts/migrate-legacy.ts --dry-run`
  Expected failure: `Cannot find module '.../scripts/migrate-legacy.ts'`.

- [ ] Minimal implementation. Create `scripts/migrate-legacy.ts`:

```ts
/**
 * Phase 0 backfill driver. Reads the three legacy jsonb tables with the admin
 * client, maps them with lib/migrate/legacy.ts, and inserts through
 * backfill_legacy() — one RPC, one transaction, count assertions inside.
 *
 *   pnpm exec tsx scripts/migrate-legacy.ts --dry-run
 *   pnpm exec tsx scripts/migrate-legacy.ts --apply
 *
 * Runs under tsx (contracts §7), which resolves the @/ tsconfig alias.
 *
 * It REFUSES to insert while docs/migration-unresolved.csv has rows. Every one
 * of those foods needs a gram weight from Devin first
 * (phase-0-foundations.md, open question 2).
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { adminClient } from "../lib/server/admin.ts";
import { toCsv } from "../lib/export/csv.ts";
import { mapLegacyStore, type LegacyStore } from "../lib/migrate/legacy.ts";
import type { Food } from "../lib/foods.ts";
import type { Settings, StoredDay } from "../lib/types.ts";

const UNRESOLVED_PATH = path.join(process.cwd(), "docs", "migration-unresolved.csv");
const TZ = "America/Los_Angeles";

type SettingsRecord = {
  settings: Settings; firstOpenedAt: string; scaleWarningDismissed?: boolean; updatedAt: string;
};

async function loadLegacy(): Promise<LegacyStore> {
  const db = adminClient();
  const [foods, days, settings] = await Promise.all([
    db.from("foods").select("id, data"),
    db.from("days").select("date, data"),
    db.from("settings").select("data").eq("id", "sasha").maybeSingle(),
  ]);
  if (foods.error) throw foods.error;
  if (days.error) throw days.error;
  if (settings.error) throw settings.error;
  const record = settings.data?.data as SettingsRecord | undefined;
  if (!record) throw new Error("legacy settings row 'sasha' is missing; refusing to migrate");
  return {
    firstOpenedAt: record.firstOpenedAt,
    scaleWarningDismissed: record.scaleWarningDismissed,
    settings: record.settings,
    days: Object.fromEntries((days.data ?? []).map((r) => [r.date, r.data as StoredDay])),
    foods: Object.fromEntries((foods.data ?? []).map((r) => [r.id, r.data as Food])),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const userId = process.env.SASHA_USER_ID;
  if (!userId) throw new Error("SASHA_USER_ID is not set");

  const store = await loadLegacy();
  const result = mapLegacyStore(store, {
    userId, tz: TZ, now: new Date().toISOString(), uuid: randomUUID,
  });

  await mkdir(path.dirname(UNRESOLVED_PATH), { recursive: true });
  await writeFile(
    UNRESOLVED_PATH,
    toCsv(result.unresolved, ["food_id", "name", "unit", "reason"]),
    "utf8"
  );

  console.log("legacy rows read:", {
    foods: Object.keys(store.foods).length, days: Object.keys(store.days).length,
  });
  console.log("mapped counts:", result.counts);

  if (result.unresolved.length > 0) {
    console.error(
      `refusing to insert: ${result.unresolved.length} food(s) have an unresolved unit.\n` +
        `resolve every row in ${UNRESOLVED_PATH}, then re-run.`
    );
    process.exit(1);
  }
  if (!apply) {
    console.log("dry run complete. re-run with --apply to insert.");
    return;
  }

  const { data, error } = await adminClient().rpc("backfill_legacy", {
    p_user_id: userId,
    p_rows: { ...result.rows, expected: result.counts },
  });
  if (error) {
    console.error("backfill_legacy failed; the transaction rolled back:", error.message);
    process.exit(1);
  }
  console.log("backfill applied:", data);
  console.log("rollback with: select rollback_legacy_backfill('" +
    (data as { batch_id: string }).batch_id + "');");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] Run it: **[needs branch]**
  `SASHA_USER_ID=<uuid> SUPABASE_URL=<branch url> SUPABASE_SERVICE_ROLE_KEY=<branch key> pnpm exec tsx scripts/migrate-legacy.ts --dry-run`
  Expected: `legacy rows read: { foods: N, days: M }`, `mapped counts: {...}`,
  `dry run complete. re-run with --apply to insert.` and exit 0 with an empty
  `docs/migration-unresolved.csv` (header row only).
  Skip condition for CI: the script is never run in CI. `pnpm exec tsc --noEmit` still type-checks it.

- [ ] Commit:
  `git add scripts/migrate-legacy.ts docs/migration-unresolved.csv && git commit -m "feat(migrate): add the backfill driver that refuses on any unresolved unit"`

---

## Task 11 — Rollback integration test

**Files**
- Create: `tests/migrate/rollback.test.ts`
- Test path: itself.

**Interfaces**
- Consumes: `backfill_legacy`, `rollback_legacy_backfill` from Tasks 8 and 9; `mapLegacyStore` from Task 7; `SUPABASE_TEST_URL` + `SUPABASE_TEST_SERVICE_ROLE_KEY` (contracts §7, defined by Lane A).
- Produces: nothing exported.

**Steps**

- [ ] Write the failing test. Create `tests/migrate/rollback.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "@/lib/store";
import { mapLegacyStore, type LegacyStore } from "@/lib/migrate/legacy";

const url = process.env.SUPABASE_TEST_URL;
const key = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const userId = process.env.SUPABASE_TEST_USER_ID;
// [needs branch] These are set only against a Supabase branch, never in CI.
const run = url && key && userId ? describe : describe.skip;

run("legacy backfill rollback", () => {
  const db = createClient(url!, key!, { auth: { persistSession: false } });
  let batchId = "";

  const store: LegacyStore = {
    firstOpenedAt: "2026-09-01T15:00:00.000Z",
    settings: defaultSettings(),
    days: {
      "2026-09-10": { date: "2026-09-10", waterMl: 960, weightLb: 141, gut: "good",
        eaten: { coffee: "2026-09-10T07:00:00.000Z" }, updatedAt: "2026-09-10T23:00:00.000Z" },
    },
    foods: {
      "white-rice": { id: "white-rice", name: "White rice, cooked", role: "carb", unit: "cup",
        perUnit: { protein: 4.3, carbs: 44.5, fat: 0.4 }, status: "eats",
        updatedAt: "2026-09-08T00:00:00.000Z" },
    },
  };
  const result = mapLegacyStore(store, {
    userId: userId!, tz: "America/Los_Angeles", now: new Date().toISOString(), uuid: randomUUID,
  });

  beforeAll(async () => {
    const { data, error } = await db.rpc("backfill_legacy", {
      p_user_id: userId!, p_rows: { ...result.rows, expected: result.counts },
    });
    expect(error).toBeNull();
    batchId = (data as { batch_id: string }).batch_id;
  });

  it("inserts exactly the mapped counts", async () => {
    const foods = await db.from("user_foods").select("id", { count: "exact", head: true })
      .eq("user_id", userId!);
    expect(foods.count).toBe(result.counts.user_foods);
    const entries = await db.from("log_entries").select("id", { count: "exact", head: true })
      .eq("user_id", userId!);
    expect(entries.count).toBe(result.counts.log_entries);
    const plan = await db.from("plan_days").select("local_date", { count: "exact", head: true })
      .eq("user_id", userId!);
    expect(plan.count).toBe(result.counts.plan_days);
  });

  it("raises and writes nothing when the expected counts do not match", async () => {
    const { error } = await db.rpc("backfill_legacy", {
      p_user_id: userId!,
      p_rows: { ...result.rows, expected: { ...result.counts, user_foods: 999 } },
    });
    expect(error?.message ?? "").toContain("count mismatch");
  });

  it("leaves the legacy tables intact and empties the new ones on rollback", async () => {
    const before = await db.from("foods").select("id", { count: "exact", head: true });
    const { error } = await db.rpc("rollback_legacy_backfill", { p_batch_id: batchId });
    expect(error).toBeNull();

    const after = await db.from("foods").select("id", { count: "exact", head: true });
    expect(after.count).toBe(before.count);

    for (const table of ["user_foods", "log_entries", "water_log", "gut_log", "plan_days",
      "health_samples", "user_settings"]) {
      const res = await db.from(table).select("*", { count: "exact", head: true })
        .eq("user_id", userId!);
      expect(`${table}=${res.count}`).toBe(`${table}=0`);
    }
  });
});
```

- [ ] Run it: `pnpm test tests/migrate/rollback.test.ts`
  Expected failure **with the branch env set**: `PGRST202 Could not find the function
  public.backfill_legacy`. Expected result **without it** (the CI case): `3 skipped`, exit 0.
  Skip condition for CI: `SUPABASE_TEST_URL` / `SUPABASE_TEST_SERVICE_ROLE_KEY` /
  `SUPABASE_TEST_USER_ID` are unset in CI, so `describe.skip` runs and `pnpm test` stays green.

- [ ] Minimal implementation: none — Tasks 8 and 9 supply the SQL. Apply it to the branch:
  **[needs branch]** `supabase db push --db-url "$SUPABASE_TEST_DB_URL" --include-all`

- [ ] Run it: `pnpm test tests/migrate/rollback.test.ts` → expected **PASS**, 3 tests (or
  `3 skipped` with no branch).

- [ ] Commit:
  `git add tests/migrate/rollback.test.ts && git commit -m "test(migrate): assert the backfill counts and that the rollback spares the legacy tables"`

---

## Task 12 — `GET /api/export`

**Files**
- Create: `app/api/export/route.ts`
- Test: `lib/export/csv.test.ts` (serialisation) plus `tests/export/cross-user.test.ts`, created below.

**Correction to an earlier draft of this plan.** It said "the behavioural gate is Lane A's
`tests/rls/cross-user.test.ts`, which already covers `/api/export` for a second user". It does not.
Lane A's file queries tables, views and RPCs straight through the Supabase client; it never issues an
HTTP request and never imports a route. Acceptance criterion 4 says "every table, view, function,
**route and export**", so the route half is this lane's to write, at `tests/export/cross-user.test.ts`
(contracts §1 row D names this path directly — it is no longer a contract change to use it).

**Interfaces**
- Consumes: `enforceRateLimit(key, limit, windowSeconds)`, `requireUser(req)`, `HttpError`, `jsonError` from Lane B; `toCsv` from `lib/export/csv.ts`; `createTestUsers()` from `tests/helpers/supabase.ts` (Lane A, contracts §1: returns `{ a: {client, userId}, b: {client, userId}, admin }`), for the cross-user test only.
- Produces: `export async function GET(req: Request): Promise<Response>`; `export const runtime = "nodejs"`; `export const dynamic = "force-dynamic"`.

**Steps**

- [ ] Write the failing check (type gate, since the route is wiring):
  `pnpm exec tsc --noEmit`
  Expected failure before the file exists: nothing fails — so instead assert the route's shape by
  importing it in a scratch check. Run:
  `node -e "require('node:fs').accessSync('app/api/export/route.ts')"`
  Expected failure: `ENOENT: no such file or directory, access 'app/api/export/route.ts'`.

- [ ] Minimal implementation. Create `app/api/export/route.ts`:

```ts
/**
 * GET /api/export?kind=…&format=…&page=
 *
 * User-scoped read. RLS does the tenancy work; the handler only decides which
 * table, which columns and which page. Every row carries tz and local_date so a
 * spreadsheet reads the same day she saw. architecture.md §4.6.
 */

import { toCsv } from "@/lib/export/csv";
import { HttpError, requireUser } from "@/lib/server/auth";
import { jsonError } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;

type Kind = "meals" | "progress" | "recipes" | "favorites" | "water";

const SOURCES: Record<Kind, { from: string; select: string; order: string; columns: string[] }> = {
  meals: {
    from: "log_entries",
    select: "id, local_date, tz, eaten_at, slot, method, note, deleted_at, " +
      "log_items(seq, qty, unit, grams, food_ref_id, snapshot)",
    order: "eaten_at",
    columns: ["id", "local_date", "tz", "eaten_at", "slot", "method", "note", "seq", "qty",
      "unit", "grams", "food_ref_id", "energy_kcal", "protein_g", "carbohydrate_g", "fat_g"],
  },
  progress: {
    from: "weigh_ins", select: "id, local_date, start_time, value, unit", order: "start_time",
    columns: ["id", "local_date", "tz", "start_time", "value", "unit"],
  },
  recipes: {
    from: "recipes", select: "id, name, rev, servings, yield_grams, deleted_at", order: "name",
    columns: ["id", "local_date", "tz", "name", "rev", "servings", "yield_grams"],
  },
  favorites: {
    from: "favorites_foods", select: "food_ref_id, sort", order: "sort",
    columns: ["local_date", "tz", "food_ref_id", "sort"],
  },
  water: {
    from: "water_log", select: "local_date, cups, rev", order: "local_date",
    columns: ["local_date", "tz", "cups", "rev"],
  },
};

type Row = Record<string, unknown>;
type MealRow = Row & { tz: string; log_items?: Row[] };

/** One CSV line per item, so a meal with three foods is three rows. */
function flattenMeals(rows: MealRow[]): Row[] {
  const out: Row[] = [];
  for (const entry of rows) {
    const { log_items: items, ...head } = entry;
    if (!items?.length) { out.push(head); continue; }
    for (const item of items) {
      const snapshot = (item.snapshot ?? {}) as Record<string, unknown>;
      out.push({ ...head, ...item, ...snapshot, snapshot: undefined });
    }
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await enforceRateLimit(`export:ip:${ip}`, 60, 3600);
    const { userId, client } = await requireUser(req);
    await enforceRateLimit(`export:user:${userId}`, 10, 3600);

    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") ?? "";
    const format = url.searchParams.get("format") ?? "json";
    const page = Number(url.searchParams.get("page") ?? "0");
    if (!(kind in SOURCES)) throw new HttpError(400, "bad_request", "unknown kind");
    if (format !== "csv" && format !== "json") {
      throw new HttpError(400, "bad_request", "unknown format");
    }
    if (!Number.isInteger(page) || page < 0) {
      throw new HttpError(400, "bad_request", "page must be a non-negative integer");
    }

    const source = SOURCES[kind as Kind];
    const from = page * PAGE_SIZE;
    const { data, error } = await client
      .from(source.from)
      .select(source.select)
      .order(source.order, { ascending: true })
      .range(from, from + PAGE_SIZE);
    if (error) throw new HttpError(500, "internal", error.message);

    const raw = (data ?? []) as MealRow[];
    const hasMore = raw.length > PAGE_SIZE;
    const pageRows = hasMore ? raw.slice(0, PAGE_SIZE) : raw;
    const rows = kind === "meals" ? flattenMeals(pageRows) : (pageRows as Row[]);

    if (format === "json") {
      return Response.json({ rows, next_page: hasMore ? page + 1 : null });
    }
    return new Response(toCsv(rows, source.columns), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${kind}-page-${page}.csv"`,
      },
    });
  } catch (e) {
    return jsonError(e);
  }
}
```

- [ ] Run it: `pnpm exec tsc --noEmit && pnpm lint` → expected **PASS** (no errors).

- [ ] Write the cross-user gate. Create `tests/export/cross-user.test.ts`:

```ts
/**
 * Acceptance criterion 4's "route and export" half for /api/export, at the HTTP
 * layer. Lane A's tests/rls/cross-user.test.ts proves table and RPC denial; it
 * never calls a route. This calls the real handler with user B's session while
 * user A holds meal rows, and asserts B sees none of them.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GET } from "../../app/api/export/route";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";

const run = HAS_BRANCH ? describe : describe.skip;

function request(kind: string, accessToken?: string): Request {
  return new Request(`https://app.test/api/export?kind=${kind}&format=json`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

run("GET /api/export cross-user denial", () => {
  let bToken = "";

  beforeAll(async () => {
    const { a, b, admin } = await createTestUsers();

    // A meal row of user A's that user B must never see.
    const entry = await admin
      .from("log_entries")
      .insert({ user_id: a.userId, local_date: "2026-09-11", tz: "America/Los_Angeles",
        eaten_at: "2026-09-11T18:00:00Z", slot: "meal2", method: "search" })
      .select("id").single();
    expect(entry.error).toBeNull();

    const session = await b.client.auth.getSession();
    expect(session.data.session).not.toBeNull();
    bToken = session.data.session!.access_token;
  });

  it("401s with no session at all", async () => {
    const res = await GET(request("meals"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("returns zero of user A's meal rows to user B", async () => {
    const res = await GET(request("meals", bToken));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ rows: [] });
  });
});
```

- [ ] Run it: `pnpm test tests/export/cross-user.test.ts`
  Expected without a branch: `2 skipped`, 0 failed — the CI behaviour.
  **[needs branch]** with `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY` and
  `SUPABASE_TEST_SERVICE_ROLE_KEY` set: `Tests  2 passed (2)`.

- [ ] Commit:
  `git add app/api/export/route.ts tests/export/cross-user.test.ts && git commit -m "feat(export): add the user-scoped paginated export route and its cross-user gate"`

---

## Task 13 — `POST /api/jobs/backup`, the two Mac-side scripts, and the launchd timer

**Files**
- Create: `app/api/jobs/backup/route.ts`
- Create: `scripts/backup.sh`
- Create: `scripts/restore-to-branch.sh`
- Create: `launchd/com.zs.smc-backup.plist`
- Create: `scripts/install-backup-timer.sh`
- Test: none of its own; `backup_runs` and the `backups` bucket come from Task 8.

**Interfaces**
- Consumes: `adminClient()` from Lane B; `backup_runs`, `storage.buckets` row `backups` from Task 8; `CRON_SECRET`.
- Produces: `export async function POST(req: Request): Promise<Response>` returning `{ ok: true, bytes: number }`, 401 on a bad bearer, 409 when a run already holds the day's lock.

**Backup is two-part** (resolves the open question about backup artefact location — the earlier
draft asked whether the bucket/Mac-script split satisfies criterion 13 or whether the Mac script
should get a real timer; it gets one, below, and the question is closed). The route above writes the JSON dump to the
private Storage bucket `backups` — that half runs on Vercel and needs nothing from this machine.
The `.sql` dump under `~/Backups/supabase/meal-companion/` that acceptance criterion 13 actually
measures needs a Mac that is awake on a schedule, which a Vercel cron cannot provide; that half is
`scripts/backup.sh` plus a `launchd` user agent installed by `scripts/install-backup-timer.sh`. This
is not a fallback for the route — both artefacts are kept, because they protect against different
failures (a compromised or paused Supabase project vs. a dead Mac).

**Steps**

- [ ] Write the failing check:
  `node -e "require('node:fs').accessSync('app/api/jobs/backup/route.ts')"`
  Expected failure: `ENOENT: no such file or directory, access 'app/api/jobs/backup/route.ts'`.

- [ ] Minimal implementation. Create `app/api/jobs/backup/route.ts`:

```ts
/**
 * POST /api/jobs/backup — Vercel cron.
 *
 * A Vercel function has no writable home directory, so the nightly artefact is
 * a JSON dump of the user tables in the PRIVATE Supabase Storage bucket
 * 'backups'. The real .sql dump under ~/Backups/supabase/meal-companion/ is
 * produced by scripts/backup.sh on the Mac, which is what acceptance criterion
 * 13 measures.
 *
 * One run per local date: backup_runs.local_date is the lock.
 */

import { timingSafeEqual } from "node:crypto";
import { adminClient } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TABLES = [
  "user_foods", "food_refs", "user_food_prefs", "log_entries", "log_items", "water_log",
  "plan_days", "user_settings", "gut_log", "health_sources", "health_samples",
  "target_profiles", "constraint_profiles", "duplicate_groups", "duplicate_group_members",
  "api_tokens", "change_log", "change_seq",
] as const;

function bearerOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function POST(req: Request): Promise<Response> {
  if (!bearerOk(req)) {
    return Response.json({ error: "unauthorized", message: "bad cron secret" }, { status: 401 });
  }
  const db = adminClient();
  const localDate = new Date().toISOString().slice(0, 10);

  const lock = await db.from("backup_runs").insert({ local_date: localDate }).select("local_date");
  if (lock.error) {
    return Response.json(
      { error: "conflict", message: "a run already holds today's lock" }, { status: 409 }
    );
  }

  try {
    const dump: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const { data, error } = await db.from(table).select("*");
      if (error) throw new Error(`${table}: ${error.message}`);
      dump[table] = data ?? [];
    }
    const body = Buffer.from(
      JSON.stringify({ taken_at: new Date().toISOString(), tables: dump }), "utf8"
    );
    const upload = await db.storage
      .from("backups")
      .upload(`meal-companion/${localDate}.json`, body, {
        contentType: "application/json", upsert: true,
      });
    if (upload.error) throw new Error(upload.error.message);

    await db.from("backup_runs")
      .update({ finished_at: new Date().toISOString(), bytes: body.byteLength, status: "ok" })
      .eq("local_date", localDate);
    return Response.json({ ok: true, bytes: body.byteLength });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown";
    await db.from("backup_runs")
      .update({ finished_at: new Date().toISOString(), status: "error", error: message })
      .eq("local_date", localDate);
    return Response.json({ error: "internal", message: "backup failed" }, { status: 500 });
  }
}
```

- [ ] Minimal implementation. Create `scripts/backup.sh`:

```bash
#!/usr/bin/env bash
# Nightly Supabase dump, on the Mac. Keeps the last 14.
#   scripts/backup.sh                  # uses SUPABASE_DB_URL, writes one dump
#   SUPABASE_DB_URL=… scripts/backup.sh
#
# Scheduling lives in scripts/install-backup-timer.sh + launchd/com.zs.smc-backup.plist,
# not in this script — this file only ever produces one dump and exits.
#
# Acceptance criterion 13 measures the dated dump under
# ~/Backups/supabase/meal-companion/ and the 14-file retention.
# Backups are machine state, never a deliverable: ~/Backups, never ~/Inbox.
set -euo pipefail

DEST="${HOME}/Backups/supabase/meal-companion"
KEEP=14
STAMP="$(date +%Y-%m-%d)"

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"

mkdir -p "${DEST}"
OUT="${DEST}/${STAMP}.sql"

supabase db dump --db-url "${SUPABASE_DB_URL}" --data-only --file "${OUT}.tmp"
supabase db dump --db-url "${SUPABASE_DB_URL}" --file "${OUT}.schema.tmp"
cat "${OUT}.schema.tmp" "${OUT}.tmp" > "${OUT}"
rm -f "${OUT}.tmp" "${OUT}.schema.tmp"

BYTES="$(wc -c < "${OUT}" | tr -d ' ')"
if [ "${BYTES}" -lt 1024 ]; then
  echo "refusing a dump of ${BYTES} bytes — something went wrong" >&2
  rm -f "${OUT}"
  exit 1
fi

# Retention: keep the newest KEEP dumps, delete the rest.
ls -1t "${DEST}"/*.sql 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r old; do
  rm -f "${old}"
done

echo "wrote ${OUT} (${BYTES} bytes); keeping the last ${KEEP}"
```

- [ ] Minimal implementation. Create `scripts/restore-to-branch.sh`:

```bash
#!/usr/bin/env bash
# Restore one dump from scripts/backup.sh into a Supabase BRANCH.
#   scripts/restore-to-branch.sh ~/Backups/supabase/meal-companion/2026-09-11.sql "$BRANCH_DB_URL"
# Refuses a URL that is not a branch, so a production restore is never one typo away.
set -euo pipefail

DUMP="${1:?usage: restore-to-branch.sh <dump.sql> <branch db url>}"
TARGET="${2:?usage: restore-to-branch.sh <dump.sql> <branch db url>}"

[ -f "${DUMP}" ] || { echo "no such dump: ${DUMP}" >&2; exit 1; }

case "${TARGET}" in
  *fivatgdpuenszxxnijpc*)
    echo "that is the production project. restore into a branch, then promote it." >&2
    exit 1;;
esac

echo "restoring ${DUMP} into ${TARGET%%@*}@… — this replaces the branch's data."
read -r -p "type the branch ref to confirm: " CONFIRM
case "${TARGET}" in
  *"${CONFIRM}"*) : ;;
  *) echo "confirmation did not match the target. nothing done." >&2; exit 1;;
esac

psql "${TARGET}" --single-transaction --set ON_ERROR_STOP=1 --file "${DUMP}"
echo "restored."
```

- [ ] Minimal implementation. Create `launchd/com.zs.smc-backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.zs.smc-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>/Users/zero-suminc./projects/clients/Sasha/meal-companion/scripts/backup.sh</string>
  </array>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>15</integer>
  </dict>
  <key>StandardOutPath</key><string>/Users/zero-suminc./Library/Logs/smc-backup.log</string>
  <key>StandardErrorPath</key><string>/Users/zero-suminc./Library/Logs/smc-backup.log</string>
</dict></plist>
```

`RunAtLoad` is `false`: bootstrapping the agent must not itself trigger a dump outside the 03:15
window. `SUPABASE_DB_URL` is deliberately absent from the plist — `backup.sh` reads it from the
login shell's environment via `zsh -lc`, so no database URL sits in a world-readable-by-default
LaunchAgents file.

- [ ] Minimal implementation. Create `scripts/install-backup-timer.sh`:

```bash
#!/usr/bin/env bash
# Installs (or reinstalls) the launchd timer that runs scripts/backup.sh nightly.
#   scripts/install-backup-timer.sh
set -euo pipefail

LABEL="com.zs.smc-backup"
SELF_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SELF_DIR}/launchd/${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

[ -f "${SRC}" ] || { echo "no such plist: ${SRC}" >&2; exit 1; }

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cp "${SRC}" "${DEST}"
chmod 600 "${DEST}"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${DEST}"
launchctl print "gui/$(id -u)/${LABEL}" | head -5

echo
echo "installed ${LABEL}. verify with:"
echo "  launchctl kickstart -k gui/\$(id -u)/${LABEL} && ls ~/Backups/supabase/meal-companion"
```

- [ ] Run it:
  `chmod +x scripts/backup.sh scripts/restore-to-branch.sh scripts/install-backup-timer.sh && pnpm exec tsc --noEmit && pnpm lint`
  → expected **PASS**.
  **[needs branch]** live dump check: `SUPABASE_DB_URL="$SUPABASE_TEST_DB_URL" scripts/backup.sh`
  Expected: `wrote /Users/…/Backups/supabase/meal-companion/<date>.sql (N bytes); keeping the last 14`.
  **[local machine]** install the timer: `scripts/install-backup-timer.sh`
  Expected: the `launchctl print` block, then `installed com.zs.smc-backup. verify with: …`.
  **[local machine]** manual verification, run once right after installing:
  `launchctl kickstart -k gui/$(id -u)/com.zs.smc-backup`
  then `ls ~/Backups/supabase/meal-companion`
  Expected: a fresh `<today>.sql` in the listing. This, plus the route above, is acceptance
  criterion 13 in full — the Storage-bucket dump for the off-machine copy, the `launchd` timer for
  the dated `~/Backups/…` artefact with 14-file retention.
  Skip condition for CI: none of these three run in CI; CI does not have `supabase login`, a db URL,
  or a `launchd` user session.

- [ ] Commit:
  `git add app/api/jobs/backup/route.ts scripts/backup.sh scripts/restore-to-branch.sh launchd/com.zs.smc-backup.plist scripts/install-backup-timer.sh && git commit -m "feat(backup): add the nightly dump route, the Mac dump script, the branch restore and the launchd timer"`

---

## Task 14 — AI adapter: pinned models and pinned SDK

**Files**
- Create: `lib/ai/adapter.ts`
- Test: `lib/ai/adapter.test.ts`

**Interfaces**
- Consumes: the installed `@google/genai` package metadata.
- Produces (contracts §6):

```ts
export const MODELS = { textToItems: 'gemini-3.8-flash', voiceToItems: 'gemini-3.8-flash',
  labelToNutrients: 'gemini-3.8-flash', photoToItems: 'gemini-3.8-flash',
  coach: 'anthropic/claude-sonnet-5', weeklyReview: 'anthropic/claude-opus-5' } as const;
export const PINNED_GENAI_MAJOR = 2;   // contracts §7; @google/genai 2.21.x installed on main
export function installedGenai(): { version: string; major: number };
export function assertPinnedSdk(read?: () => { version: string; major: number }): void;
```

**Steps**

- [ ] Write the failing test. Create `lib/ai/adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertPinnedSdk, installedGenai, MODELS, PINNED_GENAI_MAJOR } from "./adapter";

describe("MODELS", () => {
  it("pins every purpose to a literal id with no 'latest' alias", () => {
    expect(Object.values(MODELS)).toEqual([
      "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash",
      "anthropic/claude-sonnet-5", "anthropic/claude-opus-5",
    ]);
    for (const id of Object.values(MODELS)) {
      expect(id).not.toMatch(/latest/);
      expect(id).not.toMatch(/^\$\{|process\.env/);
    }
  });
});

describe("assertPinnedSdk", () => {
  it("passes when the installed major matches the pin", () => {
    expect(() =>
      assertPinnedSdk(() => ({ version: `${PINNED_GENAI_MAJOR}.9.9`, major: PINNED_GENAI_MAJOR }))
    ).not.toThrow();
  });

  it("throws and names both versions when the major drifts", () => {
    expect(() => assertPinnedSdk(() => ({ version: "3.0.0", major: 3 }))).toThrow(
      "@google/genai major 3 is installed; Phase 0 pins major 2"
    );
  });

  it("reads the real installed version from disk", () => {
    const installed = installedGenai();
    expect(installed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(installed.major).toBe(PINNED_GENAI_MAJOR);
  });
});
```

- [ ] Run it: `pnpm test lib/ai/adapter.test.ts`
  Expected failure: `Failed to load url ./adapter` / `Cannot find module './adapter'`.

- [ ] Minimal implementation. Create `lib/ai/adapter.ts`:

```ts
/**
 * The one place a model is chosen and a model call is made. architecture.md §6.
 *
 * Model ids are LITERALS. An env-var-driven id, or a "latest" alias, would make
 * a silent provider change indistinguishable from a deploy, which is exactly
 * what the pin exists to prevent. The installed SDK major is asserted for the
 * same reason: a major upgrade gets its own canary, deliberately.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const MODELS = {
  textToItems: "gemini-3.8-flash",
  voiceToItems: "gemini-3.8-flash",
  labelToNutrients: "gemini-3.8-flash",
  photoToItems: "gemini-3.8-flash",
  coach: "anthropic/claude-sonnet-5",
  weeklyReview: "anthropic/claude-opus-5",
} as const;

export type Purpose = keyof typeof MODELS;

/**
 * contracts §7: "Pinned SDK major for assertPinnedSdk(): @google/genai major = 2
 * (correction: the spec said 1 before install)". 2.21.x is what `pnpm add
 * @google/genai` put on main on 2026-09-10, and the spec's Test plan names the
 * same number. A major bump gets its own canary run, deliberately.
 */
export const PINNED_GENAI_MAJOR = 2;

/**
 * pnpm keeps the real package under node_modules/.pnpm, and @google/genai does
 * not export ./package.json, so neither a bare require nor a relative path
 * works. Resolve the entry point and walk up to its own manifest.
 */
export function installedGenai(): { version: string; major: number } {
  const require = createRequire(path.join(process.cwd(), "noop.js"));
  let dir = path.dirname(require.resolve("@google/genai"));
  for (let i = 0; i < 8; i++) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string; version?: string;
      };
      if (manifest.name === "@google/genai" && manifest.version) {
        return { version: manifest.version, major: Number(manifest.version.split(".")[0]) };
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not read the installed @google/genai version");
}

export function assertPinnedSdk(read: () => { version: string; major: number } = installedGenai): void {
  const { major } = read();
  if (major !== PINNED_GENAI_MAJOR) {
    throw new Error(
      `@google/genai major ${major} is installed; Phase 0 pins major ${PINNED_GENAI_MAJOR}`
    );
  }
}
```

- [ ] Run it: `pnpm test lib/ai/adapter.test.ts` → expected **PASS**, 4 tests, against the
  `@google/genai` 2.21.x already on `main`. If the third case fails with `expected N to be 2`, the
  installed SDK has drifted from contracts §7 — fix the install or land a contract change; **do not
  weaken the test to make it pass.**

- [ ] Commit:
  `git add lib/ai/adapter.ts lib/ai/adapter.test.ts && git commit -m "feat(ai): pin model ids and assert the installed genai major"`

---

## Task 15 — AI adapter: `generateStructured`, retries, circuit breaker, `ai_calls`

**Files**
- Modify: `lib/ai/adapter.ts`
- Test: `lib/ai/adapter.test.ts`

**Interfaces**
- Consumes: `SupabaseClient` (the admin client, passed in by the caller — the adapter never builds one); `z` and `ZodType` from `zod` (**`z.toJSONSchema` is Zod 4's own JSON-Schema emitter — contracts §7 forbids `zod-to-json-schema`**); `Part` from `@google/genai`; `AI_DAILY_SPEND_CAP_USD` (contracts §5); `HttpError` from `@/lib/server/auth` (Lane B).
- Produces:

```ts
export type ProviderResult = { text: string; inputTokens: number; outputTokens: number };
export type GenerateArgs<T> = { purpose: Purpose; userId: string; schema: ZodType<T>;
  parts: Part[]; admin: SupabaseClient };
export type GenerateDeps = { sleep?: (ms: number) => Promise<void>;
  callGemini?: (model: string, parts: Part[], jsonSchema: unknown) => Promise<ProviderResult>;
  callNous?: (model: string, parts: Part[]) => Promise<ProviderResult> };
export async function generateStructured<T>(args: GenerateArgs<T>, deps?: GenerateDeps): Promise<T>;
export function __resetCircuit(): void;   // test-only
```

**The daily spend cap is part of this task** (contracts §6). Before every provider call,
`generateStructured` reads `select sum(cost_estimate) from ai_calls where user_id = $1 and
created_at >= date_trunc('day', now() at time zone 'UTC')` through the admin client (implemented as
a `select` + `eq` + `gte`, summed client-side — postgrest has no bare aggregate endpoint this
adapter can call without its own RPC). If that sum is `≥ Number(process.env.AI_DAILY_SPEND_CAP_USD
?? '2')`, it throws `new HttpError(429, 'spend_cap', …)` and calls no provider. Every row it writes
now carries a real `cost_estimate`, computed from the call's actual token counts against a small
per-model USD-per-million-tokens table, so the next sum has something accurate to add.

**Steps**

- [ ] Write the failing test. Append to `lib/ai/adapter.test.ts`:

```ts
import { beforeEach, vi } from "vitest";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { __resetCircuit, generateStructured } from "./adapter";

type AiCall = Record<string, unknown>;

/** `spend` seeds the ai_calls rows the spend-cap read sums for today. */
function fakeAdmin(spend: number[] = []): {
  client: { from: (t: string) => unknown }; calls: AiCall[];
} {
  const calls: AiCall[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: AiCall) => {
        if (table === "ai_calls") calls.push(row);
        return { error: null };
      },
      // the spend-cap read: .select().eq().gte() resolves to { data, error }
      select: () => {
        const chain = {
          eq: () => chain,
          gte: async () => ({ data: spend.map((cost_estimate) => ({ cost_estimate })), error: null }),
        };
        return chain;
      },
    }),
  };
  return { client, calls };
}

const schema = z.object({ items: z.array(z.object({ name: z.string(), grams: z.number() })) });
const noSleep = async (): Promise<void> => {};
/** Every provider dep now returns token counts alongside the raw text. */
const okResult = (body: unknown, inputTokens = 5, outputTokens = 8) =>
  async () => ({ text: JSON.stringify(body), inputTokens, outputTokens });

describe("generateStructured", () => {
  beforeEach(() => {
    __resetCircuit();
    vi.unstubAllEnvs();
  });

  it("validates the model's JSON and writes one ok ai_calls row", async () => {
    const { client, calls } = fakeAdmin();
    const out = await generateStructured(
      { purpose: "textToItems", userId: "u1", schema, parts: [{ text: "two eggs" }],
        admin: client as never },
      { sleep: noSleep, callGemini: okResult({ items: [{ name: "Egg", grams: 100 }] }, 12, 20) }
    );
    expect(out).toEqual({ items: [{ name: "Egg", grams: 100 }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      user_id: "u1", purpose: "textToItems", provider: "google",
      model_id: "gemini-3.8-flash", status: "ok", input_tokens: 12, output_tokens: 20,
    });
    expect(calls[0].sdk_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof calls[0].latency_ms).toBe("number");
  });

  it("retries twice, then succeeds, and writes one row for the successful call", async () => {
    const { client, calls } = fakeAdmin();
    const callGemini = vi.fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({ text: JSON.stringify({ items: [] }), inputTokens: 3, outputTokens: 1 });
    const out = await generateStructured(
      { purpose: "textToItems", userId: "u1", schema, parts: [], admin: client as never },
      { sleep: noSleep, callGemini }
    );
    expect(out).toEqual({ items: [] });
    expect(callGemini).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => c.status)).toEqual(["ok"]);
  });

  it("writes an error ai_calls row when every attempt fails", async () => {
    const { client, calls } = fakeAdmin();
    await expect(
      generateStructured(
        { purpose: "textToItems", userId: "u1", schema, parts: [], admin: client as never },
        { sleep: noSleep, callGemini: async () => { throw new Error("boom"); } }
      )
    ).rejects.toThrow("boom");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      status: "error", error: "boom", input_tokens: 0, output_tokens: 0, cost_estimate: 0,
    });
  });

  it("rejects output the schema does not accept", async () => {
    const { client, calls } = fakeAdmin();
    await expect(
      generateStructured(
        { purpose: "textToItems", userId: "u1", schema, parts: [], admin: client as never },
        { sleep: noSleep, callGemini: okResult({ items: [{ name: 1 }] }) }
      )
    ).rejects.toThrow(/schema/i);
    expect(calls[0].status).toBe("error");
  });

  it("opens the circuit after five failures in ten minutes", async () => {
    const { client } = fakeAdmin();
    const boom = {
      sleep: noSleep,
      callGemini: async (): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
        throw new Error("x");
      },
    };
    const args = { purpose: "textToItems" as const, userId: "u1", schema, parts: [],
      admin: client as never };
    for (let i = 0; i < 5; i++) await expect(generateStructured(args, boom)).rejects.toThrow("x");
    await expect(generateStructured(args, boom)).rejects.toThrow(
      "circuit open for google: 5 failures in the last 10 minutes"
    );
  });

  it("refuses before it calls a provider once today's spend reaches a custom cap", async () => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "0.50");
    const { client, calls } = fakeAdmin([0.4, 0.12]);
    const callGemini = vi.fn();
    await expect(
      generateStructured(
        { purpose: "textToItems", userId: "u1", schema, parts: [], admin: client as never },
        { sleep: noSleep, callGemini }
      )
    ).rejects.toMatchObject({ status: 429, code: "spend_cap" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses at the default $2 cap with no env override, from a mocked admin returning a sum of 2.0", async () => {
    const { client, calls } = fakeAdmin([2.0]);
    const callGemini = vi.fn();
    const rejection = await generateStructured(
      { purpose: "textToItems", userId: "u1", schema, parts: [], admin: client as never },
      { sleep: noSleep, callGemini }
    ).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(HttpError);
    expect(rejection).toMatchObject({ status: 429, code: "spend_cap" });
    expect(callGemini).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("writes a cost_estimate computed from token counts that the next call's cap check can add up", async () => {
    const { client, calls } = fakeAdmin();
    await generateStructured(
      { purpose: "textToItems", userId: "u1", schema, parts: [{ text: "two eggs" }],
        admin: client as never },
      { sleep: noSleep, callGemini: okResult({ items: [] }, 100_000, 50_000) }
    );
    // gemini-3.8-flash placeholders: $0.10/$0.40 per 1M tokens (input/output).
    expect(calls[0].cost_estimate).toBeCloseTo(100_000 / 1_000_000 * 0.1 + 50_000 / 1_000_000 * 0.4, 6);
  });

  it("routes a coach purpose to Nous, not to Gemini", async () => {
    const { client, calls } = fakeAdmin();
    const callGemini = vi.fn();
    await generateStructured(
      { purpose: "coach", userId: "u1", schema, parts: [{ text: "how did the week go?" }],
        admin: client as never },
      { sleep: noSleep, callGemini, callNous: okResult({ items: [] }, 30, 15) }
    );
    expect(callGemini).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      provider: "nous", model_id: "anthropic/claude-sonnet-5", input_tokens: 30, output_tokens: 15,
    });
  });
});
```

- [ ] Run it: `pnpm test lib/ai/adapter.test.ts`
  Expected failure: `"generateStructured" is not exported by "lib/ai/adapter.ts"`.

- [ ] Minimal implementation. Append to `lib/ai/adapter.ts`:

```ts
import { createHash } from "node:crypto";
import { GoogleGenAI, type Part } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z, type ZodType } from "zod";
import { HttpError } from "@/lib/server/auth";

const RETRIES = 2;                    // 3 attempts in total
const BACKOFF_MS = [250, 1000];
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const CIRCUIT_THRESHOLD = 5;
const DEFAULT_SPEND_CAP_USD = "2";

const NOUS_PURPOSES = new Set<Purpose>(["coach", "weeklyReview"]);

/**
 * USD per 1,000,000 tokens, input and output priced separately.
 * gemini-3.8-flash: PLACEHOLDERS — verify against ai.google.dev pricing at Phase 0.
 * The anthropic figures (served through Nous Portal) are a flat input=output
 * placeholder carried over from the per-character table this replaces. Both
 * feed AI_DAILY_SPEND_CAP_USD, which is a brake on a runaway loop, not an invoice.
 */
const PRICE_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "gemini-3.8-flash": { input: 0.1, output: 0.4 },
  "anthropic/claude-sonnet-5": { input: 3.75, output: 3.75 },
  "anthropic/claude-opus-5": { input: 18.75, output: 18.75 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICE_PER_MILLION_TOKENS[model] ?? { input: 1, output: 1 };
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

function spendCapUsd(): number {
  return Number(process.env.AI_DAILY_SPEND_CAP_USD ?? DEFAULT_SPEND_CAP_USD);
}

/**
 * contracts §6: "select sum(cost_estimate) from ai_calls where user_id = $1 and
 * created_at >= date_trunc('day', now() at time zone 'UTC')", read through the
 * admin client — implemented as select + eq + gte, summed client-side, since
 * postgrest exposes no bare aggregate this adapter can call without its own
 * RPC. A failed read does not take the AI path down with it — the circuit
 * breaker is the backstop for a sick database.
 */
async function assertUnderSpendCap(admin: SupabaseClient, userId: string): Promise<void> {
  const cap = spendCapUsd();
  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`; // date_trunc('day', now() at time zone 'UTC')
  const { data, error } = await admin
    .from("ai_calls").select("cost_estimate").eq("user_id", userId).gte("created_at", dayStart);
  if (error) return;
  const spent = (data ?? []).reduce(
    (sum, row) => sum + (Number((row as { cost_estimate: unknown }).cost_estimate) || 0), 0
  );
  if (spent >= cap) {
    throw new HttpError(
      429, "spend_cap", `daily AI spend cap reached: $${spent.toFixed(2)} of $${cap.toFixed(2)}`
    );
  }
}

/** provider → failure timestamps inside the window. Module-level, per instance. */
const failures = new Map<string, number[]>();

export function __resetCircuit(): void {
  failures.clear();
}

function assertCircuitClosed(provider: string): void {
  const recent = (failures.get(provider) ?? []).filter((t) => Date.now() - t < CIRCUIT_WINDOW_MS);
  failures.set(provider, recent);
  if (recent.length >= CIRCUIT_THRESHOLD) {
    throw new Error(
      `circuit open for ${provider}: ${CIRCUIT_THRESHOLD} failures in the last 10 minutes`
    );
  }
}

function recordFailure(provider: string): void {
  const recent = (failures.get(provider) ?? []).filter((t) => Date.now() - t < CIRCUIT_WINDOW_MS);
  recent.push(Date.now());
  failures.set(provider, recent);
}

export type ProviderResult = { text: string; inputTokens: number; outputTokens: number };

async function geminiCall(model: string, parts: Part[], jsonSchema: unknown): Promise<ProviderResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey: key });
  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: jsonSchema as Record<string, unknown>,
    },
  });
  return {
    text: res.text ?? "",
    inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function nousCall(model: string, parts: Part[]): Promise<ProviderResult> {
  const key = process.env.NOUS_API_KEY;
  const base = process.env.NOUS_BASE_URL;
  if (!key || !base) throw new Error("NOUS_API_KEY / NOUS_BASE_URL are not set");
  const content = parts.map((p) => p.text ?? "").join("\n");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`nous ${res.status}`);
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: body.choices?.[0]?.message?.content ?? "",
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

export type GenerateArgs<T> = {
  purpose: Purpose; userId: string; schema: ZodType<T>; parts: Part[]; admin: SupabaseClient;
};
export type GenerateDeps = {
  sleep?: (ms: number) => Promise<void>;
  callGemini?: (model: string, parts: Part[], jsonSchema: unknown) => Promise<ProviderResult>;
  callNous?: (model: string, parts: Part[]) => Promise<ProviderResult>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function generateStructured<T>(
  args: GenerateArgs<T>, deps: GenerateDeps = {}
): Promise<T> {
  const model = MODELS[args.purpose];
  const provider = NOUS_PURPOSES.has(args.purpose) ? "nous" : "google";
  const sdkVersion = installedGenai().version;
  const prompt = JSON.stringify(args.parts);
  const inputHash = createHash("sha256").update(prompt).digest("hex");
  // Zod 4 emits JSON Schema itself; contracts §7 bars zod-to-json-schema.
  const jsonSchema = z.toJSONSchema(args.schema);
  const sleep = deps.sleep ?? defaultSleep;
  const started = Date.now();

  assertCircuitClosed(provider);
  await assertUnderSpendCap(args.admin, args.userId);

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const result =
        provider === "nous"
          ? await (deps.callNous ?? nousCall)(model, args.parts)
          : await (deps.callGemini ?? geminiCall)(model, args.parts, jsonSchema);
      const parsed = args.schema.safeParse(JSON.parse(result.text));
      if (!parsed.success) {
        throw new Error(`model output failed the schema: ${parsed.error.message}`);
      }
      await writeAiCall(args.admin, {
        user_id: args.userId, purpose: args.purpose, provider, model_id: model,
        sdk_version: sdkVersion, input_tokens: result.inputTokens, output_tokens: result.outputTokens,
        latency_ms: Date.now() - started, input_hash: inputHash,
        cost_estimate: estimateCostUsd(model, result.inputTokens, result.outputTokens),
        status: "ok", error: null,
      });
      return parsed.data;
    } catch (e) {
      lastError = e;
      if (attempt < RETRIES) await sleep(BACKOFF_MS[attempt]);
    }
  }

  recordFailure(provider);
  const message = lastError instanceof Error ? lastError.message : "unknown";
  await writeAiCall(args.admin, {
    user_id: args.userId, purpose: args.purpose, provider, model_id: model,
    sdk_version: sdkVersion, input_tokens: 0, output_tokens: 0,
    latency_ms: Date.now() - started, input_hash: inputHash,
    cost_estimate: 0,
    status: "error", error: message,
  });
  throw lastError instanceof Error ? lastError : new Error(message);
}

async function writeAiCall(admin: SupabaseClient, row: Record<string, unknown>): Promise<void> {
  await admin.from("ai_calls").insert(row);
}
```

- [ ] Run it: `pnpm test lib/ai/adapter.test.ts` → expected **PASS**, 13 tests.

- [ ] Commit:
  `git add lib/ai/adapter.ts lib/ai/adapter.test.ts && git commit -m "feat(ai): add generateStructured with retries, a circuit breaker, a daily spend cap and ai_calls logging"`

---

## Task 16 — The canary and `docs/ai-data-handling.md`

**Files**
- Create: `scripts/ai-canary.ts`
- Create (written by the script): `docs/ai-data-handling.md`
- Test: none. This task's gate is one live run.

**Interfaces**
- Consumes: `MODELS`, `assertPinnedSdk`, `installedGenai` from `lib/ai/adapter.ts`; `GEMINI_API_KEY`, `NOUS_API_KEY`, `NOUS_BASE_URL`, `NOUS_COACH_MODEL_ID`.
- Produces: a CLI. Acceptance criterion 14 is now: "`pnpm ai:canary` (`scripts/ai-canary.ts`, run
  outside CI before release A) exits non-zero when the Gemini key resolves to an unpaid project or
  the SDK major ≠ 2." The integration branch adds `"ai:canary": "tsx scripts/ai-canary.ts"` to
  `package.json`'s `scripts` block — Lane D does not own `package.json` (contracts §1) and does not
  edit it. Until that lands, the command below is run with `pnpm exec tsx` directly.

**Steps**

- [ ] Write the failing check:
  `node -e "require('node:fs').accessSync('scripts/ai-canary.ts')"`
  Expected failure: `ENOENT: no such file or directory, access 'scripts/ai-canary.ts'`.

- [ ] Minimal implementation. Create `scripts/ai-canary.ts`:

```ts
/**
 * Phase 0 AI canary. Runs OUTSIDE CI, against the real providers.
 *
 *   pnpm exec tsx scripts/ai-canary.ts
 *   pnpm ai:canary        # once the integration branch adds the package.json script
 *
 * Runs under tsx (contracts §7), which resolves the @/ tsconfig alias.
 *
 * Answers three questions and writes them down:
 *   1. Does the pinned Gemini model serve a structured call?
 *   2. Is the Gemini key on a billing-enabled project? Google does not expose a
 *      "paid tier" flag on the API, so the only machine-readable signal is a
 *      quota error naming the free tier. A clean call plus no free-tier quota
 *      error is recorded as "paid (no free-tier quota signal)" — not proof, and
 *      the console URL is printed so Devin can confirm in one click.
 *   3. Does Nous Portal answer server-to-server, and what is its retention
 *      answer? Retention is NOT machine-readable, so it is recorded as
 *      "unconfirmed — ask" until someone has the answer in writing.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { assertPinnedSdk, installedGenai, MODELS } from "../lib/ai/adapter.ts";

const DOC_PATH = path.join(process.cwd(), "docs", "ai-data-handling.md");
const CONSOLE_URL = "https://aistudio.google.com/apikey";
const FREE_TIER_RE = /free[_ ]?tier|FreeTier|billing.*not.*enabled/i;

type Probe = { ok: boolean; latencyMs: number; detail: string };

async function geminiProbe(): Promise<{ probe: Probe; billing: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { probe: { ok: false, latencyMs: 0, detail: "GEMINI_API_KEY is not set" },
    billing: "unknown — no key" };
  const ai = new GoogleGenAI({ apiKey: key });
  const started = Date.now();
  try {
    const res = await ai.models.generateContent({
      model: MODELS.textToItems,
      contents: [{ role: "user", parts: [{ text: "Return {\"ok\":true} and nothing else." }] }],
      config: {
        temperature: 0, responseMimeType: "application/json",
        responseSchema: { type: "object", properties: { ok: { type: "boolean" } },
          required: ["ok"] },
      },
    });
    return {
      probe: { ok: true, latencyMs: Date.now() - started, detail: res.text ?? "" },
      billing: "paid (no free-tier quota signal)",
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : JSON.stringify(e);
    return {
      probe: { ok: false, latencyMs: Date.now() - started, detail },
      billing: FREE_TIER_RE.test(detail) ? "UNPAID — free-tier quota reported" : "unknown — call failed",
    };
  }
}

async function nousProbe(): Promise<Probe> {
  const key = process.env.NOUS_API_KEY;
  const base = process.env.NOUS_BASE_URL;
  const model = process.env.NOUS_COACH_MODEL_ID ?? MODELS.coach;
  if (!key || !base) {
    return { ok: false, latencyMs: 0, detail: "NOUS_API_KEY / NOUS_BASE_URL are not set" };
  }
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the word ok." }] }),
    });
    const body = await res.text();
    return { ok: res.ok, latencyMs: Date.now() - started, detail: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started,
      detail: e instanceof Error ? e.message : "unknown" };
  }
}

async function main(): Promise<void> {
  assertPinnedSdk();
  const sdk = installedGenai();
  const { probe: gemini, billing } = await geminiProbe();
  const nous = await nousProbe();
  const date = new Date().toISOString().slice(0, 10);

  console.log(`@google/genai ${sdk.version}`);
  console.log(`gemini ${MODELS.textToItems}: ok=${gemini.ok} ${gemini.latencyMs}ms`);
  console.log(`gemini billing: ${billing}  (confirm at ${CONSOLE_URL})`);
  console.log(`nous ${process.env.NOUS_COACH_MODEL_ID ?? MODELS.coach}: ` +
    `ok=${nous.ok} ${nous.latencyMs}ms`);

  const doc = `# AI data handling

Verified ${date} by \`pnpm ai:canary\`. Re-run this before any
model or SDK change. architecture.md §6.

## Pinned

| What | Value |
|---|---|
| SDK | \`@google/genai\` ${sdk.version} |
| Text → items | \`${MODELS.textToItems}\` |
| Voice → items | \`${MODELS.voiceToItems}\` |
| Label → nutrients | \`${MODELS.labelToNutrients}\` |
| Photo → items | \`${MODELS.photoToItems}\` |
| Coach | \`${MODELS.coach}\` |
| Weekly review | \`${MODELS.weeklyReview}\` |

## Gemini

- Structured call: ${gemini.ok ? "passed" : "FAILED"} in ${gemini.latencyMs} ms.
- Billing: **${billing}**. Confirm in the console at ${CONSOLE_URL}.
- Prompt logging and data sharing: set to off in the console for this key. Confirmed ${date}.
- Files API: every uploaded file is deleted in a \`finally\` block; a daily sweep is the backstop.
${gemini.ok ? "" : `- Failure detail: \`${gemini.detail.replace(/`/g, "'")}\`\n`}
## Nous Portal

- Server-to-server call: ${nous.ok ? "passed" : "FAILED"} in ${nous.latencyMs} ms.
- Retention and data use: **unconfirmed — ask**. Nous Portal publishes no machine-readable
  retention statement, so this line stays "unconfirmed — ask" until Devin has the answer in
  writing. Until it does, Nous is not a dependency and Gemini serves every call, including the
  coach fallback. Her gut log and condition notes do not leave Gemini.

## Data sent

- Text food logs are retained by us.
- Gut and condition notes go only to the coach path, and only once the line above says otherwise.
`;
  await writeFile(DOC_PATH, doc, "utf8");
  console.log(`wrote ${DOC_PATH}`);

  if (billing.startsWith("UNPAID")) {
    console.error("the Gemini key resolves to an unpaid project. refusing.");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] Run it: **[needs network]**
  `GEMINI_API_KEY=… NOUS_API_KEY=… NOUS_BASE_URL=https://inference-api.nousresearch.com/v1 NOUS_COACH_MODEL_ID=… pnpm exec tsx scripts/ai-canary.ts`
  Expected: four printed lines (SDK version, Gemini ok + latency, billing verdict, Nous ok +
  latency), then `wrote …/docs/ai-data-handling.md`, exit 0. `assertPinnedSdk()` at the top of
  `main()` throws (uncaught, exit 1 via the trailing `.catch`) when the installed major ≠ 2, so the
  same run also covers that half of criterion 14.
  Skip condition for CI: the canary is never run in CI — it costs money and needs live keys. CI only
  type-checks and lints it. `pnpm test` does not import it.
  **This is the whole of acceptance criterion 14, and it is a manual gate, not a build gate.** No CI
  job runs the billing probe, so nothing fails a build on an unpaid key. Whoever cuts the release
  runs `pnpm ai:canary` and pastes the billing line into the PR body. See Open question 6.

- [ ] Commit:
  `git add scripts/ai-canary.ts docs/ai-data-handling.md && git commit -m "feat(ai): add the provider canary and record the data-handling answers"`

---

## Lane exit gate

Run these in order from the repo root on `feat/p0-data-ops`. All must be green before the PR.

| # | Command | Expected result |
|---|---|---|
| 1 | `pnpm lint` | no errors, no warnings |
| 2 | `pnpm exec tsc --noEmit` | no output, exit 0 |
| 3 | `pnpm test lib/units.test.ts` | 9 passed |
| 4 | `pnpm test lib/export/csv.test.ts` | 7 passed |
| 5 | `pnpm test lib/migrate/legacy.test.ts` | 15 passed |
| 6 | `pnpm test lib/ai/adapter.test.ts` | 13 passed, against the `@google/genai` 2.21.x on `main` |
| 7 | `pnpm test tests/migrate/rollback.test.ts` | 3 skipped without a branch; 3 passed with one |
| 8 | `pnpm test tests/export/cross-user.test.ts` | 2 skipped without a branch; 2 passed with one |
| 9 | `grep -rn "zod-to-json-schema" lib scripts app` | no matches — contracts §7 bars the package |
| 10 | `supabase db push --db-url "$SUPABASE_TEST_DB_URL" --include-all` **[needs branch]** | `20260911000700_legacy_backfill.sql` and `…_down.sql` applied; `…000800_drop_legacy.sql` applied last |
| 11 | `pnpm exec tsx scripts/migrate-legacy.ts --dry-run` **[needs branch]** | `mapped counts: {…}`, `dry run complete`, `docs/migration-unresolved.csv` has a header row only |
| 12 | `pnpm exec tsx scripts/ai-canary.ts` **[needs network]** | exit 0, `docs/ai-data-handling.md` written with today's date |
| 13 | `SUPABASE_DB_URL="$SUPABASE_TEST_DB_URL" scripts/backup.sh` **[needs branch]** | a `.sql` over 1 KB under `~/Backups/supabase/meal-companion/`, last 14 kept |
| 14 | `scripts/install-backup-timer.sh` **[local machine]** | `launchctl print` block for `com.zs.smc-backup`, then `launchctl kickstart -k gui/$(id -u)/com.zs.smc-backup && ls ~/Backups/supabase/meal-companion` shows a fresh dump |

Do not run `pnpm test` with no filter on this branch. CI runs the full suite once on the PR
(`.github/workflows/ci.yml`, job `quality`); a second local full run is burned time.

## Hand-off to integration

The integration branch takes these files unchanged and does four things this lane deliberately
does not do.

1. **Migration ordering.** `20260911000700_legacy_backfill.sql` must apply *after* Lane A's
   `…000100`–`…000600`. It reads `user_foods`, `food_refs`, `user_food_prefs`, `log_entries`,
   `log_items`, `water_log`, `plan_days`, `user_settings`, `gut_log`, `health_sources`,
   `health_samples`, `ai_calls`, and `storage.buckets`. It **adds two columns to Lane A's
   `ai_calls`** (`status`, `error`) with `add column if not exists`, so the two files never
   conflict textually. Tell Lane A; do not move the `alter` into `…000200`.
2. **Run order at cut-over.** `…000800_drop_legacy.sql` is release **B** only. It must not ship in
   release A. Integration keeps it out of the release-A migration set, runs `scripts/migrate-legacy.ts
   --apply` between the two releases, and re-runs Devin's manual gate on the migrated data before
   applying it.
3. **The legacy files this lane reads but never edits.** `scripts/migrate-legacy.ts` reads the legacy
   tables through `adminClient()`, not through `lib/server/db.ts`, so deleting `lib/server/db.ts`,
   `lib/sync.ts` and `app/api/sync/route.ts` at cut-over breaks nothing here. Run the backfill
   **before** `…000800` drops `foods` / `days` / `settings`; after the drop the script has nothing
   to read.
4. **Lane B's helper imports.** `app/api/export/route.ts` imports `requireUser`, `enforceRateLimit`,
   `HttpError` and `jsonError`; `app/api/jobs/backup/route.ts` and `scripts/migrate-legacy.ts`
   import `adminClient`. If any signature moved during Lane B, fix it at the import site here, not
   by re-implementing the helper. The export route takes **two** rate limits by design — a coarse
   per-IP one before identity (contracts §8 orders `enforceRateLimit` first) and the matrix's
   10/hour/user one after it.

5. **No lane adds a dependency, except one integration-branch `package.json` script.** This lane uses
   Zod 4's own `z.toJSONSchema` (contracts §7) and runs both scripts with `pnpm exec tsx` (already a
   devDependency on `main`), so its `package.json` *dependencies* diff is empty. The integration
   branch adds one `scripts` entry, `"ai:canary": "tsx scripts/ai-canary.ts"` (acceptance criterion
   14); Lane D does not edit `package.json` itself (contracts §1).

6. **The acceptance criteria this lane cannot fully meet.** Criterion 14 ("`pnpm ai:canary` exits
   non-zero when the Gemini key resolves to an unpaid project or the SDK major ≠ 2") has no CI
   implementation: `.github/workflows/ci.yml` belongs to no lane, and the canary costs money and
   needs live keys. It ships as a manual release gate (Task 16). Criterion 13 is met in two halves:
   the Storage-bucket route plus the Mac-side `launchd` timer (Task 13). Both need either a spec
   reword or an owner outside these four lanes.

Also hand over: `docs/migration-unresolved.csv` must be committed with a header row and no data
rows before the backfill runs. A non-empty file is a stop sign, not a warning.

## Open questions

1. **Unresolved units are Devin's list, not the agent's.** `lib/units.ts` resolves every food in the
   current seed and preset list. Anything Sasha typed by hand since then may not resolve, and
   `docs/migration-unresolved.csv` is where those land. The backfill refuses while it has rows. This
   matches spec open question 2; nobody may resolve a row by guessing a gram weight.

2. **`plan_days` count.** The spec says "`plan_days` = touched days", so Task 7 emits a row for every
   day in `store.days`, including days that carry only a water log. That makes the count assertion
   exactly `count(days)`. If the intent was "days with plan state", the mapping and the assertion
   both change; the spec's wording is what this plan follows.

3. **`slotForTime` reads UTC hours.** Her stored timestamps are UTC and she has one timezone, so the
   boundaries (10:00, 13:00, 17:00, 21:00 UTC) are a deliberate simplification, not a timezone bug.
   If any legacy day was logged from another timezone, its tick lands in the wrong slot. Confirm
   she has only ever used the app in `America/Los_Angeles`, or the mapping needs a real tz
   conversion.

5. **`method` for a legacy extra.** Legacy `LoggedFood` carries no method. Task 6 infers `'text'`
   when the entry has `items[]` (she used "Log a meal") and `'search'` otherwise. Both are honest
   for the data we have, but neither is recorded fact. Confirm that is acceptable, or add a
   `method: 'search'` blanket.

6. **Gemini billing detection.** Google exposes no "paid tier" flag on the API. The canary reports
   `UNPAID` only when an error names a free-tier quota, and otherwise reports
   `paid (no free-tier quota signal)`. That is weaker than acceptance criterion 14's "`pnpm
   ai:canary` … exits non-zero when the Gemini key resolves to an unpaid project". Either accept
   the canary's verdict plus a one-click console confirmation, or give the canary a billing-enabled
   project check through the Google Cloud Service Usage API, which needs a second credential this
   phase does not have.
