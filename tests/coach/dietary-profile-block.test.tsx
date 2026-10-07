// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmProfileInstance = vi.fn();
const confirmFoodPreference = vi.fn();
vi.mock("@/lib/profile/instances-client", () => ({
  confirmProfileInstance: (...a: unknown[]) => confirmProfileInstance(...a),
  confirmFoodPreference: (...a: unknown[]) => confirmFoodPreference(...a),
}));

const { bindAccount, unbindAccount } = await import("@/lib/device/account");
const { default: DietaryProfileProposalBlock } = await import("@/components/coach/blocks/dietary_profile");
const { hydrateDietaryProfileProposal, hydrateFoodPreferenceProposal } =
  await import("@/lib/coach/blocks/hydrate-dietary-profile");
const { profileSummary } = await import("@/lib/policy/profiles/catalog-summary");

afterEach(cleanup);
beforeEach(() => {
  confirmProfileInstance.mockReset().mockResolvedValue({ profileId: "vegan", rules: [] });
  confirmFoodPreference.mockReset().mockResolvedValue({ profileId: "food_preferences", rules: [] });
  unbindAccount();
  bindAccount("u1");
});

describe("DietaryProfileProposalBlock (chat confirm card)", () => {
  it("never writes on render — nothing applied silently", () => {
    const block = hydrateDietaryProfileProposal("blk1", profileSummary("vegan")!);
    const view = render(<DietaryProfileProposalBlock block={block} />);
    expect(confirmProfileInstance).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-block-id="blk1"]')?.getAttribute("style"))
      .toContain("var(--color-feedback-pending)");
  });

  it("confirms only after the profile reaches the server", async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
    let settle!: () => void;
    confirmProfileInstance.mockReturnValue(new Promise<void>((resolve) => { settle = resolve; }));
    const block = hydrateDietaryProfileProposal("blk1", profileSummary("allergy_peanut")!);
    const view = render(<DietaryProfileProposalBlock block={block} />);
    fireEvent.click(screen.getByText("Yes, add this"));

    expect(view.container.querySelector('[data-block-id="blk1"]')
      ?.getAttribute("data-feedback-state")).toBe("pending");
    expect(vibrate).not.toHaveBeenCalled();
    await act(async () => settle());

    expect(view.container.querySelector('[data-block-id="blk1"]')
      ?.getAttribute("data-feedback-state")).toBe("success");
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("a profile-level profile (a named allergy) confirms on the primary tap", async () => {
    const block = hydrateDietaryProfileProposal("blk1", profileSummary("allergy_peanut")!);
    render(<DietaryProfileProposalBlock block={block} />);
    fireEvent.click(screen.getByText("Yes, add this"));
    await waitFor(() => expect(confirmProfileInstance).toHaveBeenCalled());
    const [handle, profileId, confirmations] = confirmProfileInstance.mock.calls[0];
    expect(handle.userId).toBe("u1");
    expect(profileId).toBe("allergy_peanut");
    expect(confirmations).toEqual([{ facet: "contains_peanut", confirmed: true }]);
  });

  it("an item-level religious profile (halal) shows each hard rule with its own Confirm", async () => {
    const block = hydrateDietaryProfileProposal("blk4", profileSummary("halal")!);
    render(<DietaryProfileProposalBlock block={block} />);
    expect(screen.queryByText("Yes, add this")).toBeNull();
    expect(screen.getByText("Not now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm pork" }));
    await waitFor(() => expect(confirmProfileInstance).toHaveBeenCalledTimes(1));
    expect(confirmProfileInstance.mock.calls[0][2]).toEqual([{ facet: "pork", confirmed: true }]);
    // The other two stay to be tapped one by one.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm pork" })).toBeNull());
    expect(screen.getByRole("button", { name: "Confirm alcohol" })).toBeTruthy();
  });

  it("a profile with no non-medical item offers no blanket tap at all, only the item's own Confirm", async () => {
    const block = hydrateDietaryProfileProposal("blk2", profileSummary("g6pd_deficiency")!);
    render(<DietaryProfileProposalBlock block={block} />);
    expect(screen.queryByText("Yes, add this")).toBeNull();
    expect(screen.getByText(/Your clinician.s advice comes first/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(confirmProfileInstance).toHaveBeenCalledTimes(1));
    const [, profileId, confirmations] = confirmProfileInstance.mock.calls[0];
    expect(profileId).toBe("g6pd_deficiency");
    expect(confirmations).toEqual([{ facet: "fava_bean", confirmed: true }]);
  });

  it("a mixed profile's blanket tap never includes a medical item's own facet", async () => {
    // atelvia-style mixed profile is rare in the catalog; drug-interaction profiles cover it
    // (R6), so this proves the classification rule directly against a synthetic mix.
    const mixed = { ...profileSummary("g6pd_deficiency")!, items: [
      { facet: "fava_bean", strength: "never" as const, hardBasis: "user_confirmed_safety" as const },
      { facet: "high_sodium", strength: "limit" as const, hardBasis: "user_confirmed_safety" as const },
    ] };
    const block = hydrateDietaryProfileProposal("blk3", mixed);
    render(<DietaryProfileProposalBlock block={block} />);
    fireEvent.click(screen.getByText("Yes, add this"));
    await waitFor(() => expect(confirmProfileInstance).toHaveBeenCalledTimes(1));
    const [, , confirmations] = confirmProfileInstance.mock.calls[0];
    expect(confirmations).toEqual([{ facet: "high_sodium", confirmed: true }]);
  });

  it("dismissing writes nothing", () => {
    const block = hydrateDietaryProfileProposal("blk1", profileSummary("vegan")!);
    render(<DietaryProfileProposalBlock block={block} />);
    fireEvent.click(screen.getByText("Not now"));
    expect(confirmProfileInstance).not.toHaveBeenCalled();
  });

  it("confirms a like or dislike through its own food-preference write, never a catalog one", async () => {
    const block = hydrateFoodPreferenceProposal("blk4", { foodName: "cilantro", strength: "avoid" });
    render(<DietaryProfileProposalBlock block={block} />);
    fireEvent.click(screen.getByText("Yes, add this"));
    await waitFor(() => expect(confirmFoodPreference).toHaveBeenCalledTimes(1));
    const [handle, foodName, strength] = confirmFoodPreference.mock.calls[0];
    expect(handle.userId).toBe("u1");
    expect([foodName, strength]).toEqual(["cilantro", "avoid"]);
    expect(confirmProfileInstance).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("Added to your profile.")).toBeTruthy());
  });
});
