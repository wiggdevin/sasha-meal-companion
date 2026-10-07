// @vitest-environment jsdom
/**
 * Phase 18 W12-F (docs/specs/phase-18-open-world-foods.md "The W12 boundary" item 2, acceptance 8):
 * before the camera opens, one line asks the user to keep medicines, prescriptions and labels with
 * names out of the frame. The recipe widget's ask box (components/recipes-hub/RecipeHub.tsx) has a
 * photo control (PlanComposer's `onPhoto`, routed to ask.readPhoto, which reaches a model the same
 * way the Plan sheet's photo does), so it needs the same notice. Reuses
 * components/ui/PhotoPrivacyNotice.tsx unchanged via PlanComposer's existing `photoNotice` prop
 * (feat/ui-photo-notice), present beside the box before any tap — never a blocking dialog.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { resetFlightsForTests } from "@/components/single-flight";

const postTurn = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coach-client", async (original) => ({
  ...(await original<typeof import("@/lib/coach-client")>()), postTurn,
}));
vi.mock("@/lib/recipe-catalog-client", async (original) => ({
  ...(await original<typeof import("@/lib/recipe-catalog-client")>()), searchCatalogRecipes: search,
}));
vi.mock("@/lib/resolve", async (original) => ({
  ...(await original<typeof import("@/lib/resolve")>()),
  resolveDay: () => ({
    targets: { kcal: 2000, protein: 150, carbs: 200, fat: 60 },
    consumed: { kcal: 1400, protein: 100, carbs: 150, fat: 40 },
    slots: [{ slot: "meal-1", time: "00:00", label: "Meal 1" }],
  }),
}));

import RecipeHub from "@/components/recipes-hub/RecipeHub";

const ENABLED = { enabled: true, loading: false };
const NOTICE_TEXT = /keep medicines, prescriptions and labels/i;

beforeEach(async () => {
  resetFlightsForTests();
  await resetTestAccount();
  postTurn.mockReset().mockResolvedValue({ threadId: "t", suggestions: [], actions: [], draft: null,
    composed: [], deflected: false, toolsUsed: [], model: { provider: "gemini", modelId: "m" },
    messages: [{ id: "a", role: "assistant", content: "Here." }] });
  search.mockReset().mockResolvedValue({ recipes: [], count: 0, limitations: [] });
});
afterEach(() => cleanup());

describe("the recipe widget's photo-capture notice", () => {
  it("is present on mount, before the + tab is ever opened or a picker tapped", () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByRole("button", { name: "Take a photo" })).toBeNull();
    expect(screen.getByText(NOTICE_TEXT)).toBeTruthy();
  });

  it("stays present once the + tab opens and the camera/upload buttons appear", () => {
    render(<RecipeHub access={ENABLED} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a photo or file" }));
    expect(screen.getByRole("button", { name: "Take a photo" })).toBeTruthy();
    expect(screen.getByText(NOTICE_TEXT)).toBeTruthy();
  });
});
