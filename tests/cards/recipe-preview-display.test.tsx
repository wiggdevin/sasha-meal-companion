// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RecipePlanFlow from "@/components/RecipePlanFlow";
import { pilotRecipes } from "@/lib/recipe-catalog/pilot";
import { distinctEvidenceIssues } from "@/lib/recipes/preview-display";
import type { RecipePreviewResult } from "@/lib/shopping/preview-contract";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), accept: vi.fn() }));
vi.mock("@/lib/recipe-plan-client", () => ({ previewRecipePlan: mocks.preview,
  acceptRecipePlan: mocks.accept }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("rounds visible nutrition, labels gap direction and keeps deduplicated evidence details", async () => {
  const recipe = { ...pilotRecipes()[0], eligibility: { status: "eligible" as const, reasons: [] } };
  const estimated = (value: number) => ({ value, status: "estimated" as const, sourceRevisionId: null });
  const issues = ["kcal", "protein", "carbs", "fat"].map(() => ({ code: "retention_unknown",
    message: "Retained amount for onion is unknown.", ingredientSeq: 1 }));
  mocks.preview.mockResolvedValue({ previewId: "proof", recipe, servingFraction: 1.7847,
    ingredientSnapshot: [{ seq: 1, name: "Onion", foodRefId: null, foodDbId: "onion",
      foodRevisionId: null, quantity: 8.9235, unit: "g", grams: 8.9235,
      purchaseGrams: null, state: "raw" }],
    nutritionSnapshot: { kcal: estimated(593.9928), protein: estimated(40.6666666667),
      carbs: estimated(52.3333), fat: estimated(11.1234) },
    gap: { kcal: 93.9928, protein: -4.3333, carbs: 0, fat: null },
    mealTarget: { kcal: 500.6666666667, protein: 45, carbs: 52.3333, fat: 12 },
    exactFitAvailable: false, approximateFitAvailable: true, evidenceIssues: issues,
    authority: { targetRevisionId: "target", targetRevision: 1, rulesFingerprint: "rules",
      planRevision: 1, stateRevision: 1 },
  } as RecipePreviewResult);
  render(<RecipePlanFlow recipe={recipe} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview portion" }));
  await screen.findByLabelText("Portion preview");
  expect(screen.getByText(/Suggested amount: 1.78 servings/)).toBeTruthy();
  expect(screen.getByText(/8.92 g/)).toBeTruthy();
  expect(screen.getByText(/594 kcal · estimated · 94 kcal above target/)).toBeTruthy();
  expect(screen.getByText(/40.7 g · estimated · 4.3 g below target/)).toBeTruthy();
  expect(screen.getByText(/Cooked nutrient retention is not measured/)).toBeTruthy();
  fireEvent.click(screen.getByText("Evidence details"));
  expect(screen.getAllByText("Retained amount for onion is unknown.")).toHaveLength(1);
  expect(distinctEvidenceIssues(issues)).toHaveLength(1);
});
