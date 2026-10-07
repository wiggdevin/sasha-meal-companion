import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { facetState } from "@/lib/foods/facet-questions";
import { FACETS } from "@/lib/foods/facets";
import {
  FACET_THRESHOLD_DATE,
  FACET_THRESHOLD_MODEL,
  FACET_THRESHOLD_RUBRIC_VERSION,
  FACET_THRESHOLDS,
  NOT_HUMAN_FOOD_THRESHOLDS,
  PORTION_LEVEL_THRESHOLDS,
  type ProbabilityBand,
} from "@/lib/foods/facet-thresholds";
import { readCache, score } from "@/scripts/eval/jev-facets/cache";
import { batchesFor, makePayload, productionState } from "@/scripts/eval/jev-facets/payload";
import { reportSource } from "@/scripts/eval/jev-facets/report";
import { deriveThresholds, frozenThresholds, observations, tsSource }
  from "@/scripts/eval/jev-facets/scoring";
import {
  CACHE_PATH,
  DEV_PATH,
  GENERATED_HEADER,
  HOLDOUT_PATH,
  PORTION_LEVELS,
  REPORT_PATH,
  THRESHOLDS_PATH,
  type EvalCase,
  type JudgmentsCache,
  evaluatedCases,
} from "@/scripts/eval/jev-facets/types";

const ROOT = resolve(import.meta.dirname, "../..");
const SLOTS = ["breakfast", "lunch", "dinner", "snack", "coffee", "pre-training-carbs",
  "post-training-refuel", "meal-1", "meal-2", "meal-3", "hot-chocolate"] as const;
const REQUIRED_TAGS = ["generic", "branded", "custom", "raw", "cooked", "composed",
  "culturally-diverse", "pet-food", "supplement", "packaging", "needs-cooking", "collision",
  "trace-wording", "ingredient-tag-conflict", "vegan-ambiguity", "uncertified-halal",
  "uncertified-kosher", "prompt-injection"] as const;

function load(path: string): EvalCase[] {
  return JSON.parse(readFileSync(path, "utf8")) as EvalCase[];
}

function expectBand(band: ProbabilityBand): void {
  expect(Number.isFinite(band.absent)).toBe(true);
  expect(Number.isFinite(band.present)).toBe(true);
  expect(band.absent).toBeGreaterThanOrEqual(0);
  expect(band.present).toBeLessThanOrEqual(1);
  expect(band.absent).toBeLessThan(band.present);
}

describe("frozen Jev facet thresholds", () => {
  it("covers every rubric-v1 question with generated action bands", () => {
    expect(readFileSync(THRESHOLDS_PATH, "utf8").startsWith(GENERATED_HEADER)).toBe(true);
    expect(FACET_THRESHOLD_RUBRIC_VERSION).toBe(1);
    expect(FACET_THRESHOLD_MODEL).toBe("jev-1.13.0");
    expect(FACET_THRESHOLD_DATE).toBe("2026-09-20");
    expect(Object.keys(FACET_THRESHOLDS)).toEqual(FACETS);
    for (const thresholds of Object.values(FACET_THRESHOLDS)) {
      expectBand(thresholds.mark);
      expectBand(thresholds.exclude);
    }
    expectBand(NOT_HUMAN_FOOD_THRESHOLDS.mark);
    expectBand(NOT_HUMAN_FOOD_THRESHOLDS.exclude);
    expect(Object.keys(PORTION_LEVEL_THRESHOLDS)).toEqual(PORTION_LEVELS);
    for (const thresholds of Object.values(PORTION_LEVEL_THRESHOLDS)) {
      expectBand(thresholds.warn);
      expectBand(thresholds.exclude);
    }
  });

  it("serializes production-only state with no label or expected field/value", () => {
    const all = [...load(DEV_PATH), ...load(HOLDOUT_PATH)];
    for (const item of evaluatedCases(all)) {
      const facetPayload = makePayload([item], "facets");
      expect(facetPayload.state.cases[item.id]).toEqual(facetState(item.food));
      expectCleanState(facetPayload.state.cases[item.id], item);
      expectCanariesExcluded(facetPayload.input, item);
      if (item.portion) {
        const portionPayload = makePayload([item], "portion");
        expect(portionPayload.state.cases[item.id]).toEqual({
          ...facetState(item.food),
          amount: item.portion.amount,
          serving: `${item.portion.unit} ${item.portion.context}`,
        });
        expect(portionPayload.state.cases[item.id]).toEqual(productionState(item, "portion"));
        expectCleanState(portionPayload.state.cases[item.id], item);
        expectCanariesExcluded(portionPayload.input, item);
      }
    }
  });

  it("keeps DEV and HOLDOUT batches separate and skips operational fixtures", async () => {
    const dev = load(DEV_PATH);
    const holdout = load(HOLDOUT_PATH);
    const [devBatches, holdoutBatches] = await Promise.all([
      batchesFor(dev, "dev"),
      batchesFor(holdout, "holdout"),
    ]);
    expect(devBatches.every((batch) => batch.split === "dev")).toBe(true);
    expect(holdoutBatches.every((batch) => batch.split === "holdout")).toBe(true);
    const operationalIds = new Set([...dev, ...holdout].filter((item) => item.operationalCase)
      .map((item) => item.id));
    expect([...devBatches, ...holdoutBatches].flatMap((batch) => batch.cases)
      .every((item) => !operationalIds.has(item.id))).toBe(true);
  });

  it("meets positive and explicitly labelled confusable-negative floors", () => {
    const all = evaluatedCases([...load(DEV_PATH), ...load(HOLDOUT_PATH)]);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    for (const facet of FACETS) {
      expect(all.filter((item) => item.labels.present.includes(facet)).length,
        `${facet} positives`).toBeGreaterThanOrEqual(20);
      expect(all.filter((item) => item.labels.confusableAbsent?.includes(facet)).length,
        `${facet} confusable negatives`).toBeGreaterThanOrEqual(20);
    }
    for (const item of all) {
      expect(item.labels.confusableAbsent?.some((facet) => item.labels.present.includes(facet)) ?? false)
        .toBe(false);
    }
    for (const slot of SLOTS) {
      expect(all.filter((item) => item.labels.slots.includes(slot)).length, slot).toBeGreaterThanOrEqual(20);
    }
    for (const portion of PORTION_LEVELS) {
      expect(all.filter((item) => item.labels.portionLevel === portion).length, portion).toBeGreaterThanOrEqual(20);
    }
    for (const tag of REQUIRED_TAGS) {
      const minimum = ["generic", "branded", "custom", "raw", "cooked", "composed"].includes(tag) ? 20 : 1;
      expect(all.filter((item) => item.tags.includes(tag)).length, tag).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("locks every named collision shape and all operational scenarios", () => {
    const all = [...load(DEV_PATH), ...load(HOLDOUT_PATH)];
    expectPair(all, ["collision-01", "collision-02"], ["Chicken breast", "Chicken nuggets"]);
    expectPair(all, ["shadow-collision-01-5", "shadow-collision-02-2"], ["Fresh milk", "Fresh milk"]);
    expectPair(all, ["collision-05", "collision-06"], ["Daily Bread", "Daily Bread"]);
    expectPair(all, ["collision-07", "collision-08"], ["Peak Bar chocolate peanut", "Peak Bar chocolate almond"]);
    expectPair(all, ["collision-09", "collision-10"], ["Sunshine bowl", "Sunshine bowl"]);
    expectPair(all, ["collision-11", "collision-12"], ["Family loaf", "Family loaf"]);
    const custom = all.filter((item) => ["collision-09", "collision-10"].includes(item.id));
    expect(new Set(custom.map((item) => item.collisionContext?.customOwner)).size).toBe(2);
    const revisions = all.filter((item) => ["collision-11", "collision-12"].includes(item.id));
    expect(revisions.map((item) => item.collisionContext?.revision).sort()).toEqual([1, 2]);
    expect(all.flatMap((item) => item.operationalCase ? [item.operationalCase.scenario] : []).sort()).toEqual([
      "cache_miss", "cache_write_failure", "cap_exhaustion", "fourth_call_skipped",
      "malformed_response", "provider_null", "stale_hash",
    ]);
  });

  it("regenerates thresholds byte-for-byte from the committed score cache", () => {
    const cases = { dev: load(DEV_PATH), holdout: load(HOLDOUT_PATH) };
    const cache = readCache([...cases.dev, ...cases.holdout]);
    const generated = tsSource(FACETS, deriveThresholds(observations(cases, cache, FACETS)), cache.model);
    expect(generated).toBe(readFileSync(THRESHOLDS_PATH, "utf8"));
  });

  it("derives thresholds from DEV observations only", () => {
    const cases = { dev: load(DEV_PATH), holdout: load(HOLDOUT_PATH) };
    const cache = readCache([...cases.dev, ...cases.holdout]);
    const observed = observations(cases, cache, FACETS);
    const baseline = deriveThresholds(observed);
    const withoutHoldout = Object.fromEntries(Object.entries(observed).map(([key, rows]) => [
      key,
      rows.filter((row) => row.split === "dev"),
    ]));
    const perturbedDev = Object.fromEntries(Object.entries(observed).map(([key, rows]) => [
      key,
      rows.map((row) => row.split === "dev" ? { ...row, p: row.truth ? 0 : 1 } : row),
    ]));
    expect(deriveThresholds(withoutHoldout)).toEqual(baseline);
    expect(deriveThresholds(perturbedDev)).not.toEqual(baseline);
  });

  it("scores a facet only when it has an explicit positive or confusable-negative label", () => {
    const item: EvalCase = {
      id: "tri-state",
      food: { name: "Tofu stir-fry" },
      labels: {
        present: ["human_food"],
        confusableAbsent: ["meat"],
        slots: [],
        notHumanFood: false,
        portionLevel: null,
      },
      reason: "The tofu dish is human food but contains no land-animal meat.",
      tags: [],
    };
    const scores = Object.fromEntries(FACETS.map((facet) => [facet, 0.5]));
    const cache = {
      version: 1,
      rubricVersion: 1,
      model: "test",
      cases: { [item.id]: { hashes: {}, scores: { ...scores, not_human_food: 0.1 } } },
    } as JudgmentsCache;
    const observed = observations({ dev: [item], holdout: [] }, cache, FACETS);
    expect(Object.keys(observed).sort()).toEqual(["human_food", "meat", "not_human_food"]);
    expect(observed.human_food).toMatchObject([{ truth: true }]);
    expect(observed.meat).toMatchObject([{ truth: false }]);
  });

  it("fails the report gate below five explicitly scored HOLDOUT facet negatives", () => {
    const rows = [
      { id: "positive", split: "holdout" as const, truth: true, p: 0.9 },
      ...[1, 2, 3, 4].map((index) => ({
        id: `negative-${index}`,
        split: "holdout" as const,
        truth: false,
        p: 0.1,
      })),
    ];
    const thresholds = { human_food: {
      mark: { absent: 0.2, present: 0.8 },
      exclude: { absent: 0.2, present: 0.8 },
    } };
    const report = reportSource({ human_food: rows }, thresholds, "test", {
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    }, { dev: 0, holdout: 5, operational: 0, privacy: 0 });
    expect(report.markdown).toContain("| human_food | 1 | 4 | below 5 |");
    expect(report.passing).toBe(false);
  });

  it("treats a missing score-level key as a hard eval error", () => {
    const cache = { cases: { sample: { hashes: {}, scores: { portion_level: [0.1] } } } } as unknown as JudgmentsCache;
    expect(() => score(cache, "sample", "portion_level", 4)).toThrow("Missing score level 4");
  });

  it("runs --report offline against frozen thresholds without writing", () => {
    const paths = [CACHE_PATH, THRESHOLDS_PATH, REPORT_PATH];
    const before = paths.map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
    const child = spawnSync("pnpm", ["exec", "tsx", "scripts/eval/jev-facets.ts", "--report"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, TYPESAFE_API_KEY: "" },
    });
    expect(child.status, child.stderr).toBe(0);
    const pair = frozenThresholds().human_food.exclude;
    expect(child.stdout).toContain(`| human_food | exclude | ${pair.absent.toFixed(3)} / ${pair.present.toFixed(3)} |`);
    for (const [index, path] of paths.entries()) {
      expect(readFileSync(path)).toEqual(before[index].bytes);
      expect(statSync(path).mtimeMs).toBe(before[index].mtime);
    }
    // Spawns a real `pnpm exec tsx` child process (pnpm resolution + a cold tsx compile of the eval
    // script) rather than calling in-process code. Under the full suite's default parallelism, with
    // many worker processes contending for CPU, that cold start alone can exceed Vitest's 5s default.
  }, 20_000);
});

function expectCleanState(state: unknown, item: EvalCase): void {
  const entries = walk(state);
  expect(entries.map(([key]) => key).filter((key) => /label|expected|level/i.test(key))).toEqual([]);
  const values = new Set(entries.map(([, value]) => value).filter((value): value is string => typeof value === "string"));
  const expected = [
    ...(item.labels.portionLevel ? [item.labels.portionLevel] : []),
    ...Object.values(item.privacyCanary ?? {}),
    ...Object.values(item.operationalCase ?? {}).filter((value): value is string => typeof value === "string")];
  for (const value of expected) expect(values.has(value), `${item.id} leaked ${value}`).toBe(false);
}

function expectCanariesExcluded(input: string, item: EvalCase): void {
  for (const value of Object.values(item.privacyCanary ?? {})) {
    expect(input, `${item.id} leaked ${value}`).not.toContain(value);
  }
}

function walk(value: unknown): [string, unknown][] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [[key, child] as [string, unknown], ...walk(child)]);
}

function expectPair(all: EvalCase[], ids: string[], names: string[]): void {
  const pair = ids.map((id) => all.find((item) => item.id === id));
  expect(pair.map((item) => item?.food.name)).toEqual(names);
}
