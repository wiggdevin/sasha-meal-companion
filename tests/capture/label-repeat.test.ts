/**
 * W124: a label scanned twice is one food. The second scan of the same product (same brand, name
 * and per-100 g, read a little differently) reuses the first scan's user_foods row and its ref;
 * a different product, or a rescan naming an allergen the saved food lacks, saves its own.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { NUTRIENT_CODES } from "@/lib/nutrients/codes";
import type { LogCommitRequest } from "@/lib/log/contract";
import {
  commitLabelFood, LABEL_FOOD_PLACEHOLDER_REF, labelKey, sameLabelFood, type LabelFoodInput,
} from "@/lib/server/log-label-food";

type Row = Record<string, unknown>;

function per100g(over: Record<string, number | null>): LabelFoodInput["per100g"] {
  const base = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, null])) as Record<string, number | null>;
  return { ...base, ...over } as LabelFoodInput["per100g"];
}

const BAR: LabelFoodInput = {
  name: "Peanut Butter Bar", brand: "Trail Co",
  per100g: per100g({ energy_kcal: 450, protein: 20, carbohydrate: 45, fat_total: 22 }),
  ingredientsText: "oats, peanuts, honey", allergenTags: [],
};

/** user_foods kept in memory: inserts land in the table, so a second scan can find the first. */
function db() {
  const foods: Row[] = [];
  const inserts: Row[] = [];
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "order"]) chain[m] = () => chain;
    chain.limit = async () => ({ data: table === "user_foods" ? foods : [], error: null });
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.insert = (row: Row) => ({ select: () => ({ single: async () => {
      inserts.push(row); foods.push({ ...row, deleted_at: null });
      return { data: { id: row.id }, error: null };
    } }) });
    return chain;
  });
  const rpc = vi.fn(async (_name: string, args: { p_user_food_id: string }) =>
    ({ data: `ref-${args.p_user_food_id}`, error: null }));
  return { foods, inserts, client: { from, rpc } as unknown as SupabaseClient };
}

function request(entryId: string): LogCommitRequest {
  return {
    entry_id: entryId, eaten_at: "2026-10-17T12:00:00.000Z", tz: "UTC", local_date: "2026-10-17",
    slot: "meal-1", method: "label", draft_id: "22222222-2222-4222-8222-222222222222",
    save_label_as_food: true,
    items: [{ id: `${entryId.slice(0, 35)}9`, seq: 1, food_ref_id: LABEL_FOOD_PLACEHOLDER_REF,
      qty: 40, unit: "g", grams: 40, portion_id: null, food_revision_id: null, was_edited: false }],
  } as LogCommitRequest;
}

describe("label scan dedupe (W124)", () => {
  it("makes one food when the same label is scanned twice", async () => {
    const store = db();
    const first = request("11111111-1111-4111-8111-111111111111");
    const second = request("11111111-1111-4111-8111-222222222222");
    const one = await commitLabelFood(store.client, "u1", first, BAR);
    // The second read of the panel differs by a rounding and in case and spacing.
    const reread: LabelFoodInput = { ...BAR, name: "peanut  butter bar", brand: "TRAIL CO",
      per100g: per100g({ energy_kcal: 452, protein: 20.2, carbohydrate: 45, fat_total: 22 }) };
    const two = await commitLabelFood(store.client, "u1", second, reread);
    expect(store.inserts).toHaveLength(1);
    expect(one.userFoodId).toBe(store.inserts[0].id);
    expect(two.userFoodId).toBeUndefined();
    expect(second.items[0].food_ref_id).toBe(first.items[0].food_ref_id);
  });

  it("saves a new food for another product", async () => {
    const store = db();
    await commitLabelFood(store.client, "u1", request("11111111-1111-4111-8111-111111111111"), BAR);
    await commitLabelFood(store.client, "u1", request("11111111-1111-4111-8111-222222222222"),
      { ...BAR, per100g: per100g({ energy_kcal: 380, protein: 20, carbohydrate: 45, fat_total: 22 }) });
    await commitLabelFood(store.client, "u1", request("11111111-1111-4111-8111-333333333333"),
      { ...BAR, brand: "Other Co" });
    expect(store.inserts).toHaveLength(3);
  });

  it("never reuses a saved food that lacks an allergen the rescan names", async () => {
    const store = db();
    await commitLabelFood(store.client, "u1", request("11111111-1111-4111-8111-111111111111"),
      { ...BAR, ingredientsText: "oats, honey" });
    await commitLabelFood(store.client, "u1", request("11111111-1111-4111-8111-222222222222"), BAR);
    expect(store.inserts).toHaveLength(2);
  });

  it("treats a core code read on one scan and missing on the other as a different food", () => {
    const row = { id: "f1", name: BAR.name, brand: BAR.brand ?? null, allergen_tags: ["peanut"],
      per_100g: { ...BAR.per100g, protein: null } as Record<string, number | null> };
    expect(sameLabelFood(BAR, ["peanut"], row)).toBe(false);
    expect(sameLabelFood(BAR, ["peanut"], { ...row, per_100g: BAR.per100g as never })).toBe(true);
    expect(labelKey("  Ｔrail\tCo ")).toBe("trail co");
  });
});
