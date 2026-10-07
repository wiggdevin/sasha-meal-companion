import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateToolCall } from "@/lib/coach/dispatch";
import { REGISTRY } from "@/lib/coach/registry";
import { SLOT_IDS } from "@/lib/coach/types";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const noArgs = z.object({});
const PRE_B1_INPUTS = {
  get_day: z.object({ date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
  get_plan: z.object({ date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
  get_entries: z.object({ date: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
  get_recipes: noArgs,
  get_week_totals: z.object({ weekStart: z.string().regex(LOCAL_DATE, "must be YYYY-MM-DD") }),
  get_targets: noArgs,
  get_expenditure_status: noArgs,
  search_foods: z.object({
    query: z.string().min(1).max(64),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  get_constraints: noArgs,
  get_recent_gut_log: z.object({ days: z.number().int().min(1).max(30).optional() }),
  draft_log_entry: z.object({
    slot: z.enum(SLOT_IDS),
    items: z.array(z.object({
      name: z.string().min(1).max(80), grams: z.number().positive().max(2000),
    })).min(1).max(6),
  }),
  compose_meal: z.object({
    wish: z.string().min(1).max(200), slot: z.enum(SLOT_IDS).optional(),
    servings: z.number().int().min(1).max(4).optional(),
  }),
  suggest_options: z.object({
    kind: z.enum(["meal", "snack", "recipe"]),
    count: z.number().int().min(1).max(5).default(3),
    slot: z.enum(SLOT_IDS).optional(), fitRemaining: z.boolean().optional(),
    wish: z.string().min(1).max(200).optional(),
  }),
} as const;

describe("UI block tool arguments", () => {
  // Phase 13 slice 6 adds `lookup` (its own tests: tests/coach/registry.test.ts); the 13 tools
  // this test names by name are the ones B1 actually touched, and stay byte-for-byte equivalent.
  it("keeps all 13 executor schemas byte-for-byte equivalent to their pre-B1 shapes", () => {
    const preB1 = REGISTRY.filter((tool) => tool.name in PRE_B1_INPUTS);
    expect(preB1).toHaveLength(13);
    for (const tool of preB1) {
      expect(z.toJSONSchema(tool.input), tool.name)
        .toEqual(z.toJSONSchema(PRE_B1_INPUTS[tool.name as keyof typeof PRE_B1_INPUTS]));
    }
  });

  it("strips model-authored chart data before the server handler", () => {
    const result = validateToolCall("show_chart", {
      chart: "weight_trend", days: 30,
      series: [{ label: "Invented", points: [{ x: "today", y: 999 }] }],
      unit: "stones",
    });
    expect(result).toMatchObject({ ok: true, args: { chart: "weight_trend", days: 30 } });
  });

  it.each([
    ["show_chart", { chart: "weight_trend", days: 6 }],
    ["show_chart", { chart: "unknown" }],
    ["quick_replies", { options: ["one"] }],
    ["quick_replies", { options: ["1", "2", "3", "4", "5"] }],
    ["search_foods", { query: "rice", intent: "delete" }],
    ["search_foods", { query: "rice", intent: "browse", limit: 11 }],
  ])("rejects invalid %s args without throwing", (name, args) => {
    expect(() => validateToolCall(name, args)).not.toThrow();
    expect(validateToolCall(name, args).ok).toBe(false);
  });
});
