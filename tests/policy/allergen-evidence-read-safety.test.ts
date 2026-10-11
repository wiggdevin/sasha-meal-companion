/**
 * sol BLOCK (review round 2): `readAllergenEvidence` used to convert a read error into an empty
 * `Map`, documented as safe because a reader could only ever make a verdict MORE cautious on a
 * miss. r3 FIX (this branch) lets a live, complete ingredient list independently derive
 * `not_listed` for a major allergen — so an empty map after a failed read let a genuinely stored
 * `listed` (an earlier label, a legacy tag, Jev) disappear behind a fresh live-only read this call
 * never actually saw, reversing a stored block instead of only ever adding to it. The read must
 * fail the caller instead, the same posture every other policy reader in this codebase already
 * takes on a read error (lib/server/catalog.ts loadUserProfile, tests/coach/attachments.test.ts's
 * "fails the turn when the ... policy read fails").
 */
import { describe, expect, it, vi } from "vitest";
import { readAllergenEvidence } from "@/lib/server/allergen-evidence";
import { resolveBarcode } from "@/lib/server/barcode";
import { getFoodDetail, searchFoods } from "@/lib/server/catalog";
import { fakeClient } from "@/tests/barcode/fake-client";
import { scannedAllergenFacts } from "@/lib/server/barcode-policy";
import { EMPTY_PROFILE, type ConstraintProfile } from "@/lib/policy/constraints";

function clientWithFailingEvidenceRead(checksData: unknown[] = []) {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const failing = table === "food_allergen_evidence";
    Object.assign(chain, {
      select: () => chain, in: () => chain, eq: () => chain, order: () => chain, range: () => chain,
      then: (resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) =>
        Promise.resolve(failing
          ? { data: null, error: { message: "read timed out" } }
          : { data: checksData, error: null }).then(resolve),
    });
    return chain;
  };
  return { from } as never;
}

describe("readAllergenEvidence: a read error must not become an empty map", () => {
  it("rejects instead of resolving to a silently-empty map", async () => {
    const client = clientWithFailingEvidenceRead();
    await expect(readAllergenEvidence(client, ["catalog_revision:1"])).rejects.toThrow("read timed out");
  });
});

describe("scannedAllergenFacts: a failed evidence read must not silently clear a stored block", () => {
  it("fails instead of deriving 'absent' from live text alone (Sol repro: a sesame finding " +
    "changing from present, with stored evidence, to absent when that evidence read fails)",
    async () => {
      const client = clientWithFailingEvidenceRead();
      const profile: ConstraintProfile = { ...EMPTY_PROFILE, avoid_allergens: ["sesame"] };
      // A complete, sesame-free-READING label: if a stored `listed` this call cannot read were
      // silently dropped instead of propagating the read failure, this would otherwise derive a
      // false "No sesame listed on the label".
      const completeLabel = "Water, rice flour, sunflower oil, salt.";
      await expect(scannedAllergenFacts(client, "user-1", profile, 34, completeLabel, []))
        .rejects.toThrow();
    });
});

/**
 * W022 (B193, Phase 10 r6 BLOCK 2): a catalog or barcode food whose allergens were never assessed
 * — no stored evidence, no tag, no complete label, an empty tag list that only LOOKS assessed, and
 * no plain whole-food class — is never `allowed` for an account that avoids an allergen. Each case
 * runs the real path (searchFoods, getFoodDetail, resolveBarcode's read-back and draft matches)
 * over a fake client, so a later change to any one path's evidence wiring fails here.
 */
describe("no assessed allergen evidence is never allowed (catalog and barcode)", () => {
  const PEANUT_RULES = {
    user_id: "user-a", avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [],
    conditions: [], custom_rules: [],
  };
  // Parsed ingredient NAMES with empty tags and no verbatim raw_text: they look assessed, but no
  // printed statement says the list is complete, so they can only ever add `listed`.
  const UNASSESSED_ROWS = [
    { food_revision_id: 34, seq: 1, name: "Oats", allergen_tags: [], raw_text: null },
    { food_revision_id: 34, seq: 2, name: "Sugar", allergen_tags: [], raw_text: null },
  ];
  const VARIANTS: { label: string; source: string; brand: string | null; description: string;
    ingredients: typeof UNASSESSED_ROWS }[] = [
    { label: "a branded row with no ingredient rows", source: "fdc_branded", brand: "Acme",
      description: "Granola bar, chocolate chip", ingredients: [] },
    { label: "a branded row whose empty tags only look assessed", source: "off", brand: "Acme",
      description: "Granola bar, chocolate chip", ingredients: UNASSESSED_ROWS },
    { label: "an unbranded prepared food", source: "fdc_sr_legacy", brand: null,
      description: "Cookies, chocolate chip, commercially prepared", ingredients: [] },
  ];

  function catalogTables(v: (typeof VARIANTS)[number]) {
    return fakeClient({
      catalog_versions: [{ version_label: "v1", is_active: true }],
      catalog_food_revisions: [{
        id: 34, catalog_food_id: 12, description: v.description, brand: v.brand, category: null,
        policy_categories: [], prep_state: null, quality_class: "crowd", quality_flags: [],
        is_active: true, catalog_foods: { source: v.source }, catalog_food_nutrients: [],
        catalog_portions: [], catalog_ingredients: v.ingredients,
      }],
      catalog_ingredients: v.ingredients,
      catalog_portions: [], catalog_food_nutrients: [], food_refs: [], user_foods: [],
      food_allergen_evidence: [], user_allergen_checks: [], constraint_profiles: [PEANUT_RULES],
    }, {
      catalog_search: [{
        catalog_food_id: 12, revision_id: 34, description: v.description, brand: v.brand,
        source: v.source, quality_class: "crowd", quality_flags: [], prep_state: null, score: 0.9,
        pref_status: null, category: null, policy_categories: [],
      }],
    });
  }

  for (const v of VARIANTS) {
    it(`search and detail read ${v.label} as unverified, never allowed`, async () => {
      const { client } = catalogTables(v);
      const search = await searchFoods(client, { q: "granola" });
      const detail = await getFoodDetail(client, 12, { catalogVersion: "v1" });
      for (const policy of [search.hits[0].policy, detail.policy]) {
        expect(policy.verdict).toBe("unverified");
        expect(policy.allergens).toEqual([expect.objectContaining(
          { allergen: "peanut", outcome: "unknown" })]);
      }
    });
  }

  const GTIN = "04006381333931";
  const NOW = new Date("2026-09-19T12:00:00.000Z");

  it("a cached barcode match with empty tags and no evidence is unverified", async () => {
    const { client } = fakeClient({
      catalog_barcodes: [{ gtin14: GTIN, catalog_food_id: 12, source: "off", published_at: "2026-09-01T00:00:00Z" }],
      catalog_food_revisions: [{
        id: 34, catalog_food_id: 12, description: "Granola bar, chocolate chip", brand: "Acme",
        quality_class: "crowd", quality_flags: [], is_active: true,
        catalog_versions: { version_label: "off-2026-09-01", imported_at: "2026-09-01T00:00:00Z" },
        catalog_food_nutrients: [], catalog_portions: [], catalog_ingredients: UNASSESSED_ROWS,
      }],
      constraint_profiles: [PEANUT_RULES], user_food_prefs: [], catalog_barcode_lookups: [],
      food_allergen_evidence: [], user_allergen_checks: [],
    }, { get_or_create_food_ref: "11111111-1111-4111-8111-111111111111" });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN },
      { fetchOff: vi.fn(), now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.cached).toBe(true);
    expect(res.match.policy.verdict).toBe("unverified");
  });

  it("a barcode match built from a fresh provider draft with no ingredients is unverified",
    async () => {
      const { client } = fakeClient({
        catalog_barcodes: [], constraint_profiles: [PEANUT_RULES], catalog_food_revisions: [],
        catalog_barcode_lookups: [], food_allergen_evidence: [], user_allergen_checks: [],
      }, {
        catalog_write_provider_revision: () => ({
          catalog_food_id: 12, revision_id: 34, version_label: "fdc_branded-2026-09-19" }),
        get_or_create_food_ref: "11111111-1111-4111-8111-111111111111",
      });
      const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: vi.fn().mockResolvedValue({ status: 404 }),
        fetchFdc: vi.fn().mockResolvedValue({
          fdcId: 1, description: "GRANOLA BAR", gtinUpc: "4006381333931", brandOwner: "Acme",
          foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 450 }],
        }),
        now: () => NOW,
      });
      expect(res.status).toBe("resolved");
      if (res.status !== "resolved") return;
      expect(res.match.policy.verdict).toBe("unverified");
    });
});
