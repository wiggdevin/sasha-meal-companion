/**
 * Phase 13 §9 R1: "I checked this product's label" marks the EXACT product — a catalog ref's active
 * revision, a user food's current rev — for every allergen the account avoids, on the caller's own
 * client. A later revision is a different product and needs its own check.
 */
import { describe, expect, it, vi } from "vitest";
import { markLabelChecked } from "@/lib/server/allergen-evidence";

function client(tables: Record<string, unknown[]>) {
  const writes: { table: string; op: string; value: unknown; filters?: [string, unknown][] }[] = [];
  const from = (table: string) => {
    // Shared by reference with whatever `writes` entry a terminal op (here, `delete`) already
    // pushed, so a filter chained AFTER it (`.delete().eq(...).in(...)`, the real call shape)
    // still lands on that same recorded entry.
    const filters: [string, unknown][] = [];
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      in: (column: string, values: unknown) => { filters.push([column, values]); return chain; },
      eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      upsert: vi.fn(async (value: unknown) => { writes.push({ table, op: "upsert", value });
        return { error: null }; }),
      delete: () => { writes.push({ table, op: "delete", value: null, filters }); return chain; },
    });
    return chain;
  };
  return { client: { from } as never, writes };
}

const CATALOG_REF = "3f1b1a2c-0000-4000-8000-0000000000c1";
const USER_REF = "3f1b1a2c-0000-4000-8000-0000000000u1";

describe("markLabelChecked", () => {
  it("checks the active catalog revision and the user food's current rev for every avoided allergen",
    async () => {
      const { client: db, writes } = client({
        food_refs: [
          { id: CATALOG_REF, kind: "catalog", catalog_food_id: 41, user_food_id: null },
          { id: USER_REF, kind: "user", catalog_food_id: null,
            user_food_id: "11111111-1111-4111-8111-111111111111" },
        ],
        catalog_food_revisions: [{ id: 410, catalog_food_id: 41 }],
        user_foods: [{ id: "11111111-1111-4111-8111-111111111111", rev: 3 }],
      });
      const result = await markLabelChecked(db, "u1", [CATALOG_REF, USER_REF],
        ["Gluten ", "milk"], true);
      expect(result).toEqual({
        foodKeys: ["catalog_revision:410", "user_food:11111111-1111-4111-8111-111111111111:3"],
        allergens: ["gluten", "dairy"], stale: [],
      });
      expect(writes).toEqual([{ table: "user_allergen_checks", op: "upsert", value: [
        { user_id: "u1", food_key: "catalog_revision:410", allergen: "gluten" },
        { user_id: "u1", food_key: "catalog_revision:410", allergen: "dairy" },
        { user_id: "u1", food_key: "user_food:11111111-1111-4111-8111-111111111111:3",
          allergen: "gluten" },
        { user_id: "u1", food_key: "user_food:11111111-1111-4111-8111-111111111111:3",
          allergen: "dairy" },
      ] }]);
    });

  it("clears the mark when unchecked", async () => {
    const { client: db, writes } = client({
      food_refs: [{ id: CATALOG_REF, kind: "catalog", catalog_food_id: 41, user_food_id: null }],
      catalog_food_revisions: [{ id: 410, catalog_food_id: 41 }],
    });
    await markLabelChecked(db, "u1", [CATALOG_REF], ["gluten"], false);
    expect(writes).toEqual([{ table: "user_allergen_checks", op: "delete", value: null,
      filters: [["user_id", "u1"], ["food_key", ["catalog_revision:410"]], ["allergen", ["gluten"]]] }]);
  });

  it("sol FIX (review round 1, finding #5): clearing one allergen must not delete a check " +
    "recorded for a DIFFERENT avoided allergen on the same food", async () => {
    const { client: db, writes } = client({
      food_refs: [{ id: CATALOG_REF, kind: "catalog", catalog_food_id: 41, user_food_id: null }],
      catalog_food_revisions: [{ id: 410, catalog_food_id: 41 }],
    });
    // The account avoids both gluten and dairy; only gluten's check is being cleared here (e.g.
    // the account dropped gluten from its avoid list). A previously recorded dairy check on this
    // same food must survive — the delete has to be scoped to `allergen IN ('gluten')`, not just
    // this food's key.
    await markLabelChecked(db, "u1", [CATALOG_REF], ["gluten"], false);
    const write = writes.find((w) => w.table === "user_allergen_checks" && w.op === "delete")!;
    const allergenFilter = write.filters?.find(([column]) => column === "allergen");
    expect(allergenFilter).toEqual(["allergen", ["gluten"]]);
  });

  it("writes nothing for an account that avoids no allergen, or refs it cannot see", async () => {
    const { client: db, writes } = client({ food_refs: [] });
    await expect(markLabelChecked(db, "u1", [CATALOG_REF], ["gluten"], true))
      .resolves.toEqual({ foodKeys: [], allergens: ["gluten"], stale: [] });
    expect(writes).toEqual([]);
  });

  describe("exact-product binding: a catalog ref's active revision may have moved since the " +
    "caller last saw it (finding #6)", () => {
    it("skips (and reports stale) a ref whose active revision no longer matches what the caller " +
      "observed, rather than silently marking whatever product is active now", async () => {
      const { client: db, writes } = client({
        food_refs: [{ id: CATALOG_REF, kind: "catalog", catalog_food_id: 41, user_food_id: null }],
        // A background refresh replaced the active revision (410 → 999) between the scan the user
        // read and this check.
        catalog_food_revisions: [{ id: 999, catalog_food_id: 41 }],
      });
      const result = await markLabelChecked(db, "u1", [CATALOG_REF], ["gluten"], true,
        { [CATALOG_REF]: 410 });
      expect(result).toEqual({ foodKeys: [], allergens: ["gluten"], stale: [CATALOG_REF] });
      expect(writes).toEqual([]);
    });

    it("checks the ref when the expected revision still matches the active one", async () => {
      const { client: db, writes } = client({
        food_refs: [{ id: CATALOG_REF, kind: "catalog", catalog_food_id: 41, user_food_id: null }],
        catalog_food_revisions: [{ id: 410, catalog_food_id: 41 }],
      });
      const result = await markLabelChecked(db, "u1", [CATALOG_REF], ["gluten"], true,
        { [CATALOG_REF]: 410 });
      expect(result).toEqual({ foodKeys: ["catalog_revision:410"], allergens: ["gluten"], stale: [] });
      expect(writes).toEqual([{ table: "user_allergen_checks", op: "upsert", value: [
        { user_id: "u1", food_key: "catalog_revision:410", allergen: "gluten" },
      ] }]);
    });

    it("checks the ref as before when the caller states no expectation (backward compatible)",
      async () => {
        const { client: db } = client({
          food_refs: [{ id: CATALOG_REF, kind: "catalog", catalog_food_id: 41, user_food_id: null }],
          catalog_food_revisions: [{ id: 410, catalog_food_id: 41 }],
        });
        const result = await markLabelChecked(db, "u1", [CATALOG_REF], ["gluten"], true);
        expect(result).toEqual({ foodKeys: ["catalog_revision:410"], allergens: ["gluten"], stale: [] });
      });

    it("r4 BLOCK #7 (reproduced): a user-food ref carries the same staleness risk as a catalog " +
      "one — an edit can advance its rev between the caller's read and this write", async () => {
      const { client: db, writes } = client({
        food_refs: [{ id: USER_REF, kind: "user", catalog_food_id: null,
          user_food_id: "11111111-1111-4111-8111-111111111111" }],
        // An edit bumped rev 3 → 4 between the caller's read and this write.
        user_foods: [{ id: "11111111-1111-4111-8111-111111111111", rev: 4 }],
      });
      const result = await markLabelChecked(db, "u1", [USER_REF], ["gluten"], true,
        { [USER_REF]: 3 });
      expect(result).toEqual({ foodKeys: [], allergens: ["gluten"], stale: [USER_REF] });
      expect(writes).toEqual([]);
    });

    it("checks a user-food ref when the expected rev still matches the current one", async () => {
      const { client: db } = client({
        food_refs: [{ id: USER_REF, kind: "user", catalog_food_id: null,
          user_food_id: "11111111-1111-4111-8111-111111111111" }],
        user_foods: [{ id: "11111111-1111-4111-8111-111111111111", rev: 3 }],
      });
      const result = await markLabelChecked(db, "u1", [USER_REF], ["gluten"], true,
        { [USER_REF]: 3 });
      expect(result).toEqual({
        foodKeys: ["user_food:11111111-1111-4111-8111-111111111111:3"],
        allergens: ["gluten"], stale: [],
      });
    });
  });

  describe("finding: shellfish must also cover the crustacean-specific evidence key (§9 R9's " +
    "own withCrustaceanAllowance — every other JUDGE/RECORD caller expands it, this one did not)",
    () => {
      it("records a crustacean check alongside shellfish when the account avoids shellfish",
        async () => {
          const { client: db, writes } = client({
            food_refs: [{ id: CATALOG_REF, kind: "catalog", catalog_food_id: 41,
              user_food_id: null }],
            catalog_food_revisions: [{ id: 410, catalog_food_id: 41 }],
          });
          const result = await markLabelChecked(db, "u1", [CATALOG_REF], ["Shellfish"], true);
          expect(result).toEqual({
            foodKeys: ["catalog_revision:410"], allergens: ["shellfish", "crustacean"], stale: [],
          });
          expect(writes).toEqual([{ table: "user_allergen_checks", op: "upsert", value: [
            { user_id: "u1", food_key: "catalog_revision:410", allergen: "shellfish" },
            { user_id: "u1", food_key: "catalog_revision:410", allergen: "crustacean" },
          ] }]);
        });

      it("clears the crustacean mark too when unchecking a shellfish avoider's product", async () => {
        const { client: db, writes } = client({
          food_refs: [{ id: CATALOG_REF, kind: "catalog", catalog_food_id: 41,
            user_food_id: null }],
          catalog_food_revisions: [{ id: 410, catalog_food_id: 41 }],
        });
        await markLabelChecked(db, "u1", [CATALOG_REF], ["shellfish"], false);
        expect(writes).toEqual([{ table: "user_allergen_checks", op: "delete", value: null,
          filters: [["user_id", "u1"], ["food_key", ["catalog_revision:410"]],
            ["allergen", ["shellfish", "crustacean"]]] }]);
      });
    });
});
