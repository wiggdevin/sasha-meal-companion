import { describe, expect, it } from "vitest";
import { uiBlockSchema } from "@/lib/coach/ui-blocks";

const meal = {
  wish: "rice bowl", slot: null, items: [],
  totals: { kcal: 300, protein: 20, carbs: 40, fat: 8 },
  target: { kcal: 300, protein: 20, carbs: 40, fat: 8 },
  flagged: [], fitsTarget: true,
};

const blocks = [
  {
    kind: "log_draft", v: 1, id: "draft-1", source: "barcode",
    localDate: "2026-09-19", status: "pending", policy: { blocked: false },
    draft: {
      status: "resolved", gtin14: "00012345678905", cached: true,
      match: {
        foodRefId: "ref-1", catalogFoodId: 7, revisionId: 71, description: "Rice",
        brand: null, source: "fdc_branded", qualityClass: "label", qualityFlags: [],
        per100g: { energy_kcal: 130 }, portions: [], ingredientsText: "rice",
        allergenTags: [], attribution: null, policy: { verdict: "allowed" },
      },
    },
  },
  {
    kind: "chart", v: 1, id: "chart-1", chart: "weight_trend", days: 30,
    series: [{ label: "Weight", points: [{ x: "2026-09-19", y: 127 }] }],
    unit: "lb", caption: "Weight over 30 days",
  },
  { kind: "quick_replies", v: 1, id: "quick-1", options: ["Yes", "No"] },
  {
    kind: "food_search", v: 1, id: "search-1", query: "rice", intent: "log",
    results: [{ foodRefId: "ref-1", revisionId: "71", name: "Rice", status: "eats" }],
    truncated: false,
  },
  { kind: "food_ideas", v: 1, id: "ideas-1", ideas: [meal] },
] as const;

describe("uiBlockSchema", () => {
  it.each(blocks)("accepts $kind v1", (block) => {
    expect(uiBlockSchema.safeParse(block).success).toBe(true);
  });

  it("rejects an unknown block kind", () => {
    expect(uiBlockSchema.safeParse({ kind: "weather", v: 1, id: "x" }).success).toBe(false);
  });

  it("rejects a known block at an unknown version", () => {
    expect(uiBlockSchema.safeParse({ ...blocks[1], v: 2 }).success).toBe(false);
  });
});
