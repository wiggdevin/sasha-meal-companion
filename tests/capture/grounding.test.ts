import { describe, expect, it } from "vitest";
import { pickCandidate, topAlternatives } from "@/lib/capture/grounding";
import { AUTO_RESOLVE } from "@/lib/search/thresholds";

const hit = (revisionId: number, score: number) => ({
  catalogFoodId: revisionId, revisionId, description: `food ${revisionId}`, brand: null, score });

describe("pickCandidate", () => {
  it("returns null on no hits", () => expect(pickCandidate([], "generic")).toBeNull());

  it("auto-resolves at the threshold and the margin", () => {
    const { minScore, minMargin } = AUTO_RESOLVE.generic;
    const out = pickCandidate([hit(1, minScore), hit(2, minScore - minMargin)], "generic");
    expect(out).toEqual({ hit: hit(1, minScore), autoResolved: true });
  });

  it("keeps the top hit but refuses to auto-resolve under the margin", () => {
    const { minScore, minMargin } = AUTO_RESOLVE.generic;
    const out = pickCandidate([hit(1, minScore), hit(2, minScore - minMargin / 2)], "generic");
    expect(out?.hit.revisionId).toBe(1);
    expect(out?.autoResolved).toBe(false);
  });

  it("never auto-resolves a single hit or a tie", () => {
    expect(pickCandidate([hit(1, 1)], "branded")?.autoResolved).toBe(false);
    expect(pickCandidate([hit(1, 0.99), hit(2, 0.99)], "branded")?.autoResolved).toBe(false);
  });
});

describe("topAlternatives", () => {
  it("takes the first three in score order", () => {
    const hits = [hit(1, 0.9), hit(2, 0.8), hit(3, 0.7), hit(4, 0.6)];
    expect(topAlternatives(hits).map((h) => h.revisionId)).toEqual([1, 2, 3]);
  });
});
