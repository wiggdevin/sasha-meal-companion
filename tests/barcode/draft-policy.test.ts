/**
 * The match built from the draft this request just wrote is judged the same way as the match read
 * back out of the catalog: an un-annotated revision is derived from its own words, never read as
 * "checked, nothing banned" (Grok pass 3, MEDIUM 7).
 *
 * The mock is the point of the file: it stands for a draft source that carries no policy
 * categories at all — an older provider mapper, or one written before the column existed. The
 * derivation must then come from the same place the read-back path takes it from.
 */
import { describe, expect, it, vi } from "vitest";
import { resolveBarcode } from "@/lib/server/barcode";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import { fakeClient } from "./fake-client";

vi.mock("@/lib/catalog/fdc-map", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog/fdc-map")>();
  return {
    ...actual,
    fdcBrandedToRevision: (...args: Parameters<typeof actual.fdcBrandedToRevision>) => {
      const draft = actual.fdcBrandedToRevision(...args);
      if ("reject" in draft) return draft;
      const { policyCategories: _dropped, ...rest } = draft;
      return rest as typeof draft;
    },
  };
});

const GTIN = "04006381333931";
const NOW = new Date("2026-09-19T12:00:00.000Z");

/**
 * The account's own rules, as its `constraint_profiles` row. `onion_garlic` used to be banned by a
 * constant in code; since D1 §6.1 the account's own row is the only place a category is banned, so
 * the case that proves blocking seeds the row the draft policy reads (lib/server/barcode.ts:70).
 */
const RULES = [{ user_id: "user-a", ...DEFAULT_PROFILE }];

/** The write lands and the read-back finds nothing: the replica-lag case matchFromDraft is for. */
function writtenButUnreadable(constraintRows: Record<string, unknown>[] = RULES) {
  return fakeClient({
    catalog_barcodes: [], constraint_profiles: constraintRows, catalog_food_revisions: [],
    catalog_barcode_lookups: [],
  }, {
    catalog_write_provider_revision: () => ({
      catalog_food_id: 12, revision_id: 34, version_label: "fdc_branded-2026-09-19",
    }),
    get_or_create_food_ref: "11111111-1111-4111-8111-111111111111",
  });
}

describe("a match built from the draft, not from a read-back", () => {
  it("derives the policy categories from the draft's own words", async () => {
    const { client } = writtenButUnreadable();
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
      fetchOff: vi.fn().mockResolvedValue({ status: 404 }),
      fetchFdc: vi.fn().mockResolvedValue({
        fdcId: 1, description: "ONIONS, RAW", gtinUpc: "4006381333931",
        brandedFoodCategory: "Vegetables and Vegetable Products",
        foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 40 }],
      }),
      now: () => NOW,
    });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.revisionId).toBe(34);
    expect(res.match.policy).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
  });

  it("blocks nothing for an account with no constraint_profiles row (D1 §6.1)", async () => {
    // The same raw-onion draft, judged for an account that has stated no rules at all: the
    // derivation still runs, and nothing in code supplies a ban of its own. What is left is the
    // draft's own unread allergen evidence — never a category this account never named.
    const { client } = writtenButUnreadable([]);
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
      fetchOff: vi.fn().mockResolvedValue({ status: 404 }),
      fetchFdc: vi.fn().mockResolvedValue({
        fdcId: 1, description: "ONIONS, RAW", gtinUpc: "4006381333931",
        brandedFoodCategory: "Vegetables and Vegetable Products",
        foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 40 }],
      }),
      now: () => NOW,
    });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.policy).toMatchObject({ verdict: "unverified" });
  });

  it("says unverified for ingredient text the allergen scanner could not read", async () => {
    // finding #8, on the other path: no declared tags and nothing the English word lists match is
    // not a clean scan, it is an unread one. The stored-row path has always answered `unverified`
    // here; the draft fallback answered `allowed`, which is the one answer she must never be
    // given about an allergen (panel round 10, item 4).
    const { client } = writtenButUnreadable();
    const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
      fetchOff: vi.fn().mockResolvedValue({ status: 404 }),
      fetchFdc: vi.fn().mockResolvedValue({
        fdcId: 1, description: "BISCUITS", gtinUpc: "4006381333931",
        ingredients: "Farine de blé, lait, beurre",
        foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 450 }],
      }),
      now: () => NOW,
    });
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") return;
    expect(res.match.qualityFlags).toContain("allergens_text_unconfirmed");
    expect(res.match.policy).toMatchObject({ verdict: "unverified" });
  });
});
