import { describe, expect, it, vi } from "vitest";
import type { Executor } from "@/lib/coach/executors";
import type { ToolName } from "@/lib/coach/registry";
import { coachTurnRequestSchema } from "@/lib/coach/types";
import { pickPrompt, wishPrompt } from "@/lib/plan/quick-picks";
import { pinPlanSlot, planSlotOf } from "@/lib/server/coach-turn/plan-slot";

const base = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000010" };

function executors() {
  const suggest = vi.fn(async () => []);
  const compose = vi.fn(async () => ({}));
  const all = { suggest_options: suggest, compose_meal: compose } as unknown as
    Record<ToolName, Executor>;
  return { all, suggest, compose };
}

describe("plan-surface turns always carry their meal slot", () => {
  it("reads the slot from a quick pick's prompt when no structured field is sent", () => {
    const text = pickPrompt("High protein", "Meal 2", "meal-2", "2026-10-03");
    expect(planSlotOf({ surface: "plan", text })).toBe("meal-2");
    expect(planSlotOf({ surface: "plan", text: wishPrompt("tacos", "Meal 1", "meal-1", "2026-10-03") }))
      .toBe("meal-1");
  });

  it("prefers the structured fields and ignores slots outside the Plan sheet", () => {
    expect(planSlotOf({ surface: "plan", planSlot: "meal-3", text: "(meal-1)" })).toBe("meal-3");
    expect(planSlotOf({ surface: "plan", planningSlot: "meal-4", text: "x" })).toBe("meal-4");
    expect(planSlotOf({ text: "Suggest options for Meal 2 (meal-2)" })).toBeNull();
    expect(planSlotOf({ surface: "plan", text: "Ideas for Snack (snack)" })).toBeNull();
  });

  it("never pins a planningSlot sent from Coach chat or the recipe widget (audit b1)", () => {
    expect(planSlotOf({ planningSlot: "meal-4", text: "ideas" })).toBeNull();
    expect(planSlotOf({ surface: "recipes", planningSlot: "meal-4", text: "ideas (meal-4)" })).toBeNull();
  });

  it("pins the slot and the strict meal fit on a High protein ask, keeping the preference", async () => {
    const { all, suggest } = executors();
    const pinned = pinPlanSlot(all, "meal-2");

    await pinned.suggest_options("u1", { kind: "snack", count: 3, fitRemaining: false,
      wish: "high protein" });

    expect(suggest).toHaveBeenCalledWith("u1", {
      kind: "meal", count: 3, fitRemaining: true, slot: "meal-2", wish: "high protein",
    });
  });

  it("pins compose_meal and leaves recipe searches alone", async () => {
    const { all, suggest, compose } = executors();
    const pinned = pinPlanSlot(all, "meal-5");

    await pinned.compose_meal("u1", { wish: "salmon bowl" });
    await pinned.suggest_options("u1", { kind: "recipe", wish: "stew" });

    expect(compose).toHaveBeenCalledWith("u1", { wish: "salmon bowl", slot: "meal-5" });
    expect(suggest).toHaveBeenCalledWith("u1", { kind: "recipe", wish: "stew" });
    expect(pinPlanSlot(all, null)).toBe(all);
  });

  it("accepts planSlot only on the Plan surface", () => {
    expect(coachTurnRequestSchema.safeParse({ ...base, text: "hi", surface: "plan",
      planSlot: "meal-2" }).success).toBe(true);
    expect(coachTurnRequestSchema.safeParse({ ...base, text: "hi", planSlot: "meal-2" }).success)
      .toBe(false);
    expect(coachTurnRequestSchema.safeParse({ ...base, text: "hi", surface: "plan",
      planSlot: "snack" }).success).toBe(false);
  });
});
