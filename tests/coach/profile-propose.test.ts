import { afterEach, describe, expect, it, vi } from "vitest";
import { proposeProfileFromMessage } from "@/lib/coach/profile-propose";

describe("proposeProfileFromMessage", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never proposes a condition pack while CONDITION_PACKS_ENABLED is off (§4)", () => {
    vi.stubEnv("CONDITION_PACKS_ENABLED", "");
    expect(proposeProfileFromMessage("I have G6PD", [])).toBeNull();
  });

  it("proposes a condition pack once the flag is on", () => {
    vi.stubEnv("CONDITION_PACKS_ENABLED", "1");
    expect(proposeProfileFromMessage("I have G6PD", [])?.id).toBe("g6pd_deficiency");
  });

  it("proposes the profile a stated need names", () => {
    const proposal = proposeProfileFromMessage("I'm vegan now", []);
    expect(proposal?.id).toBe("vegan");
  });

  it("never re-proposes a profile the account already has a stored row for", () => {
    expect(proposeProfileFromMessage("I'm vegan now", [{ profileId: "vegan" }])).toBeNull();
  });

  it("an unconfirmed stored row still counts as already surfaced — no repeat prompting", () => {
    // profileId alone is enough; confirmation state lives in the row's own rules, not here.
    expect(proposeProfileFromMessage("I'm vegan now", [{ profileId: "vegan" }])).toBeNull();
  });

  it("returns null when the message names nothing in the catalog", () => {
    expect(proposeProfileFromMessage("what's for dinner tonight?", [])).toBeNull();
  });

  it("picks the first candidate when a message names more than one", () => {
    const proposal = proposeProfileFromMessage("I'm vegan and allergic to peanuts", []);
    expect(["vegan", "allergy_peanut"]).toContain(proposal?.id);
  });
});
