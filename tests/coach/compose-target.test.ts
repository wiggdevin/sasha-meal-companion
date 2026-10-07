import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const dayContext = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/server/day-context", () => ({
  buildDayContext: vi.fn(async () => dayContext.value),
}));

const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const remaining = { kcal: 1800, protein: 150, carbs: 180, fat: 60 };
const slot = (id: string, state: "empty" | "pending" | "eaten", totals = zero) =>
  ({ slot: id, label: id, title: id, time: "08:00", state, totals });
const admin = {} as SupabaseClient;
const clock = { tz: "UTC", date: "2026-09-21" };

afterEach(() => { dayContext.value = null; });

describe("composeTarget", () => {
  it("throws for needs_profile: no remaining means no target to size against", async () => {
    dayContext.value = { remaining: null, slots: [slot("meal-1", "empty")] };
    const { composeTarget } = await import("@/lib/server/coach-ports");
    await expect(composeTarget(admin, "u1", "meal-1", clock))
      .rejects.toThrow("Profile setup is required before sizing a meal.");
  });

  it("sizes one meal of a new account's empty day, not the whole revision", async () => {
    dayContext.value = {
      remaining,
      slots: [slot("meal-1", "empty"), slot("meal-2", "empty"), slot("meal-3", "empty"), slot("coffee", "empty")],
    };
    const { composeTarget } = await import("@/lib/server/coach-ports");
    expect(await composeTarget(admin, "u1", "meal-1", clock))
      .toEqual({ kcal: 600, protein: 50, carbs: 60, fat: 20 });
  });

  it("uses a planned slot's own totals and shares the remainder across pending meals otherwise", async () => {
    const lunch = { kcal: 700, protein: 50, carbs: 70, fat: 25 };
    dayContext.value = {
      remaining,
      slots: [slot("meal-1", "eaten", lunch), slot("meal-2", "pending", lunch), slot("meal-3", "pending", lunch)],
    };
    const { composeTarget } = await import("@/lib/server/coach-ports");
    expect(await composeTarget(admin, "u1", "meal-2", clock)).toEqual(lunch);
    expect(await composeTarget(admin, "u1", undefined, clock))
      .toEqual({ kcal: 900, protein: 75, carbs: 90, fat: 30 });
  });

  it("sizes a cleared named slot from its share, not the next rebalanced meal", async () => {
    const rebalanced = { kcal: 600, protein: 50, carbs: 60, fat: 20 };
    dayContext.value = { remaining,
      slots: [slot("meal-1", "pending", rebalanced), slot("meal-2", "pending", rebalanced),
        slot("meal-3", "pending", rebalanced), slot("meal-4", "empty")] };
    const { composeTarget, suggestionTarget } = await import("@/lib/server/coach-ports");
    const expected = { kcal: 450, protein: 38, carbs: 45, fat: 15 };
    expect(await composeTarget(admin, "u1", "meal-4", clock)).toEqual(expected);
    expect(await suggestionTarget(admin, "u1", { kind: "meal", count: 3,
      slot: "meal-4", fitRemaining: true }, clock)).toEqual(expected);
  });

  it("uses the account-derived cleared-slot share after a fixed authored meal", async () => {
    const planned = { kcal: 1600 / 3, protein: 115 / 3, carbs: 140 / 3, fat: 58 / 3 };
    dayContext.value = { remaining, planningTarget: planned,
      slots: [slot("meal-1", "pending", { kcal: 200, protein: 5, carbs: 40, fat: 2 }),
        slot("meal-2", "pending", { kcal: 800, protein: 58, carbs: 70, fat: 29 }),
        slot("meal-3", "pending", { kcal: 800, protein: 58, carbs: 70, fat: 29 }),
        slot("meal-4", "empty")] };
    const { composeTarget, suggestionTarget } = await import("@/lib/server/coach-ports");
    expect(await composeTarget(admin, "u1", "meal-4", clock)).toEqual(planned);
    expect(await suggestionTarget(admin, "u1", { kind: "meal", count: 3,
      slot: "meal-4", fitRemaining: true }, clock)).toEqual(planned);
  });
});
