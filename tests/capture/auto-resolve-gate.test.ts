/** W125 (T3): the owner's conservative ruling — a capture auto-resolves only at high confidence. */
import { describe, expect, it } from "vitest";
import { CAPTURE_AUTO_RESOLVE, captureAutoResolves } from "@/lib/capture/auto-resolve-gate";
import { pickCandidate } from "@/lib/capture/grounding";

const hits = (...scores: number[]) => scores.map((score, i) => ({
  catalogFoodId: i, revisionId: i, description: `f${i}`, brand: null, score,
}));

describe("capture auto-resolve gate", () => {
  it("is the documented conservative value", () => {
    expect(CAPTURE_AUTO_RESOLVE).toEqual({ minScore: 0.95, minMargin: 0.3 });
  });

  it("resolves only a certain top match with a clear lead", () => {
    expect(captureAutoResolves(hits(0.97, 0.5), "generic")).toBe(true);
    expect(captureAutoResolves(hits(0.95, 0.6), "branded")).toBe(true);
  });

  it("asks below the score, below the margin, or with one hit", () => {
    expect(captureAutoResolves(hits(0.94, 0.1), "generic")).toBe(false);
    expect(captureAutoResolves(hits(0.99, 0.7), "generic")).toBe(false);
    expect(captureAutoResolves(hits(0.99), "branded")).toBe(false);
    expect(captureAutoResolves([], "branded")).toBe(false);
  });

  it("is what grounding's pickCandidate uses", () => {
    expect(pickCandidate(hits(0.97, 0.5), "generic")?.autoResolved).toBe(true);
    expect(pickCandidate(hits(0.9, 0.1), "generic")?.autoResolved).toBe(false);
  });
});
