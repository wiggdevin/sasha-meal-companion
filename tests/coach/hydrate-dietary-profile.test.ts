import { describe, expect, it } from "vitest";
import { hydrateDietaryProfileProposal } from "@/lib/coach/blocks/hydrate-dietary-profile";
import { profileSummary } from "@/lib/policy/profiles/catalog-summary";
import { uiBlockSchema } from "@/lib/coach/ui-blocks";

describe("hydrateDietaryProfileProposal", () => {
  it("builds a schema-valid block from the catalog summary", () => {
    const summary = profileSummary("vegan")!;
    const block = hydrateDietaryProfileProposal("blk1", summary);
    expect(uiBlockSchema.safeParse(block).success).toBe(true);
    expect(block.profileId).toBe("vegan");
    expect(block.kind).toBe("dietary_profile_proposal");
  });

  it("carries the profile's own rule items, unmodified", () => {
    const summary = profileSummary("allergy_peanut")!;
    const block = hydrateDietaryProfileProposal("blk2", summary);
    expect(block.items).toEqual(summary.items);
  });

  it("carries whether the profile's hard rules need item-level confirmation", () => {
    expect(hydrateDietaryProfileProposal("h", profileSummary("halal")!).requiresUserConfirmation)
      .toBe(true);
    expect(hydrateDietaryProfileProposal("p", profileSummary("allergy_peanut")!)
      .requiresUserConfirmation).toBe(false);
  });

  it("bounds do/dont to at most 3 lines each, within the block's own size limit", () => {
    const summary = { ...profileSummary("vegan")!, do: ["a", "b", "c", "d", "e"], dont: ["x", "y", "z", "w"] };
    const block = hydrateDietaryProfileProposal("blk3", summary);
    expect(block.do.length).toBeLessThanOrEqual(3);
    expect(block.dont.length).toBeLessThanOrEqual(3);
  });
});
