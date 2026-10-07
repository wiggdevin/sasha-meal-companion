import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";
import { adviseGroundedListActions } from "@/lib/server/coach-role-advice";
import { searchExactUserFood } from "@/lib/server/coach-ports";

const listAction = {
  kind: "add_to_eats",
  actionId: "action-1",
  flagged: [],
  name: "Blue pea crunch",
  foodRefId: "food-ref-1",
  catalogFoodRevisionId: null,
  kcalPer100g: 167,
  proteinPer100g: 30,
  carbsPer100g: 5,
  fatPer100g: 3,
  verdict: "unverified",
} satisfies CoachAction;

function query(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "ilike", "limit", "order", "range"]) {
    chain[method] = () => chain;
  }
  chain.maybeSingle = async () => result;
  return chain;
}

describe("streak: role-less custom food advice", () => {
  afterEach(() => vi.restoreAllMocks());

  it("grounds an exact account-scoped custom food before catalog results", async () => {
    const from = vi.fn((table: string) => table === "user_foods"
      ? query({ data: {
          id: "user-food-1", name: "Blue pea crunch", brand: null,
          per_100g: { energy_kcal: 167, protein: 30, carbohydrate: 5, fat_total: 3 },
          allergen_tags: [],
        }, error: null })
      : query({ data: { status: "avoid" }, error: null }));
    const admin = {
      from,
      rpc: vi.fn(async () => ({ data: "food-ref-1", error: null })),
    };

    const hit = await searchExactUserFood(admin as never, "user-1", "Blue pea crunch");

    expect(hit).toMatchObject({
      foodRefId: "food-ref-1", name: "Blue pea crunch", catalogFoodRevisionId: null,
      proteinPer100g: 30, carbsPer100g: 5, fatPer100g: 3, prefStatus: "avoid",
    });
  });

  it("attaches confirmable advice without writing a stored role", async () => {
    const storedRoles = vi.fn(async () => new Map([["food-ref-1", null]]));
    const systemOne = vi.fn(async () => ({
      meal_component_role: {
        type: "choice" as const,
        choice: "protein_anchor" as const,
        probabilities: {
          protein_anchor: 1, carb_source: 0, fat_source: 0,
          produce_or_free: 0, mixed_dish: 0, none: 0,
        },
        confidence: 0.94,
      },
    }));

    const result = await adviseGroundedListActions("user-1", [listAction], {
      storedRoles, systemOne,
    });

    expect(result).toEqual([expect.objectContaining({
      kind: "add_to_eats",
      roleAdvice: {
        foodRefId: "food-ref-1",
        suggestedRole: "protein_anchor",
        proposedRole: "protein",
        currentRole: null,
        reason: "The food is chiefly the meal's protein anchor.",
        confidence: 0.94,
        requiresConfirmation: true,
      },
    })]);
    expect(storedRoles).toHaveBeenCalledOnce();
    expect(systemOne).toHaveBeenCalledOnce();
  });

  it("keeps DB failures confirm-required without guessing a storable role", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await adviseGroundedListActions("user-1", [listAction], {
      storedRoles: vi.fn(async () => { throw new Error("DB unavailable"); }),
      systemOne: vi.fn(),
    });

    expect(result).toEqual([expect.objectContaining({
      roleAdvice: {
        foodRefId: "food-ref-1",
        suggestedRole: "mixed_dish",
        proposedRole: null,
        currentRole: null,
        reason: "No role was saved. The food is a mixed dish without one clear component role.",
        confidence: 0,
        requiresConfirmation: true,
      },
    })]);
    expect(warn).toHaveBeenCalledWith(
      "[coach-role-advice] advice failed; requiring confirmation",
      { error: { name: "Error" } },
    );
  });

  it("keeps Jev failures confirm-required without guessing a storable role", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await adviseGroundedListActions("user-1", [listAction], {
      storedRoles: vi.fn(async () => new Map([["food-ref-1", null]])),
      // systemOne catches provider failures and returns null after its own safe warning.
      systemOne: vi.fn(async () => null),
    });

    expect(result).toEqual([expect.objectContaining({
      roleAdvice: {
        foodRefId: "food-ref-1",
        suggestedRole: "mixed_dish",
        proposedRole: null,
        currentRole: null,
        reason: "No role was saved. The food is a mixed dish without one clear component role.",
        confidence: 0,
        requiresConfirmation: true,
      },
    })]);
    expect(warn).toHaveBeenCalledWith(
      "[coach-role-advice] advice unavailable; requiring confirmation",
    );
  });
});
