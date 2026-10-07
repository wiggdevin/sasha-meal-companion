// Streak regression (block-protein-or-fibre, 2026-09-20): three live turns where the coach asked a
// clarifying question ("What would you like to change your breakfast to?") without attaching
// quick replies. The guidance must bind the choices to the coach's own question, in the same step.
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/lib/coach/prompt";
import type { CoachTurnResponse } from "@/lib/coach/types";
import { evaluateTurn, type CoachCase } from "@/scripts/eval/coach-streak-state";

const blockCase: CoachCase = {
  id: "block-protein-or-fibre",
  category: "block",
  sentence: "can you change my breakfast?",
  expected_path: "llm",
  expected_action_kinds: [],
  expected_block_kinds: ["quick_replies"],
  expected_quick_replies: { min: 2, max: 4 },
  expected_card_count: { min: 0, max: 0 },
  latency_bound_ms: { fast: 2_000, llm: 15_000 },
  no_unsupported_claim: true,
};

const response: CoachTurnResponse = {
  threadId: "thread-1",
  suggestions: [],
  actions: [],
  messages: [{ id: "message-1", role: "assistant", content: "Which one?", seq: 1 }],
  draft: null,
  composed: [],
  deflected: false,
  toolsUsed: [],
  model: { provider: "gemini", modelId: "stored-model" },
};

function assertionPassed(result: ReturnType<typeof evaluateTurn>, name: string): boolean {
  return result.assertions.find((assertion) => assertion.name === name)?.passed ?? false;
}

describe("streak: quick replies accompany the coach's own clarifying question", () => {
  it("binds quick_replies to a question the reply asks, in the same step, with 2–4 choices", () => {
    const prompt = buildSystemPrompt({
      constraints: { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null },
      today: "2026-09-20",
    });
    expect(prompt).toContain("When YOUR reply asks a question");
    expect(prompt).toContain("call quick_replies in the SAME step");
    expect(prompt).toContain("Never ask such a question without the choices");
    expect(prompt).not.toContain("after an open question");
  });

  it.each([
    [0, false], [1, false], [2, true], [3, true], [4, true], [5, false],
  ])("requires 2–4 options on the persisted quick_replies block (got %i)", (count, passes) => {
    const result = evaluateTurn(blockCase, response, 1_000, { flagged: false, p: null }, [{
      kind: "quick_replies",
      v: 1,
      options: Array.from({ length: count }, (_, index) => `Option ${index + 1}`),
    }]);

    expect(assertionPassed(result, "expected quick-reply count")).toBe(passes);
    expect(result.passed).toBe(passes);
  });

  it("rejects the wrong intent on the persisted food_search block", () => {
    const result = evaluateTurn({
      ...blockCase,
      id: "block-search-greek-yogurt-eats",
      expected_block_kinds: ["food_search"],
      expected_block_intent: "eats",
      expected_quick_replies: undefined,
    }, response, 1_000, { flagged: false, p: null }, [{
      kind: "food_search", v: 1, intent: "log",
    }]);

    expect(assertionPassed(result, "expected food-search intent")).toBe(false);
    expect(result.passed).toBe(false);
  });
});
