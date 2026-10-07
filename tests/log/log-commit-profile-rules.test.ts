/**
 * Phase 13 §4, §9 R5, owner ruling 2026-10-02: the log commit path never read an account's
 * confirmed dietary-profile hard rules (religious / user_rule / user_confirmed_safety) at all —
 * only the suggestion and compose paths did (tests/coach/run-turn-profile-rules.test.ts). A food
 * logged straight from search or barcode, naming exactly what a confirmed "never" rule names,
 * committed with no mark whatsoever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadSuggestionEvidenceMock } = vi.hoisted(() => ({
  loadSuggestionEvidenceMock: vi.fn(),
}));

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
const FOOD_REF = "00000000-0000-4000-8000-000000000003";
const ENTRY_ID = "00000000-0000-4000-8000-000000000001";
const ITEM_ID = "00000000-0000-4000-8000-000000000002";

function rule(facet: string, confirmation: string) {
  return {
    id: `halal:${facet}`, profileId: "halal", facet, strength: "never", hardBasis: "religious",
    evidenceStrength: "user_rule", confirmation, expiresAt: null,
  };
}

function baseRows(ruleRows: Row[]): Record<string, Row[]> {
  return {
    food_refs: [{ id: FOOD_REF }],
    catalog_ingredients: [{ food_revision_id: 467, allergen_tags: [] }],
    catalog_food_revisions: [{ id: 467, is_active: true }],
    user_food_prefs: [],
    media_objects: [],
    constraint_profiles: [],
    user_dietary_profiles: [{
      user_id: "user-1", profile_id: "halal", source: "user_stated",
      confirmed_at: "2026-09-19T00:00:00.000Z", rules: ruleRows, options: {}, notes: null,
    }],
    log_items: [{
      id: ITEM_ID, entry_id: ENTRY_ID, seq: 0, food_ref_id: FOOD_REF, qty: 1, unit: "g",
      grams: 100, portion_id: null, food_revision_id: 467, was_edited: false, confidence: null,
      snapshot: {},
    }],
  };
}

function client(ruleRows: Row[]) {
  const rows = baseRows(ruleRows);
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      order: () => chain,
      range: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        if (table === "constraint_profiles") return { data: null, error: null };
        if (table === "user_settings") return { data: null, error: null };
        return { data: (rows[table] ?? [])[0] ?? null, error: null };
      },
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
    });
    return chain;
  });
  return {
    from,
    rpc: vi.fn(async (name: string) => name === "apply_sync_op"
      ? { data: { status: "applied", rev: 1 }, error: null }
      : { data: null, error: null }),
  } as never;
}

function commitReq() {
  return {
    entry_id: ENTRY_ID,
    eaten_at: "2026-09-20T12:00:00.000Z",
    tz: "UTC",
    local_date: "2026-09-20",
    slot: "meal-2",
    method: "search",
    items: [{
      id: ITEM_ID, seq: 0, food_ref_id: FOOD_REF, food_revision_id: 467, qty: 1, unit: "g",
      grams: 100,
    }],
  };
}

describe("applyLogEntry — a confirmed profile hard rule reaches the commit's own policy check", () => {
  beforeEach(() => loadSuggestionEvidenceMock.mockReset());

  it("blocks a food a confirmed religious rule names", async () => {
    loadSuggestionEvidenceMock.mockResolvedValue({
      status: "ready",
      preferenceFlags: [],
      byIdentity: {
        [`ref:${FOOD_REF}`]: {
          allergenTags: [], policyCategories: [], noCook: null, onEatsList: false,
          onAvoidList: false, role: null, foodName: "Pork chop",
          facets: { pork: { p: 0.99, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00.000Z" } },
        },
      },
    });

    const result = await applyLogEntry(client([rule("pork", "confirmed")]), "user-1", commitReq());

    expect(result).toMatchObject({
      status: "ok",
      flagged: [{ path: "items.0", message: "blocked:rule:pork" }],
    });
    // The rule's own facet is read from the cache alongside everything else (never a fresh model
    // call): lib/policy/profiles/account-rules.ts profileRuleFacets must reach this read.
    expect(loadSuggestionEvidenceMock).toHaveBeenCalledWith("user-1", expect.any(Array),
      expect.objectContaining({ facets: expect.arrayContaining(["pork"]) }));
  });

  it("marks the food unverified when the rule's facet has no evidence yet", async () => {
    loadSuggestionEvidenceMock.mockResolvedValue({
      status: "ready",
      preferenceFlags: [],
      byIdentity: {
        [`ref:${FOOD_REF}`]: {
          allergenTags: [], policyCategories: [], noCook: null, onEatsList: false,
          onAvoidList: false, role: null, foodName: "Mystery casserole", facets: {},
        },
      },
    });

    const result = await applyLogEntry(client([rule("pork", "confirmed")]), "user-1", commitReq());

    expect(result).toMatchObject({
      status: "ok",
      flagged: [{ path: "items.0", message: "unverified:profile_rule:pork" }],
    });
  });

  it("does not block under an unconfirmed rule on the same facet", async () => {
    loadSuggestionEvidenceMock.mockResolvedValue({
      status: "ready",
      preferenceFlags: [],
      byIdentity: {
        [`ref:${FOOD_REF}`]: {
          allergenTags: [], policyCategories: [], noCook: null, onEatsList: false,
          onAvoidList: false, role: null, foodName: "Pork chop",
          facets: { pork: { p: 0.99, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00.000Z" } },
        },
      },
    });

    const result = await applyLogEntry(client([rule("pork", "unconfirmed")]), "user-1", commitReq());

    expect(result).toMatchObject({ status: "ok" });
    expect((result as { flagged?: unknown }).flagged).toBeUndefined();
  });
});
