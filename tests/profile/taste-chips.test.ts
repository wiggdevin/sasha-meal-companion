/**
 * Phase 18 W5b: the pure half of the taste chips — family matching, the fixed question set, the
 * payload builder's own safety re-check, and reading Jev's answers into validated chips.
 */
import { describe, expect, it } from "vitest";
import { jevProvenance, tastePayload } from "@/lib/ai/payloads";
import { CUISINES } from "@/lib/profile/cuisines";
import { SENSORY_TAGS } from "@/lib/profile/taste";
import { matchFamilies, TASTE_CHIP_THRESHOLD, tasteChipsFromAnswers, tasteQuestions } from "@/lib/profile/taste-chips";
import { tasteFamilies } from "@/lib/profile/taste-families";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

const FAMILIES = tasteFamilies();
const yes = (p: number) => ({ noul: p });

describe("family matching", () => {
  it("finds the families the text names, longest first, in text order, at most four", () => {
    expect(FAMILIES.length).toBeGreaterThan(250);
    expect(matchFamilies("I love salmon", FAMILIES)).toEqual(["salmon"]);
    expect(matchFamilies("I hate mushrooms", FAMILIES)).toEqual(["mushrooms"]);
    expect(matchFamilies("I love sweet potatoes and black beans", FAMILIES)).toEqual(["sweet potato", "black beans"]);
    expect(matchFamilies("I hate eggplant", FAMILIES)).toEqual(["eggplant"]);
    expect(matchFamilies("okra, kale, tofu, salmon and tuna", FAMILIES)).toHaveLength(4);
    expect(matchFamilies("I grew up on Tex-Mex", FAMILIES)).toEqual([]);
  });

  it("never returns a name that is not on the family list", () => {
    expect(matchFamilies("I love zorbleflux and salmon", ["salmon"])).toEqual(["salmon"]);
    expect(matchFamilies("I love Salmon", ["Salmon"])).toEqual([]);
  });
});

describe("the fixed questions", () => {
  it("asks 12 tag and 12 cuisine questions plus two per family, within 32, with positional ids", () => {
    const questions = tasteQuestions(["salmon", "okra"]);
    expect(Object.keys(questions)).toHaveLength(28);
    expect(Object.keys(tasteQuestions(["a", "b", "c", "d"]))).toHaveLength(32);
    for (const id of Object.keys(questions)) expect(id).toMatch(/^(like|dislike|tag|cuisine)_\d+$/);
    expect(() => tasteQuestions(["a", "b", "c", "d", "e"])).toThrow();
    expect(() => tasteQuestions(["Salmon, raw"])).toThrow();
    expect(SENSORY_TAGS).toHaveLength(12);
    expect(CUISINES).toHaveLength(12);
  });

  it("the payload builder sends the text as typed and the families only, and refuses kept text", () => {
    const payload = tastePayload({ text: "I love salmon", families: ["salmon"] });
    expect(jevProvenance(payload)).toBe("profile-taste");
    expect(payload.state).toEqual({ text: "I love salmon", foods: ["salmon"] });
    const smuggled = tastePayload({ text: "I love salmon", families: ["salmon"],
      ...{ profile: { conditions: ["celiac"] }, cuisines: ["korean"], taste: { dislikes: ["f:okra"] } } });
    expect(smuggled).toEqual(payload);
    for (const c of [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS]) {
      expect(() => tastePayload({ text: c.text, families: [] })).toThrow(/never sent/);
    }
    expect(() => tastePayload({ text: "I love salmon", families: ["Salmon, raw"] })).toThrow();
  });
});

describe("answers to chips", () => {
  it("suggests only at 0.8 or more, with labels and probabilities", () => {
    expect(TASTE_CHIP_THRESHOLD).toBe(0.8);
    const chips = tasteChipsFromAnswers(["salmon", "okra"], {
      like_0: yes(0.95), dislike_0: yes(0.02), like_1: yes(0.1), dislike_1: yes(0.79),
      tag_0: yes(0.8), tag_1: yes(0.5), cuisine_1: yes(0.9), cuisine_0: yes(0.2),
    });
    expect(chips).toEqual({
      likes: [{ key: "f:salmon", label: "salmon", p: 0.95 }],
      dislikes: [{ key: "t:soft", label: "Soft or mushy textures", p: 0.8 }],
      cuisines: [{ key: "latin_american", label: "Mexican and Latin American", p: 0.9 }],
    });
  });

  it("drops a family both liked and disliked, malformed numbers, and keeps at most six cuisines", () => {
    const answers: Record<string, { noul: number }> = { like_0: yes(0.9), dislike_0: yes(0.9), tag_2: yes(1.5),
      tag_3: yes(Number.NaN) };
    CUISINES.forEach((_, i) => { answers[`cuisine_${i}`] = yes(0.81 + i / 100); });
    const chips = tasteChipsFromAnswers(["okra"], answers);
    expect(chips.likes).toEqual([]);
    expect(chips.dislikes).toEqual([]);
    expect(chips.cuisines.map((c) => c.key)).toEqual(CUISINES.slice(-6).reverse());
  });

  it("never turns a non-canonical family into a chip", () => {
    expect(tasteChipsFromAnswers(["Okra"], { like_0: yes(0.99) }).likes).toEqual([]);
  });
});
