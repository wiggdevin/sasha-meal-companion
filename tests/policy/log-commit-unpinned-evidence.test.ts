/**
 * ai-audit 2026-10-01 (safety): /api/log/commit judged a catalog item with no food_revision_id
 * on its active revision's structured tags only. loadSuggestionEvidence keyed its rows by the
 * item's pinned revision, so an unpinned item (the capture confirm sheet's food swap sends one)
 * got none of the revision's stored food_allergen_evidence — a Jev-derived `listed` finding with
 * no structured tag — and committed with a weaker mark than the same food pinned.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ENTRY_ID, fakeClient, ITEM_ID, REF_A, req } from "@/tests/helpers/log-fake-client";

const admin = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin.client as SupabaseClient }));
vi.mock("@/lib/foods/facets", async (original) => ({
  ...(await original<typeof import("@/lib/foods/facets")>()),
  readFacets: vi.fn(async () => Object.assign(new Map(), { errors: 0 })),
}));

const { applyLogEntry } = await import("@/lib/server/log");

const CATALOG_FOOD = 900;
const ACTIVE_REVISION = 901;

function db() {
  const fake = fakeClient({
    tables: {
      food_refs: [{ id: REF_A, kind: "catalog", user_food_id: null, catalog_food_id: CATALOG_FOOD }],
      catalog_food_revisions: [{
        id: ACTIVE_REVISION, catalog_food_id: CATALOG_FOOD, is_active: true,
        description: "Granola bar", brand: null, category: "snack", policy_categories: [],
        prep_state: null,
        // Structured tags name no peanut; only the stored (Jev-derived) evidence does.
        catalog_ingredients: [{ seq: 1, name: "Oats", raw_text: "Oats, honey", allergen_tags: [] }],
        catalog_portions: [],
      }],
      catalog_ingredients: [{ food_revision_id: ACTIVE_REVISION, allergen_tags: [] }],
      food_allergen_evidence: [{ food_key: `catalog_revision:${ACTIVE_REVISION}`,
        allergen: "peanut", level: "listed", label_complete: false }],
      constraint_profiles: [{ user_id: "u1", avoid_allergens: ["peanut"], avoid_food_ref_ids: [],
        banned_categories: [], conditions: [], custom_rules: [] }],
      log_entries: [{ id: ENTRY_ID, rev: 1 }],
    },
    rpc: { apply_sync_op: { status: "applied", rev: 1 } },
  });
  admin.client = fake.client;
  return fake;
}

async function commit(foodRevisionId: number | null) {
  const out = await applyLogEntry(db().client, "u1", req([{ id: ITEM_ID, seq: 0,
    food_ref_id: REF_A, qty: 1, unit: "g", grams: 100, food_revision_id: foodRevisionId }]));
  expect(out).toMatchObject({ status: "ok" });
  return (out as { flagged?: { path: string; message: string }[] }).flagged;
}

describe("applyLogEntry — an unpinned catalog item gets its active revision's stored evidence", () => {
  it("marks the pinned item blocked from the stored Jev-derived peanut finding", async () => {
    expect(await commit(ACTIVE_REVISION))
      .toEqual([{ path: "items.0", message: "blocked:allergen:peanut" }]);
  });

  it("marks the same food blocked when the commit pins no revision", async () => {
    expect(await commit(null))
      .toEqual([{ path: "items.0", message: "blocked:allergen:peanut" }]);
  });
});
