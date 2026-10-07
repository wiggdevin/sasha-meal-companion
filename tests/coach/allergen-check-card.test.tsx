// @vitest-environment jsdom

/**
 * sol FIX (review round 1, finding #4): the barcode card's "I checked the label" button showed
 * the pre-check findings (e.g. "Check the label for gluten") AND the post-check "Marked checked"
 * confirmation at the same time, until the page refreshed — contradictory state on screen. The
 * findings that the check itself resolves (the `checkable` ones) drop out once the mark succeeds;
 * a finding the check never affects (an already `listed`/blocked allergen) keeps showing.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AllergenCheck from "@/components/coach/editors/AllergenCheck";
import type { BarcodeMatch } from "@/lib/barcode/client";

vi.mock("@/lib/foods/allergen-check-client", () => ({ markAllergenChecked: vi.fn(async () => true) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function match(overrides: Partial<BarcodeMatch> = {}): BarcodeMatch {
  return {
    foodRefId: "ref-1", catalogFoodId: 7, revisionId: 70,
    description: "Trail mix", brand: null, source: "off",
    qualityClass: "crowd", qualityFlags: [], per100g: {},
    portions: [], ingredientsText: null, allergenTags: [], attribution: null,
    policy: { verdict: "unverified", allergens: [
      { allergen: "gluten", outcome: "unknown", checkable: true,
        text: "No gluten listed, but labels need not declare it. Check with the maker and mark "
          + "this product checked" },
    ] },
    ...overrides,
  };
}

describe("AllergenCheck: no contradictory state once the check succeeds", () => {
  it("drops the stale checkable finding once marked checked, instead of showing it beside " +
    "the confirmation", async () => {
    render(<AllergenCheck match={match()} />);

    expect(screen.getByText(/Check the label for gluten|Check with the maker/)).toBeTruthy();
    fireEvent.click(screen.getByText("I checked the label"));

    await screen.findByText("Marked checked for this product.");
    expect(screen.queryByText(/Check with the maker/)).toBeNull();
  });

  it("keeps a finding the check never affects (an already-listed allergen) showing alongside " +
    "the confirmation", async () => {
    render(<AllergenCheck match={match({ policy: { verdict: "blocked", reason: "allergen:sesame",
      allergens: [
        { allergen: "sesame", outcome: "present", checkable: false, text: "Contains sesame" },
        { allergen: "gluten", outcome: "unknown", checkable: true,
          text: "No gluten listed, but labels need not declare it. Check with the maker and "
            + "mark this product checked" },
      ] } })} />);

    fireEvent.click(screen.getByText("I checked the label"));

    await screen.findByText("Marked checked for this product.");
    expect(screen.getByText("Contains sesame")).toBeTruthy();
    expect(screen.queryByText(/Check with the maker/)).toBeNull();
  });
});
