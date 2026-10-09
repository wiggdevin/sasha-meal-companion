import { describe, expect, it } from "vitest";
import { BREAKFAST, brokenRules, eats, F, MAIN } from "@/tests/helpers/meal-foods";
import { affinity, pairScore, PAIR_FLOOR } from "./affinity";
import { planDay } from "./day";
import { occasionAt } from "./occasion";
import { partsOf } from "./parts";
import { rankPlates } from "./plate";

const DATE = "2026-10-04";
const ACCOUNT = eats(F.eggs, F.yogurt, F.oats, F.toast, F.tuna, F.banana, F.rice, F.broccoli, F.oliveOil);
const anchorOf = (plate: { rows: { part: string; food: { id: string } }[] }) =>
  plate.rows.find((row) => row.part === "anchor")?.food.id;
const ids = (plate: { rows: { food: { id: string } }[] }) => plate.rows.map((row) => row.food.id);
const day = () => planDay(DATE, [
  { id: "meal-1", target: BREAKFAST, clock: "07:30" },
  { id: "meal-2", target: MAIN, clock: "12:30" },
  { id: "meal-3", target: MAIN, clock: "19:00" },
], ACCOUNT);

describe("acceptance (a): the 07:30 tuna-and-banana plate", () => {
  it("ranks egg and yogurt anchors above canned tuna at breakfast, by affinity alone", () => {
    expect(affinity(F.eggs, "breakfast").score).toBeGreaterThan(affinity(F.tuna, "breakfast").score);
    expect(affinity(F.yogurt, "breakfast").score).toBeGreaterThan(affinity(F.tuna, "breakfast").score);
    expect(affinity(F.tuna, "breakfast").score).toBeGreaterThan(0); // soft, never a ban
    const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion: "breakfast", target: BREAKFAST, foods: ACCOUNT });
    expect(["eggs", "yogurt"]).toContain(anchorOf(plates[0]));
    const bestTuna = plates.find((plate) => anchorOf(plate) === "tuna");
    if (bestTuna) expect(bestTuna.score).toBeLessThan(plates[0].score);
  });

  it("pairs a side by the table, separately from the anchor: tuna never takes banana", () => {
    expect(pairScore(F.tuna, F.banana, "fruit", "breakfast", "breakfast").score).toBeLessThan(PAIR_FLOOR);
    expect(pairScore(F.yogurt, F.banana, "fruit", "breakfast", "breakfast").score).toBeGreaterThanOrEqual(0.7);
    for (const occasion of ["breakfast", "lunch", "snack", "dinner"] as const) {
      const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion, target: BREAKFAST, foods: ACCOUNT });
      expect(plates.some((plate) => ids(plate).includes("tuna") && ids(plate).includes("banana"))).toBe(false);
    }
  });

  it("lays out a day: no tuna at 07:30, and dinner is anchor + starch + vegetable", () => {
    const plan = day();
    expect(plan.shortages).toEqual([]);
    const [breakfast, , dinner] = plan.plates;
    expect(breakfast.plate.occasion).toBe("breakfast");
    expect(anchorOf(breakfast.plate)).not.toBe("tuna");
    expect(dinner.plate.rows.map((row) => row.part)).toEqual(expect.arrayContaining(["anchor", "starch", "veg"]));
    expect(plan.plates.every(({ plate }) => !(ids(plate).includes("tuna") && ids(plate).includes("banana")))).toBe(true);
  });

  it("names the plate after the dish, a second protein beside the anchor", () => {
    const names = day().plates.map(({ plate }) => plate.name);
    for (const name of names) expect(name).toMatch(/^[A-Z][\w ]+( and [a-z][\w ]+)?( with [a-z][\w ]+( and [a-z][\w ]+)?)?$/);
    const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion: "breakfast", target: BREAKFAST,
      foods: eats(F.yogurt, F.blueberries, F.oats, F.almonds) });
    expect(plates[0].name).toBe("Greek yogurt with blueberries and oats");
  });
});

describe("acceptance (b): template, coherence and bands", () => {
  it("every ranked plate at every occasion keeps its template, pairs and bands", () => {
    for (const clock of ["07:30", "12:30", "15:30", "19:00", "02:00"]) {
      const occasion = occasionAt(clock);
      for (const target of [BREAKFAST, MAIN, { kcal: 900, protein: 60, carbs: 100, fat: 30 }]) {
        const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion, target, foods: ACCOUNT });
        expect(plates.length).toBeGreaterThan(0);
        for (const plate of plates) expect([plate.name, brokenRules(plate)]).toEqual([plate.name, []]);
      }
    }
  });
});

describe("acceptance (d)–(g)", () => {
  it("(d) eggs play an anchor or a second protein; lentils an anchor or a starch", () => {
    expect(partsOf(F.eggs)).toEqual(["anchor", "protein"]);
    expect(partsOf(F.lentils)).toEqual(["anchor", "starch"]);
    const { plates } = rankPlates({ date: DATE, slot: "meal-1", occasion: "breakfast",
      target: { kcal: 650, protein: 60, carbs: 60, fat: 18 }, foods: eats(F.yogurt, F.eggs, F.oats, F.banana) });
    expect(plates.some((plate) => anchorOf(plate) === "eggs")).toBe(true);
    expect(plates.some((plate) => plate.rows.some((row) => row.food.id === "eggs" && row.part === "protein")))
      .toBe(true);
  });

  it("(e) an overnight 02:00 slot is 'other' and gets the savoury-main template", () => {
    expect(occasionAt("02:00")).toBe("other");
    const plan = planDay(DATE, [{ id: "meal-1", target: MAIN, clock: "02:00" }], ACCOUNT);
    expect(plan.plates[0].plate.template).toBe("main");
    expect(affinity(F.tuna, "other").score).toBe(0.5);
  });

  it("(f) a food the table does not know still gets a neutral, valid plate", () => {
    expect(affinity(F.quorn, "lunch")).toEqual({ score: 0.5, source: "neutral" });
    const foods = eats(F.quorn, F.rice, F.broccoli, F.oliveOil);
    const { plates } = rankPlates({ date: DATE, slot: "meal-2", occasion: "lunch", target: MAIN, foods });
    expect(plates.length).toBeGreaterThan(0);
    expect(anchorOf(plates[0])).toBe("quorn");
    expect(brokenRules(plates[0])).toEqual([]);
  });

  it("(g) a slot with no coherent plate names the missing part", () => {
    const breakfast = rankPlates({ date: DATE, slot: "meal-1", occasion: "breakfast", target: BREAKFAST,
      foods: eats(F.eggs, F.oliveOil) });
    expect(breakfast.plates).toEqual([]);
    expect(breakfast.shortage).toEqual({ missing: ["starch", "fruit"], reason: "No breakfast starch or fruit fits yet — try another food" });
    // Banana is in Eats, but tuna does not pair with it: still short of a starch or fruit.
    const tuna = rankPlates({ date: DATE, slot: "meal-1", occasion: "breakfast", target: BREAKFAST,
      foods: eats(F.tuna, F.banana) });
    expect(tuna.shortage?.reason).toBe("No breakfast starch or fruit fits yet — try another food");
    expect(rankPlates({ date: DATE, slot: "meal-2", occasion: "lunch", target: MAIN,
      foods: eats(F.tuna, F.oliveOil) }).shortage?.reason).toBe("No lunch starch fits yet — try another food");
    expect(rankPlates({ date: DATE, slot: "meal-3", occasion: "dinner", target: MAIN,
      foods: eats(F.rice, F.oliveOil) }).shortage).toEqual({ missing: ["anchor"], reason: "No dinner protein fits yet — try another food" });
  });
});

describe("acceptance (h): deterministic for a date", () => {
  it("gives the same day for the same date whatever order Eats arrive in", () => {
    const first = JSON.stringify(day());
    expect(JSON.stringify(day())).toBe(first);
    const reversed = Object.fromEntries(Object.entries(ACCOUNT).reverse());
    const again = planDay(DATE, [
      { id: "meal-1", target: BREAKFAST, clock: "07:30" },
      { id: "meal-2", target: MAIN, clock: "12:30" },
      { id: "meal-3", target: MAIN, clock: "19:00" },
    ], reversed);
    expect(JSON.stringify(again)).toBe(first);
  });

  it("rotates over dates and stays coherent on every one", () => {
    const richer = { ...ACCOUNT, ...eats(F.chicken, F.lentils, F.blueberries, F.spinach, F.almonds) };
    const names = new Set<string>();
    for (let n = 0; n < 14; n += 1) {
      const date = `2026-10-${String(n + 1).padStart(2, "0")}`;
      const plan = planDay(date, [{ id: "meal-1", target: BREAKFAST, clock: "07:30" },
        { id: "meal-2", target: MAIN, clock: "12:30" }, { id: "meal-3", target: MAIN, clock: "19:00" }], richer);
      for (const { plate } of plan.plates) {
        expect(brokenRules(plate)).toEqual([]);
        names.add(plate.name);
      }
    }
    expect(names.size).toBeGreaterThan(3);
  });
});
