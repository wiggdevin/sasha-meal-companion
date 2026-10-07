import { describe, expect, it } from "vitest";
import type { FoodSearchHit } from "@/lib/server/catalog";
import {
  calibrate,
  CALIBRATION_FALLBACK,
  gateDecision,
  relevanceMetrics,
  resolveLabels,
  TOP1_GATE,
  TOP3_GATE,
  type LabelledQuery,
} from "./eval";

function hit(catalogFoodId: number, score: number): FoodSearchHit {
  return {
    catalogFoodId, revisionId: catalogFoodId * 10, description: `food ${catalogFoodId}`, brand: null,
    source: "fdc_sr_legacy", qualityClass: "analytical", qualityFlags: [], prepState: null,
    score, prefStatus: null, policyCategories: [], policy: { verdict: "unverified" },
    kcalPer100g: null, per100g: null,
    portions: [{ id: null, label: "100 g", grams: 100, kcal: null }], defaultPortion: null,
  };
}

const label = (q: string, sourceId: string): LabelledQuery => ({ q, source: "fdc_sr_legacy", sourceId });

describe("relevance gates", () => {
  it("carries Devin's R1 gate: top-1 ≥ 82 %, top-3 unchanged at 95 % (2026-09-12)", () => {
    expect(TOP1_GATE).toBe(0.82);
    expect(TOP3_GATE).toBe(0.95);
  });

  it("passes at 0.836 top-1 / 1.0 top-3 (the production measurement)", () => {
    expect(gateDecision({ top1: 0.836, top3: 1 })).toEqual({ pass: true, reasons: [] });
  });

  it("fails 0.819 top-1 on top-1 alone", () => {
    const decision = gateDecision({ top1: 0.819, top3: 1 });
    expect(decision.pass).toBe(false);
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toMatch(/top-1 81\.9 % below the gate/);
  });

  it("fails 0.949 top-3 on top-3 alone", () => {
    const decision = gateDecision({ top1: 0.836, top3: 0.949 });
    expect(decision.pass).toBe(false);
    expect(decision.reasons).toHaveLength(1);
    expect(decision.reasons[0]).toMatch(/top-3 94\.9 % below the gate/);
  });

  it("lists both reasons when both gates fail", () => {
    const decision = gateDecision({ top1: 0.819, top3: 0.949 });
    expect(decision.pass).toBe(false);
    expect(decision.reasons).toHaveLength(2);
    expect(decision.reasons.join(" | ")).toMatch(/top-1 81\.9 %.*top-3 94\.9 %/);
  });
});

describe("resolveLabels", () => {
  it("swaps the FDC id for the catalog id and blanks an unknown one", () => {
    const out = resolveLabels(
      [label("chicken", "171077"), label("beef", "999999"), label("rice", "")],
      new Map([["fdc_sr_legacy:171077", 7]])
    );
    expect(out.map((l) => l.sourceId)).toEqual(["7", "", ""]);
  });
});

describe("relevanceMetrics", () => {
  it("counts top-1 and top-3 over resolved labels only", () => {
    const labels = [label("a", "1"), label("b", "2"), label("c", "3"), label("d", "")];
    const runs = [
      [hit(1, 0.9), hit(9, 0.2)],
      [hit(9, 0.9), hit(2, 0.5)],
      [hit(8, 0.9), hit(7, 0.5), hit(6, 0.4), hit(3, 0.1)],
      [hit(4, 0.9)],
    ];
    const m = relevanceMetrics(labels, runs);
    expect(m.n).toBe(3);
    expect(m.top1).toBeCloseTo(1 / 3, 10);
    expect(m.top3).toBeCloseTo(2 / 3, 10);
    expect(m.misses.map((x) => x.q)).toEqual(["c"]);
  });

  it("refuses a run list of the wrong length", () => {
    expect(() => relevanceMetrics([label("a", "1")], [])).toThrow(/one run per labelled query/);
  });
});

describe("calibrate", () => {
  it("picks the smallest pair that reaches the precision floor", () => {
    const labels = [label("a", "1"), label("b", "2"), label("c", "3")];
    const runs = [
      [hit(1, 0.7), hit(9, 0.4)],   // correct, margin 0.30
      [hit(2, 0.62), hit(9, 0.6)],  // correct, margin 0.02
      [hit(9, 0.68), hit(3, 0.3)],  // WRONG, margin 0.38
    ];
    const out = calibrate(labels, runs);
    // A margin floor of 0.02 admits the wrong third run (score 0.68) unless the
    // score floor clears it; the smallest eligible pair keeps precision at 1.00.
    expect(out.generic.minScore + out.generic.minMargin).toBeLessThan(1);
    const top = runs.filter(
      (r) => r[0].score >= out.generic.minScore && r[0].score - r[1].score >= out.generic.minMargin
    );
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((r) => r[0].catalogFoodId !== 9)).toBe(true);
  });

  it("falls back to the strict pair when nothing is eligible", () => {
    const labels = [label("a", "1"), label("b", "2")];
    const runs = [[hit(9, 0.9), hit(1, 0.1)], [hit(8, 0.9), hit(2, 0.1)]];
    expect(calibrate(labels, runs).generic).toEqual(CALIBRATION_FALLBACK);
  });

  it("calibrates branded and generic separately", () => {
    const labels = [label("Kirkland Signature oil", "1"), label("olive oil", "2")];
    const runs = [[hit(1, 0.99), hit(9, 0.1)], [hit(9, 0.99), hit(2, 0.1)]];
    const out = calibrate(labels, runs);
    expect(out.branded).not.toEqual(CALIBRATION_FALLBACK);
    expect(out.generic).toEqual(CALIBRATION_FALLBACK);
  });
});
