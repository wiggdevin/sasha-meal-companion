import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  SCAN_FORMATS, ScanUnavailable, offlineMatch, scanGtin, toCachedRevision,
  type BarcodeMatch,
} from "@/lib/barcode/client";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { foodRulesEpoch, noteFoodRulesChanged } from "@/lib/foods/rules-epoch";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const GTIN = "04006381333931";

const MATCH: BarcodeMatch = {
  foodRefId: "11111111-1111-4111-8111-111111111111", catalogFoodId: 12, revisionId: 34,
  description: "Apple & blueberry pouch", brand: "Ella's Kitchen", source: "off",
  qualityClass: "crowd", qualityFlags: [], per100g: { energy_kcal: 60, iron: null },
  portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
  ingredientsText: "Apple juice concentrate", allergenTags: ["apple"],
  attribution: "Data from Open Food Facts (ODbL)", policy: { verdict: "blocked", reason: "allergen:apple" },
};

const RESOLVED = { status: "resolved" as const, gtin14: GTIN, cached: true, match: MATCH };

function res(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("scanGtin", () => {
  it("posts the request and returns the response body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(RESOLVED));
    expect(await scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual(RESOLVED);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/foods/barcode");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ gtin: GTIN });
  });

  it("throws ScanUnavailable with the Retry-After in ms on a 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      res({ error: "rate_limited", message: "slow down" }, 429, { "retry-after": "60" }));
    await expect(scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ gtin14: GTIN, retryAfterMs: 60_000 });
  });

  it.each([[503], [500], [404]])("throws ScanUnavailable on a %i", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ error: "upstream_unavailable" }, status));
    await expect(scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(ScanUnavailable);
  });

  it("throws ScanUnavailable when the network is gone", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(ScanUnavailable);
  });

  it("does NOT swallow a 400: a bad barcode is an answer the sheet must show", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res({ error: "invalid_gtin" }, 400));
    await expect(scanGtin({ gtin: "abc" }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ name: "BarcodeRejected" });
  });
});

describe("toCachedRevision", () => {
  it("flattens a match into the shape buildCommitRequest takes", () => {
    const row = toCachedRevision(MATCH, GTIN, Date.parse("2026-09-19T12:00:00.000Z"));
    expect(row).toEqual({
      revision_id: 34, catalog_food_id: 12, description: "Apple & blueberry pouch",
      brand: "Ella's Kitchen", source: "off", version_label: "Data from Open Food Facts (ODbL)",
      per_100g: { energy_kcal: 60, iron: null },
      portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
      gtin14: GTIN, food_ref_id: "11111111-1111-4111-8111-111111111111",
      allergen_tags: ["apple"], policy: { verdict: "blocked", reason: "allergen:apple" },
      rules_epoch: foodRulesEpoch(), cached_at: "2026-09-19T12:00:00.000Z",
    });
    expect(row.per_100g.iron).toBeNull();
  });
});

describe("offlineMatch", () => {
  const CACHED: CachedRevision = toCachedRevision(MATCH, GTIN, Date.parse("2026-09-19T12:00:00.000Z"));

  it("returns null when the row carries no food_ref_id — never fabricate one", () => {
    const without: CachedRevision = { ...CACHED };
    delete without.food_ref_id;
    expect(offlineMatch(without)).toBeNull();
    expect(offlineMatch({ ...CACHED, food_ref_id: "" })).toBeNull();
  });

  it("rebuilds a loggable match from the cached row, preserving the real verdict", () => {
    const match = offlineMatch(CACHED);
    expect(match).toEqual({
      foodRefId: "11111111-1111-4111-8111-111111111111", catalogFoodId: 12, revisionId: 34,
      description: "Apple & blueberry pouch", brand: "Ella's Kitchen", source: "off",
      qualityClass: "crowd", qualityFlags: [], per100g: { energy_kcal: 60, iron: null },
      portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
      ingredientsText: null, allergenTags: ["apple"],
      attribution: "Data from Open Food Facts (ODbL)", policy: { verdict: "blocked", reason: "allergen:apple" },
    });
    expect(match?.per100g.iron).toBeNull();
  });

  it("W014 (A031): replays an allowed verdict only under the rules epoch it was cached under", () => {
    const allowed = toCachedRevision({ ...MATCH, policy: { verdict: "allowed" } }, GTIN);
    expect(allowed.rules_epoch).toBe(foodRulesEpoch());
    expect(offlineMatch(allowed)?.policy).toEqual({ verdict: "allowed" });
    noteFoodRulesChanged();
    // The user added an allergy or an Avoid mark since: the old "allowed" may no longer hold.
    expect(offlineMatch(allowed)?.policy).toEqual({ verdict: "unverified" });
    expect(offlineMatch({ ...allowed, rules_epoch: undefined })?.policy).toEqual({ verdict: "unverified" });
  });

  it("W014 (A031): keeps a blocked verdict after a rules change — a lapsed warning beats none", () => {
    const blocked = toCachedRevision(MATCH, GTIN);
    noteFoodRulesChanged();
    expect(offlineMatch(blocked)?.policy).toEqual({ verdict: "blocked", reason: "allergen:apple" });
  });

  it("falls back to 'unverified' for a row cached before the verdict was persisted", () => {
    const legacy = { ...CACHED };
    delete legacy.allergen_tags;
    delete legacy.policy;
    const match = offlineMatch(legacy);
    expect(match?.allergenTags).toEqual([]);
    expect(match?.policy).toEqual({ verdict: "unverified" });
  });
});

describe("SCAN_FORMATS", () => {
  it("is the six symbologies on a grocery package", () => {
    expect(SCAN_FORMATS).toEqual(["EAN-8", "UPC-A", "UPC-E", "EAN-13", "ITF", "Code128"]);
  });
});
