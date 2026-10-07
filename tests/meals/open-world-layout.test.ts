/**
 * Phase 18 W8 (docs/specs/phase-18-open-world-foods.md §W8): the open food-world layout, built the
 * way the phone builds it, from a v3 snapshot and the device's own foods.
 *
 * Acceptance 1: an open account with no Favored foods gets a plate in every slot on 30 dates.
 * Acceptance 2: phone and server give identical plates for identical inputs (200 dates), and the
 *   0.01 quantization boundary cannot split them.
 * Acceptance 3: over 365 dates a food from an avoided family never appears (server admission and
 *   a later local Avoid mark).
 * Acceptance 4 lives in tests/meals/favored-never-limits.test.ts (the spec §9 guard).
 * Acceptance 5: at most 20,000 `sizePlate` calls for a 6-slot day; the p95 scoring time is
 *   reported against the 20 ms target (docs/specs W8 report).
 * Acceptance 8: a kosher account's plates never hold meat beside dairy over 365 dates.
 * Acceptance 11: a bundled item absent from `admittedUniverseIds`, and a local food whose ref is
 *   absent from `admittedRefIds`, are never generated over 365 dates.
 */
import { describe, expect, it, vi } from "vitest";
import type { Food } from "@/lib/foods";
import { baseFoodName } from "@/lib/foods/base-name";
import { universeIdOf } from "@/lib/foods/universe/food";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { ownPlateEvidence, universePlateEvidence } from "@/lib/foods/world/plate-evidence";
import { deriveItem } from "@/lib/foods/universe/derive";
import { planMealsForDay, type LayoutSlot } from "@/lib/foods/layout-plan";
import { planDay } from "@/lib/meals/day";
import { livePool, openWorldInputs, REASON_CHIP_COPY, type OpenWorldInputs } from "@/lib/meals/open-world";
import { quantizeZ, tasteMultiplier } from "@/lib/meals/preference";
import { sizePlateStats } from "@/lib/meals/size";
import { onZGrid, parseMealSnapshotV3 } from "@/lib/meals/snapshot-v3";
import { checkPlateRules } from "@/lib/policy/plate-rules";
import {
  device, inputsFor, ITEMS, openSnapshot, overTheWire, ownFood,
} from "@/tests/helpers/open-snapshot";

// Hundreds of whole days per case: the layout is real, not sampled.
vi.setConfig({ testTimeout: 120_000 });

const START = Date.parse("2026-10-06T00:00:00Z");
const dates = (n: number) => Array.from({ length: n }, (_, i) => new Date(START + i * 86_400_000).toISOString().slice(0, 10));

/** 2,000 kcal and 140 g protein over 4 meals. */
const FOUR: LayoutSlot[] = ["08:00", "12:30", "15:30", "19:00"].map((clock, i) => ({
  id: `meal-${i + 1}` as LayoutSlot["id"], clock, target: { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 } }));
/** 2,400 kcal and 160 g protein over 6 meals. */
const SIX: LayoutSlot[] = ["07:30", "10:00", "12:30", "15:30", "18:30", "21:00"].map((clock, i) => ({
  id: `meal-${i + 1}` as LayoutSlot["id"], clock, target: { kcal: 400, protein: 26.7, carbs: 42, fat: 13.3 } }));

function layout(date: string, open: OpenWorldInputs, foods: Record<string, Food> = {}, slots = FOUR) {
  return planMealsForDay(date, slots, livePool(open, foods), undefined, open.evidence, open);
}

/** The pool ids a day's meals were built from, by matching each component to the pool food it came from. */
function poolIdsOf(open: OpenWorldInputs, plan: ReturnType<typeof layout>): string[] {
  const byName = new Map(Object.entries(open.foods).map(([id, food]) => [food.name, id]));
  return plan.meals.flatMap(({ meal }) => meal.components.map((part) => byName.get(part.name) ?? `?${part.name}`));
}

const CHICKEN = ownFood("11111111-1111-4111-8111-111111111111", "Chicken breast, grilled", "protein", [31, 0, 3.6]);
const YOGURT = ownFood("22222222-2222-4222-8222-222222222222", "Greek yogurt, plain, nonfat", "protein", [10, 3.6, 0.4]);
const TOFU = ownFood("33333333-3333-4333-8333-333333333333", "Tofu, firm", "protein", [17, 3, 9]);

describe("acceptance 1: an open account with no Favored foods", () => {
  it("gets a plate in every slot on 30 consecutive dates", () => {
    const open = inputsFor(openSnapshot());
    for (const date of dates(30)) {
      const plan = layout(date, open);
      expect([date, plan.shortages]).toEqual([date, []]);
      expect(plan.meals.map((row) => row.slot)).toEqual(FOUR.map((slot) => slot.id));
    }
  });
});

describe("acceptance 2: phone and server agree", () => {
  const taste = { m: 14, identities: ITEMS.filter((_, i) => i % 9 === 0).map((item, i) => ({
    key: `u:${item.entry.id}`, name: item.food.name, h: 0.3 + (i % 5) * 0.37, q: i % 2, days180: 2, episodes: 2,
    lastOn: "2026-10-01", provenance: { match: "universe" as const, estimated: false,
      sources: { log: 1, recipe: 0, tick: 0, mixed_dish: 0 }, collapsed: 0,
      choices: { swap_pick: 0, plan_add: 0, shopping_manual: 0 } } })) };
  const snapshot = openSnapshot({ favored: [CHICKEN, YOGURT], taste, cuisines: ["mediterranean", "south_asian"],
    dislikes: ["t:strong_fish"] });

  it("gives identical plates over 200 dates from the served body and the parsed wire body", () => {
    const server = inputsFor(snapshot, [CHICKEN, YOGURT]);
    const phone = inputsFor(overTheWire(snapshot), [CHICKEN, YOGURT]);
    expect(phone.taste).toEqual(server.taste);
    expect(Object.keys(server.taste).length).toBeGreaterThan(10);
    const local = device([CHICKEN, YOGURT]).foods;
    for (const date of dates(200)) {
      expect([date, layout(date, phone, local)]).toEqual([date, layout(date, server, local)]);
    }
  });

  it("the 0.01 quantum survives the wire: the phone never re-rounds a server value", () => {
    // Half-steps whose binary form sits on either side of the boundary (0.285 * 100 = 28.4999…).
    const raw = [0.285, 0.005, -0.005, 0.015, -0.125, 0.105, 0.795, -0.795, 0.8049, 1 / 3, -2 / 7];
    let seed = 7;
    for (let i = 0; i < 5000; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      raw.push((seed / 2147483648) * 2 - 1);
    }
    for (const value of raw) {
      const served = quantizeZ(value);
      const wire = JSON.parse(JSON.stringify({ base: served })).base as number;
      expect([value, onZGrid(wire)]).toEqual([value, true]);
      expect([value, wire]).toEqual([value, served]);
      // Idempotent: a phone that quantized again would get the same number.
      expect([value, quantizeZ(wire)]).toEqual([value, served]);
      const items = [{ key: "a", amount: 310 }, { key: "b", amount: 190 }];
      expect(tasteMultiplier(items, { a: { base: wire }, b: { base: -wire } }, null))
        .toBe(tasteMultiplier(items, { a: { base: served }, b: { base: -served } }, null));
    }
    // An unquantized value on the wire makes the whole body malformed: the phone ranks with
    // server numbers or not at all.
    const body = JSON.parse(JSON.stringify(snapshot));
    const id = Object.keys(body.foods)[0];
    body.foods[id].z = { base: 0.285 };
    expect(parseMealSnapshotV3(body)).toBeNull();
    body.foods[id].z = { base: 0.29, occasion: { dinner: 0.125 } };
    expect(parseMealSnapshotV3(body)).toBeNull();
  });
});

describe("acceptance 3: an avoided family never appears", () => {
  it("excluded at admission: no chicken on 365 dates", () => {
    const open = inputsFor(overTheWire(openSnapshot({ avoidNames: ["Chicken breast", "Chicken thigh"] })));
    expect(Object.keys(open.foods).some((id) => id.includes("chicken-breast"))).toBe(false);
    for (const date of dates(365)) {
      for (const { meal } of layout(date, open).meals) {
        for (const part of meal.components) {
          expect([date, baseFoodName(part.name)]).not.toEqual([date, "chicken breast"]);
          expect([date, baseFoodName(part.name)]).not.toEqual([date, "chicken thigh"]);
        }
      }
    }
  });

  it("a local Avoid mark written after the snapshot leaves the pool at once, universe items included", () => {
    const snapshot = overTheWire(openSnapshot());
    // An admitted anchor the layout uses: marked Avoid on this device after the read.
    const before = openWorldInputs(snapshot, {}, {});
    const used = new Map<string, number>();
    for (const date of dates(14)) for (const id of poolIdsOf(before, layout(date, before))) used.set(id, (used.get(id) ?? 0) + 1);
    const target = [...used.entries()].filter(([id]) => id.startsWith("universe:")).sort((a, b) => b[1] - a[1])[0][0];
    const family = baseFoodName(before.foods[target].name);
    const avoided: Food = { id: "44444444-4444-4444-8444-444444444444", name: before.foods[target].name.split(",")[0],
      role: "protein", unit: "g", perUnit: { protein: 0.24, carbs: 0, fat: 0.003 }, status: "avoid", updatedAt: "2026-10-06" };
    const local = { [avoided.id]: avoided };
    expect(Object.keys(openWorldInputs(snapshot, local, {}).foods)).not.toContain(target);
    expect(Object.keys(livePool(before, local))).not.toContain(target);
    for (const date of dates(365)) {
      const plan = planMealsForDay(date, FOUR, livePool(before, local), undefined, before.evidence, before);
      for (const { meal } of plan.meals) {
        expect([date, meal.components.some((part) => baseFoodName(part.name) === family)]).toEqual([date, false]);
      }
    }
  });
});

describe("acceptance 5: the search bound", () => {
  it("sizes at most 20,000 plates for a 6-slot day, and reports the p95 scoring time", () => {
    const open = inputsFor(overTheWire(openSnapshot({ favored: [CHICKEN, YOGURT] })), [CHICKEN, YOGURT]);
    const pool = livePool(open, device([CHICKEN, YOGURT]).foods);
    const counts: number[] = [];
    const times: number[] = [];
    for (const date of dates(60)) {
      sizePlateStats.calls = 0;
      const started = performance.now();
      const plan = planDay(date, SIX, pool, undefined, open.evidence, open.taste, open.ranking);
      times.push(performance.now() - started);
      counts.push(sizePlateStats.calls);
      expect(plan.plates).toHaveLength(6);
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(20_000);
    const p95 = [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)];
    // Reported, not gated: the 20 ms target is a phone figure (D11); this runs on the CI host.
    (globalThis as { __W8_SCORING__?: unknown }).__W8_SCORING__ = { p95Ms: p95, maxSizePlate: Math.max(...counts) };
    expect(Number.isFinite(p95)).toBe(true);
  });
});

describe("acceptance 8: kosher meat with dairy", () => {
  it("no plate over 365 dates holds a meat food beside a dairy food, and none holds an unproven food", () => {
    const favored = [CHICKEN, YOGURT];
    const open = inputsFor(overTheWire(openSnapshot({ flags: ["kosher"], favored })), favored);
    expect(open.ranking.plateOk).toBeDefined();
    const local = device(favored).foods;
    const evidenceOf = (id: string, food: Food) => {
      const universe = universeIdOf(id);
      const entry = universe ? universeEntry(universe) : undefined;
      const item = entry ? deriveItem(entry) : null;
      return item ? universePlateEvidence(item) : ownPlateEvidence(food.name);
    };
    let plates = 0;
    for (const date of dates(365)) {
      const plan = planDay(date, FOUR, livePool(open, local), undefined, open.evidence, open.taste, open.ranking);
      for (const { plate } of plan.plates) {
        plates += 1;
        const evidence = plate.rows.map((row) => evidenceOf(row.food.id, row.food));
        expect([date, plate.name, checkPlateRules(["kosher"], evidence)]).toEqual([date, plate.name, { ok: true }]);
        expect(evidence.some((food) => food.meat === "present") && evidence.some((food) => food.dairy === "present"))
          .toBe(false);
      }
    }
    expect(plates).toBeGreaterThan(0);
  });
});

describe("acceptance 11: the admitted set is explicit and positive", () => {
  it("a bundled universe item absent from admittedUniverseIds is never generated over 365 dates", () => {
    // The anchor the unrestricted open account uses most.
    const baseline = inputsFor(overTheWire(openSnapshot()));
    const uses = new Map<string, number>();
    for (const date of dates(30)) {
      for (const id of poolIdsOf(baseline, layout(date, baseline))) uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    const top = [...uses.entries()].filter(([id]) => id.startsWith("universe:")).sort((a, b) => b[1] - a[1])[0][0];
    const withheld = universeIdOf(top) as string;
    const open = inputsFor(overTheWire(openSnapshot({ withhold: [withheld] })));
    expect(Object.keys(open.foods)).not.toContain(top);
    const name = baseline.foods[top].name;
    for (const date of dates(365)) {
      expect([date, layout(date, open).meals.some(({ meal }) => meal.components.some((part) => part.name === name))])
        .toEqual([date, false]);
    }
  });

  it("a local food whose ref is absent from admittedRefIds, or with no ref and no admitted entry, is never generated", () => {
    const snapshot = overTheWire(openSnapshot({ favored: [CHICKEN] }));
    const stranger = ownFood("55555555-5555-4555-8555-555555555555", "Venison, roasted", "protein", [30, 0, 3]);
    const noRef: Food = { ...ownFood("66666666-6666-4666-8666-666666666666", "Bison, roasted", "protein", [28, 0, 2.4]).food };
    const local = { ...device([CHICKEN, stranger]).foods, [noRef.id]: noRef };
    const refs = device([CHICKEN, stranger]).refs;
    const open = openWorldInputs(snapshot, local, refs);
    expect(Object.keys(open.foods)).toContain(CHICKEN.food.id);
    expect(Object.keys(open.foods)).not.toContain(stranger.food.id);
    expect(Object.keys(open.foods)).not.toContain(noRef.id);
    for (const date of dates(365)) {
      const plan = planMealsForDay(date, FOUR, livePool(open, local), undefined, open.evidence, open);
      const names = plan.meals.flatMap(({ meal }) => meal.components.map((part) => part.name));
      expect([date, names.includes(stranger.food.name) || names.includes(noRef.name)]).toEqual([date, false]);
    }
  });

  it("a body whose ranking data names a food the admitted sets do not list is malformed", () => {
    const body = JSON.parse(JSON.stringify(openSnapshot({ favored: [CHICKEN] })));
    const listed = Object.values(body.foods as Record<string, { universeId: string | null }>)
      .find((food) => food.universeId !== null)!.universeId;
    body.admittedUniverseIds = body.admittedUniverseIds.filter((id: string) => id !== listed);
    expect(parseMealSnapshotV3(body)).toBeNull();
    const refs = JSON.parse(JSON.stringify(openSnapshot({ favored: [CHICKEN] })));
    refs.admittedRefIds = [];
    expect(parseMealSnapshotV3(refs)).toBeNull();
  });
});

describe("reason chips", () => {
  it("a plate with a food the account eats often says so; a closed layout carries none", () => {
    const item = ITEMS.find((row) => row.entry.id === "chicken-breast-roasted")!;
    const open = inputsFor(overTheWire(openSnapshot({ taste: { m: 20, identities: [{ key: "u:chicken-breast-roasted",
      name: item.food.name, h: 3.5, q: 0, days180: 6, episodes: 6, lastOn: "2026-10-05",
      provenance: { match: "universe", estimated: false, sources: { log: 6, recipe: 0, tick: 0, mixed_dish: 0 },
        collapsed: 0, choices: { swap_pick: 0, plan_add: 0, shopping_manual: 0 } } }] } })));
    expect(open.chips["universe:chicken-breast-roasted"]).toEqual(["eaten_often"]);
    const meals = dates(14).flatMap((date) => layout(date, open).meals);
    const chicken = meals.filter(({ meal }) => meal.components.some((part) => part.name === item.food.name));
    expect(chicken.length).toBeGreaterThan(0);
    for (const { meal } of chicken) expect(meal.reasons).toEqual(["eaten_often"]);
    expect(REASON_CHIP_COPY.eaten_often).toBe("You eat this often");
    expect(REASON_CHIP_COPY.on_list).toBe("On your list");
    // A closed account's layout (no open inputs): no field at all.
    const closed = planMealsForDay("2026-10-06", FOUR, device([CHICKEN, YOGURT, TOFU]).foods);
    for (const { meal } of closed.meals) expect("reasons" in meal).toBe(false);
  });
});
