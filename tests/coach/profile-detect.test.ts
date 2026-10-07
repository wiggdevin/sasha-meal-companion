import { describe, expect, it } from "vitest";
import { detectProfileCandidates } from "@/lib/coach/profile-detect";

describe("detectProfileCandidates", () => {
  it("matches a profile whose own synonym the sentence names verbatim", () => {
    expect(detectProfileCandidates("I'm vegan now, please keep that in mind"))
      .toEqual(["vegan"]);
  });

  it("matches a multi-word synonym phrase", () => {
    expect(detectProfileCandidates("just so you know, I have a peanut allergy"))
      .toEqual(["allergy_peanut"]);
  });

  it("is case-insensitive", () => {
    expect(detectProfileCandidates("I'M MUSLIM and need halal meals")).toContain("halal");
  });

  it("never matches a substring inside an unrelated word", () => {
    // "vegan" must not match inside "leguminous", and the sentence names no real synonym.
    expect(detectProfileCandidates("I like leguminous vegetables")).toEqual([]);
  });

  it("returns concrete profile ids only, never a broader inferred category", () => {
    // "healthy eating" names no concrete profile synonym anywhere in the catalog.
    expect(detectProfileCandidates("I want to eat healthy")).toEqual([]);
  });

  it("returns every distinct profile a sentence names, in catalog order, without duplicates", () => {
    const candidates = detectProfileCandidates("I'm vegan and also allergic to peanuts");
    expect(candidates).toContain("vegan");
    expect(candidates).toContain("allergy_peanut");
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("an empty or whitespace-only message matches nothing", () => {
    expect(detectProfileCandidates("")).toEqual([]);
    expect(detectProfileCandidates("   ")).toEqual([]);
  });
});
