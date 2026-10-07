// @vitest-environment jsdom

/**
 * Phase 18 W2a UI hand-off (docs/plans/2026-10-05-backend-ui-handoffs.md items 10-11; spec §7.2):
 * the Foods sheet's "I checked the label" never offers to cover an allergen key the food's
 * detail holds for review (`FoodDetail.heldAllergens`, `lib/policy/held-allergens.ts`) — the
 * user's check cannot clear a hold either way (lib/policy/allergens.ts allergenFinding). A held
 * key shows the held copy instead, built on the imported `HELD_ALLERGEN_TEXT` constant. A food
 * with no `heldAllergens` (no catalog detail, or a cached detail from before the field existed)
 * behaves exactly as it did before this change.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabelCheck } from "@/components/FoodSheet";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { loadConstraints } from "@/lib/constraints-client";
import { markFoodLabelChecked } from "@/lib/foods/label-check-client";
import { getFoodDetail } from "@/lib/catalog-client";
import { FOOD_PREF_REFS_KEY } from "@/lib/foods/prefs-client";
import type { Food } from "@/lib/foods";

vi.mock("@/lib/constraints-client", () => ({ loadConstraints: vi.fn() }));
vi.mock("@/lib/foods/label-check-client", () => ({ markFoodLabelChecked: vi.fn(async () => ["dairy"]) }));
vi.mock("@/lib/foods/food-revision-client", () => ({
  currentRevisionAndIdentityFor: vi.fn(async () => (
    { revisionId: 410, identity: { description: "Trail mix", brand: null } })),
}));
vi.mock("@/lib/catalog-client", () => ({ getFoodDetail: vi.fn() }));

function profileWith(allergens: string[]) {
  return { profile: { avoid_allergens: allergens, avoid_food_ref_ids: [], banned_categories: [],
    conditions: [], notes: null }, rev: 1 };
}

const USER_ID = "11111111-1111-4111-8111-111111111111";

function makeFood(overrides: Partial<Food> = {}): Food {
  return {
    id: "trail-mix", name: "Trail mix", role: "fat", unit: "oz",
    perUnit: { protein: 4, carbs: 6, fat: 9 }, status: "neutral",
    updatedAt: "2026-09-20T00:00:00.000Z", catalogFoodId: 7, ...overrides,
  };
}

function seedRefs(foodId: string, refs: { userRefId?: string; catalogRefId?: string }) {
  localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify({ [USER_ID]: { [foodId]: refs } }));
}

afterEach(() => { cleanup(); vi.clearAllMocks(); unbindAccount(); localStorage.clear(); });

describe("LabelCheck: a held allergen is never offered the check", () => {
  it("hides the button entirely when every allergen the account avoids is held, and shows the " +
    "held copy built on the imported constant", async () => {
    vi.mocked(loadConstraints).mockResolvedValue(profileWith(["peanut"]));
    vi.mocked(getFoodDetail).mockResolvedValue(
      { kind: "ok", detail: { heldAllergens: ["peanut"] } } as never);
    bindAccount(USER_ID);
    seedRefs("trail-mix", { catalogRefId: "ref-catalog-1" });

    render(<LabelCheck food={makeFood()} />);

    await screen.findByText("Peanut: Not verified. Evidence under review");
    expect(screen.queryByText("I checked the label")).toBeNull();
    expect(screen.queryByText(/Read this product's ingredient list/)).toBeNull();
  });

  it("mixed: the button and its copy cover only the non-held key, and the held key still shows " +
    "its own held line", async () => {
    vi.mocked(loadConstraints).mockResolvedValue(profileWith(["dairy", "peanut"]));
    vi.mocked(getFoodDetail).mockResolvedValue(
      { kind: "ok", detail: { heldAllergens: ["peanut"] } } as never);
    bindAccount(USER_ID);
    seedRefs("trail-mix", { catalogRefId: "ref-catalog-1" });

    render(<LabelCheck food={makeFood()} />);

    await screen.findByText("Peanut: Not verified. Evidence under review");
    const prompt = await screen.findByText(/Read this product's ingredient list for/);
    expect(prompt.textContent).toContain("dairy");
    expect(prompt.textContent).not.toContain("peanut");

    const button = await screen.findByText("I checked the label") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await screen.findByText(/You checked this label for dairy/);
    expect(vi.mocked(markFoodLabelChecked)).toHaveBeenCalledWith("trail-mix", true,
      expect.objectContaining({ allergenKeys: ["dairy"] }));
  });

  it("a food with no heldAllergens on its detail (an older cached read) behaves as before: the " +
    "button covers every allergen the account avoids", async () => {
    vi.mocked(loadConstraints).mockResolvedValue(profileWith(["dairy"]));
    vi.mocked(getFoodDetail).mockResolvedValue({ kind: "ok", detail: {} } as never);
    bindAccount(USER_ID);
    seedRefs("trail-mix", { catalogRefId: "ref-catalog-1" });

    render(<LabelCheck food={makeFood()} />);

    expect(screen.queryByText(/Not verified/)).toBeNull();
    const button = await screen.findByText("I checked the label") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);

    await screen.findByText(/You checked this label for dairy/);
    expect(vi.mocked(markFoodLabelChecked)).toHaveBeenCalledWith("trail-mix", true,
      expect.objectContaining({ allergenKeys: ["dairy"] }));
  });

  it("a food with no catalogFoodId never calls getFoodDetail, and behaves as before", async () => {
    vi.mocked(loadConstraints).mockResolvedValue(profileWith(["dairy"]));
    bindAccount(USER_ID);
    seedRefs("no-catalog-food", { catalogRefId: "ref-catalog-1" });

    render(<LabelCheck food={makeFood({ id: "no-catalog-food", catalogFoodId: undefined })} />);

    const button = await screen.findByText("I checked the label") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(vi.mocked(getFoodDetail)).not.toHaveBeenCalled();
  });
});
