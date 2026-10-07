/**
 * Phase 18 W1c, the NHANES co-consumption feature (docs/specs/phase-18-open-world-foods.md D8 part
 * 5): on synthetic occasions, the weighted pair rate, the base rate, the n_eff floor (H3) and the
 * lift transform; only aggregate pair rates come out, never an occasion or a respondent.
 */
import { describe, expect, it } from "vitest";
import type { CuratedPair } from "@/lib/foods/pairing/table";
import { coConsumption, coFeature } from "@/scripts/pairing/co-consumption";
import type { Occasion } from "@/scripts/pairing/occasions";

const pairs: CuratedPair[] = [
  { anchor: "poultry", side: "rice", template: "main", part: "starch", b: 1 },
  { anchor: "poultry", side: "banana", template: "main", part: "starch", b: 0.4 },
  { anchor: "poultry", side: "toast", template: "main", part: "starch", b: 0.1 },
];

/** 200 respondents over 8 clusters in 4 strata; every one eats chicken at dinner, half with rice. */
function occasions(n = 200, withRice = (i: number) => Math.floor(i / 8) % 2 === 0): Occasion[] {
  const out: Occasion[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = { respondent: i, release: 0, cluster: i % 8, stratum: (i % 8) >> 1, weight: 1 + (i % 3), template: "main" as const };
    out.push({ ...base, foods: new Map([["chicken", 120], ...(withRice(i) ? [["rice", 150] as const] : []), ["toast", 40]]) });
    out.push({ ...base, foods: new Map([["rice", 100], ["banana", 3]]) });
  }
  return out;
}

const input = (list: Occasion[]) => ({ occasions: list, clusters: 8, pairs,
  expand: (_release: number, code: string) => ({ shares: new Map([[code, 1]]) }),
  familyOf: new Map([["chicken", "poultry"]]), sideIsFat: new Map([["rice", false], ["banana", false], ["toast", false]]) });

describe("co-consumption", () => {
  it("gives the weighted pair rate and base rate, aggregate rows only", () => {
    const rows = coConsumption(input(occasions()));
    const rice = rows.find((row) => row.side === "rice")!;
    const weights = Array.from({ length: 200 }, (_, i) => 1 + (i % 3));
    const withRice = weights.filter((_, i) => Math.floor(i / 8) % 2 === 0).reduce((a, b) => a + b, 0);
    const total = weights.reduce((a, b) => a + b, 0);
    expect(rice.rate).toBeCloseTo(withRice / total, 5);
    expect(rice.base_rate).toBeCloseTo((withRice + total) / (2 * total), 5);
    expect(rice.n_eff).toBeGreaterThanOrEqual(30);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["anchor", "base_rate", "n_eff", "rate", "side", "template"]);
  });

  it("drops a side under its gram threshold, and never scores a curated exclusion", () => {
    const rows = coConsumption(input(occasions()));
    expect(rows.find((row) => row.side === "banana")).toBeUndefined();
    expect(rows.find((row) => row.side === "toast")).toBeUndefined();
  });

  it("ships no cell under 30 effective respondents (H3)", () => {
    expect(coConsumption(input(occasions(20)))).toEqual([]);
  });

  it("maps lift to co: 0.5 at independence, 0 never together, toward 1 when far more common", () => {
    expect(coFeature({ rate: 0.2, base_rate: 0.2 })).toBe(0.5);
    expect(coFeature({ rate: 0, base_rate: 0.2 })).toBe(0);
    expect(coFeature({ rate: 0.9, base_rate: 0.1 })).toBeCloseTo(0.9, 10);
  });
});
