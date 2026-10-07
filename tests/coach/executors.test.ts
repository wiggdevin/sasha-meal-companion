import { describe, expect, it, vi } from "vitest";
import { makeExecutors } from "@/lib/coach/executors";
import { TOOL_NAMES } from "@/lib/coach/registry";

const ports = () => ({
  dayTotals: vi.fn(async (_u: string, d: string) => ({ local_date: d, nutrients: [] })),
  weekTotals: vi.fn(async () => []),
  activeTargets: vi.fn(async () => ({ kcal_train: 2200 })),
  latestEstimate: vi.fn(async () => ({ status: "burn_in", tdeeKcal: null })),
  searchFoods: vi.fn(async (_u: string, q: string) => [
    { foodRefId: "3f1b1a2c-0000-4000-8000-00000000000a", name: q, brand: null,
      kcalPer100g: 130, prefStatus: "eats" as const },
  ]),
  getConstraints: vi.fn(async () => ({ avoid_allergens: ["gluten"] })),
  recentGut: vi.fn(async () => [{ local_date: "2026-09-10", state: "iffy", note: "raw onion" }]),
  dayPlan: vi.fn(async () => ({ slots: [] })),
  recipes: vi.fn(async () => []),
  compose: vi.fn(async () => ({ wish: "", slot: null, items: [],
    totals: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    target: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, flagged: [], fitsTarget: false })),
  suggest: vi.fn(async () => []),
  dayEntries: vi.fn(async () => []),
  lookup: vi.fn(async (_u: string, subject: string) => ({
    ok: true as const, subject, resolvedName: subject, foodRefId: null, brand: null,
    answer: "", sources: [], webSearchQueries: 0,
    evidence: { level: "no_evidence" as const, labelComplete: false },
  })),
  newDraftId: () => "draft-1",
});

describe("makeExecutors", () => {
  it("covers every registry tool and nothing else", () => {
    expect(Object.keys(makeExecutors(ports())).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("passes userId from the closure argument, never from args", async () => {
    const p = ports();
    await makeExecutors(p).get_day("user-a", { date: "2026-09-11", userId: "user-b" });
    expect(p.dayTotals).toHaveBeenCalledWith("user-a", "2026-09-11");
  });

  it("passes suggestion inputs to the read-only server port", async () => {
    const p = ports();
    await makeExecutors(p).suggest_options("user-a", {
      kind: "snack", count: 5, fitRemaining: true,
    });
    expect(p.suggest).toHaveBeenCalledWith("user-a", {
      kind: "snack", count: 5, fitRemaining: true,
    });
  });

  it("builds a draft in memory and calls no write port", async () => {
    const p = ports();
    const result = await makeExecutors(p).draft_log_entry("user-a", {
      slot: "meal-2", items: [{ name: "white rice", grams: 150 }],
    }) as { draft: { draftId: string; items: unknown[] }; dropped: string[] };
    expect(result.draft.draftId).toBe("draft-1");
    expect(result.draft.items).toHaveLength(1);
    expect(result.dropped).toEqual([]);
    expect(Object.keys(p)).not.toContain("commit");
  });

  it("drops an item it cannot ground rather than inventing a food ref", async () => {
    const p = ports();
    p.searchFoods = vi.fn(async () => []);
    const result = await makeExecutors(p).draft_log_entry("user-a", {
      slot: "meal-1", items: [{ name: "unicorn steak", grams: 100 }],
    }) as { draft: unknown; dropped: string[] };
    expect(result.draft).toBeNull();
    expect(result.dropped).toEqual(["unicorn steak"]);
  });

  it("defaults get_recent_gut_log to 14 days and clamps search limit", async () => {
    const p = ports();
    const e = makeExecutors(p);
    await e.get_recent_gut_log("user-a", {});
    expect(p.recentGut).toHaveBeenCalledWith("user-a", 14);
    await e.search_foods("user-a", { query: "rice" });
    expect(p.searchFoods).toHaveBeenCalledWith("user-a", "rice", 5);
  });

  it("hands a search hit's allergen evidence through to the caller unchanged", async () => {
    const searchFoods = vi.fn(async (_u: string, q: string) => [
      { foodRefId: "3f1b1a2c-0000-4000-8000-00000000000c", name: q, brand: null,
        kcalPer100g: null, prefStatus: null, allergenTags: ["dairy"], category: null },
    ]);
    const hits = await makeExecutors({ ...ports(), searchFoods })
      .search_foods("user-a", { query: "cheese" }) as
      { name: string; allergenTags: string[] | null }[];
    expect(hits[0]).toMatchObject({ name: "cheese", allergenTags: ["dairy"] });
  });
});
