/**
 * Phase 18 W1b, the build's pure parts on synthetic data (no NHANES file is read): the XPORT number
 * format, the crosswalk, survey-weighted rates with their effective counts, the shrinkage rule, the
 * cell floor and the canonical artifact hash (acceptance 1: same inputs, same hash).
 */
import { describe, expect, it } from "vitest";
import { artifactText, canonical, roundRate, sha256 } from "@/scripts/priors/artifact-io";
import { createExpander, createMatcher, familyParts } from "@/scripts/priors/crosswalk";
import { decileBins, ece, emptyCells, emptyPerRespondent, scoreRespondents, widthBins } from "@/scripts/priors/metrics";
import { COHORTS, estimateRates, predictionTable, type Panel } from "@/scripts/priors/panel";
import { ibmToNumber } from "@/scripts/priors/xpt";

describe("SAS transport numbers", () => {
  it("decode IBM floats and SAS missing values", () => {
    expect(ibmToNumber(Buffer.from([0x41, 0x10, 0, 0, 0, 0, 0, 0]), 0, 8)).toBe(1);
    expect(ibmToNumber(Buffer.from([0xc2, 0x76, 0xa0, 0, 0, 0, 0, 0]), 0, 8)).toBe(-118.625);
    expect(ibmToNumber(Buffer.from([0x2e, 0, 0, 0, 0, 0, 0, 0]), 0, 8)).toBeNull();
    expect(ibmToNumber(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), 0, 8)).toBe(0);
  });
});

describe("the crosswalk", () => {
  const refs = [
    { key: "chicken-breast-roasted", ndb: "5064", sr: "Chicken, broilers or fryers, breast, meat only, cooked, roasted", order: 0 },
    { key: "egg-scrambled", ndb: "1132", sr: "Egg, whole, cooked, scrambled", order: 1 },
    { key: "egg-hard-boiled", ndb: "1129", sr: "Egg, whole, cooked, hard-boiled", order: 2 },
    { key: "almond-milk", ndb: "14016", sr: "Beverages, almond milk, unsweetened, shelf stable", order: 3 },
  ];
  const match = createMatcher(refs);
  it("maps by SR number, then by family, crediting every tied food", () => {
    expect(match({ code: "5064", description: "anything" })?.how).toBe("exact");
    expect(match({ code: "5062", description: "Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw" })?.keys)
      .toEqual(["chicken-breast-roasted"]);
    expect(match({ code: "1123", description: "Egg, whole, raw, fresh" })?.keys).toEqual(["egg-scrambled", "egg-hard-boiled"]);
  });
  it("never maps a generic first part, water or a processed form", () => {
    expect(match({ code: "14411", description: "Beverages, water, tap, drinking" })).toBeNull();
    expect(match({ code: "5999", description: "Chicken, broilers or fryers, breast, smoked" })).toBeNull();
    expect(familyParts("Beans, pinto, mature seeds, cooked, boiled, without salt")).toEqual(["bean", "pinto", "mature seed"]);
  });
  it("expands a dish through its sub-recipes by gram share", () => {
    const release = { label: "t", ingredients: new Map([
      ["11111111", [{ code: "5064", description: "chicken", grams: 60 }, { code: "22222222", description: "sub", grams: 40 }]],
      ["22222222", [{ code: "1132", description: "egg", grams: 10 }, { code: "14411", description: "Beverages, water, tap", grams: 10 }]],
    ]) };
    const { expand } = createExpander([release], match);
    const out = expand("11111111");
    expect(out.shares.get("chicken-breast-roasted")).toBeCloseTo(0.6);
    expect(out.shares.get("egg-scrambled")).toBeCloseTo(0.2);
    expect(out.unmapped).toBeCloseTo(0.2);
    expect(out.drink).toBeCloseTo(0.2);
    expect(expand("99999999").unmapped).toBe(1);
  });
});

/** Two strata of two PSUs; respondents 0..n-1, food 0 eaten by every third, food 1 by nobody. */
function syntheticPanel(n: number): Panel {
  const cluster = Int32Array.from({ length: n }, (_, i) => i % 4);
  return {
    n, foods: ["a", "b"], clusters: ["s1:1", "s1:2", "s2:1", "s2:2"], strata: ["s1", "s2"],
    release: new Uint8Array(n), cluster, stratum: Int32Array.from(cluster, (k) => (k < 2 ? 0 : 1)),
    child: Int32Array.from({ length: n }, (_, i) => 1 + (i % 12)), adult: new Uint8Array(n).fill(1), weight: Float64Array.from({ length: n }, (_, i) => 1 + (i % 5)),
    auditGroup: new Int32Array(n), eaten: Array.from({ length: n }, (_, i) => Int32Array.from(i % 3 === 0 ? [0] : [])),
  };
}

describe("survey-weighted rates", () => {
  const panel = syntheticPanel(960);
  const rates = estimateRates(panel, () => true);
  it("gives the weighted share and an effective count capped at the cell size", () => {
    let w = 0, wy = 0;
    for (let i = 0; i < panel.n; i += 1) { w += panel.weight[i]; if (i % 3 === 0) wy += panel.weight[i]; }
    expect(rates.rate[0]).toBeCloseTo(wy / w, 12);
    expect(rates.nEff[0]).toBeGreaterThan(0);
    expect(rates.nEff[0]).toBeLessThanOrEqual(panel.n);
    expect(rates.rate[1]).toBe(0);
  });
  it("shrinks a child toward the national root, and a cell under 30 reads its parent", () => {
    const table = predictionTable(rates, 200);
    const F = 2;
    const national = table[0];
    expect(national).toBeCloseTo((rates.nEff[0] * rates.rate[0] + 0.5) / (rates.nEff[0] + 1), 12);
    const c = 3, nc = rates.nEff[c * F];
    const expected = nc >= 30 ? (nc * rates.rate[c * F] + 200 * national) / (nc + 200) : national;
    expect(table[c * F]).toBeCloseTo(expected, 12);
    const small = estimateRates(syntheticPanel(64), () => true);
    const smallTable = predictionTable(small, 200);
    for (let child = 1; child <= 12; child += 1) {
      if (small.nEff[child * F] < 30) expect(smallTable[child * F]).toBe(smallTable[0]);
    }
  });
});

describe("the artifact hash", () => {
  it("is the same for the same rows in any key order, and changes with any value", () => {
    const a = [{ cohort: "national", food_key: "banana", rate: roundRate(0.1687512), n_eff: 3473 }];
    const b = [{ n_eff: 3473, rate: 0.168751, food_key: "banana", cohort: "national" }];
    expect(sha256(canonical(a))).toBe(sha256(canonical(b)));
    expect(sha256(canonical(a))).not.toBe(sha256(canonical([{ ...b[0], n_eff: 3474 }])));
    expect(JSON.parse(artifactText(a))).toEqual(a);
  });
});

describe("fold-matched calibration", () => {
  it("bins each observation with the prediction of the fold that scored it", () => {
    const panel = syntheticPanel(960);
    const F = 2, C = COHORTS.length;
    const cells = emptyCells(F, 2);
    const out = emptyPerRespondent(panel.n);
    const ranked = new Set([0]);
    const tableA = new Float64Array(C * F).fill(1 / 3), tableB = new Float64Array(C * F).fill(0.9);
    scoreRespondents(panel, tableA, ranked, (i) => i % 2 === 0, out, cells, 0, 0);
    scoreRespondents(panel, tableB, ranked, (i) => i % 2 === 1, out, cells, 0, 1);
    const used = [...cells.predicted.keys()].filter((at) => cells.weight[at] > 0);
    expect(new Set(used.map((at) => cells.predicted[at]))).toEqual(new Set([1 / 3, 0.9]));
    const deciles = decileBins(cells);
    expect(deciles.reduce((sum, bin) => sum + bin.mass, 0)).toBeCloseTo(1, 12);
    // Fold B claims 0.9 against an observed third: the error shows, it is not overwritten by fold A.
    expect(ece(widthBins(cells))).toBeGreaterThan(0.2);
  });
});
