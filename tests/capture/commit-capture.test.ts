import { labelFoodIdFor } from "@/lib/log/op-id";
import { describe, expect, it, vi } from "vitest";
import { NUTRIENT_CODES } from "@/lib/nutrients/codes";
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/server/log-label-food";
import { applyLogEntry } from "@/lib/server/log";

const PER_100G = Object.fromEntries(NUTRIENT_CODES.map((code) => [code, null])) as
  Record<string, number | null>;
PER_100G.energy_kcal = 60;
PER_100G.protein = 0.4;
const REQ = {
  entry_id: "11111111-1111-4111-8111-111111111111",
  eaten_at: "2026-09-11T16:00:00.000Z", tz: "UTC", local_date: "2026-09-11",
  slot: "meal-1", method: "label", draft_id: "22222222-2222-4222-8222-222222222222",
  save_label_as_food: true,
  items: [{ id: "33333333-3333-4333-8333-333333333333", seq: 0,
    food_ref_id: LABEL_FOOD_PLACEHOLDER_REF, qty: 1, unit: "whole", grams: 90 }],
};
const LABEL = { name: "Pear pouch", brand: "Serenity", per100g: PER_100G,
  ingredientsText: "pear", allergenTags: [] };

function fakeDb(opts: { media?: { path: string }[]; existingEntry?: boolean;
  profile?: Record<string, unknown> | null } = {}) {
  const writes: { table: string; row: unknown }[] = [];
  const removed: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    if (name === "get_or_create_food_ref") return { data: "ref-new", error: null };
    if (opts.existingEntry) return { data: { status: "duplicate", rev: 1 }, error: null };
    return { data: { status: "applied", rev: 1 }, error: null };
  });
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["eq", "order", "like"]) chain[m] = vi.fn(self);
    chain.select = vi.fn(() => {
      if (table === "media_objects") return { ...chain,
        eq: vi.fn(() => ({ ...chain, like: vi.fn(async () => ({ data: opts.media ?? [], error: null })) })) };
      return chain;
    });
    // Echoes back whatever ids unknownRefIssues asks about as known: these tests exercise the
    // label-save and media-delete paths, not ref validation, so every ref (swapped or not) resolves.
    chain.in = vi.fn(async (_col: string, ids: string[]) => ({ data: ids.map((id) => ({ id })), error: null }));
    chain.insert = vi.fn((row: unknown) => ({ select: () => ({ single: async () => {
      writes.push({ table, row }); return { data: { id: "uf-1" }, error: null }; } }) }));
    chain.update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
    chain.maybeSingle = vi.fn(async () => {
      if (table === "constraint_profiles") return { data: opts.profile ?? null, error: null };
      if (opts.existingEntry && table === "log_entries") return { data: { id: REQ.entry_id }, error: null };
      if (opts.existingEntry && table === "log_items") return { data: { food_ref_id: "ref-existing" }, error: null };
      return { data: null, error: null };
    });
    return chain;
  });
  const storage = { from: () => ({ remove: vi.fn(async (keys: string[]) => {
    removed.push(...keys); return { error: null }; }) }) };
  return { writes, removed, rpc, client: { rpc, from, storage } as never };
}

describe("applyLogEntry with a label capture", () => {
  it("creates the label food, swaps the placeholder ref and reports the new id", async () => {
    const db = fakeDb();
    const out = await applyLogEntry(db.client, "u1", REQ, { admin: db.client, labelFood: LABEL });
    expect(out.status).toBe("ok");
    // W017 A036: the food's id is named by the account and the entry, so a retry meets it.
    const id = labelFoodIdFor("u1", REQ.entry_id);
    expect(out.status === "ok" && out.user_food_id).toBe(id);
    expect(db.rpc).toHaveBeenCalledWith("get_or_create_food_ref",
      { p_user_id: "u1", p_kind: "user", p_catalog_food_id: null, p_user_food_id: id });
  });

  it("refuses save_label_as_food with no label_food rather than writing an empty food", async () => {
    const db = fakeDb();
    const out = await applyLogEntry(db.client, "u1", REQ, { admin: db.client });
    expect(out).toMatchObject({ status: "invalid" });
  });

  it("refuses a label_food whose per100g is missing a nutrient code", async () => {
    const db = fakeDb();
    const incomplete = Object.fromEntries(
      Object.entries(PER_100G).filter(([code]) => code !== "energy_kcal_calc"));
    const out = await applyLogEntry(db.client, "u1", REQ,
      { admin: db.client, labelFood: { ...LABEL, per100g: incomplete } });
    expect(out).toMatchObject({ status: "invalid" });
  });

  it("stores allergen_tags as the union of the client's tags and ones read off the ingredients", async () => {
    // A profile that avoids nothing: the default profile bans apple, and this test is about the
    // union logic, not the constraint policy (that is tests/capture/commit-policy.test.ts).
    const db = fakeDb({ profile: { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], custom_rules: [] } });
    await applyLogEntry(db.client, "u1", REQ, { admin: db.client,
      labelFood: { ...LABEL, ingredientsText: "apple, water", allergenTags: [] } });
    const write = db.writes.find((w) => w.table === "user_foods");
    expect((write?.row as { allergen_tags: string[] }).allergen_tags).toEqual(["apple"]);
  });

  // sol BLOCK (review round 1, phase 13 slice 2): the stored tags used to come from
  // allergenTagsFromIngredients (lib/capture/propose.ts), a scanner limited to gluten, dairy and
  // apple — a peanut-naming label saved no peanut tag at all, even though the client sent none
  // either. Persisted allergen_tags must carry every allergen the printed text actually names.
  it("stores a peanut tag read off the ingredients even when the client sent none", async () => {
    const db = fakeDb({ profile: { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], custom_rules: [] } });
    await applyLogEntry(db.client, "u1", REQ, { admin: db.client,
      labelFood: { ...LABEL, ingredientsText: "peanuts, raisins, almonds", allergenTags: [] } });
    const write = db.writes.find((w) => w.table === "user_foods");
    expect((write?.row as { allergen_tags: string[] }).allergen_tags).toContain("peanut");
  });

  it("deletes our media copy for the derived path after a successful apply", async () => {
    const db = fakeDb({ media: [{ path: "media/u1/22222222-2222-4222-8222-222222222222.jpg" }] });
    await applyLogEntry(db.client, "u1", REQ, { admin: db.client, labelFood: LABEL });
    expect(db.removed).toEqual(["u1/22222222-2222-4222-8222-222222222222.jpg"]);
  });

  it("does not create a second label food when the same entry is committed again", async () => {
    const db = fakeDb({ existingEntry: true });
    const out = await applyLogEntry(db.client, "u1", REQ, { admin: db.client, labelFood: LABEL });
    expect(out).toMatchObject({ status: "ok" });
    expect(out.status === "ok" && "user_food_id" in out).toBe(false);
    expect(db.rpc).not.toHaveBeenCalledWith("get_or_create_food_ref", expect.anything());
    expect(db.writes).toEqual([]);
  });

  it("refuses save_label_as_food when no item carries the placeholder ref", async () => {
    const db = fakeDb();
    const out = await applyLogEntry(db.client, "u1", {
      ...REQ, items: [{ ...REQ.items[0], food_ref_id: "44444444-4444-4444-8444-444444444444" }],
    }, { admin: db.client, labelFood: LABEL });
    expect(out).toMatchObject({ status: "invalid" });
    expect(db.writes).toEqual([]);
  });

  it("leaves a search commit untouched: no label insert, no media delete", async () => {
    const db = fakeDb();
    const out = await applyLogEntry(db.client, "u1", {
      ...REQ, method: "search", draft_id: undefined, save_label_as_food: undefined,
      items: [{ ...REQ.items[0], food_ref_id: "44444444-4444-4444-8444-444444444444" }],
    }, { admin: db.client });
    expect(out.status).toBe("ok");
    expect(db.removed).toEqual([]);
  });
});
