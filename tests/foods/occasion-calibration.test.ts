import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OCCASION_RUBRIC_VERSION } from "@/lib/foods/facet-vocabulary";
import { OCCASION_CALIBRATION } from "@/lib/foods/occasion-calibration.data";
import {
  ACCEPTANCE, CALIBRATION_CUISINES, calibrationVerdict, MEAL_OCCASIONS, occasionFacetGate,
  type CalibrationCuisine, type CuisineScore, type StoredOccasionCalibration,
} from "@/lib/foods/occasion-gate";
import {
  balancedAccuracy, calibrationSource, facetScoresFor, judgePlate, promoted, evaluate, holdoutReviewed,
  observations, parseHoldout, perCuisine, selectThreshold, selectThresholds, storedCalibration, type Answers,
  type Holdout, type HoldoutItem, type Observation, type PantryItem, type PlateGenerator,
} from "@/scripts/eval/facets-occasion/metrics";
import { pantryEvidence, pantryFood, rankPlatesGenerator } from "@/scripts/eval/facets-occasion/plates";

const ROOT = resolve(import.meta.dirname, "../..");
const SEED_PATH = resolve(ROOT, "scripts/eval/facets-occasion.holdout.json");

const obs = (truth: boolean, p: number, extra: Partial<Observation> = {}): Observation =>
  ({ id: `x${p}`, cuisine: "south-asian", dish: false, occasion: "breakfast", truth, p, ...extra });

const PANTRY_LABELS: readonly Record<"breakfast" | "lunch" | "dinner" | "snack", boolean>[] = [
  { breakfast: true, lunch: false, dinner: false, snack: true },
  { breakfast: true, lunch: true, dinner: true, snack: false },
  { breakfast: false, lunch: true, dinner: true, snack: false },
  { breakfast: false, lunch: false, dinner: true, snack: true },
];

/**
 * Four items per cuisine (two dishes) plus a four-food pantry, every occasion labelled: each cuisine
 * has 32 labelled pairs, and each occasion has exactly two pantry foods labelled typical.
 */
function syntheticHoldout(): Holdout {
  const items: HoldoutItem[] = [];
  const pantry: PantryItem[] = [];
  for (const cuisine of CALIBRATION_CUISINES) {
    for (let index = 0; index < 4; index += 1) {
      items.push({ id: `${cuisine}-${index}`, cuisine, kind: index < 2 ? "dish" : "food",
        food: { name: `Food ${cuisine} ${index}` },
        labels: { breakfast: index % 2 === 0, lunch: index !== 0, dinner: index > 1, snack: index === 3 } });
      pantry.push({ id: `${cuisine}-p${index}`, cuisine, role: "protein", per100g: { protein: 10, carbs: 5, fat: 5 },
        food: { name: `Pantry ${cuisine} ${index}` }, labels: { ...PANTRY_LABELS[index] } });
    }
  }
  return { status: "reviewed", reviewedBy: "owner", reviewedAt: "2026-10-05", items, pantry };
}

/**
 * A stand-in for the real plate generator: ranks the pantry by facet score (then id) and serves
 * two plates per occasion, the top two foods and the top one alone. No facet evidence means id
 * order, which puts foods labelled false on some plates.
 */
const fakeGenerator: PlateGenerator = (pantry, occasion, facets) => {
  const ranked = [...pantry].sort((a, b) => (facets[b.id]?.[occasion] ?? 0.5) - (facets[a.id]?.[occasion] ?? 0.5)
    || (a.id < b.id ? -1 : 1));
  return [{ occasion, foodIds: ranked.slice(0, 2).map((item) => item.id) },
    { occasion, foodIds: [ranked[0].id] }];
};

/** Answers that agree with every label (0.8 yes / 0.2 no), except where `wrong` says otherwise. */
function answersFor(holdout: Holdout, wrong: (item: { id: string }) => boolean = () => false): Answers {
  return Object.fromEntries([...holdout.items, ...holdout.pantry].map((item) => [item.id,
    Object.fromEntries(MEAL_OCCASIONS.map((o) => {
      const truth = item.labels[o] === true;
      return [o, (truth !== wrong(item)) ? 0.8 : 0.2];
    }))]));
}

function scores(value: Partial<CuisineScore>): Record<CalibrationCuisine, CuisineScore> {
  return Object.fromEntries(CALIBRATION_CUISINES.map((cuisine) => [cuisine,
    { accuracy: 0.9, plausibility: 0.9, dishAccuracy: 0.9, pairs: 40, plates: 16, ...value }])) as
    Record<CalibrationCuisine, CuisineScore>;
}

function stored(overrides: Partial<StoredOccasionCalibration> = {}): StoredOccasionCalibration {
  return { rubricVersion: OCCASION_RUBRIC_VERSION, model: "jev-test", measuredAt: "2026-10-05T00:00:00.000Z",
    holdoutSha256: "a".repeat(64), holdoutReviewed: true,
    thresholds: { breakfast: 0.6, lunch: 0.5, dinner: 0.4, snack: 0.55 }, perCuisine: scores({}), ...overrides };
}

describe("threshold selection (balanced accuracy)", () => {
  it("averages the true-positive and true-negative rates", () => {
    const rows = [obs(true, 0.95), obs(true, 0.7), obs(false, 0.2), obs(false, 0.1), obs(false, 0.9)];
    // At 0.8: TPR 1/2, TNR 2/3.
    expect(balancedAccuracy(rows, 0.8)).toBeCloseTo((0.5 + 2 / 3) / 2, 10);
    expect(balancedAccuracy([obs(true, 0.9)], 0.8)).toBe(1);
    expect(balancedAccuracy([], 0.8)).toBe(0);
  });

  it("never counts an uncertain p = 0.5 as typical, at any threshold", () => {
    expect(promoted(0.5, 0.3)).toBe(false);
    expect(balancedAccuracy([obs(true, 0.5)], 0.3)).toBe(0);
  });

  it("picks the threshold that separates the classes, in the middle of a tied run", () => {
    const rows = [obs(true, 0.97), obs(true, 0.85), obs(false, 0.7), obs(false, 0.05)];
    // Every grid value in 0.71–0.85 is perfect: 15 values, the middle one is 0.78.
    expect(selectThreshold(rows)).toBe(0.78);
    // An even run (0.71–0.84, 14 values) takes the upper middle.
    expect(selectThreshold([obs(true, 0.84), obs(false, 0.7)])).toBe(0.78);
  });

  it("weighs a rare class as much as a common one", () => {
    // Nine negatives at 0.75 and one positive at 0.8: plain accuracy is 90 % at any threshold
    // above 0.8; balanced accuracy needs the positive too, so only 0.76–0.80 are best: 0.78.
    const rows = [obs(true, 0.8), ...Array.from({ length: 9 }, (_, i) => obs(false, 0.75, { id: `n${i}` }))];
    expect(selectThreshold(rows)).toBe(0.78);
  });

  it("selects one threshold per occasion, never below the promote floor", () => {
    const rows = [
      obs(true, 0.9, { occasion: "breakfast" }), obs(false, 0.75, { occasion: "breakfast" }),
      obs(true, 0.7, { occasion: "dinner" }), obs(false, 0.1, { occasion: "dinner" }),
    ];
    const thresholds = selectThresholds(rows);
    expect(thresholds.breakfast).toBe(0.83); // 0.76–0.90
    expect(thresholds.dinner).toBe(0.68); // 0.65–0.70, even run: upper middle
  });
});

describe("generated-plate plausibility (Acceptance 9)", () => {
  it("judges a plate against human labels: no food on it may be labelled false at its occasion", () => {
    const labels = new Map([
      ["a", { breakfast: true, lunch: false, dinner: null, snack: true }],
      ["b", { breakfast: null, lunch: true, dinner: true, snack: false }],
    ] as const);
    expect(judgePlate({ occasion: "breakfast", foodIds: ["a", "b"] }, labels)).toBe(true); // null is not false
    expect(judgePlate({ occasion: "lunch", foodIds: ["a", "b"] }, labels)).toBe(false);
    expect(judgePlate({ occasion: "dinner", foodIds: ["a", "b"] }, labels)).toBe(true);
    expect(judgePlate({ occasion: "snack", foodIds: [] }, labels)).toBe(false);
    expect(() => judgePlate({ occasion: "snack", foodIds: ["zz"] }, labels)).toThrow(/unknown food/);
  });

  it("maps answers to ladder scores with the production mapping (uncertain stays out)", () => {
    const pantry = syntheticHoldout().pantry.slice(0, 2);
    const answers: Answers = { [pantry[0].id]: { breakfast: 0.9, lunch: 0.5, dinner: 0.66, snack: 0.2 } };
    const facets = facetScoresFor(pantry, answers, { breakfast: 0.7, lunch: 0.4, dinner: 0.4, snack: 0.4 });
    expect(Object.keys(facets)).toEqual([pantry[0].id]);
    expect(Object.keys(facets[pantry[0].id]).sort()).toEqual(["breakfast", "dinner"]);
  });

  it("scores plates per cuisine; label accuracy and dish accuracy ride along", () => {
    const holdout = syntheticHoldout();
    const answers = answersFor(holdout, (item) => item.id === "west-african-2");
    const rows = observations(holdout, answers);
    const { scores: result, plates } = perCuisine(holdout, rows, answers, selectThresholds(rows), false, fakeGenerator);
    expect(result["south-asian"]).toEqual({ accuracy: 1, plausibility: 1, dishAccuracy: 1, pairs: 32, plates: 8 });
    // The wrong item is a named food, not a pantry food: plates are untouched.
    expect(result["west-african"]).toMatchObject({ accuracy: 0.875, plausibility: 1, dishAccuracy: 1 });
    expect(plates.filter((plate) => plate.cuisine === "east-asian")).toHaveLength(8);
  });

  it("wrong pantry answers put implausible foods on plates", () => {
    const holdout = syntheticHoldout();
    const answers = answersFor(holdout, (item) => item.id.startsWith("mediterranean-p"));
    const rows = observations(holdout, answers);
    const { scores: result } = perCuisine(holdout, rows, answers, selectThresholds(rows), false, fakeGenerator);
    expect(result.mediterranean.plausibility).toBeLessThan(0.85);
    expect(result["latin-american"].plausibility).toBe(1);
  });

  it("scores each cuisine at thresholds chosen without it (leave-one-cuisine-out)", () => {
    const holdout = syntheticHoldout();
    // East Asian answers sit lower (yes = 0.68): a threshold chosen without them sits above it.
    const answers = answersFor(holdout);
    for (const item of [...holdout.items, ...holdout.pantry].filter((i) => i.cuisine === "east-asian")) {
      for (const o of MEAL_OCCASIONS) if (answers[item.id][o] === 0.8) answers[item.id][o] = 0.68;
    }
    const rows = observations(holdout, answers);
    const { scores: crossValidated } = perCuisine(holdout, rows, answers, selectThresholds(rows), true, fakeGenerator);
    expect(crossValidated["east-asian"].accuracy).toBeLessThan(1);
    expect(crossValidated["south-asian"].accuracy).toBe(1);
  });

  it("refuses a labelled pair with no answer, and skips null labels", () => {
    const holdout = syntheticHoldout();
    holdout.items[0].labels.snack = null;
    const answers = answersFor(holdout);
    delete answers[holdout.items[0].id].snack;
    expect(observations(holdout, answers)).toHaveLength((holdout.items.length + holdout.pantry.length) * 4 - 1);
    delete answers[holdout.items[1].id].lunch;
    expect(() => observations(holdout, answers)).toThrow(/no answer/);
  });
});

describe("Acceptance 9 verdict", () => {
  it("passes at >= 85 % per cuisine with no cuisine more than 10 points below the best", () => {
    expect(calibrationVerdict(scores({}))).toEqual({ passes: true, reasons: [] });
    const edge = scores({});
    edge["west-african"] = { ...edge["west-african"], plausibility: 0.85 };
    edge["east-asian"] = { ...edge["east-asian"], plausibility: 0.95 };
    expect(calibrationVerdict(edge).passes).toBe(true);
    // Label accuracy is reported, not gated.
    expect(calibrationVerdict(scores({ accuracy: 0.5, dishAccuracy: 0.5 })).passes).toBe(true);
  });

  it("fails a cuisine under 85 %, a gap over 10 points, a missing cuisine or a thin sample", () => {
    const low = scores({});
    low.mediterranean = { ...low.mediterranean, plausibility: 0.84 };
    expect(calibrationVerdict(low).reasons).toEqual(expect.arrayContaining([expect.stringMatching(/mediterranean: plate plausibility/)]));

    const gap = scores({ plausibility: 0.97 });
    gap["latin-american"] = { ...gap["latin-american"], plausibility: 0.86 };
    expect(calibrationVerdict(gap).reasons).toEqual([expect.stringMatching(/latin-american: plausibility .* below the best/)]);

    const missing: Partial<Record<CalibrationCuisine, CuisineScore>> = scores({});
    delete missing["west-african"];
    expect(calibrationVerdict(missing).reasons).toContain("west-african: not measured");

    expect(calibrationVerdict(scores({ pairs: ACCEPTANCE.minPairsPerCuisine - 1 })).passes).toBe(false);
    expect(calibrationVerdict(scores({ pairs: Number.NaN })).passes).toBe(false);
    expect(calibrationVerdict(scores({ plates: Number.POSITIVE_INFINITY })).passes).toBe(false);
    expect(calibrationVerdict(scores({ pairs: 40.5 })).passes).toBe(false);
    expect(calibrationVerdict(scores({ plates: ACCEPTANCE.minPlatesPerCuisine - 1 })).passes).toBe(false);
  });

  it("an end-to-end report passes only on a reviewed holdout, and stores only then", () => {
    const holdout = syntheticHoldout();
    const answers = answersFor(holdout);
    const report = evaluate(holdout, "raw", answers, { model: "jev-test", measuredAt: "2026-10-05T00:00:00.000Z" },
      fakeGenerator);
    expect(report.verdict).toEqual({ passes: true, reasons: [] });
    expect(report.perCuisine["north-american-european"]).toMatchObject({ accuracy: 1, plausibility: 1, plates: 8 });
    // With every facet abstaining, id order puts labelled-false foods on some plates.
    expect(report.curatedOnlyPlausibility["south-asian"]).toBeLessThan(1);
    expect(report.plates).toHaveLength(CALIBRATION_CUISINES.length * 8);
    expect(storedCalibration(report)).toMatchObject({ rubricVersion: OCCASION_RUBRIC_VERSION, holdoutReviewed: true });

    const seed = { ...holdout, status: "seed", reviewedBy: null, reviewedAt: null };
    const seedReport = evaluate(seed, "raw", answers, { model: "jev-test", measuredAt: "2026-10-05T00:00:00.000Z" },
      fakeGenerator);
    expect(seedReport.verdict.passes).toBe(false);
    expect(storedCalibration(seedReport)).toBeNull();
  });
});

describe("the occasion-facet gate", () => {
  it("abstains by default: no calibration is stored yet", () => {
    expect(OCCASION_CALIBRATION).toBeNull();
    expect(occasionFacetGate()).toEqual({ open: false, reason: "no stored calibration report" });
  });

  it("opens only for a passing, reviewed calibration of the current rubric", () => {
    const open = occasionFacetGate(stored());
    expect(open).toMatchObject({ open: true, rubricVersion: OCCASION_RUBRIC_VERSION,
      thresholds: { breakfast: 0.6, lunch: 0.5, dinner: 0.4, snack: 0.55 } });
    expect(occasionFacetGate(stored({ rubricVersion: 1 })).open).toBe(false);
    expect(occasionFacetGate(stored({ holdoutReviewed: false })).open).toBe(false);
    expect(occasionFacetGate(stored({ thresholds: { breakfast: 1, lunch: 0.5, dinner: 0.4, snack: 0.5 } })).open).toBe(false);
    expect(occasionFacetGate(stored({ perCuisine: scores({ plausibility: 0.8 }) })).open).toBe(false);
  });

  it("the committed data file is exactly what --freeze writes", () => {
    const committed = readFileSync(resolve(ROOT, "lib/foods/occasion-calibration.data.ts"), "utf8");
    expect(committed).toBe(calibrationSource(OCCASION_CALIBRATION));
  });
});

describe("the seed holdout", () => {
  const raw = readFileSync(SEED_PATH, "utf8");
  const holdout = parseHoldout(JSON.parse(raw));

  it("is marked a seed set for the owner to review, so it can never open the gate", () => {
    expect(holdout.status).toBe("seed");
    expect(holdoutReviewed(holdout)).toBe(false);
    expect(JSON.parse(raw).note).toMatch(/reviewed by the owner/i);
  });

  it("covers every cuisine with foods, dishes and a plate pantry with every part", () => {
    expect(holdout.items.length).toBeGreaterThanOrEqual(60);
    for (const cuisine of CALIBRATION_CUISINES) {
      const own = holdout.items.filter((item) => item.cuisine === cuisine);
      const pairs = own.flatMap((item) => MEAL_OCCASIONS.filter((o) => item.labels[o] !== null).map(() => item));
      expect(own.length, cuisine).toBeGreaterThanOrEqual(10);
      expect(pairs.length, cuisine).toBeGreaterThanOrEqual(ACCEPTANCE.minPairsPerCuisine);
      expect(own.filter((item) => item.kind === "dish").length, cuisine).toBeGreaterThanOrEqual(3);
      const pantry = holdout.pantry.filter((item) => item.cuisine === cuisine);
      expect(pantry.length, cuisine).toBeGreaterThanOrEqual(9);
      for (const role of ["protein", "carb", "fat"]) expect(pantry.some((item) => item.role === role), `${cuisine} ${role}`).toBe(true);
    }
  });

  it("labels fish and savoury foods at breakfast where that is the usual practice", () => {
    const label = (id: string) => holdout.items.find((item) => item.id === id)?.labels;
    expect(label("japanese-breakfast-set")?.breakfast).toBe(true);
    expect(label("congee")?.breakfast).toBe(true);
    expect(label("akara")?.breakfast).toBe(true);
    expect(label("canned-tuna")?.breakfast).toBe(false);
  });
});

describe("the real plate generator (lib/meals rankPlates over the seed pantry)", () => {
  const holdout = parseHoldout(JSON.parse(readFileSync(SEED_PATH, "utf8")));

  it("builds enough distinct plates per cuisine to judge, with facets abstaining", () => {
    for (const cuisine of CALIBRATION_CUISINES) {
      const pantry = holdout.pantry.filter((item) => item.cuisine === cuisine);
      const plates = MEAL_OCCASIONS.flatMap((occasion) => rankPlatesGenerator(pantry, occasion, {}));
      expect(plates.length, cuisine).toBeGreaterThanOrEqual(ACCEPTANCE.minPlatesPerCuisine);
      for (const plate of plates) expect(plate.foodIds.every((id) => pantry.some((item) => item.id === id))).toBe(true);
    }
  });

  it("puts facet scores on the evidence ladder under each food's key", () => {
    const pantry = holdout.pantry.filter((item) => item.cuisine === "west-african");
    const foods = pantry.map(pantryFood);
    const evidence = pantryEvidence(foods, { [pantry[0].id]: { breakfast: 0.8 } });
    expect(Object.values(evidence.facets ?? {})).toEqual([{ breakfast: 0.8 }]);
    expect(evidence.history).toEqual({});
  });
});
