import { describe, expect, it } from "vitest";
import { F } from "@/tests/helpers/meal-foods";
import type { Food } from "@/lib/foods";
import { affinity, NEUTRAL } from "./affinity";
import { foodKey } from "./parts";
import type { MealEvidence } from "./snapshot";
import {
  FACET_PROMOTE_FLOOR, FACET_SCORE_MAX, FACET_SCORE_MIN, facetOccasionScore, withFacetPrior,
} from "./facet-affinity";

/** A food no curated family knows: curated says neutral, so the facets rung may speak. */
const MOI_MOI: Food = { ...F.eggs, id: "moi-moi", name: "Moi moi" };

describe("facetOccasionScore: calibrated p to affinity, never below neutral", () => {
  it("abstains below the threshold and for unusable values", () => {
    expect(facetOccasionScore(0.39, 0.4)).toBeNull();
    expect(facetOccasionScore(undefined, 0.4)).toBeNull();
    expect(facetOccasionScore(Number.NaN, 0.4)).toBeNull();
    expect(facetOccasionScore(1.2, 0.4)).toBeNull();
    expect(facetOccasionScore(0.9, 0)).toBeNull();
    expect(facetOccasionScore(0.9, 1)).toBeNull();
  });

  it("keeps an uncertain p = 0.5 neutral at every threshold (D6)", () => {
    for (let t = 0.01; t < 1; t += 0.01) expect(facetOccasionScore(0.5, t), String(t)).toBeNull();
    expect(facetOccasionScore(FACET_PROMOTE_FLOOR - 0.001, 0.2)).toBeNull();
  });

  it("lifts linearly from FACET_SCORE_MIN at the effective floor to FACET_SCORE_MAX at certainty", () => {
    expect(facetOccasionScore(0.8, 0.8)).toBe(FACET_SCORE_MIN);
    expect(facetOccasionScore(FACET_PROMOTE_FLOOR, 0.4)).toBe(FACET_SCORE_MIN);
    expect(facetOccasionScore(1, 0.4)).toBe(FACET_SCORE_MAX);
    const mid = facetOccasionScore(0.8, 0.4) as number;
    expect(mid).toBeGreaterThan(FACET_SCORE_MIN);
    expect(mid).toBeLessThan(FACET_SCORE_MAX);
    expect(FACET_SCORE_MIN).toBeGreaterThan(NEUTRAL);
    expect(FACET_SCORE_MAX).toBeLessThan(affinity(F.eggs, "breakfast").score);
  });
});

describe("withFacetPrior: curated > facets v2 > neutral", () => {
  it("lets a facet lift a food the curated table does not know", () => {
    const prior = affinity(MOI_MOI, "breakfast");
    expect(prior).toEqual({ score: NEUTRAL, source: "neutral" });
    expect(withFacetPrior(prior, 0.8, "breakfast")).toEqual({ score: 0.8, source: "facets" });
  });

  it("never overrides curated evidence, usual or never", () => {
    const usual = affinity(F.eggs, "breakfast");
    const never = affinity(F.tuna, "breakfast");
    expect(never.source).toBe("curated");
    expect(withFacetPrior(usual, 0.6, "breakfast")).toBe(usual);
    expect(withFacetPrior(never, 0.85, "breakfast")).toBe(never);
  });

  it("never penalises: a low or missing facet score leaves the food at neutral", () => {
    const prior = affinity(MOI_MOI, "dinner");
    expect(withFacetPrior(prior, 0.1, "dinner")).toBe(prior);
    expect(withFacetPrior(prior, undefined, "dinner")).toBe(prior);
    expect(withFacetPrior(prior, 0.99, "dinner")).toEqual({ score: FACET_SCORE_MAX, source: "facets" });
  });

  it("stays silent for an overnight or untimed slot", () => {
    const prior = affinity(MOI_MOI, "other");
    expect(withFacetPrior(prior, 0.8, "other")).toBe(prior);
    const untimed = affinity(MOI_MOI, "breakfast", true);
    expect(withFacetPrior(untimed, 0.8, "breakfast", true)).toBe(untimed);
  });
});

describe("affinity reads facets from the snapshot evidence: history > curated > facets > neutral", () => {
  const evidence = (extra: Partial<MealEvidence> = {}): MealEvidence =>
    ({ accountId: "a", computedAt: "2026-10-05T00:00:00.000Z", history: {}, ...extra });

  it("lifts an unknown food with a facet score, and nothing without one", () => {
    const key = foodKey(MOI_MOI);
    expect(affinity(MOI_MOI, "breakfast", false, evidence({ facets: { [key]: { breakfast: 0.8 } } })))
      .toEqual({ score: 0.8, source: "facets" });
    expect(affinity(MOI_MOI, "breakfast", false, evidence())).toEqual({ score: NEUTRAL, source: "neutral" });
  });

  it("never lets a facet move a curated food, and lets history outrank a facet", () => {
    const tuna = foodKey(F.tuna);
    expect(affinity(F.tuna, "breakfast", false, evidence({ facets: { [tuna]: { breakfast: 0.85 } } })).source)
      .toBe("curated");
    const key = foodKey(MOI_MOI);
    expect(affinity(MOI_MOI, "breakfast", false, evidence({ facets: { [key]: { breakfast: 0.7 } },
      history: { [key]: { breakfast: 0.9 } } }))).toEqual({ score: 0.9, source: "history" });
  });
});
