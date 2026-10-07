/**
 * Phase 18 W4 acceptance 3 (docs/specs/phase-18-open-world-foods.md §10 W4): a logged FNDDS dish
 * counts its documented inputs at half weight, marked estimated; a dish with no inputs counts as
 * itself. Runs the real catalog port (lib/server/mixed-dish-inputs.ts) and the real W3 read,
 * identity, admission and policy code over the PostgREST double, with `catalog_food_inputs` rows
 * shaped as scripts/import-fndds-inputs.ts writes them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { H_HALF_LIFE_DAYS } from "@/lib/meals/taste";
import { MAX_DEPTH, readMixedDishInputs } from "@/lib/server/mixed-dish-inputs";
import { accountTaste, type TasteResponse } from "@/lib/server/taste-admission";
import {
  A, NOW, REF, TODAY, catRef, day, tasteDb, tastePorts, tasteTables, type FixturePorts,
} from "@/tests/helpers/taste-fixture";
import type { Row } from "@/tests/helpers/occasion-fake-db";

let tables: Record<string, Row[]>;
let ports: FixturePorts;

/** Catalog foods the dish names: SR broccoli and olive oil (universe items, no ref), SR oregano
 *  (no universe item, no ref), an FNDDS sauce sub-recipe, two FNDDS foods with one or no input. */
const FOODS: [number, string, string, string][] = [
  [911, "fdc_sr_legacy", "169967", "Broccoli, cooked, boiled, drained, without salt"],
  [912, "fdc_sr_legacy", "171413", "Oil, olive, salad or cooking"],
  [914, "fdc_sr_legacy", "171328", "Spices, oregano, dried"],
  [913, "fdc_fndds", "2710001", "Tomato sauce"],
  [905, "fdc_fndds", "2709001", "Banana, raw"],
  [907, "fdc_fndds", "2705383", "Milk, human"],
];

const inputs = (revision: number, rows: [number, number][]) =>
  rows.map(([food, grams], i) => ({ food_revision_id: revision, seq: i + 1, input_catalog_food_id: food, grams,
    source: "fndds", estimated: true }));

function logDish(catalogId: number, age: number, grams: number) {
  const id = `entry-w4-${catalogId}-${age}`;
  tables.log_entries.push({ id, user_id: A, local_date: day(age), slot: "meal-6", deleted_at: null });
  tables.log_items.push({ entry_id: id, food_ref_id: catRef(catalogId), grams });
}

beforeEach(() => {
  tables = tasteTables();
  ports = tastePorts(tables);
  ports.mixedDishInputs = readMixedDishInputs;
  for (const [id, source, sourceId, description] of FOODS) {
    tables.catalog_foods.push({ id, source, source_id: sourceId });
    tables.catalog_food_revisions.push({ id: id * 10, catalog_food_id: id, description, is_active: true });
  }
  // The FNDDS foods carry catalog refs (a log names them); the SR inputs above have none.
  for (const id of [905, 907, 913]) tables.food_refs.push({ id: catRef(id), kind: "catalog", catalog_food_id: id, user_food_id: null });
  // Lasagna (904, revision 9040): broccoli 100 g, sauce 50 g, chicken 50 g; the sauce: oil 10 g, oregano 10 g.
  // "Banana, raw" (905) lists one input; "Milk, human" (907) lists none.
  tables.catalog_food_inputs = [...inputs(9040, [[911, 100], [913, 50], [901, 50]]),
    ...inputs(9130, [[912, 10], [914, 10]]), ...inputs(9050, [[902, 100]])];
});

const read = () => accountTaste(tasteDb(tables).client, A, TODAY, ports, NOW);
const item = (body: TasteResponse, key: string) => body.items.find((row) => row.key === key);
const r4 = (value: number) => Math.round(value * 10_000) / 10_000;

describe("the catalog port", () => {
  it("expands a dish through its sub-recipe into leaf shares, each named by ref, bundled id or catalog id", async () => {
    const out = await readMixedDishInputs([904], tasteDb(tables).client);
    expect(out.get(904)).toEqual([
      { foodRefId: REF.c901, gramsPerGram: 0.25 },
      { foodDbId: "broccoli-cooked", gramsPerGram: 0.5 },
      { foodDbId: "olive-oil", gramsPerGram: 0.125 },
      { catalogFoodId: 914, gramsPerGram: 0.125 },
    ]);
  });

  it("leaves out a food with one leaf input or none: it counts as itself", async () => {
    const out = await readMixedDishInputs([905, 907], tasteDb(tables).client);
    expect([...out.keys()]).toEqual([]);
  });

  it("stops at a cycle and at MAX_DEPTH, never looping", async () => {
    tables.catalog_food_inputs.push(...inputs(9140, [[913, 5]]));
    tables.catalog_foods.find((row) => row.id === 914)!.source = "fdc_fndds";
    const out = await readMixedDishInputs([904], tasteDb(tables).client);
    const total = out.get(904)!.reduce((sum, input) => sum + input.gramsPerGram, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(MAX_DEPTH).toBeGreaterThanOrEqual(2);
  });

  it("reads shared catalog rows only, by the ids it was given", async () => {
    const db = tasteDb(tables);
    await readMixedDishInputs([904], db.client);
    expect(new Set(db.queries.map((q) => q.table))).toEqual(new Set(["catalog_food_revisions", "catalog_food_inputs",
      "catalog_foods", "food_refs"]));
    for (const q of db.queries) expect(q.filters.some((f) => f.startsWith("in:"))).toBe(true);
  });
});

describe("W4 acceptance 3: a logged FNDDS dish counts its inputs at half weight, marked estimated", () => {
  it("credits each judged input at half weight and estimated; the dish is not an identity", async () => {
    const body = await read();
    // Broccoli: the day-15 recipe (whole weight) and the day-12 lasagna (estimated, half weight).
    expect(item(body, "u:broccoli-cooked")).toMatchObject({ days180: 2,
      h: r4(0.5 ** (15 / H_HALF_LIFE_DAYS) + 0.5 * 0.5 ** (12 / H_HALF_LIFE_DAYS)),
      provenance: expect.objectContaining({ estimated: true, sources: expect.objectContaining({ mixed_dish: 1 }) }) });
    // Chicken through its catalog ref: one more mixed-dish day, judged on that ref.
    expect(item(body, "u:chicken-breast-roasted")!.provenance.sources.mixed_dish).toBe(1);
    expect(body.items.some((row) => /lasagna|tomato sauce/i.test(row.key))).toBe(false);
    // Oregano has no ref and no universe item: nothing can vouch for it, so it adds nothing.
    expect(body.items.some((row) => /oregano/i.test(row.key))).toBe(false);
  });

  it("a dish's inputs stop counting when the dish itself is held out", async () => {
    tables.user_food_prefs.push({ user_id: A, food_ref_id: REF.c904, status: "avoid" });
    const broccoli = item(await read(), "u:broccoli-cooked")!;
    expect(broccoli.days180).toBe(1);
    expect(broccoli.provenance.sources.mixed_dish).toBe(0);
  });

  it("a dish with no inputs, or one input, counts as itself at full weight, not estimated", async () => {
    logDish(907, 3, 120);
    logDish(905, 4, 118);
    const body = await read();
    const milk = body.items.find((row) => /milk, human/i.test(row.name))!;
    expect(milk).toMatchObject({ days180: 1, provenance: expect.objectContaining({ estimated: false }) });
    const banana = body.items.find((row) => row.name === "Banana, raw")!;
    expect(banana.provenance.estimated).toBe(false);
    expect(banana.provenance.sources.mixed_dish).toBe(1);
  });

  it("with no input rows at all, the lasagna counts as itself (pre-W4 behaviour)", async () => {
    tables.catalog_food_inputs = [];
    const body = await read();
    expect(body.items.some((row) => /lasagna/i.test(row.name))).toBe(true);
    expect(item(body, "u:broccoli-cooked")!.provenance.sources.mixed_dish).toBe(0);
  });
});
