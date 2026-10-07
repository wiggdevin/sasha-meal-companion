// @vitest-environment jsdom

/**
 * sol BLOCK (review round 2): "I checked the label" marks a hidden cached catalog revision from a
 * generic food sheet that shows no product identity or label, so the account cannot verify the
 * product they inspected is the revision being cleared. `food.name` (the Sheet's title) is the
 * account's own saved label for the row, not necessarily the resolved ref's own catalog
 * description or brand — a remapped ref, or a name that simply reads differently than the
 * catalog's own copy, leaves the account guessing. The card must show the resolved product's own
 * identity so it can be compared against the physical label the account actually read.
 *
 * review round 2 (sol BLOCK, follow-up): the revision id and this identity now come from the same
 * `currentRevisionAndIdentityFor` call (lib/foods/food-revision-client.ts) instead of two raced
 * separately, so they can never name two different products.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabelCheck } from "@/components/FoodSheet";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { FOOD_PREF_REFS_KEY } from "@/lib/foods/prefs-client";
import { currentRevisionAndIdentityFor } from "@/lib/foods/food-revision-client";
import type { Food } from "@/lib/foods";

vi.mock("@/lib/foods/label-check-client", () => ({ markFoodLabelChecked: vi.fn(async () => ["sesame"]) }));
vi.mock("@/lib/foods/food-revision-client", () => ({
  currentRevisionAndIdentityFor: vi.fn(async () => null),
}));
vi.mock("@/lib/constraints-client", () => ({
  loadConstraints: vi.fn(async () => ({
    profile: { avoid_allergens: ["sesame"], avoid_food_ref_ids: [], banned_categories: [],
      conditions: [], notes: null },
    rev: 1,
  })),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const food: Food = {
  id: "trail-mix", name: "Trail mix", role: "fat", unit: "oz",
  perUnit: { protein: 4, carbs: 6, fat: 9 }, status: "neutral",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

function seedRefs(refs: { userRefId?: string; catalogRefId?: string }) {
  localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify({ [USER_ID]: { [food.id]: refs } }));
}

afterEach(() => { cleanup(); vi.clearAllMocks(); unbindAccount(); localStorage.clear(); });

describe("LabelCheck: shows the resolved product's own identity, not just food.name", () => {
  it("renders the resolved catalog revision's description and brand once it resolves", async () => {
    vi.mocked(currentRevisionAndIdentityFor).mockResolvedValueOnce(
      { revisionId: 410, identity: { description: "Deluxe trail mix", brand: "Acme" } });
    bindAccount(USER_ID);
    seedRefs({ catalogRefId: "ref-catalog-1" });
    render(<LabelCheck food={food} />);

    await waitFor(() => expect(vi.mocked(currentRevisionAndIdentityFor))
      .toHaveBeenCalledWith("ref-catalog-1"));
    expect(await screen.findByText("Deluxe trail mix · Acme")).toBeTruthy();
  });

  it("renders no identity line, and calls no lookup, when no ref resolves at all", async () => {
    render(<LabelCheck food={food} />);
    await screen.findByText("I checked the label");
    expect(vi.mocked(currentRevisionAndIdentityFor)).not.toHaveBeenCalled();
  });
});

describe("sol BLOCK (review round 1, phase 13 slice 2): a failed identity lookup must never " +
  "permit an unverified-product label check", () => {
  it("keeps the button disabled when a ref is bound but currentRevisionAndIdentityFor resolves " +
    "null (a transient read failure or a remapped ref), so a tap can never mark a product the " +
    "account was never shown the identity of — the same 'never permit an unbound check' rule " +
    "finding #3 already gives a failed lookup, extended to identity", async () => {
    bindAccount(USER_ID);
    seedRefs({ catalogRefId: "ref-catalog-1" });
    render(<LabelCheck food={food} />);

    const button = await screen.findByText("I checked the label") as HTMLButtonElement;
    await waitFor(() => expect(vi.mocked(currentRevisionAndIdentityFor))
      .toHaveBeenCalledWith("ref-catalog-1"));
    // Give any (wrong) enabling effect a tick to run before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.disabled).toBe(true);
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("enables the button once identity actually resolves, showing the exact product beside it",
    async () => {
      vi.mocked(currentRevisionAndIdentityFor).mockResolvedValueOnce(
        { revisionId: 410, identity: { description: "Deluxe trail mix", brand: "Acme" } });
      bindAccount(USER_ID);
      seedRefs({ catalogRefId: "ref-catalog-1" });
      render(<LabelCheck food={food} />);

      expect(await screen.findByText("Deluxe trail mix · Acme")).toBeTruthy();
      const button = await screen.findByText("I checked the label") as HTMLButtonElement;
      await waitFor(() => expect(button.disabled).toBe(false));
    });
});
