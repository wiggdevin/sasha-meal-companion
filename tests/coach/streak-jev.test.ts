import { describe, expect, it } from "vitest";
import { loadCorpus, runConfig } from "@/scripts/eval/coach-streak-state";

describe("Jev coach streak lane", () => {
  it("keeps its six cases and artifacts separate from the block and L3 runs", () => {
    const config = runConfig("jev");
    const corpus = loadCorpus();
    const cases = corpus.filter((item) => item.category === "jev");

    expect(corpus).toHaveLength(38);
    expect(corpus.filter((item) => item.category === "meals")).toHaveLength(5);
    expect(corpus.filter((item) => item.category === "activity")).toHaveLength(1);
    expect(cases).toHaveLength(6);
    expect(cases.every((item) => item.expected_block_kinds !== undefined)).toBe(true);
    expect(cases.every((item) => item.expected_jev !== undefined)).toBe(true);
    const kinds = cases.flatMap((item) => item.expected_jev?.kind ?? []).sort();
    expect(kinds).toEqual([
      "logged_facet_mark",
      "ranked_suggestions",
      "recipe_exclusion",
      "role_advice_unconfirmed",
      "tiny_log_commit",
      "unverified_recipe",
    ]);
    expect(config).toMatchObject({
      branch: "chat-first-2026-09-19",
      streakTarget: 6,
      turnLimit: 30,
    });
    expect(config.reportPath).toMatch(/coach-streak-jev\.md$/);
    expect(config.statePath).toMatch(/coach-streak-jev-state\.json$/);
    expect(config.turnDir).toMatch(/coach-streak-jev-turns$/);
  });

  it("gives the five-case meals lane its own streak artifacts", () => {
    const config = runConfig("meals");
    expect(config).toMatchObject({ category: "meals", streakTarget: 5, turnLimit: 25 });
    expect(config.reportPath).toMatch(/coach-streak-meals\.md$/);
    expect(config.statePath).toMatch(/coach-streak-meals-state\.json$/);
    expect(config.turnDir).toMatch(/coach-streak-meals-turns$/);
  });
});
