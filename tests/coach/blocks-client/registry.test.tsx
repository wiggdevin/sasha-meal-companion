// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOCK_KINDS, renderBlock } from "@/components/coach/blocks";
import type { UiBlock } from "@/lib/coach/ui-blocks";
import { blockContext } from "@/tests/coach/blocks-client/fixtures";
import { barcodeResponse } from "@/tests/coach/editors/fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const idea = {
  wish: "Rice bowl", slot: "meal-2", items: [{
    name: "White rice", foodRefId: "11111111-1111-4111-8111-111111111111",
    catalogFoodRevisionId: 71, grams: 180, kcalPer100g: 130,
    proteinPer100g: 2.7, carbsPer100g: 28, fatPer100g: 0.3,
    macros: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 }, verdict: "allowed" as const,
  }],
  totals: { kcal: 234, protein: 4.9, carbs: 50.4, fat: 0.5 },
  target: { kcal: 400, protein: 30, carbs: 50, fat: 10 },
  flagged: [], fitsTarget: true,
};

const validBlocks: Array<[UiBlock, string]> = [
  [{ kind: "log_draft", v: 1, id: "draft-valid", source: "barcode",
    localDate: "2026-09-19", draft: barcodeResponse, policy: { blocked: false },
    status: "dismissed" }, "Dismissed"],
  [{ kind: "chart", v: 1, id: "chart-valid", chart: "weight_trend",
    series: [{ label: "Weight", points: [{ x: "2026-09-19", y: 127 }] }],
    unit: "lb", caption: "Weight this month" }, "Weight this month"],
  [{ kind: "quick_replies", v: 1, id: "quick-valid",
    options: ["Show today", "Plan tomorrow"] }, "Show today"],
  [{ kind: "food_search", v: 1, id: "search-valid", query: "rice", intent: "log",
    results: [{ foodRefId: "11111111-1111-4111-8111-111111111111", revisionId: "71",
      name: "White rice", kcalPer100g: 130, status: "neutral", blocked: false }],
    truncated: false }, "White rice"],
  [{ kind: "food_ideas", v: 1, id: "ideas-valid", ideas: [idea] }, "White rice"],
  [{ kind: "dietary_profile_proposal", v: 1, id: "profile-valid", profileId: "vegan",
    label: "Vegan", do: ["Offer plant-based proteins."], dont: ["Treat honey as vegan."],
    requiresUserConfirmation: true,
    items: [{ facet: "contains_animal_product", strength: "never", hardBasis: "user_rule" }],
  }, "Vegan"],
  [{ kind: "next_action_chip", v: 1, id: "chip-valid", action: "log_meal",
    label: "Log your next meal" }, "Log your next meal"],
];

const malformedBlocks = [
  { kind: "chart", v: 1, id: "chart-bad", chart: "weight_trend",
    unit: "lb", caption: "Missing series" },
  { kind: "quick_replies", v: 1, id: "quick-bad", options: "not an array" },
  { kind: "food_search", v: 1, id: "search-bad", query: "rice", intent: "log",
    results: [{ foodRefId: "ref", revisionId: "71", name: "Rice",
      kcalPer100g: "130", status: "neutral" }], truncated: false },
  { kind: "food_ideas", v: 1, id: "ideas-bad",
    ideas: [{ ...idea, totals: "not totals" }] },
  { kind: "log_draft", v: 1, id: "draft-bad", source: "barcode",
    localDate: "2026-09-19", policy: { blocked: false }, status: "pending" },
  { kind: "dietary_profile_proposal", v: 1, id: "profile-bad", profileId: "vegan",
    label: "Vegan", do: [], dont: [], items: [] },
  { kind: "next_action_chip", v: 1, id: "chip-bad", action: "not_a_real_action",
    label: "Log your next meal" },
];

describe("client block registry", () => {
  it("lists the supported versioned kinds", () => {
    expect(BLOCK_KINDS).toEqual([
      "log_draft", "chart", "quick_replies", "food_search", "food_ideas", "recipe_results", "ui",
      "dietary_profile_proposal", "next_action_chip",
    ]);
  });

  it("omits an unknown kind or version", () => {
    const ctx = blockContext();
    expect(renderBlock({ kind: "future", v: 1 }, ctx)).toBeNull();
    expect(renderBlock({ kind: "log_draft", v: 2 }, ctx)).toBeNull();
  });

  it.each(malformedBlocks)("omits malformed $kind blocks without breaking the transcript", (block) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<div aria-label="Conversation">
      <p>Message before</p>
      {renderBlock(block, blockContext())}
      <p>Message after</p>
    </div>);

    expect(screen.getByLabelText("Conversation").textContent).toBe("Message beforeMessage after");
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      `Invalid coach block ${JSON.stringify({ kind: block.kind, id: block.id })}`,
    );
  });

  it.each(validBlocks)("renders a valid registry fixture", (block, expectedText) => {
    const { container } = render(renderBlock(block, blockContext()));
    expect(container.textContent).toContain(expectedText);
  });
});
