/**
 * sol BLOCK (r5): §9 R2 — "client-created custom foods migrate to no_evidence" — is enforced by
 * the WARM path (lib/foods/facet-warm.ts: `labelComplete: row.kind === "label_scan" && ...`), but
 * `searchExactUserFood`'s live read exposed the same `ingredients_text` for every kind, with no
 * signal telling the policy's live derivation (lib/policy/allergens.ts allergenFinding) that a
 * "custom" food's own editable text is not a printed label at all. A self-authored ingredient
 * list that happens to read as complete could clear a major allergen with no label ever checked.
 */
import { describe, expect, it, vi } from "vitest";
import { searchExactUserFood } from "@/lib/server/coach-ports";

function admin(row: Record<string, unknown>) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "is", "ilike", "limit", "in", "order", "range"]) chain[m] = vi.fn(self);
    chain.maybeSingle = vi.fn(async () => table === "user_foods" ? { data: row, error: null }
      : table === "user_food_prefs" ? { data: null, error: null }
      : { data: null, error: null });
    return chain;
  });
  const rpc = vi.fn(async () => ({ data: "ref-1", error: null }));
  return { from, rpc } as never;
}

const BASE_ROW = {
  id: "user-food-1", name: "Grandma's chili", brand: null,
  per_100g: { energy_kcal: 200 }, allergen_tags: [], rev: 1,
  ingredients_text: "Water, sugar, salt, dried beans.",
};

describe("searchExactUserFood: a custom food's own text is never a label", () => {
  it("marks a client-created custom food's ingredient text as not a label", async () => {
    const hit = await searchExactUserFood(admin({ ...BASE_ROW, kind: "custom" }), "u1", "chili");
    expect(hit).toMatchObject({
      ingredientsText: "Water, sugar, salt, dried beans.", ingredientsTextIsLabel: false,
    });
  });

  it("keeps a scanned label's own text eligible to clear a major allergen by completeness",
    async () => {
      const hit = await searchExactUserFood(
        admin({ ...BASE_ROW, kind: "label_scan" }), "u1", "chili",
      );
      expect(hit).toMatchObject({
        ingredientsText: "Water, sugar, salt, dried beans.", ingredientsTextIsLabel: true,
      });
    });
});

/** 2026-10-02 DeepSeek audit, round 4 (#1): the coach lanes read a stored label scan as a plain
 *  whole food, because this was the one FoodHit producer that never set `packaged`. */
describe("searchExactUserFood: packaged", () => {
  it("marks a label scan packaged, whatever its brand reads", async () => {
    const hit = await searchExactUserFood(admin({ ...BASE_ROW, name: "Chicken breast", kind: "label_scan" }), "u1", "chicken breast");
    expect(hit).toMatchObject({ packaged: true });
  });

  it("leaves a client-created custom food unpackaged", async () => {
    const hit = await searchExactUserFood(admin({ ...BASE_ROW, kind: "custom" }), "u1", "chili");
    expect(hit).toMatchObject({ packaged: false });
  });
});
