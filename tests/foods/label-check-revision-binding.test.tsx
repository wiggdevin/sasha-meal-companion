// @vitest-environment jsdom

/**
 * sol BLOCK (review round 2): the Foods sheet's "I checked the label" button sent no
 * `expectedRevisions`, so the server marked whichever catalog or user-food revision was current
 * when the request arrived, not the one this sheet actually resolved to — violating §9 R1's
 * exact-product requirement. The barcode card already binds its own displayed revision
 * (components/coach/editors/AllergenCheck.tsx, `match.revisionId`); this closes the same gap for
 * the Foods sheet by resolving the food ref's current revision (and identity, in the SAME read —
 * review round 2's own fix, lib/foods/food-revision-client.ts) when the sheet mounts, and sending
 * the revision back on the tap.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabelCheck } from "@/components/FoodSheet";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { markFoodLabelChecked } from "@/lib/foods/label-check-client";
import { currentRevisionAndIdentityFor } from "@/lib/foods/food-revision-client";
import { FOOD_PREF_REFS_KEY } from "@/lib/foods/prefs-client";
import type { Food } from "@/lib/foods";

vi.mock("@/lib/foods/label-check-client", () => ({ markFoodLabelChecked: vi.fn(async () => ["sesame"]) }));
// review round 1 (phase 13 slice 2, BLOCK fix): readiness also waits on the identity half of this
// read (tests/foods/label-check-product-identity.test.tsx) — this file is about revision BINDING,
// not identity, so its default mock resolves a real identity rather than null, the same way it
// already resolves a real revision. review round 2: both now come from one call.
vi.mock("@/lib/foods/food-revision-client", () => ({
  currentRevisionAndIdentityFor: vi.fn(async () => (
    { revisionId: 410, identity: { description: "Hummus, classic", brand: null } })),
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
  id: "hummus", name: "Hummus", role: "protein", unit: "oz",
  perUnit: { protein: 4, carbs: 6, fat: 5 }, status: "neutral",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

function seedRefs(refs: { userRefId?: string; catalogRefId?: string }) {
  localStorage.setItem(FOOD_PREF_REFS_KEY, JSON.stringify({ [USER_ID]: { [food.id]: refs } }));
}

afterEach(() => { cleanup(); vi.clearAllMocks(); unbindAccount(); localStorage.clear(); });

describe("LabelCheck: binds the mark to the revision resolved when the sheet opened", () => {
  it("sends expectedRevisions and the ref for the resolved catalog ref, not an unbounded mark",
    async () => {
      bindAccount(USER_ID);
      seedRefs({ catalogRefId: "ref-catalog-1" });
      render(<LabelCheck food={food} />);

      const button = await screen.findByText("I checked the label");
      fireEvent.click(button);

      await screen.findByText(/You checked this label/);
      expect(vi.mocked(currentRevisionAndIdentityFor)).toHaveBeenCalledWith("ref-catalog-1");
      expect(vi.mocked(markFoodLabelChecked)).toHaveBeenCalledWith("hummus", true,
        { allergenKeys: ["sesame"], expectedRevisions: { "ref-catalog-1": 410 },
        foodRefId: "ref-catalog-1" });
    });

  it("resolves no revision (and calls no lookup) when no account is bound to resolve a ref for",
    async () => {
      seedRefs({ catalogRefId: "ref-catalog-1" });
      render(<LabelCheck food={food} />);

      const button = await screen.findByText("I checked the label");
      fireEvent.click(button);

      await screen.findByText(/You checked this label/);
      expect(vi.mocked(currentRevisionAndIdentityFor)).not.toHaveBeenCalled();
      expect(vi.mocked(markFoodLabelChecked)).toHaveBeenCalledWith("hummus", true,
        { allergenKeys: ["sesame"], expectedRevisions: {}, foodRefId: null });
    });
});

describe("ORCHESTRATOR fix (round 7, item 2): the button is disabled until the ref and its " +
  "expected revision resolve, and both are sent unchanged at tap — never re-read", () => {
  it("the button is disabled while currentRevisionAndIdentityFor is still pending, and enables " +
    "once it resolves", async () => {
    let resolveLookup: (v: { revisionId: number; identity: { description: string; brand: null } }) => void
      = () => {};
    vi.mocked(currentRevisionAndIdentityFor).mockReturnValueOnce(
      new Promise((resolve) => { resolveLookup = resolve; }));
    bindAccount(USER_ID);
    seedRefs({ catalogRefId: "ref-catalog-1" });
    render(<LabelCheck food={food} />);

    const button = await screen.findByText("I checked the label") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    // A tap while disabled fires no request at all.
    expect(vi.mocked(markFoodLabelChecked)).not.toHaveBeenCalled();

    resolveLookup({ revisionId: 410, identity: { description: "Hummus, classic", brand: null } });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText(/You checked this label/);
    expect(vi.mocked(markFoodLabelChecked)).toHaveBeenCalledWith("hummus", true,
      { allergenKeys: ["sesame"], expectedRevisions: { "ref-catalog-1": 410 },
        foodRefId: "ref-catalog-1" });
  });

  it("a background mapping change after the sheet opens (the cache now pointing at a different " +
    "ref) does not change what the tap sends — the ref and revision bound at open time go out " +
    "unchanged", async () => {
    bindAccount(USER_ID);
    seedRefs({ catalogRefId: "ref-catalog-1" });
    render(<LabelCheck food={food} />);

    const button = await screen.findByText("I checked the label") as HTMLButtonElement;
    await waitFor(() =>
      expect(vi.mocked(currentRevisionAndIdentityFor)).toHaveBeenCalledWith("ref-catalog-1"));
    await waitFor(() => expect(button.disabled).toBe(false));

    // The cache now maps this food to a DIFFERENT product — the sheet already resolved its own
    // ref and revision before this happened, and must not pick the new one up.
    seedRefs({ catalogRefId: "ref-catalog-2" });

    fireEvent.click(button);
    await screen.findByText(/You checked this label/);
    expect(vi.mocked(currentRevisionAndIdentityFor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markFoodLabelChecked)).toHaveBeenCalledWith("hummus", true,
      { allergenKeys: ["sesame"], expectedRevisions: { "ref-catalog-1": 410 },
        foodRefId: "ref-catalog-1" });
  });
});

describe("sol BLOCK (review round 1, finding #3): a failed lookup must never permit an unbound " +
  "label check", () => {
  it("keeps the button disabled when a ref is bound but currentRevisionAndIdentityFor resolves " +
    "null (a transient read failure), so a tap can never send an empty expectedRevisions map " +
    "for an active ref", async () => {
    vi.mocked(currentRevisionAndIdentityFor).mockResolvedValueOnce(null);
    bindAccount(USER_ID);
    seedRefs({ catalogRefId: "ref-catalog-1" });
    render(<LabelCheck food={food} />);

    const button = await screen.findByText("I checked the label") as HTMLButtonElement;
    await waitFor(() =>
      expect(vi.mocked(currentRevisionAndIdentityFor)).toHaveBeenCalledWith("ref-catalog-1"));
    // Give any (wrong) enabling effect a tick to run before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    expect(vi.mocked(markFoodLabelChecked)).not.toHaveBeenCalled();
  });
});
