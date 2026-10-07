import { describe, expect, it } from "vitest";
import { filterGroundedAnswer, REDACTED, type GroundingMetadata } from "@/lib/ai/lookup-grounding";

describe("filterGroundedAnswer (Phase 13 §3.3, closes Sol r1 finding 8)", () => {
  it("keeps a numeric claim whose segment names a source chunk", () => {
    const text = "This has 5g of protein and 200 calories.";
    const start = text.indexOf("5g");
    const metadata: GroundingMetadata = {
      groundingChunks: [{ web: { uri: "https://example.com/a", title: "Example A" } }],
      groundingSupports: [
        { segment: { startIndex: start, endIndex: start + "5g".length }, groundingChunkIndices: [0] },
      ],
      webSearchQueries: ["food nutrition lookup"],
    };
    const out = filterGroundedAnswer(text, metadata);
    expect(out.text).toContain("5g");
    expect(out.text).not.toContain("200");
    expect(out.text).toContain(REDACTED);
    expect(out.sources).toEqual([{ uri: "https://example.com/a", title: "Example A" }]);
    expect(out.webSearchQueries).toBe(1);
  });

  it("drops every number and cites nothing when there is no grounding metadata at all", () => {
    const out = filterGroundedAnswer("It has 5g of protein and 200 calories.", null);
    expect(out.text).not.toContain("5");
    expect(out.text).not.toContain("200");
    expect(out.sources).toEqual([]);
    expect(out.webSearchQueries).toBe(0);
  });

  it("drops a number whose segment names no source chunk", () => {
    const text = "About 300mg of sodium.";
    const start = text.indexOf("300mg");
    const metadata: GroundingMetadata = {
      groundingChunks: [{ web: { uri: "https://example.com/a", title: null } }],
      groundingSupports: [
        { segment: { startIndex: start, endIndex: start + "300mg".length }, groundingChunkIndices: [] },
      ],
      webSearchQueries: [],
    };
    const out = filterGroundedAnswer(text, metadata);
    expect(out.text).toContain(REDACTED);
    expect(out.text).not.toContain("300");
    expect(out.sources).toEqual([]);
  });

  it("drops a number whose only cited chunk index is out of range (review r1, sol FIX)", () => {
    const text = "About 300mg of sodium.";
    const start = text.indexOf("300mg");
    const metadata: GroundingMetadata = {
      groundingChunks: [{ web: { uri: "https://example.com/a", title: "A" } }],
      groundingSupports: [
        { segment: { startIndex: start, endIndex: start + "300mg".length }, groundingChunkIndices: [7] },
      ],
      webSearchQueries: ["q1"],
    };
    const out = filterGroundedAnswer(text, metadata);
    expect(out.text).not.toContain("300");
    expect(out.text).toContain(REDACTED);
    expect(out.sources).toEqual([]);
  });

  it("drops a number whose cited chunk carries no web link", () => {
    const text = "About 300mg of sodium.";
    const start = text.indexOf("300mg");
    const metadata: GroundingMetadata = {
      groundingChunks: [{ web: { uri: "", title: "A" } }, { web: null }],
      groundingSupports: [
        { segment: { startIndex: start, endIndex: start + "300mg".length }, groundingChunkIndices: [0, 1] },
      ],
      webSearchQueries: ["q1"],
    };
    const out = filterGroundedAnswer(text, metadata);
    expect(out.text).not.toContain("300");
    expect(out.sources).toEqual([]);
  });

  it("deduplicates a source cited by more than one kept claim", () => {
    const text = "5g protein and 10g fat.";
    const startA = text.indexOf("5g");
    const startB = text.indexOf("10g");
    const metadata: GroundingMetadata = {
      groundingChunks: [{ web: { uri: "https://example.com/a", title: "A" } }],
      groundingSupports: [
        { segment: { startIndex: startA, endIndex: startA + 2 }, groundingChunkIndices: [0] },
        { segment: { startIndex: startB, endIndex: startB + 3 }, groundingChunkIndices: [0] },
      ],
      webSearchQueries: ["q1", "q2"],
    };
    const out = filterGroundedAnswer(text, metadata);
    expect(out.text).toContain("5g");
    expect(out.text).toContain("10g");
    expect(out.sources).toHaveLength(1);
    expect(out.webSearchQueries).toBe(2);
  });

  it("keeps prose with no numeric claims unchanged", () => {
    const out = filterGroundedAnswer("This is a plant-based snack bar.", null);
    expect(out.text).toBe("This is a plant-based snack bar.");
  });
});
