/**
 * Phase 18 W3, Sol re-plan regression matrix: five sources × seven states. Every cell adds ONE
 * A-owned source row (the foreign cells carry B's refs inside A's row) to a fresh fixture and
 * compares the full taste profile with the same fixture without that row. A supplied ref or key is
 * authoritative: foreign, missing and malformed rows are unreadable, never fall back to a name or a
 * bundled id, and never enter the identity reps.
 */
import { describe, expect, it } from "vitest";
import { H_HALF_LIFE_DAYS, M_HALF_LIFE_DAYS, tasteProfile, type TasteResult } from "@/lib/meals/taste";
import { admitHistory } from "@/lib/server/taste-admission";
import { readTasteHistory } from "@/lib/server/taste-history";
import {
  A, FOOD, NOW, REF, TODAY, catRef, day, tasteDb, tastePorts, tasteTables, type FixturePorts,
} from "@/tests/helpers/taste-fixture";
import type { Row } from "@/tests/helpers/occasion-fake-db";

const KIWI = "Matrixfruit, house blend";
const R950 = catRef(950);
const AGE = 40;
const SOURCES = ["log", "recipe", "tick", "shopping", "mixed"] as const;
const STATES = ["own valid", "own Avoid", "own rule-blocked", "foreign", "missing", "malformed", "absent"] as const;
type Source = (typeof SOURCES)[number];
type State = (typeof STATES)[number];

const NONEXISTENT = "00000000-0000-4000-8000-000000009999";
const DANGLING = "00000000-0000-4000-8000-000000003001";

/**
 * The ref-bearing fields each state puts on the row (several variants for "missing" / "malformed").
 * Rows that carry a ref also carry a bundled id (Sol r2's failing case): a ref that does not
 * resolve must never fall back to it, nor to the name.
 */
function variants(source: Source, state: State): Row[] {
  const rows = refFields(source, state);
  return state === "absent" || source === "log" || source === "tick" ? rows
    : rows.map((row) => ({ ...row, foodDbId: "banana" }));
}

function refFields(source: Source, state: State): Row[] {
  const ref = source === "log" ? "food_ref_id" : "foodRefId";
  switch (state) {
    case "own valid": case "own Avoid": case "own rule-blocked":
      return [source === "tick" ? { foodKey: "catalog:950" } : { [ref]: R950 }];
    case "foreign":
      return [source === "tick" ? { foodKey: `food:${FOOD.bSecret}` } : { [ref]: REF.bSecret }];
    case "missing":
      return source === "tick" ? [{ foodKey: "food:00000000-0000-4000-8000-000000004001" }, { foodKey: "catalog:977" }]
        : [{ [ref]: NONEXISTENT }, { [ref]: DANGLING }];
    case "malformed":
      return source === "log" ? [{ [ref]: "not a ref!" }] : source === "recipe" ? [{ [ref]: 42 }]
        // The phone's marker and a raw bad key both stop a legacy name match, even for a Favored name.
        : source === "tick" ? [{ foodKey: "catalog:abc" }, { foodKeyInvalid: true },
          { foodKey: "catalog:abc", name: "Mom's dal" }, { foodKeyInvalid: true, name: "Mom's dal" },
          { foodKey: null, name: "Mom's dal" }, { foodKey: null, name: "banana" }]
          : source === "shopping" ? [{ [ref]: "" }] : [{ [ref]: {} }];
    case "absent":
      return [source === "log" ? { [ref]: null } : source === "tick" ? {} : { [ref]: null, foodDbId: null }];
  }
}

function setup(state: State) {
  const tables = tasteTables();
  const ports = tastePorts(tables);
  tables.catalog_foods.push({ id: 950, source: "fdc_branded", source_id: "0950" });
  tables.catalog_food_revisions.push({ id: 9500, catalog_food_id: 950, description: KIWI, is_active: true });
  tables.food_refs.push({ id: R950, kind: "catalog", catalog_food_id: 950, user_food_id: null },
    // A ref whose target account food row does not exist.
    { id: DANGLING, kind: "user", catalog_food_id: null, user_food_id: "00000000-0000-4000-8000-000000004001" });
  if (state === "own Avoid") tables.user_food_prefs.push({ user_id: A, food_ref_id: R950, status: "avoid" });
  if (state === "own rule-blocked") ports.profile = { ...ports.profile, avoid_allergens: ["milk"] };
  return { tables, ports };
}

/** Adds the one A-owned source row for this cell. */
function addRow(tables: Record<string, Row[]>, ports: FixturePorts, source: Source, fields: Row) {
  const date = day(AGE);
  if (source === "log") {
    tables.log_entries.push({ id: "matrix-entry", user_id: A, local_date: date, slot: "meal-6", deleted_at: null });
    tables.log_items.push({ entry_id: "matrix-entry", grams: 100, ...fields });
  } else if (source === "recipe") {
    tables.plan_days.push({ user_id: A, local_date: date, item_overrides: {}, eaten_slots: { "meal-6": {
      eaten_at: "2026-08-27T12:00:00Z", changed_at: "2026-08-27T12:00:00Z",
      consumed: { baseMealId: "recipe:rev-m", title: "Bowl", components: [{ name: "Bowl", qty: 1 }] } } } });
    tables.recipe_plan_selections.push({ user_id: A, local_date: date, slot_id: "meal-6", recipe_revision_id: "rev-m",
      serving_fraction: 1, ingredient_snapshot: [{ seq: 1, name: KIWI, grams: 100, ...fields }] });
  } else if (source === "tick") {
    tables.plan_days.push({ user_id: A, local_date: date, eaten_slots: { "meal-6": { eaten_at: "2026-08-27T12:00:00Z",
      changed_at: "2026-08-27T12:00:00Z" } }, item_overrides: { "meal-6": { baseMealId: "gen", components: [
      { name: KIWI, qty: 100, unit: "g", role: "carb", macros: {}, ...fields }] } } });
  } else if (source === "shopping") {
    const absent = Object.values(fields).every((value) => value === null);
    tables.shopping_lines.push({ user_id: A, origin: "manual", name: KIWI, deleted_at: null, rev: 1,
      updated_at: `${date}T10:00:00.000Z`, identity: absent ? null : fields });
  } else {
    ports.mixedInputs = [...ports.mixedInputs, { ...fields, gramsPerGram: 0.1 }];
  }
}

async function profile(tables: Record<string, Row[]>, ports: FixturePorts) {
  const db = tasteDb(tables);
  const history = await readTasteHistory(db.client, A, TODAY, ports.mixedDishInputs);
  const admitted = await admitHistory(db.client, A, history, NOW, ports);
  const result = tasteProfile({ today: TODAY, items: admitted.items, choices: admitted.choices,
    admitted: admitted.admitted });
  return { result, repKeys: [...history.reps.keys()].sort() };
}

const r4 = (value: number) => Math.round(value * 10_000) / 10_000;
const kiwi = (result: TasteResult) => result.identities.find((row) => row.key === "f:matrixfruit");
const UNREADABLE_STATES: State[] = ["foreign", "missing", "malformed"];
const cells = SOURCES.flatMap((source) => STATES.map((state) => [source, state] as const));

describe("W3 resolution matrix: 5 sources × 7 states", () => {
  it.each(cells)("%s row, %s", async (source, state) => {
    for (const fields of variants(source, state)) {
      const base = setup(state);
      const before = await profile(base.tables, base.ports);
      const cell = setup(state);
      addRow(cell.tables, cell.ports, source, fields);
      const after = await profile(cell.tables, cell.ports);
      const counts = state === "own valid";
      if (!counts) {
        // No effect at all on H, Q or M.
        expect(after.result).toEqual(before.result);
      } else if (source === "shopping") {
        expect(kiwi(after.result)).toMatchObject({ q: 0.5, days180: 0 });
        expect(after.result.m).toBe(before.result.m);
      } else if (source === "mixed") {
        // Same episode as the lasagna (day 12): family half × estimated half; M unchanged.
        expect(kiwi(after.result)).toMatchObject({ days180: 1, h: r4(0.25 * 0.5 ** (12 / H_HALF_LIFE_DAYS)) });
        expect(after.result.episodes).toBe(before.result.episodes);
      } else {
        expect(kiwi(after.result)).toMatchObject({ days180: 1, h: r4(0.5 * 0.5 ** (AGE / H_HALF_LIFE_DAYS)) });
        expect(after.result.episodes).toBe(before.result.episodes + 1);
        expect(after.result.m).toBeCloseTo(before.result.m + 0.5 ** (AGE / M_HALF_LIFE_DAYS), 3);
      }
      const unreadable = UNREADABLE_STATES.includes(state)
        || (state === "absent" && (source === "log" || source === "mixed"));
      if (unreadable) {
        // Never in the identity reps: no kiwi, no B food, nothing new at all.
        expect(after.repKeys).toEqual(before.repKeys);
      } else {
        expect(after.repKeys).toContain("f:matrixfruit");
      }
    }
  });
});

describe("W3 resolution positive controls", () => {
  it("a valid food:<bundled-id> tick counts as its universe item", async () => {
    const { tables, ports } = setup("own valid");
    const before = await profile(tables, ports);
    addRow(tables, ports, "tick", { foodKey: "food:spinach-raw", name: "Spinach" });
    const after = await profile(tables, ports);
    const spinach = after.result.identities.find((row) => row.key === "u:spinach-raw")!;
    const was = before.result.identities.find((row) => row.key === "u:spinach-raw")!;
    expect(spinach.days180).toBe(was.days180 + 1);
    expect(spinach.h).toBe(r4(was.h + 0.5 ** (AGE / H_HALF_LIFE_DAYS)));
  });

  it("a legacy tick with no key counts through the Favored food it names", async () => {
    const { tables, ports } = setup("own valid");
    const before = await profile(tables, ports);
    addRow(tables, ports, "tick", { name: "Mom's dal" });
    const after = await profile(tables, ports);
    const dal = (result: TasteResult) => result.identities.find((row) => row.key === "f:mom's dal")!;
    expect(dal(after.result).days180).toBe(dal(before.result).days180 + 1);
    expect(dal(after.result).provenance.sources.tick).toBe(dal(before.result).provenance.sources.tick + 1);
  });
});
