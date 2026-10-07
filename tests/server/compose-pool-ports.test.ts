/**
 * Phase 18 W9 (Sol r3 BLOCK, verified real): the closed-world compose pool is the account's
 * Eats projection (`foodsFor`) intersected with CURRENTLY eligible food ids (`eligibleFoods`) --
 * a raw Eats mark can be stale (added before a rule that would now exclude it), so a pool-filled
 * compose_meal item must never read "allowed" for a food current rules would actually block.
 */
import { describe, expect, it, vi } from "vitest";
import type { Food } from "@/lib/foods";

const chicken: Food = { id: "food-1", name: "Chicken breast, roasted", role: "protein", unit: "g",
  perUnit: { protein: 0.31, carbs: 0, fat: 0.036 }, status: "eats", updatedAt: "2026-10-04" };
const shrimp: Food = { id: "food-2", name: "Shrimp", role: "protein", unit: "g",
  perUnit: { protein: 0.24, carbs: 0, fat: 0.003 }, status: "eats", updatedAt: "2026-10-04" };

vi.mock("@/lib/server/day-context", () => ({
  foodsFor: vi.fn(async () => ({ [chicken.id]: chicken, [shrimp.id]: shrimp })),
  userFoodRefIds: vi.fn(async () => ({})),
}));

vi.mock("@/lib/server/eligible-foods", () => ({
  // Shrimp was Favored before a new shellfish allergen rule; it is no longer eligible, exactly
  // the stale-mark case this intersection exists to close.
  eligibleFoods: vi.fn(async () => ({
    eligibleRefIds: [], eligibleFoodIds: [chicken.id], eligibleCatalogFoodIds: [],
    excluded: [], rulesRevision: 1,
  })),
}));

describe("composePoolPorts: the closed-world pool is current-rules-filtered", () => {
  it("keeps a currently eligible Eats food and drops a stale one eligibleFoods no longer admits", async () => {
    const { composePoolPorts } = await import("@/lib/server/compose-pool-ports");
    const ports = composePoolPorts({} as never, {} as never);
    const pool = await ports.pool!("u1");
    expect(Object.keys(pool)).toEqual([chicken.id]);
    expect(pool[chicken.id]).toBe(chicken);
    expect(pool[shrimp.id]).toBeUndefined();
  });
});
