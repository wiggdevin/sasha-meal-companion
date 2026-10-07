import { describe, expect, it, vi } from "vitest";
import { writeProviderRevision } from "@/lib/server/catalog-writer";
import type { RevisionDraft } from "@/lib/catalog/off-map";
import { emptyPer100g } from "@/lib/catalog/off-map";

const DRAFT: RevisionDraft = {
  description: "Apple & blueberry pouch", brand: "Ella's Kitchen", qualityClass: "crowd",
  per100g: { ...emptyPer100g(), energy_kcal: 60, protein: 0.4 },
  portions: [{ description: "1 pouch (90 g)", gramWeight: 90 }],
  ingredients: [{ seq: 1, name: "Apple juice concentrate", allergenTags: ["apple"] }],
  ingredientsText: "Apple juice concentrate", qualityFlags: [], category: null,
  policyCategories: [],
  sourceId: "04006381333931", publishedAt: "2026-09-19T12:00:00.000Z",
};

function adminWith(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { admin: { rpc } as never, rpc };
}

describe("writeProviderRevision", () => {
  it("sends the draft to the one RPC and returns camelCase ids", async () => {
    const { admin, rpc } = adminWith({
      data: { catalog_food_id: 12, revision_id: 34, version_label: "off-2026-09-19" }, error: null,
    });
    expect(await writeProviderRevision(admin, "off", "04006381333931", DRAFT, "user-a")).toEqual({
      catalogFoodId: 12, revisionId: 34, versionLabel: "off-2026-09-19",
    });
    expect(rpc).toHaveBeenCalledWith("catalog_write_provider_revision", {
      p_user_id: "user-a", p_source: "off", p_gtin14: "04006381333931", p_draft: DRAFT,
    });
  });

  it("throws a 502 with no provider detail when the RPC fails", async () => {
    const { admin } = adminWith({ data: null, error: { message: "duplicate key value 42P01" } });
    await expect(writeProviderRevision(admin, "off", "04006381333931", DRAFT, "user-a"))
      .rejects.toMatchObject({ status: 502, code: "catalog_write_failed" });
  });

  it("throws a 502 when the RPC answers nothing", async () => {
    const { admin } = adminWith({ data: null, error: null });
    await expect(writeProviderRevision(admin, "off", "04006381333931", DRAFT, "user-a"))
      .rejects.toMatchObject({ status: 502 });
  });
});
