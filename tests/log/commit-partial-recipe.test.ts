/**
 * #21 end to end through applyLogEntry: a serving of a partly measured saved recipe is WRITTEN
 * (logging marks, never refuses) and the answer names it in `partial_nutrition`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSuggestionEvidenceMock } = vi.hoisted(() => ({ loadSuggestionEvidenceMock: vi.fn() }));
vi.mock("@/lib/coach/suggest-policy", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/coach/suggest-policy")>(),
  loadSuggestionEvidence: loadSuggestionEvidenceMock,
}));
vi.mock("@/lib/server/log-duplicates", () => ({ recordFingerprint: vi.fn() }));
vi.mock("@/lib/server/day-totals", () => ({
  dayTotals: vi.fn(async () => ({ local_date: "2026-09-20", nutrients: [], micro_coverage_pct: 0 })),
}));

const { applyLogEntry } = await import("@/lib/server/log");

type Row = Record<string, unknown>;
const ENTRY = "00000000-0000-4000-8000-000000000001";
const ITEM = "00000000-0000-4000-8000-000000000002";
const REF = "00000000-0000-4000-8000-000000000003";
const RECIPE = "00000000-0000-4000-8000-000000000004";

function client(coverage: number, recipesFail: boolean | string = false, recorded: boolean | null = null) {
  const failing = recipesFail === true ? "recipes" : recipesFail || null;
  const rows: Record<string, Row[]> = {
    food_refs: [{ id: REF, user_food_id: RECIPE }],
    recipes: [{ id: RECIPE, rev: 1, recipe_revisions: [
      { rev: 1, nutrients_per_serving: { energy_kcal: 50, coverage } }] }],
    user_food_prefs: [], media_objects: [],
    log_items: [{ id: ITEM, entry_id: ENTRY, seq: 0, food_ref_id: REF, qty: 1, unit: "g",
      grams: 100, portion_id: null, food_revision_id: null, was_edited: false, confidence: null,
      snapshot: { energy_kcal: { amount: 50, unit: "kcal" } }, nutrition_partial: recorded }],
  };
  const rpc = vi.fn(async (name: string) => name === "apply_sync_op"
    ? { data: { status: "applied", rev: 1 }, error: null } : { data: null, error: null });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    let columns = "";
    Object.assign(chain, {
      // Other readers of food_refs stay up; only the coverage read (it asks for the kind) fails.
      select: (cols = "") => { columns = cols; return chain; }, eq: () => chain, in: () => chain, is: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(
        table === failing && (table !== "food_refs" || columns.includes("user_foods(kind)"))
          ? { data: null, error: { message: "down" } }
          : { data: rows[table] ?? [], error: null }).then(resolve),
    });
    return chain;
  });
  return { client: { from, rpc } as never, rpc };
}

const body = {
  entry_id: ENTRY, eaten_at: "2026-09-20T12:00:00.000Z", tz: "UTC", local_date: "2026-09-20",
  slot: "meal-2", method: "search",
  items: [{ id: ITEM, seq: 0, food_ref_id: REF, qty: 1, unit: "g", grams: 100 }],
};

describe("committing a serving of a partly measured recipe", () => {
  beforeEach(() => {
    loadSuggestionEvidenceMock.mockReset().mockResolvedValue({
      status: "unavailable", preferenceFlags: [], byIdentity: {} });
  });

  it("writes the entry and names the item partial", async () => {
    const { client: db, rpc } = client(0.5);
    const result = await applyLogEntry(db, "user-1", body);
    expect(rpc).toHaveBeenCalledWith("apply_sync_op", expect.anything());
    expect(result).toMatchObject({ status: "ok", partial_nutrition: [
      { path: "items.0", item_id: ITEM, seq: 0, food_ref_id: REF, coverage: 0.5, source: "derived" }] });
  });

  it("names nothing for a fully measured recipe", async () => {
    const result = await applyLogEntry(client(1).client, "user-1", body);
    expect(result).toMatchObject({ status: "ok" });
    expect(result).not.toHaveProperty("partial_nutrition");
  });

  it("answers from the item's recorded flag, not the recipe's current revision", async () => {
    // The recipe is complete now (coverage 1), but the stored item was written partial.
    const marked = await applyLogEntry(client(1, true, true).client, "user-1", body);
    expect(marked).toMatchObject({ status: "ok", partial_nutrition: [{ item_id: ITEM, source: "recorded" }] });
    // Recorded whole: no mark even though the recipe is partial now.
    const whole = await applyLogEntry(client(0.5, false, false).client, "user-1", body);
    expect(whole).not.toHaveProperty("partial_nutrition");
  });

  it("calls nothing partial when the food refs are unreadable, and says the entry is unchecked", async () => {
    const result = await applyLogEntry(client(0.5, "food_refs").client, "user-1", body);
    expect(result).toMatchObject({ status: "ok", nutrition_unchecked: true });
    expect(result).not.toHaveProperty("partial_nutrition");
  });

  it("still answers ok, marking the item unchecked, when the recipe read fails after the write", async () => {
    const result = await applyLogEntry(client(0.5, true).client, "user-1", body);
    expect(result).toMatchObject({ status: "ok", partial_nutrition: [{ item_id: ITEM, coverage: null, source: "unchecked" }] });
  });
});
