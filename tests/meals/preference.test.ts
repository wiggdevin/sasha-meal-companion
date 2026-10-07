/**
 * Phase 18 W7 (`pref-2`, D8): acceptance 2 (pinned values and spread rules) and acceptance 3
 * (monotonicity of a food's best plate). Acceptance 1 is tests/meals/pref2-baseline.test.ts;
 * acceptance 4 is tests/meals/ranking-boundary.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Food } from "@/lib/foods";
import { OCCASIONS, type Occasion } from "@/lib/meals/occasion";
import { foodKey } from "@/lib/meals/parts";
import { rankPlates } from "@/lib/meals/plate";
import { planDay } from "@/lib/meals/day";
import {
  directEvidence, PREFERENCE_WEIGHTS, preferenceScores, priorFade, quantizeZ, recipeTastePoints,
  spreadEvidence, tasteMultiplier, tasteValues, tasteZ,
  type FoodSignals, type PreferenceFood, type PreferenceInput, type PreferenceTerms as FoodPreferenceTerms,
} from "@/lib/meals/preference";
import { TIERS } from "@/lib/foods/universe/vocabulary";
import { BREAKFAST, eats, F, MAIN } from "@/tests/helpers/meal-foods";

/** A small deterministic PRNG (mulberry32), so every property case is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const one = (food: PreferenceFood, episodes = 0) => preferenceScores({ episodes, foods: [food] })[food.key];

describe("acceptance 2: pinned values", () => {
  it("fades the prior: w(0) = 1, w(12) = 0.5, w(36) = 0.125, w(59) > 0, w(60) = 0", () => {
    expect(priorFade(0)).toBe(1);
    expect(priorFade(12)).toBe(0.5);
    expect(priorFade(36)).toBe(0.125);
    expect(priorFade(59)).toBeGreaterThan(0);
    expect(priorFade(60)).toBe(0);
    expect(priorFade(500)).toBe(0);
    expect(priorFade(Number.NaN)).toBe(1);
    expect(priorFade(-5)).toBe(1);
  });

  it("scores every universe cuisine tier", () => {
    expect(Object.keys(PREFERENCE_WEIGHTS.tiers).sort()).toEqual([...TIERS].sort());
  });

  it("weights each term as D8 states", () => {
    expect(one({ key: "a", prior: 1.5 }).base.z).toBe(0.3);
    expect(one({ key: "a", prior: 1.5 }, 12).base.z).toBe(0.15);
    expect(one({ key: "a", prior: 1.5 }, 60).base.z).toBe(0);
    expect(one({ key: "a", signals: { favored: true } }).base.z).toBe(0.54);
    expect(one({ key: "a", signals: { disliked: true } }).base.z).toBe(-0.72);
    expect(one({ key: "a", cuisineTiers: ["occasional", "core"] }).base.z).toBe(0.15);
    expect(one({ key: "a", cuisineTiers: ["common"] }).base.z).toBe(0.09);
    expect(one({ key: "a", rules: 3 }).base.z).toBe(0.15);
    expect(one({ key: "a", rules: -5 }).base.z).toBe(-0.2);
    expect(one({ key: "a", rules: 100 }).base.z).toBe(0.2);
    expect(directEvidence({ eaten: Math.E - 1 }, null)).toBeCloseTo(0.7, 12);
    expect(directEvidence({ notThis: { lunch: 1 } }, "lunch")).toBeCloseTo(-0.7 * Math.log(2), 12);
    expect(directEvidence({ notThis: { lunch: 1 } }, "dinner")).toBe(0);
    expect(directEvidence({ favored: true, eaten: 1e9, chosen: 1e9 }, null)).toBe(2);
  });

  it("keeps z inside [-0.8, 0.8] on a quantum of 0.01 for arbitrary, even invalid, inputs", () => {
    const next = rng(7);
    const wild = () => [Number.NaN, Number.POSITIVE_INFINITY, -1e9, 1e9, -3, 0][Math.floor(next() * 6)];
    const value = () => (next() < 0.2 ? wild() : (next() - 0.3) * 40);
    for (let i = 0; i < 2_000; i += 1) {
      const foods: PreferenceFood[] = Array.from({ length: 4 }, (_, j) => ({
        key: `f${j}`, prior: value(), rules: value(),
        cuisineTiers: next() < 0.5 ? ["core"] : [],
        signals: { favored: next() < 0.5, disliked: next() < 0.5, eaten: value(), chosen: value(),
          shop: value(), pantry: value(), notThis: { lunch: value(), snack: value() } },
        neighbours: [0, 1, 2, 3].filter((k) => k !== j).map((k) => ({ key: `f${k}`, k: next() * 1.2, sensory: next() < 0.5 })),
      }));
      const scores = preferenceScores({ episodes: value(), foods });
      for (const score of Object.values(scores)) {
        for (const terms of [score.base, ...OCCASIONS.map((o) => score.byOccasion[o])]) {
          expect(terms.z).toBeGreaterThanOrEqual(-0.8);
          expect(terms.z).toBeLessThanOrEqual(0.8);
          expect(Math.abs(Math.round(terms.z * 100) - terms.z * 100)).toBeLessThan(1e-9);
        }
      }
    }
    expect(quantizeZ(Number.NaN)).toBe(0);
    expect(Object.is(quantizeZ(-0.001), -0)).toBe(false);
  });
});

describe("acceptance 2: the substitute spread", () => {
  const liked: FoodSignals = { favored: true };
  const food = (key: string, signals?: FoodSignals, neighbours: PreferenceFood["neighbours"] = []): PreferenceFood =>
    ({ key, ...(signals ? { signals } : {}), neighbours });

  it("is 0 with no neighbour, or neighbours with no evidence, never dividing by zero", () => {
    expect(spreadEvidence("bison", [], () => undefined)).toBe(0);
    expect(spreadEvidence("bison", [{ key: "x", k: 0 }], () => undefined)).toBe(0);
    expect(spreadEvidence("bison", [{ key: "bison", k: 1 }], () => liked)).toBe(0);
    expect(one(food("bison", undefined, [{ key: "venison", k: 0.8 }])).base.spread).toBe(0);
  });

  it("lifts a food with no direct evidence from a liked neighbour, capped at 0.10", () => {
    const scores = preferenceScores({ episodes: 0, foods: [food("venison", liked),
      food("bison", undefined, [{ key: "venison", k: 0.8 }])] });
    expect(scores.bison.base.spread).toBe(0.1);
    expect(scores.bison.base.z).toBe(0.1);
    expect(scores.bison.reasons.map((reason) => reason.code)).toContain("like_liked");
  });

  it("is G = 0 for a food with direct evidence", () => {
    for (const signals of [{ eaten: 2 }, { chosen: 1 }, { favored: true }, { disliked: true }, { shop: 1 },
      { pantry: 1 }] as FoodSignals[]) {
      const scores = preferenceScores({ episodes: 0, foods: [food("venison", liked),
        food("bison", signals, [{ key: "venison", k: 0.8 }])] });
      expect(scores.bison.base.spread).toBe(0);
      for (const o of OCCASIONS) expect(scores.bison.byOccasion[o].spread).toBe(0);
    }
    // "Not this" is direct evidence only at its own occasion.
    const scores = preferenceScores({ episodes: 0, foods: [food("venison", liked),
      food("bison", { notThis: { lunch: 1 } }, [{ key: "venison", k: 0.8 }])] });
    expect(scores.bison.byOccasion.lunch.spread).toBe(0);
    expect(scores.bison.byOccasion.dinner.spread).toBe(0.1);
  });

  it("spreads a taste dislike only along a reviewed sensory edge of at least 0.7", () => {
    const disliked: FoodSignals = { disliked: true };
    const zOf = (edge: { k: number; sensory?: boolean }) => preferenceScores({ episodes: 0, foods: [
      food("okra", disliked), food("nopal", undefined, [{ key: "okra", ...edge }])] }).nopal.base.spread;
    expect(zOf({ k: 0.7, sensory: true })).toBe(-0.1);
    expect(zOf({ k: 0.95, sensory: true })).toBe(-0.1);
    expect(zOf({ k: 0.69, sensory: true })).toBe(0);
    expect(zOf({ k: 0.95, sensory: false })).toBe(0);
    expect(zOf({ k: 0.95 })).toBe(0);
  });

  it("never spreads an occasion's Not this", () => {
    const scores = preferenceScores({ episodes: 0, foods: [food("salmon", { notThis: { breakfast: 9, lunch: 9 } }),
      food("trout", undefined, [{ key: "salmon", k: 1, sensory: true }])] });
    for (const o of OCCASIONS) expect(scores.trout.byOccasion[o].z).toBe(0);
    expect(scores.trout.base.z).toBe(0);
  });

  it("keeps at most eight neighbours, the strongest", () => {
    const neighbours = Array.from({ length: 9 }, (_, i) => ({ key: `n${i}`, k: i === 8 ? 0.1 : 0.9 }));
    const signalsOf = (key: string) => (key === "n8" ? { favored: true } : undefined);
    expect(spreadEvidence("f", neighbours, signalsOf)).toBe(0);
  });
});

describe("the retained neighbour estimate (D8 G = 0 vs acceptance 3)", () => {
  it("reports spread 0 with direct evidence, and the floor as retained, with its reason", () => {
    const scores = preferenceScores({ episodes: 0, foods: [{ key: "venison", signals: { favored: true } },
      { key: "bison", signals: { eaten: 0.01 }, neighbours: [{ key: "venison", k: 0.8 }] }] });
    const bison = scores.bison.base;
    expect(bison.spread).toBe(0);
    expect(bison.direct).toBeCloseTo(0.45 * 0.7 * Math.log1p(0.01), 4);
    expect(bison.retained).toBeCloseTo(0.1 - bison.direct, 4);
    expect(bison.z).toBe(0.1);
    const like = scores.bison.reasons.find((reason) => reason.code === "like_liked");
    expect(like?.contribution).toBe(bison.retained);
  });

  it("retains nothing once direct evidence outweighs the estimate, or points the other way", () => {
    const strong = preferenceScores({ episodes: 0, foods: [{ key: "venison", signals: { favored: true } },
      { key: "bison", signals: { eaten: 3 }, neighbours: [{ key: "venison", k: 0.8 }] }] }).bison;
    expect(strong.base.retained).toBe(0);
    expect(strong.reasons.some((reason) => reason.code === "like_liked")).toBe(false);
    const against = preferenceScores({ episodes: 0, foods: [{ key: "venison", signals: { favored: true } },
      { key: "bison", signals: { disliked: true }, neighbours: [{ key: "venison", k: 0.8 }] }] }).bison;
    expect(against.base.retained).toBe(0);
    expect(against.base.z).toBe(-0.72);
  });
});

describe("reasons and keys", () => {
  it("states effective contributions that sum to the terms, D's clip and the floor included", () => {
    const pre = (terms: FoodPreferenceTerms) => terms.prior + terms.direct + terms.spread + terms.retained
      + terms.cuisine + terms.rules;
    const cases: PreferenceFood[][] = [
      [{ key: "a", prior: 1, cuisineTiers: ["core"], rules: 2,
        signals: { favored: true, eaten: 50, chosen: 20, shop: 1, notThis: { lunch: 3 } } }],
      // Sol r2: a retained floor at the base that "Not this" reverses at lunch.
      [{ key: "a", signals: { eaten: 0.01, notThis: { lunch: 1 } }, neighbours: [{ key: "n", k: 0.8 }] },
        { key: "n", signals: { favored: true } }],
      [{ key: "a", signals: { notThis: { dinner: 2 } }, neighbours: [{ key: "n", k: 0.9 }] },
        { key: "n", signals: { eaten: 4 } }],
    ];
    for (const foods of cases) {
      const score = preferenceScores({ episodes: 6, foods }).a;
      const shared = score.reasons.filter((reason) => !reason.occasions)
        .reduce((sum, reason) => sum + reason.contribution, 0);
      expect(shared).toBeCloseTo(pre(score.base), 3);
      for (const o of OCCASIONS) {
        const own = score.reasons.filter((reason) => reason.occasions?.includes(o))
          .reduce((sum, reason) => sum + reason.contribution, 0);
        expect(shared + own).toBeCloseTo(pre(score.byOccasion[o]), 3);
      }
    }
    expect(preferenceScores({ episodes: 6, foods: cases[0] }).a.base.direct).toBeCloseTo(0.45 * 2, 4);
  });

  it("keeps a food named __proto__ as an own entry", () => {
    const scores = preferenceScores({ episodes: 0, foods: [{ key: "__proto__", signals: { favored: true } }] });
    expect(Object.hasOwn(scores, "__proto__")).toBe(true);
    const values = tasteValues(scores);
    expect(Object.hasOwn(values, "__proto__")).toBe(true);
    expect(tasteZ(values, "__proto__", null)).toBe(0.54);
  });

  it("treats an empty taste map as no taste term", () => {
    const input = { date: "2026-03-02", slot: "meal-1", occasion: "breakfast" as Occasion, target: BREAKFAST,
      foods: eats(F.eggs, F.oats, F.banana) };
    expect(JSON.stringify(rankPlates({ ...input, taste: {} }))).toBe(JSON.stringify(rankPlates(input)));
  });

  it("keeps T finite for huge amounts", () => {
    expect(tasteMultiplier([{ key: "a", amount: 1e308 }, { key: "b", amount: 1e308 }], { a: { base: 0.5 } }, null))
      .toBeCloseTo(Math.exp(0.25), 12);
  });
});

describe("taste values and T", () => {
  it("leaves zeros out, keeps only differing occasions, and reads 0 for unknown or bad values", () => {
    const scores = preferenceScores({ episodes: 0, foods: [{ key: "a", signals: { favored: true, notThis: { lunch: 2 } } },
      { key: "b" }] });
    const values = tasteValues(scores);
    expect(Object.keys(values)).toEqual(["a"]);
    expect(values.a.base).toBe(0.54);
    expect(Object.keys(values.a.occasion ?? {})).toEqual(["lunch"]);
    expect(tasteZ(values, "a", "lunch")).toBe(values.a.occasion?.lunch);
    expect(tasteZ(values, "a", "dinner")).toBe(0.54);
    expect(tasteZ(values, "b", null)).toBe(0);
    expect(tasteZ({ x: { base: Number.NaN } }, "x", null)).toBe(0);
    expect(tasteZ({ x: { base: 9 } }, "x", null)).toBe(0.8);
    expect(tasteZ(values, "toString", null)).toBe(0);
  });

  it("computes T by calorie (or gram) share, and the recipe points as 6 × (T − 1)", () => {
    const values = { a: { base: 0.5 }, b: { base: -0.5 } };
    expect(tasteMultiplier([{ key: "a", amount: 300 }, { key: "b", amount: 100 }], values, null))
      .toBeCloseTo(Math.exp(0.25), 12);
    expect(tasteMultiplier([{ key: "a", amount: 0 }], values, null)).toBe(1);
    expect(recipeTastePoints([{ key: "a", amount: 10 }], values)).toBeCloseTo(6 * (Math.exp(0.5) - 1), 12);
    expect(PREFERENCE_WEIGHTS.recipeTastePoints).toBe(6);
  });

  it("changes the ranking when taste values are given and records T on the plate", () => {
    const foods = eats(F.eggs, F.yogurt, F.tofu, F.oats, F.toast, F.banana, F.blueberries, F.almonds);
    const input = { date: "2026-03-02", slot: "meal-1", occasion: "breakfast" as Occasion, target: BREAKFAST, foods };
    const plain = rankPlates(input);
    expect(plain.plates.every((plate) => plate.taste === undefined)).toBe(true);
    const tofu = foodKey(F.tofu);
    const tasted = rankPlates({ ...input, taste: { [tofu]: { base: 0.8 } } });
    const best = tasted.plates[0];
    expect(best.anchorKey).toBe(tofu);
    expect(best.taste).toBeGreaterThan(1);
  });
});

describe("acceptance 3: monotonicity of a food's best plate", () => {
  const pool: Food[] = [F.eggs, F.yogurt, F.tofu, F.chicken, F.oats, F.toast, F.rice, F.banana, F.blueberries,
    F.broccoli, F.oliveOil, F.almonds];
  const foods = eats(...pool);
  const keys = pool.map(foodKey);
  const slots: { occasion: Occasion; target: typeof MAIN; date: string }[] = [
    { occasion: "breakfast", target: BREAKFAST, date: "2026-02-03" },
    { occasion: "lunch", target: MAIN, date: "2026-05-11" },
  ];

  /** Random signals for every food, and a substitute graph among them. */
  function randomInput(next: () => number): PreferenceInput {
    return { episodes: next() * 80, foods: keys.map((key) => ({
      key, prior: (next() - 0.5) * 3, rules: next() < 0.3 ? (next() - 0.5) * 8 : 0,
      cuisineTiers: next() < 0.3 ? ["common"] : [],
      signals: next() < 0.5 ? {} : { favored: next() < 0.2, disliked: next() < 0.2, eaten: next() < 0.5 ? next() * 4 : 0,
        chosen: next() < 0.3 ? Math.floor(next() * 3) : 0, notThis: next() < 0.3 ? { lunch: 1, breakfast: 1 } : {} },
      neighbours: keys.filter((other) => other !== key && next() < 0.3)
        .map((other) => ({ key: other, k: 0.3 + next() * 0.7, sensory: next() < 0.5 })),
    })) };
  }

  const bestFor = (input: PreferenceInput, key: string, slot: (typeof slots)[number]) => {
    const taste = tasteValues(preferenceScores(input));
    const plates = rankPlates({ date: slot.date, slot: "meal-1", occasion: slot.occasion, target: slot.target, foods, taste }).plates;
    return Math.max(0, ...plates.filter((plate) => plate.rows.some((row) => foodKey(row.food) === key)).map((p) => p.score));
  };

  type Bump = (signals: FoodSignals) => FoodSignals;
  const RAISE: [string, Bump][] = [
    ["F", (s) => ({ ...s, favored: true })],
    ["H", (s) => ({ ...s, eaten: (s.eaten ?? 0) + 0.03 })],
    ["H+", (s) => ({ ...s, eaten: (s.eaten ?? 0) + 2 })],
    ["Q", (s) => ({ ...s, chosen: (s.chosen ?? 0) + 0.5 })],
  ];
  const LOWER: [string, Bump][] = [
    ["L", (s) => ({ ...s, disliked: true })],
    ["N", (s) => ({ ...s, notThis: { ...s.notThis, lunch: (s.notThis?.lunch ?? 0) + 1, breakfast: (s.notThis?.breakfast ?? 0) + 1 } })],
  ];

  const bumped = (input: PreferenceInput, key: string, bump: Bump): PreferenceInput => ({
    ...input, foods: input.foods.map((food) => (food.key === key ? { ...food, signals: bump(food.signals ?? {}) } : food)),
  });

  it("raising F, H or Q never lowers it; raising L or N never raises it", () => {
    const next = rng(2026);
    for (let round = 0; round < 12; round += 1) {
      const input = randomInput(next);
      const key = keys[Math.floor(next() * keys.length)];
      for (const slot of slots) {
        const before = bestFor(input, key, slot);
        for (const [, bump] of RAISE) expect(bestFor(bumped(input, key, bump), key, slot)).toBeGreaterThanOrEqual(before);
        for (const [, bump] of LOWER) expect(bestFor(bumped(input, key, bump), key, slot)).toBeLessThanOrEqual(before);
      }
    }
  }, 60_000);

  it("holds z monotone for every food over many random cases", () => {
    const next = rng(99);
    for (let round = 0; round < 400; round += 1) {
      const input = randomInput(next);
      const key = keys[Math.floor(next() * keys.length)];
      const before = preferenceScores(input);
      for (const [name, bump] of [...RAISE, ...LOWER]) {
        const after = preferenceScores(bumped(input, key, bump));
        const raise = RAISE.some(([n]) => n === name);
        for (const other of keys) {
          for (const o of OCCASIONS) {
            const a = before[other].byOccasion[o].z;
            const b = after[other].byOccasion[o].z;
            if (raise) expect(b).toBeGreaterThanOrEqual(a);
            else expect(b).toBeLessThanOrEqual(a);
          }
        }
      }
    }
  });

  it("fills a day with taste values as it does without them", () => {
    const next = rng(5);
    const taste = tasteValues(preferenceScores(randomInput(next)));
    const slotsOfDay = [{ id: "meal-1" as const, clock: "07:30", target: BREAKFAST },
      { id: "meal-2" as const, clock: "12:30", target: MAIN }, { id: "meal-3" as const, clock: "19:00", target: MAIN }];
    const plan = planDay("2026-06-01", slotsOfDay, foods, undefined, undefined, taste);
    expect(plan.plates).toHaveLength(3);
    expect(plan.plates.every(({ plate }) => typeof plate.taste === "number")).toBe(true);
  });
});
