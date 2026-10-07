/**
 * Grok round 4, WARN 3: `gramsPerUnit` now answers null for a liquid of unknown density, where it
 * used to assume water. The one runtime writer of `user_foods.per_100g` must store `{}` for it
 * (no invented mass reaches the server) and must not throw; a known density is used in full.
 */
import { describe, expect, it } from "vitest";
import type { Food } from "@/lib/foods";
import { per100gFor } from "@/lib/foods/prefs-client";

const food = (name: string, perUnit: Food["perUnit"]): Food =>
  ({ id: name, name, role: "fat", unit: "ml", perUnit, status: "eats", updatedAt: "2026-10-05T00:00:00.000Z" });

describe("per100gFor — the user_foods.per_100g writer for an ml food", () => {
  it("stores {} for a liquid of unknown density, and does not throw", () => {
    expect(per100gFor(food("Grandma's tonic", { protein: 0, carbs: 0.1, fat: 0 }))).toEqual({});
  });

  it("scales a known liquid by its full density: olive oil is 100 g fat per 100 g", () => {
    expect(per100gFor(food("Olive oil", { protein: 0, carbs: 0, fat: 0.92 })))
      .toEqual({ protein: 0, carbohydrate: 0, fat_total: 100, energy_kcal: 900 });
  });
});
