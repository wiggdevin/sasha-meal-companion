import { describe, expect, it, vi } from "vitest";
import { refreshBarcode, resolveBarcode } from "@/lib/server/barcode";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import { fakeClient } from "./fake-client";

const GTIN = "04006381333931";
const NOW = new Date("2026-09-19T12:00:00.000Z");

/**
 * The account's own rules, as its `constraint_profiles` row. They used to live in code as
 * `DEFAULT_PROFILE`; since D1 §6.1 the row is the only place a restriction exists, so a case that
 * proves blocking has to seed the row the policy actually reads (lib/server/barcode.ts:70).
 */
const RULES = [{ user_id: "user-a", ...DEFAULT_PROFILE }];

function cached(
  overrides: Record<string, unknown> = {},
  prefs: Record<string, unknown>[] = [],
  constraints: Record<string, unknown>[] = RULES,
) {
  return fakeClient({
    catalog_barcodes: [{ gtin14: GTIN, catalog_food_id: 12, source: "off", published_at: "2026-09-01T00:00:00Z" }],
    catalog_food_revisions: [{
      // 2026-10-02: the product's own NAME must not itself name one of TEST_PROFILE's own
      // allergens (apple/gluten/dairy) — escalation by name (owner decision, lib/policy/
      // allergens.ts) would otherwise block every case in this file for "apple" by the product's
      // own title alone, whatever that specific case is actually testing. The ingredient row
      // below still names "Apple juice concentrate" on purpose, unaffected: that is ingredient
      // text, the existing (and correct) escalation path, not this file's own fixture noise.
      id: 34, catalog_food_id: 12, description: "Mixed berry pouch", brand: "Ella's Kitchen",
      quality_class: "crowd", quality_flags: [], is_active: true,
      catalog_versions: { version_label: "off-2026-09-01", imported_at: "2026-09-01T00:00:00Z" },
      catalog_food_nutrients: [{ nutrient_code: "energy_kcal", amount_per_100g: 60 }],
      catalog_portions: [{ id: 5, description: "1 pouch (90 g)", gram_weight: 90, is_default: true, seq: 1 }],
      catalog_ingredients: [{ seq: 1, name: "Apple juice concentrate", allergen_tags: ["apple"], raw_text: "Apple juice concentrate, blueberry puree" }],
      ...overrides,
    }],
    constraint_profiles: constraints, user_food_prefs: prefs, catalog_barcode_lookups: [],
  }, { get_or_create_food_ref: "11111111-1111-4111-8111-111111111111" });
}

describe("resolveBarcode", () => {
  it("400s on a bad check digit before any I/O", async () => {
    const { client } = cached();
    const fetchOff = vi.fn();
    await expect(resolveBarcode(client, client, "user-a", { gtin: "4006381333932" }, { fetchOff }))
      .rejects.toMatchObject({ status: 400, code: "invalid_gtin" });
    expect(fetchOff).not.toHaveBeenCalled();
  });

  it("serves a cached barcode with cached:true and no outbound call", async () => {
    const { client } = cached();
    const fetchOff = vi.fn();
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { fetchOff, now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.cached).toBe(true);
    expect(res.match.revisionId).toBe(34);
    expect(res.match.attribution).toBe("Data from Open Food Facts (ODbL)");
    expect(res.match.allergenTags).toEqual(["apple"]);
    expect(res.match.ingredientsText).toBe("Apple juice concentrate, blueberry puree");
    expect(res.match.policy).toMatchObject({ verdict: "blocked", reason: "allergen:apple" });
    expect(res.match.portions).toEqual([{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }]);
    expect(fetchOff).not.toHaveBeenCalled();
  });

  it("treats a text-scan-only miss as unverified, not allowed (finding #8)", async () => {
    // No OFF-declared allergen tags, and the stored ingredient rows carry no allergenTags because
    // the English word lists missed this text (e.g. non-English ingredient text) — the writer
    // flagged the revision allergens_text_unconfirmed rather than reporting a confirmed clean scan.
    const { client } = cached({
      quality_flags: ["allergens_text_unconfirmed"],
      catalog_ingredients: [{ seq: 1, name: "Farine de blé, lait, beurre, pomme", allergen_tags: [], raw_text: "Farine de blé, lait, beurre, pomme" }],
    });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.allergenTags).toEqual([]);
    expect(res.match.policy).toMatchObject({ verdict: "unverified" });
  });

  // 2026-10-02 DeepSeek audit (HIGH, finding #2): a scanned barcode is packaged by definition —
  // even an unbranded store-brand row ("Chicken breast", brand: null, no ingredient list) must
  // never read as a generic whole food. Before this, `foodBrand` was never threaded through
  // `toMatch`'s evaluatePolicy call at all, so the whole-food check always saw brand: undefined
  // regardless of the row's real brand, and a plain-sounding name with no ingredient evidence
  // cleared outright ("Plain poultry has no dairy").
  it("never gives a scanned barcode whole-food clearance, even unbranded (finding #2)", async () => {
    const dairyProfile = [{ user_id: "user-a", ...DEFAULT_PROFILE, avoid_allergens: ["dairy"] }];
    const { client } = cached({
      description: "Chicken breast", brand: null, catalog_ingredients: [],
    }, [], dairyProfile);
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.policy.allergens).toContainEqual(
      expect.objectContaining({ allergen: "dairy", outcome: "unknown", text: "Check the label for dairy" }),
    );
  });

  it("round 13/1: a nonverbatim, name-joined ingredient list (no raw_text on any row) must stay " +
    "unverified, not clear a major allergen — the final policy check must not silently re-treat " +
    "it as the label's own verbatim statement", async () => {
    const peanutProfile = [{ user_id: "user-a", ...DEFAULT_PROFILE, avoid_allergens: ["peanut"] }];
    const { client } = cached({
      catalog_ingredients: [
        { seq: 1, name: "Water", allergen_tags: [], raw_text: null },
        { seq: 2, name: "rice", allergen_tags: [], raw_text: null },
        { seq: 3, name: "salt.", allergen_tags: [], raw_text: null },
      ],
    }, [], peanutProfile);
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.policy.verdict).toBe("unverified");
    expect(res.match.policy.allergens).toContainEqual(
      expect.objectContaining({ allergen: "peanut", outcome: "unknown", text: "Check the label for peanut" }),
    );
  });

  it("round 13/2: a later parsed ingredient NAME (no allergen_tags entry of its own) must still " +
    "block, the same presence signal search and detail already scan for", async () => {
    const peanutProfile = [{ user_id: "user-a", ...DEFAULT_PROFILE, avoid_allergens: ["peanut"] }];
    const { client } = cached({
      catalog_ingredients: [
        { seq: 1, name: "Water, rice, salt", allergen_tags: [], raw_text: "Water, rice, salt." },
        { seq: 2, name: "peanut", allergen_tags: [], raw_text: null },
      ],
    }, [], peanutProfile);
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.policy).toMatchObject({ verdict: "blocked", reason: "allergen:peanut" });
  });

  it("flags a hit older than 90 days for the next request and still answers from cache", async () => {
    const { client } = cached({
      catalog_versions: { version_label: "off-2026-01-01", imported_at: "2026-01-01T00:00:00Z" },
    });
    const scheduleRefresh = vi.fn();
    const fetchOff = vi.fn();
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN },
      { fetchOff, now: () => NOW, scheduleRefresh });
    expect(res.status).toBe("resolved");
    expect(scheduleRefresh).toHaveBeenCalledWith(GTIN);
    expect(fetchOff).not.toHaveBeenCalled();
  });

  it("makes no outbound call for a miss row younger than 7 days", async () => {
    const { client } = fakeClient({
      catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [],
      catalog_barcode_lookups: [{ gtin14: GTIN, status: "miss", attempts: 1, last_fetched_at: "2026-09-15T00:00:00Z" }],
    });
    const fetchOff = vi.fn();
    const res = await resolveBarcode(client, client, "user-a",
      { gtin: GTIN, hint: { brand: "Ella's" } }, { fetchOff, now: () => NOW });
    expect(res).toEqual({ status: "not_found", gtin14: GTIN, searchHint: { brand: "Ella's" } });
    expect(fetchOff).not.toHaveBeenCalled();
  });

  it("falls OFF 404 → FDC 404 → not_found, and records the miss", async () => {
    const { client, upserts } = fakeClient({
      catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [], catalog_barcode_lookups: [],
    });
    const fetchOff = vi.fn().mockResolvedValue({ status: 404 });
    const fetchFdc = vi.fn().mockResolvedValue({ status: 404 });
    const onOutbound = vi.fn().mockResolvedValue(undefined);
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN },
      { fetchOff, fetchFdc, onOutbound, now: () => NOW });
    expect(res.status).toBe("not_found");
    expect(onOutbound).toHaveBeenCalledTimes(1);
    expect(upserts[0]).toEqual({
      table: "catalog_barcode_lookups",
      rows: { gtin14: GTIN, status: "miss", source: null, http_status: 404, attempts: 1,
              last_fetched_at: NOW.toISOString() },
    });
  });

  it("answers not_found on an OFF outage + FDC 404, but records the lookup as an error", async () => {
    // A partial outage must never negative-cache: a 'miss' row would suppress the retry for 7 days.
    const { client, upserts } = fakeClient({
      catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [], catalog_barcode_lookups: [],
    });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
      fetchOff: vi.fn().mockResolvedValue({ status: "timeout" }),
      fetchFdc: vi.fn().mockResolvedValue({ status: 404 }),
      now: () => NOW,
    });
    expect(res.status).toBe("not_found");
    expect(upserts[0]).toMatchObject({
      table: "catalog_barcode_lookups",
      rows: { gtin14: GTIN, status: "error" },
    });
  });

  it("falls through an OFF timeout to FDC and writes the revision", async () => {
    // R3: the brief's tables are static, so a plain rpcResults value can't reflect a write into
    // catalog_food_revisions for the post-write re-read. tables is built first so the
    // catalog_write_provider_revision function can push the written rows into it.
    const tables = {
      catalog_barcodes: [] as Record<string, unknown>[],
      constraint_profiles: [] as Record<string, unknown>[],
      catalog_barcode_lookups: [] as Record<string, unknown>[],
      catalog_food_revisions: [] as Record<string, unknown>[],
    };
    const { client, rpc } = fakeClient(tables, {
      catalog_write_provider_revision: () => {
        tables.catalog_barcodes.push({ gtin14: GTIN, catalog_food_id: 12, source: "fdc_branded", published_at: NOW.toISOString() });
        tables.catalog_food_revisions.push({
          id: 34, catalog_food_id: 12, description: "POUCH", brand: null,
          quality_class: "label", quality_flags: [], is_active: true,
          catalog_versions: { version_label: "fdc_branded-2026-09-19", imported_at: NOW.toISOString() },
          catalog_food_nutrients: [{ nutrient_code: "energy_kcal", amount_per_100g: 60 }],
          catalog_portions: [], catalog_ingredients: [],
        });
        return { catalog_food_id: 12, revision_id: 34, version_label: "fdc_branded-2026-09-19" };
      },
      get_or_create_food_ref: "11111111-1111-4111-8111-111111111111",
    });
    const fetchOff = vi.fn().mockResolvedValue({ status: "timeout" });
    const fetchFdc = vi.fn().mockResolvedValue({
      fdcId: 1, description: "POUCH", gtinUpc: "4006381333931",
      foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 60 }],
    });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN },
      { fetchOff, fetchFdc, now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.cached).toBe(false);
    expect(res.match.source).toBe("fdc_branded");
    expect(rpc).toHaveBeenCalledWith("catalog_write_provider_revision", expect.objectContaining({
      p_source: "fdc_branded", p_gtin14: GTIN,
    }));
  });

  it("503s when both providers fail transport and nothing is cached", async () => {
    const { client } = fakeClient({
      catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [], catalog_barcode_lookups: [],
    });
    await expect(resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
      fetchOff: vi.fn().mockResolvedValue({ status: "timeout" }),
      fetchFdc: vi.fn().mockResolvedValue({ status: 503 }),
      now: () => NOW,
    })).rejects.toMatchObject({ status: 503, code: "upstream_unavailable" });
  });

  it("blocks a scanned item whose category is on her banned-category list (finding #33)", async () => {
    // No allergen tags on this row — an allergen block would mask the category check.
    // T1: the policy reads `policy_categories` (controlled keys), not the provider's own text.
    const { client } = cached({
      category: "Sweets", policy_categories: ["simple_sugars"], catalog_ingredients: [],
    });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.policy).toMatchObject({ verdict: "blocked", reason: "category:simple_sugars" });
  });

  it("flags a scanned product she has marked Avoid on its catalog ref (T1)", async () => {
    // No allergen on this row, so the block can only come from her own list.
    const { client } = cached(
      { catalog_ingredients: [{ seq: 1, name: "Water", allergen_tags: [], raw_text: "Water" }] },
      [{ user_id: "user-a", food_ref_id: "11111111-1111-4111-8111-111111111111", status: "avoid" }],
    );
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.policy).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
  });

  it("derives the policy categories when the column was never annotated", async () => {
    const { client } = cached({
      description: "Onions, raw", category: "Vegetables and Vegetable Products",
      policy_categories: null,
      catalog_ingredients: [{ seq: 1, name: "Onion", allergen_tags: [], raw_text: "Onion" }],
    });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.policy).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("trusts an annotated-clean revision rather than re-deriving it", async () => {
    const { client } = cached({
      description: "Onions, raw", category: "Vegetables and Vegetable Products",
      policy_categories: [],
      // Three items, terminated: the ORCHESTRATOR RULING (round 7) requires at least three items
      // for ANY live scan to clear a major allergen, not just a bare word or a two-item fragment.
      catalog_ingredients: [{ seq: 1, name: "Onion", allergen_tags: [],
        raw_text: "Onion, water, salt." }],
    });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    // Not blocked by category. Phase 13 §9 R1: dairy (one of the nine) reads "No dairy listed on
    // the label" off the complete list; gluten and apple are not among the nine, so they stay
    // unverified until the user marks this product checked.
    expect(res.match.policy.verdict).toBe("unverified");
    expect(res.match.policy.allergens?.map((finding) => finding.outcome))
      .toEqual(["unknown", "absent", "unknown"]);
    expect(res.match.policy.allergens?.[1].text).toBe("No dairy listed on the label");
    expect(res.match.policy.allergens?.[0].text).toMatch(/^No gluten listed, but labels need not/);
  });

  it("blocks nothing for an account with no constraint_profiles row (D1 §6.1)", async () => {
    // The same apple-tagged hit that is blocked above, for an account whose own row does not exist:
    // no row is "this account restricts nothing", not the absence of a code floor.
    const { client } = cached({}, [], []);
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.allergenTags).toEqual(["apple"]);
    expect(res.match.policy).toEqual({ verdict: "allowed" });
  });

  it("carries the revision's quality_flags into the match (finding #38)", async () => {
    const { client } = cached({ quality_flags: ["energy_mismatch"] });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.qualityFlags).toEqual(["energy_mismatch"]);
  });

  it("returns at most three candidates ranked by quality_class then published_at", async () => {
    const { client } = fakeClient({
      catalog_barcodes: [
        { gtin14: GTIN, catalog_food_id: 1, source: "off", published_at: "2026-09-10T00:00:00Z" },
        { gtin14: GTIN, catalog_food_id: 2, source: "fdc_branded", published_at: "2026-01-01T00:00:00Z" },
      ],
      catalog_food_revisions: [
        { id: 10, catalog_food_id: 1, description: "Crowd row", brand: null, quality_class: "crowd",
          quality_flags: [], is_active: true, catalog_versions: { version_label: "off-2026-09-10", imported_at: "2026-09-10T00:00:00Z" },
          catalog_food_nutrients: [], catalog_portions: [], catalog_ingredients: [] },
        { id: 20, catalog_food_id: 2, description: "Label row", brand: null, quality_class: "label",
          quality_flags: [], is_active: true, catalog_versions: { version_label: "fdc_branded-2026-01-01", imported_at: "2026-01-01T00:00:00Z" },
          catalog_food_nutrients: [], catalog_portions: [], catalog_ingredients: [] },
      ],
      constraint_profiles: [], catalog_barcode_lookups: [],
    }, { get_or_create_food_ref: "11111111-1111-4111-8111-111111111111" });
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
    expect(res.status).toBe("ambiguous");
    if (res.status !== "ambiguous") return;
    expect(res.matches.map((m) => m.revisionId)).toEqual([20, 10]);
  });

  it("starts the allergen-evidence read alongside the food-ref lookup rather than after the " +
    "pref-status read (finding #2: scannedAllergenFacts needs only the revision, not the ref)",
    async () => {
      const { client, from, rpc } = cached();
      await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
      const refCallIndex = rpc.mock.calls.findIndex(([name]) => name === "get_or_create_food_ref");
      const prefCallIndex = from.mock.calls.findIndex(([table]) => table === "user_food_prefs");
      const evidenceCallIndex = from.mock.calls.findIndex(([table]) => table === "user_allergen_checks");
      expect(refCallIndex).toBeGreaterThanOrEqual(0);
      expect(prefCallIndex).toBeGreaterThanOrEqual(0);
      expect(evidenceCallIndex).toBeGreaterThanOrEqual(0);
      // The allergen-evidence read is issued before the ref→pref chain resolves the pref read —
      // it does not wait its turn behind a lookup it never needed.
      expect(rpc.mock.invocationCallOrder[refCallIndex])
        .toBeLessThan(from.mock.invocationCallOrder[prefCallIndex]);
      expect(from.mock.invocationCallOrder[evidenceCallIndex])
        .toBeLessThan(from.mock.invocationCallOrder[prefCallIndex]);
    });

  it("blocks on a stored 'listed' evidence row this scan's own label text does not repeat " +
    "(lib/server/barcode-policy.ts scannedAllergenFacts must merge food_allergen_evidence, not " +
    "just re-derive from the live label)", async () => {
      const { client } = fakeClient({
        catalog_barcodes: [{ gtin14: GTIN, catalog_food_id: 12, source: "off", published_at: "2026-09-01T00:00:00Z" }],
        catalog_food_revisions: [{
          id: 34, catalog_food_id: 12, description: "Snack bar", brand: "Acme",
          quality_class: "crowd", quality_flags: [], is_active: true,
          catalog_versions: { version_label: "off-2026-09-01", imported_at: "2026-09-01T00:00:00Z" },
          catalog_food_nutrients: [], catalog_portions: [],
          // No sesame-family word anywhere in this scan's own text — a keyword-only reader would
          // clear it. The stored row below is what a prior Jev-backed facet warm found.
          catalog_ingredients: [{ seq: 1, name: "Rice, mixed seasoning", allergen_tags: [],
            raw_text: "Rice, mixed seasoning, oil, salt." }],
        }],
        constraint_profiles: [{ user_id: "user-a", avoid_allergens: ["sesame"],
          avoid_food_ref_ids: [], banned_categories: [] }],
        user_food_prefs: [], catalog_barcode_lookups: [],
        food_allergen_evidence: [{ food_key: "catalog_revision:34", allergen: "sesame",
          level: "listed", label_complete: true }],
      }, { get_or_create_food_ref: "11111111-1111-4111-8111-111111111111" });
      const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
      expect(res.status).toBe("resolved");
      if (res.status !== "resolved") return;
      expect(res.match.policy).toMatchObject({ verdict: "blocked", reason: "allergen:sesame" });
      expect(res.match.policy.allergens).toMatchObject([{ allergen: "sesame", outcome: "present" }]);
    });
});

describe("refreshBarcode", () => {
  it("re-fetches a stale hit and writes the revision, spending the outbound budget", async () => {
    const { client, rpc, upserts } = fakeClient({
      catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [], catalog_barcode_lookups: [],
    }, { catalog_write_provider_revision: { catalog_food_id: 12, revision_id: 34, version_label: "fdc_branded-2026-09-19" } });
    const onOutbound = vi.fn().mockResolvedValue(undefined);
    await refreshBarcode(client, "user-a", GTIN, {
      onOutbound, now: () => NOW,
      fetchOff: vi.fn().mockResolvedValue({ status: "timeout" }),
      fetchFdc: vi.fn().mockResolvedValue({
        fdcId: 1, description: "POUCH", gtinUpc: "4006381333931",
        foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 60 }],
      }),
    });
    expect(onOutbound).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("catalog_write_provider_revision", expect.objectContaining({ p_gtin14: GTIN }));
    expect(upserts.at(-1)).toMatchObject({
      table: "catalog_barcode_lookups", rows: { gtin14: GTIN, status: "hit", source: "fdc_branded" },
    });
  });

  it("records a miss and writes nothing when both providers 404", async () => {
    const { client, rpc, upserts } = fakeClient({
      catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [], catalog_barcode_lookups: [],
    });
    await refreshBarcode(client, "user-a", GTIN, {
      now: () => NOW,
      fetchOff: vi.fn().mockResolvedValue({ status: 404 }),
      fetchFdc: vi.fn().mockResolvedValue({ status: 404 }),
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(upserts[0]).toMatchObject({ table: "catalog_barcode_lookups", rows: { status: "miss" } });
  });

  it("never rejects: a background refresh must not surface an error", async () => {
    const { client } = fakeClient({ catalog_barcode_lookups: [] });
    // Both providers are stubbed now that they are raced (T0 §4): an OFF socket hang up no
    // longer short-circuits the turn, it just loses, and FDC is still asked. Leaving fetchFdc
    // unstubbed would reach the real USDA host from a unit test.
    await expect(refreshBarcode(client, "user-a", GTIN, {
      now: () => NOW,
      fetchOff: vi.fn().mockRejectedValue(new Error("socket hang up")),
      fetchFdc: vi.fn().mockRejectedValue(new Error("socket hang up")),
    })).resolves.toBeUndefined();
  });
});
