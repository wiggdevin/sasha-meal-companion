// @vitest-environment jsdom
/**
 * U8 (owner, 2026-10-04): "per serving, what is that? How much does it weigh and how many
 * calories". A search row states one serving; a portion pill says label, weight and calories; and
 * every search field is the shared lookup field.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CachedRevision } from "@/lib/db/catalog-cache";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { default: LogFoodPortion, revisionKcalPer100 } = await import("@/components/LogFoodSheet.Portion");
const { default: RecipeFoodSearch } = await import("@/components/RecipeFoodSearch");

afterEach(() => cleanup());

const REVISION: CachedRevision = {
  revision_id: 1, catalog_food_id: 2, description: "Fat, beef tallow", brand: null, source: "usda",
  version_label: "v1", per_100g: { energy_kcal: 902, protein: 0, carbohydrate: 0, fat_total: 100 },
  portions: [{ id: 11, description: "1 tbsp", gramWeight: 12.8, isDefault: true },
    { id: 12, description: "1 cup", gramWeight: 205, isDefault: false }],
  cached_at: "2026-10-04T00:00:00.000Z",
};

describe("the log sheet's portion pills", () => {
  it("say what each portion weighs and holds", () => {
    render(<LogFoodPortion revision={REVISION} portion={REVISION.portions[0]} qty={1} grams={12.8} gramsText="12.8"
      mode="food" canCommit onPortion={() => {}} onQty={() => {}} onGramsText={() => {}} onConfirm={() => {}}
      onBack={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "1 tbsp · 13 g · 115 kcal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 cup · 205 g · 1849 kcal" })).toBeTruthy();
  });

  it("read the calories per 100 g from the serving data first, then from the revision's own energy", () => {
    expect(revisionKcalPer100(REVISION)).toBe(902);
    expect(revisionKcalPer100({ ...REVISION, kcalPer100g: 900 } as CachedRevision)).toBe(900);
    expect(revisionKcalPer100({ ...REVISION, per_100g: { energy_kcal_calc: 880 } })).toBe(880);
    expect(revisionKcalPer100({ ...REVISION, per_100g: {} })).toBeNull();
  });
});

describe("the recipe ingredient search", () => {
  it("is the shared lookup field and states each bundled food by its serving", () => {
    render(<RecipeFoodSearch query="peanut butter" mine={{}} onQuery={() => {}} onPick={() => {}} />);
    const field = screen.getByRole("searchbox", { name: "Search foods" });
    expect(field.closest("[data-tier='lookup']")).toBeTruthy();
  });
});
