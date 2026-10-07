import { describe, expect, it } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";
import {
  jevAssertions,
  type JevPersistedEvidence,
} from "@/scripts/eval/coach-streak-jev";

function action(value: Record<string, unknown>): CoachAction {
  return value as CoachAction;
}

function evidence(overrides: Partial<JevPersistedEvidence>): JevPersistedEvidence {
  return {
    assistantContent: "",
    toolCalls: {},
    actions: [],
    blocks: [],
    commit: null,
    logEntry: null,
    rankingPurposes: [],
    membershipBefore: null,
    membershipAfter: null,
    ...overrides,
  };
}

function allPass(result: ReturnType<typeof jevAssertions>): boolean {
  return result.every((item) => item.passed);
}

describe("Jev streak persisted-row assertions", () => {
  it("requires the soy mark on both the stored action/reply and commit result", () => {
    const result = jevAssertions({
      kind: "logged_facet_mark", facet: "contains_soy", preference: "no_soy",
    }, evidence({
      assistantContent: "Logged it off-plan because it contains soy.",
      actions: [action({
        kind: "log_meal", flagged: ["Smoked tofu"],
        items: [{ name: "Smoked tofu", verdict: "blocked" }],
      })],
      commit: { status: "ok", flagged: [{ message: "blocked:facet:contains_soy" }] },
      logEntry: { id: "entry", grams: [100] },
    }));

    expect(allPass(result)).toBe(true);
  });

  it("requires a soy recipe refusal and excludes the blocked ingredient", () => {
    const result = jevAssertions({
      kind: "recipe_exclusion", facet: "contains_soy", preference: "no_soy",
    }, evidence({
      assistantContent: "Skipped smoked tofu: contains soy (your no-soy preference).",
      actions: [action({ kind: "save_recipe", items: [{ name: "Rice" }] })],
    }));

    expect(allPass(result)).toBe(true);
  });

  it("requires Not verified copy and excludes the low-FODMAP unknown", () => {
    const result = jevAssertions({
      kind: "unverified_recipe", preference: "low_fodmap",
    }, evidence({
      assistantContent: "Cannot verify Mystery broth for your low-FODMAP preference — marked Not verified.",
      actions: [action({ kind: "save_recipe", items: [{ name: "Rice" }] })],
    }));

    expect(allPass(result)).toBe(true);
  });

  it("requires the persisted tiny warning and committed one-gram item", () => {
    const result = jevAssertions({ kind: "tiny_log_commit", grams: 1 }, evidence({
      actions: [action({
        kind: "log_meal",
        items: [{ grams: 1, sanity: {
          status: "warn", warnings: [{ kind: "portion", level: "tiny" }],
        } }],
      })],
      commit: { status: "ok" },
      logEntry: { id: "entry", grams: [1] },
    }));

    expect(allPass(result)).toBe(true);
  });

  it("requires one ranking row and three policy-clean persisted cards", () => {
    const result = jevAssertions({
      kind: "ranked_suggestions", purpose: "suggest-options", calls: 1,
    }, evidence({
      rankingPurposes: ["coach-intent", "suggest-options", "coach-reply-verify"],
      blocks: [{ kind: "food_ideas", ideas: [1, 2, 3].map((id) => ({
        id, items: [{ name: "Rice", verdict: "allowed" }],
      })) }],
    }));

    expect(allPass(result)).toBe(true);
  });

  it("requires confirmation advice while the stored role and membership stay unchanged", () => {
    const result = jevAssertions({ kind: "role_advice_unconfirmed" }, evidence({
      actions: [action({
        kind: "add_to_eats",
        roleAdvice: { suggestedRole: "mixed_dish", requiresConfirmation: true },
      })],
      membershipBefore: { status: "avoid", role: null },
      membershipAfter: { status: "avoid", role: null },
    }));

    expect(allPass(result)).toBe(true);
  });

  it("does not let client-view data rescue missing persisted evidence", () => {
    const result = jevAssertions({
      kind: "ranked_suggestions", purpose: "suggest-options", calls: 1,
    }, evidence({ rankingPurposes: ["suggest-options"] }));

    expect(result.find((item) => item.name === "Jev persisted cards are policy-clean")?.passed)
      .toBe(false);
  });
});
