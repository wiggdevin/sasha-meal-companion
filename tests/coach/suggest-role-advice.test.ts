import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({
  choice: (instructions: string, criteria: Record<string, string>) => ({
    type: "choice", instructions, criteria,
  }),
  systemOne: vi.fn(async () => null),
}));

import {
  adviseMealComponentRole, MEAL_COMPONENT_ROLES, nutrientBuckets, type RoleAdviceFood, type RolePort,
} from "@/lib/coach/role-advice";

const FOOD: RoleAdviceFood = {
  foodRefId: "food-1",
  name: "Tahini",
  description: "Sesame seed paste",
  prepState: "ready to eat",
  proteinPer100g: 17,
  carbsPer100g: 6,
  fatPer100g: 54,
  storedRole: null,
};

function choiceAnswer(choice: keyof typeof MEAL_COMPONENT_ROLES) {
  return {
    meal_component_role: {
      type: "choice" as const,
      choice,
      probabilities: Object.fromEntries(Object.keys(MEAL_COMPONENT_ROLES)
        .map((key) => [key, key === choice ? 1 : 0])) as Record<keyof typeof MEAL_COMPONENT_ROLES, number>,
      confidence: 0.92,
    },
  };
}

/** The port takes the builder's payload (Phase 13 §9 R3); the spies keep a state/questions view. */
function port(spy: (state: unknown, questions: Record<string, { criteria: Record<string, string> }>,
  options: { purpose: string; userId: string; deadlineMs: number }) => Promise<unknown>): RolePort {
  return (payload, options) => spy(payload.state, payload.questions,
    { ...options, purpose: payload.purpose }) as ReturnType<RolePort>;
}

describe("meal component role advice", () => {
  it("returns a confirmable Choice for a role-less food and never persists it", async () => {
    const systemOne = vi.fn(async (_state: unknown,
      _questions: Record<string, { criteria: Record<string, string> }>,
      _options: { purpose: string; userId: string; deadlineMs: number }) =>
      choiceAnswer("fat_source"));

    const result = await adviseMealComponentRole(FOOD, { userId: "u1", systemOne: port(systemOne) });

    expect(result).toEqual({
      foodRefId: "food-1",
      suggestedRole: "fat_source",
      proposedRole: "fat",
      currentRole: null,
      reason: MEAL_COMPONENT_ROLES.fat_source,
      confidence: 0.92,
      requiresConfirmation: true,
    });
    expect(systemOne).toHaveBeenCalledOnce();
    const [state, questions, options] = systemOne.mock.calls[0];
    expect(state).toEqual({
      food: { name: "Tahini", description: "Sesame seed paste", prepState: "ready to eat" },
      nutrientBuckets: { protein: "source", carb: "low", fat: "dense" },
    });
    expect(Object.keys(questions.meal_component_role.criteria)).toEqual(
      Object.keys(MEAL_COMPONENT_ROLES));
    expect(options).toMatchObject({ purpose: "meal-component-role", userId: "u1" });
  });

  it("lets a stored role win without calling Jev", async () => {
    const systemOne = vi.fn(async (_state: unknown,
      _questions: Record<string, { criteria: Record<string, string> }>,
      _options: { purpose: string; userId: string; deadlineMs: number }) =>
      choiceAnswer("fat_source"));

    const result = await adviseMealComponentRole(
      { ...FOOD, storedRole: "protein" }, { userId: "u1", systemOne: port(systemOne) },
    );

    expect(result).toBeNull();
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("returns no advice when Choice says none", async () => {
    const result = await adviseMealComponentRole(FOOD, {
      userId: "u1", systemOne: async () => choiceAnswer("none"),
    });

    expect(result).toBeNull();
  });

  it("computes nutrient buckets in code", () => {
    expect(nutrientBuckets({ proteinPer100g: 20, carbsPer100g: 10, fatPer100g: 4.9 }))
      .toEqual({ protein: "dense", carb: "source", fat: "low" });
  });
});
