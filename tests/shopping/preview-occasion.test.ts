// Phase 17 O4 (acceptance 10): the shopping preview reads the account's schedule on the server and
// places each meal word in the slot whose clock on that date is that meal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingredient, recipe } from "../recipes/fixture";

const mocks = vi.hoisted(() => ({
  candidates: [] as unknown[],
  detail: vi.fn(),
  storePreview: vi.fn(async () => ({ data: "preview-1", error: null })),
}));

vi.mock("@/lib/server/targets", () => ({
  activeProfile: vi.fn(async () => ({ id: "target-1", rev: 3,
    training_macros: { kcal: 2000, protein: 120, carbs: 200, fat: 70 },
    rest_macros: { kcal: 2000, protein: 120, carbs: 200, fat: 70 } })),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ rpc: mocks.storePreview }) }));
vi.mock("@/lib/server/recipe-candidates", () => ({
  loadRecipeCandidates: vi.fn(async () => ({ candidates: mocks.candidates,
    noResultReasons: [], rulesFingerprint: "rules-1" })),
  loadRecipeDetail: mocks.detail,
}));
vi.mock("@/lib/shopping/repository", () => ({
  getPeriod: vi.fn(async () => null), listPantry: vi.fn(async () => []),
}));
vi.mock("@/lib/server/day-context", () => ({ loggedEntries: vi.fn(async () => []) }));
vi.mock("@/lib/recipes/slot-target", () => ({
  authoritativeSlotTarget: vi.fn(() => ({ kcal: 200, protein: 20, carbs: 20, fat: 5 })),
}));

const { previewShopping } = await import("@/lib/server/recipe-plan");

type Row = Record<string, unknown>;
/** A read-only PostgREST stand-in: equality and null filters only; range filters pass. */
function fakeClient(tables: Record<string, Row[]>): SupabaseClient {
  return { from(table: string) {
    const filters: [string, unknown][] = [];
    const rows = () => (tables[table] ?? []).filter((row) =>
      filters.every(([key, value]) => !(key in row) || row[key] === value));
    const builder: Record<string, unknown> = {
      select: () => builder, gte: () => builder, lte: () => builder, gt: () => builder,
      order: () => builder, limit: () => builder,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: rows(), error: null }),
    };
    return builder;
  } } as unknown as SupabaseClient;
}

const eligible = (partial: Parameters<typeof recipe>[0]) =>
  ({ ...recipe(partial), eligibility: { status: "eligible" as const, reasons: [] } });
const oats = eligible({ recipeId: "oats", revisionId: "oats-v1", name: "Overnight oats",
  dishTags: ["oats", "breakfast"], ingredients: [ingredient({ seq: 1, name: "oats" })] });
const bowl = eligible({ recipeId: "bowl", revisionId: "bowl-v1", name: "Steak bowl",
  dishTags: ["beef", "lunch"], ingredients: [ingredient({ seq: 1, name: "beef" })] });

const draft = (mealCoverage: string[]) => ({ startDate: "2026-10-01", endDate: "2026-10-02",
  timezone: "UTC", people: 1, mealCoverage, mode: "balanced" as const, effort: "standard" as const,
  maxActiveMinutes: null, variety: "balanced" as const, budgetAmount: null, currency: "USD",
  locale: "US-CO", lockMode: "none" as const });
const settings = (slotTimes: Record<string, string>) => ({
  recipe_plan_state: [{ rev: 1 }], recipe_plan_selections: [],
  user_settings: [{ meals_per_day: 3, diet_prefs: null, slot_times: slotTimes, shift_minutes: 0 }],
});

describe("previewShopping places coverage by the server schedule (Phase 17 O4)", () => {
  beforeEach(() => {
    mocks.candidates = [oats, bowl];
    mocks.storePreview.mockClear();
  });

  it("standard schedule: breakfast is meal-1 at 08:00 and gets the breakfast recipe", async () => {
    const result = await previewShopping(fakeClient(settings({})), "user-1",
      { draft: draft(["breakfast"]), basket: [] });
    expect(result.choices.map((row) => [row.localDate, row.slotId, row.recipeName])).toEqual([
      ["2026-10-01", "meal-1", "Overnight oats"], ["2026-10-02", "meal-1", "Overnight oats"]]);
  });

  it("meal-1 at 10:30 is lunch: lunch lands in meal-1 with the lunch recipe", async () => {
    const result = await previewShopping(fakeClient(settings({ "meal-1": "10:30", "meal-2": "15:30",
      "meal-3": "19:00" })), "user-1", { draft: draft(["lunch"]), basket: [] });
    expect(result.choices.map((row) => [row.slotId, row.recipeName])).toEqual([
      ["meal-1", "Steak bowl"], ["meal-1", "Steak bowl"]]);
    expect(result.blockingIssues).toEqual([]);
  });

  it("no breakfast-time slot: falls back to meal-1 and says so", async () => {
    const result = await previewShopping(fakeClient(settings({ "meal-1": "10:30", "meal-2": "15:30",
      "meal-3": "19:00" })), "user-1", { draft: draft(["breakfast"]), basket: [] });
    expect(result.choices.map((row) => row.slotId)).toEqual(["meal-1", "meal-1"]);
    expect(result.informationalIssues).toContain("No meal in your schedule falls at breakfast time on "
      + "2026-10-01, 2026-10-02; breakfast is planned in Meal 1 instead.");
  });

  it("a date's own time edit moves that day's occasion", async () => {
    const tables = { ...settings({}), plan_days: [{ user_id: "user-1", local_date: "2026-10-02",
      rev: 1, eaten_slots: {}, swaps: {}, item_overrides: { "meal-1": { baseMealId: null,
        components: [], followPlan: true, time: "11:00" } } }] };
    const result = await previewShopping(fakeClient(tables), "user-1",
      { draft: draft(["breakfast"]), basket: [] });
    // Meal 1 moved to 11:00 on the second day only: that day has no breakfast-time slot.
    expect(result.choices.map((row) => [row.localDate, row.slotId, row.recipeName])).toEqual([
      ["2026-10-01", "meal-1", "Overnight oats"], ["2026-10-02", "meal-1", "Steak bowl"]]);
    expect(result.informationalIssues).toContain("No meal in your schedule falls at breakfast time on "
      + "2026-10-02; breakfast is planned in Meal 1 instead.");
  });

  it("does not call a fallback planned when no recipe fills it", async () => {
    mocks.candidates = [];
    const result = await previewShopping(fakeClient(settings({ "meal-1": "10:30", "meal-2": "15:30",
      "meal-3": "19:00" })), "user-1", { draft: draft(["breakfast"]), basket: [] });
    expect(result.choices).toEqual([]);
    expect(result.informationalIssues).toContain("Breakfast is not planned on 2026-10-01, 2026-10-02: "
      + "no free meal in your schedule falls at breakfast time.");
    expect(result.informationalIssues.some((line) => line.includes("is planned in"))).toBe(false);
    // Review round 4 WARN 3: an unfilled slot is named by its meal, not a bare slot id.
    expect(result.blockingIssues.some((line) => line.startsWith("No lunch recipe fits Meal 1 on 2026-10-01: ")))
      .toBe(true);
    expect(result.blockingIssues.some((line) => line.includes("for meal-1"))).toBe(false);
  });

  it("names the meal on a saved-edit issue (review round 6 WARN 5)", async () => {
    const tables = { ...settings({ "meal-1": "10:30", "meal-2": "15:30", "meal-3": "19:00" }),
      plan_days: [{ user_id: "user-1", local_date: "2026-10-01", rev: 1, eaten_slots: {},
        swaps: { "meal-1": "swap-1" }, item_overrides: {} }] };
    const result = await previewShopping(fakeClient(tables), "user-1", { draft: draft(["lunch"]), basket: [] });
    expect(result.blockingIssues).toContain("Lunch (Meal 1) on 2026-10-01 has a saved edit or swap.");
  });
});
