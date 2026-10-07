import { describe, expect, it } from "vitest";
import { recipePreviewBody, shoppingPreviewBody } from "@/lib/shopping/preview-contract";

const draft = { startDate: "2026-10-01", endDate: "2026-10-07", timezone: "America/Denver",
  people: 1, mealCoverage: ["dinner"], mode: "balanced", effort: "standard",
  maxActiveMinutes: null, variety: "balanced", budgetAmount: null, currency: null,
  locale: null, lockMode: "none" };

describe("recipe and shopping preview edge", () => {
  it("rejects invalid calendar dates and slots before authority reads", () => {
    expect(recipePreviewBody.safeParse({ date: "2026-02-30", slotId: "meal-1" }).success).toBe(false);
    expect(recipePreviewBody.safeParse({ date: "2026-10-01", slotId: "pouches-pre" }).success).toBe(false);
    expect(recipePreviewBody.safeParse({ date: "2026-10-01", slotId: "meal-1",
      servingFraction: 2.1 }).success).toBe(false);
  });

  it("requires a paired owner revision and bounded basket", () => {
    const periodId = "550e8400-e29b-41d4-a716-446655440000";
    expect(shoppingPreviewBody.safeParse({ draft, basket: [] }).success).toBe(true);
    expect(shoppingPreviewBody.safeParse({ draft: { ...draft, endDate: "2026-11-07" },
      basket: [] }).success).toBe(false);
    expect(shoppingPreviewBody.safeParse({ draft: { ...draft, timezone: "not/a-zone" },
      basket: [] }).success).toBe(false);
    expect(shoppingPreviewBody.safeParse({ periodId, draft, basket: [] }).success).toBe(false);
    expect(shoppingPreviewBody.safeParse({ periodId, expectedRevision: 2,
      draft, basket: [] }).success).toBe(true);
    expect(shoppingPreviewBody.safeParse({ draft, basket: Array(101).fill({
      foodRefId: periodId, catalogFoodRevisionId: null,
      purchaseState: "raw", variantKey: "raw" }) }).success).toBe(false);
    expect(shoppingPreviewBody.safeParse({ draft, basket: [{ foodRefId: null,
      foodDbId: null, catalogFoodRevisionId: null, purchaseState: "raw",
      variantKey: "raw" }] }).success).toBe(false);
  });
});
