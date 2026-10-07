import { describe, expect, it } from "vitest";
import {
  parseCoachCase,
  type CoachCase,
} from "@/scripts/eval/coach-streak-state";
import { persistedBlockEvidence } from "@/scripts/eval/coach-streak-proof";

const baseCase = {
  id: "block-proof-case",
  category: "block",
  sentence: "show me the evidence",
  expected_path: "either",
  expected_action_kinds: [],
  expected_card_count: { min: 0, max: 0 },
  latency_bound_ms: { fast: 2_000, llm: 15_000 },
  no_unsupported_claim: true,
} satisfies Omit<CoachCase, "expected_block_kinds">;

describe("coach streak corpus block refinements", () => {
  it.each([
    ["chart", "expected_chart"],
    ["food_search", "expected_block_intent"],
    ["quick_replies", "expected_quick_replies"],
  ] as const)("requires %s cases to declare %s", (kind, field) => {
    expect(() => parseCoachCase({ ...baseCase, expected_block_kinds: [kind] }))
      .toThrow(field);
  });
});

describe("stored block proof", () => {
  it("fails without actual.persistedBlocks and ignores client-view blocks", () => {
    const evidence = persistedBlockEvidence({
      blocks: [{ kind: "chart", v: 1, chart: "weight_trend" }],
    });

    expect(evidence.persistedBlocks).toEqual([]);
    expect(evidence.assertion).toEqual({
      name: "persisted block proof",
      passed: false,
      detail: "actual.persistedBlocks is missing; client-view blocks are not accepted",
    });
  });
});
