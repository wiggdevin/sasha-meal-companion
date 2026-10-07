/**
 * The constraint-policy half of applyLogEntry (contracts §9a(d)) — a fake Supabase client, no
 * network. Everything else applyLogEntry does (idempotency, conflicts, totals) is covered by
 * tests/log/commit.test.ts against a real branch; this file only proves the policy gate: a
 * blocked item is MARKED rather than refused (2026-09-14 ruling), an item with no evidence passes
 * as unverified, and confidence reaches the apply_sync_op payload.
 */
import { describe, expect, it } from "vitest";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";
import { entryFingerprint } from "@/lib/sync/fingerprint";
import { toBytea } from "@/lib/server/tokens";
import { LABEL_FOOD_PLACEHOLDER_REF } from "./log-label-food";
import { DRAFT_ID, ENTRY_ID, fakeClient, ITEM_ID, PER_100G, REF_A, req } from "@/tests/helpers/log-fake-client";
import { RULES_UNREADABLE_MESSAGE } from "@/lib/coach/log-policy";
import { applyLogEntry } from "./log";

/**
 * The account's own rules, as its `constraint_profiles` row. They used to be a constant in code;
 * since D1 §6.1 (PRD R2) the row is the only place a restriction exists, so a case that proves
 * blocking seeds the row `loadConstraintProfile` actually reads (lib/server/log.ts:124). The cases
 * that assert an item she eats, an avoid-listed item or a no-evidence item is not blocked by an
 * allergen keep no row — and the mark they do expect (`avoid_list`) comes from `user_food_prefs`.
 */
const RULES = { user_id: "u1", custom_rules: [], ...TEST_PROFILE };

describe("applyLogEntry — constraint policy (contracts §9a(d))", () => {
  it("marks an item whose catalog ingredients carry gluten, and still records it", async () => {
    const db = fakeClient({
      tables: {
        // The ref has to exist now: the write path is reached, so the unknown-ref check runs. It
        // used to be unreachable because the policy refused first.
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }],
        catalog_food_revisions: [{ id: 10, catalog_food_id: 7, is_active: true }],
        catalog_ingredients: [{ food_revision_id: 10, allergen_tags: ["gluten"] }],
        constraint_profiles: [RULES],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1", req([{ id: ITEM_ID, seq: 1,
      food_ref_id: REF_A, qty: 1, unit: "g", grams: 100, food_revision_id: 10 }]));
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: "blocked:allergen:gluten" }]);
  });

  it("marks an item whose catalog ingredients carry dairy, and still records it", async () => {
    const db = fakeClient({
      tables: {
        // The ref has to exist now: the write path is reached, so the unknown-ref check runs. It
        // used to be unreachable because the policy refused first.
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }],
        catalog_food_revisions: [{ id: 11, catalog_food_id: 7, is_active: true }],
        catalog_ingredients: [{ food_revision_id: 11, allergen_tags: ["dairy"] }],
        constraint_profiles: [RULES],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1", req([{ id: ITEM_ID, seq: 1,
      food_ref_id: REF_A, qty: 1, unit: "g", grams: 100, food_revision_id: 11 }]));
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: "blocked:allergen:dairy" }]);
  });

  it("marks an item whose catalog ingredients carry apple, and still records it", async () => {
    const db = fakeClient({
      tables: {
        // The ref has to exist now: the write path is reached, so the unknown-ref check runs. It
        // used to be unreachable because the policy refused first.
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }],
        catalog_food_revisions: [{ id: 12, catalog_food_id: 7, is_active: true }],
        catalog_ingredients: [{ food_revision_id: 12, allergen_tags: ["apple"] }],
        constraint_profiles: [RULES],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1", req([{ id: ITEM_ID, seq: 1,
      food_ref_id: REF_A, qty: 1, unit: "g", grams: 100, food_revision_id: 12 }]));
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: "blocked:allergen:apple" }]);
  });

  it("marks an avoid-listed item and still records it — never refuses (2026-09-14)", async () => {
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }],
        catalog_food_revisions: [{ id: 13, catalog_food_id: 7, is_active: true }],
        catalog_ingredients: [{ food_revision_id: 13, allergen_tags: [] }],
        user_food_prefs: [{ food_ref_id: REF_A, status: "avoid" }],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1", req([{ id: ITEM_ID, seq: 1,
      food_ref_id: REF_A, qty: 1, unit: "g", grams: 100, food_revision_id: 13 }]));
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: "blocked:avoid_list" }]);
  });

  it("leaves an item she eats unflagged", async () => {
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }],
        catalog_food_revisions: [{ id: 14, catalog_food_id: 7, is_active: true }],
        catalog_ingredients: [{ food_revision_id: 14, allergen_tags: [] }],
        user_food_prefs: [{ food_ref_id: REF_A, status: "eats" }],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1", req([{ id: ITEM_ID, seq: 1,
      food_ref_id: REF_A, qty: 1, unit: "g", grams: 100, food_revision_id: 14 }]));
    // No policy finding. This file has no service-role client, so the evidence port is unread and
    // Phase 18 W2a marks the item for that alone (review r1 BLOCK 2), never a silent clear.
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: RULES_UNREADABLE_MESSAGE }]);
  });

  it("passes an item with no evidence through as unverified, not blocked", async () => {
    // A catalog-kind ref with no pinned revision: neither branch of evidenceForItems has
    // anything to read, so allergenTags is null — "no evidence", not "clean".
    const db = fakeClient({
      tables: { food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null }] },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1",
      req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A, qty: 1, unit: "g", grams: 100 }]));
    expect(out).toMatchObject({ status: "ok" });
  });

  it("judges a catalog item with no pinned revision on the food's active revision", async () => {
    // Dropping food_revision_id from the request must not skip the policy (contracts §9a(d)).
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: 7 }],
        catalog_food_revisions: [{ id: 70, catalog_food_id: 7, is_active: true },
          { id: 69, catalog_food_id: 7, is_active: false }],
        catalog_ingredients: [{ food_revision_id: 70, allergen_tags: ["gluten"] }],
        constraint_profiles: [RULES],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1",
      req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A, qty: 1, unit: "g", grams: 100 }]));
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: "blocked:allergen:gluten" }]);
  });

  it("marks a user food whose allergen_tags carry an avoided allergen", async () => {
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF_A, kind: "user", user_food_id: "uf-1" }],
        user_foods: [{ id: "uf-1", allergen_tags: ["dairy"] }],
        constraint_profiles: [RULES],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const out = await applyLogEntry(db.client, "u1",
      req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A, qty: 1, unit: "g", grams: 100 }]));
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: "blocked:allergen:dairy" }]);
  });

  /**
   * The label food is saved too. Refusing it was the old disposition; a food she typed off a
   * packet she actually ate belongs in her list, marked — hiding it does not un-eat it, and the
   * mark is what her rules are for (2026-09-14 ruling).
   */
  it("saves a blocked label food and marks the entry", async () => {
    const db = fakeClient({
      // The label food is saved, gets a ref, and that ref is then what the entry points at — all
      // of it downstream of the policy, and all of it unreachable while a block refused first.
      tables: {
        food_refs: [{ id: "ref-for-label", kind: "user", user_food_id: "user_foods-new" }],
        constraint_profiles: [RULES],
      },
      rpc: {
        apply_sync_op: { status: "applied", rev: 1 },
        get_or_create_food_ref: "ref-for-label",
      },
    });
    const labelFood = { name: "Wheat crackers", per100g: PER_100G,
      ingredientsText: "wheat flour, salt", allergenTags: [] };
    const out = await applyLogEntry(db.client, "u1", req(
      [{ id: ITEM_ID, seq: 0, food_ref_id: LABEL_FOOD_PLACEHOLDER_REF, qty: 1, unit: "whole",
        grams: 90 }],
      { method: "label", draft_id: DRAFT_ID, save_label_as_food: true },
    ), { labelFood });
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: unknown }).flagged)
      .toEqual([{ path: "items.0", message: "blocked:allergen:gluten" }]);
    expect(db.inserted.some((i) => i.table === "user_foods")).toBe(true);
  });

  /**
   * sol BLOCK (review round 1, phase 13 slice 2): the commit path used to rebuild the label's
   * allergen tags with lib/capture/propose.ts's `allergenTagsFromIngredients`, a scanner limited
   * to gluten, dairy and apple (spec AC9, a Phase 3/4 leftover). A label whose printed ingredients
   * read "peanut" — and whose client-supplied `allergenTags` omits it, exactly as a real client
   * would if its own draft scan disagreed or was stale — used to commit as merely `unverified`
   * instead of `blocked`, silently dropping a major allergen at the one place a block actually
   * matters. The commit path must reach the same, full allergen vocabulary the capture card
   * itself blocks against (lib/policy/allergens.ts), not a narrower, second list.
   */
  it("marks an item whose LABEL ingredients name peanut, even when the client's own tags omit it",
    async () => {
      const db = fakeClient({
        tables: {
          food_refs: [{ id: "ref-for-label", kind: "user", user_food_id: "user_foods-new" }],
          constraint_profiles: [{ user_id: "u1", avoid_allergens: ["peanut"],
            avoid_food_ref_ids: [], banned_categories: [], custom_rules: [] }],
        },
        rpc: {
          apply_sync_op: { status: "applied", rev: 1 },
          get_or_create_food_ref: "ref-for-label",
        },
      });
      const labelFood = { name: "Trail mix", per100g: PER_100G,
        ingredientsText: "peanuts, raisins, almonds", allergenTags: [] };
      const out = await applyLogEntry(db.client, "u1", req(
        [{ id: ITEM_ID, seq: 0, food_ref_id: LABEL_FOOD_PLACEHOLDER_REF, qty: 1, unit: "whole",
          grams: 40 }],
        { method: "label", draft_id: DRAFT_ID, save_label_as_food: true },
      ), { labelFood });
      expect(out).toMatchObject({ status: "ok" });
      expect((out as { flagged?: unknown }).flagged)
        .toEqual([{ path: "items.0", message: "blocked:allergen:peanut" }]);
    });

  it("passes the item's confidence through to the apply_sync_op payload", async () => {
    const db = fakeClient({
      tables: { food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null }] },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    await applyLogEntry(db.client, "u1", req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A,
      qty: 1, unit: "g", grams: 100, confidence: 0.42 }]));
    const call = db.rpc.mock.calls.find((c) => c[0] === "apply_sync_op");
    const op = (call?.[1] as { p_op: { payload: { items: { confidence: number | null }[] } } }).p_op;
    expect(op.payload.items[0].confidence).toBe(0.42);
  });

  it("writes confidence: null when the item carries none", async () => {
    const db = fakeClient({
      tables: { food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null }] },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    await applyLogEntry(db.client, "u1", req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A,
      qty: 1, unit: "g", grams: 100 }]));
    const call = db.rpc.mock.calls.find((c) => c[0] === "apply_sync_op");
    const op = (call?.[1] as { p_op: { payload: { items: { confidence: number | null }[] } } }).p_op;
    expect(op.payload.items[0].confidence).toBeNull();
  });
});

// Finding #47 (2026-09-13 audit): entryFingerprint/fingerprintSource existed but nothing ever
// called them at commit time, so a double-logged meal never opened a duplicate_groups row.
describe("applyLogEntry — duplicate-fingerprint recording (finding #47)", () => {
  it("opens a duplicate_groups row and records the new entry as its first member", async () => {
    const db = fakeClient({
      tables: { food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null }] },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    await applyLogEntry(db.client, "u1",
      req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A, qty: 1, unit: "g", grams: 100 }]));
    expect(db.inserted.some((i) => i.table === "duplicate_groups")).toBe(true);
    expect(db.inserted).toContainEqual(
      { table: "duplicate_group_members", row: { group_id: "duplicate_groups-new", entry_id: ENTRY_ID } });
  });

  it("adds a second entry with the same fingerprint to the SAME open group instead of opening a new one", async () => {
    const OTHER_ENTRY = "20000000-0000-4000-8000-000000000002";
    const fingerprint = toBytea(Buffer.from(await entryFingerprint({
      localDate: "2026-09-11", slot: "meal-1", eatenAt: "2026-09-11T16:00:00.000Z",
      items: [{ canonicalFoodId: REF_A, grams: 100 }],
    }), "hex"));
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null }],
        duplicate_groups: [{ id: "existing-group", fingerprint }],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    await applyLogEntry(db.client, "u1",
      req([{ id: ITEM_ID, seq: 1, food_ref_id: REF_A, qty: 1, unit: "g", grams: 100 }],
        { entry_id: OTHER_ENTRY }));
    expect(db.inserted.some((i) => i.table === "duplicate_groups")).toBe(false);
    expect(db.inserted).toContainEqual(
      { table: "duplicate_group_members", row: { group_id: "existing-group", entry_id: OTHER_ENTRY } });
  });
});
