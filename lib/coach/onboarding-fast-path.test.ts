/**
 * BRIEF.md §6 Lane 1 acceptance: "10+ bare-number vs. unit-worded utterances banded correctly."
 * Every case below asserts both the extracted value AND its confidence band (never presence
 * alone — a wrong band is as much a bug here as a wrong value).
 */
import { describe, expect, it } from "vitest";
import { onboardingConfidenceBand } from "@/lib/coach/ui-blocks";
import {
  extractFastPath, GHOST_CONFIDENCE, HIGH_CONFIDENCE, redactAgeAndSex, sanitizeDietFlags,
} from "@/lib/coach/onboarding-fast-path";

const NOW = new Date("2026-10-06T12:00:00Z");

describe("extractFastPath — unit-worded utterances band HIGH", () => {
  it("height in feet and inches, with the apostrophe mark", () => {
    const r = extractFastPath("I'm 5'10 and want to get started", NOW);
    expect(r.heightCm).toBeCloseTo(177.8, 1);
    expect(r.confidence.heightCm).toBe(HIGH_CONFIDENCE);
    expect(onboardingConfidenceBand(r.confidence.heightCm)).toBe("high");
  });

  it("height in explicit centimeters", () => {
    const r = extractFastPath("I'm 178 cm tall", NOW);
    expect(r.heightCm).toBe(178);
    expect(r.confidence.heightCm).toBe(HIGH_CONFIDENCE);
  });

  it("weight in explicit pounds", () => {
    const r = extractFastPath("I weigh 165 lbs right now", NOW);
    expect(r.weightKg).toBeCloseTo(74.84, 1);
    expect(r.confidence.weightKg).toBe(HIGH_CONFIDENCE);
  });

  it("weight in explicit kilograms", () => {
    const r = extractFastPath("about 75 kg these days", NOW);
    expect(r.weightKg).toBe(75);
    expect(r.confidence.weightKg).toBe(HIGH_CONFIDENCE);
  });

  it("age with the 'years old' unit word maps to a birth year, visibly", () => {
    const r = extractFastPath("I'm 34 years old", NOW);
    expect(r.birthYear).toBe(1992); // 2026 - 34
    expect(r.confidence.birthYear).toBe(HIGH_CONFIDENCE);
  });

  it("an explicit 'born in' year", () => {
    const r = extractFastPath("born in 1990, if that matters", NOW);
    expect(r.birthYear).toBe(1990);
    expect(r.confidence.birthYear).toBe(HIGH_CONFIDENCE);
  });

  it("goal phrase: lose fat", () => {
    const r = extractFastPath("I want to lose some fat", NOW);
    expect(r.goal).toBe("lose_fat");
    expect(r.confidence.goal).toBe(HIGH_CONFIDENCE);
  });

  it("goal phrase: build muscle", () => {
    const r = extractFastPath("trying to build muscle this year", NOW);
    expect(r.goal).toBe("gain_muscle");
    expect(r.confidence.goal).toBe(HIGH_CONFIDENCE);
  });

  it("goal phrase: maintain", () => {
    const r = extractFastPath("just want to maintain for now", NOW);
    expect(r.goal).toBe("maintain");
    expect(r.confidence.goal).toBe(HIGH_CONFIDENCE);
  });

  it("explicit sex word: male", () => {
    const r = extractFastPath("I'm a 34 year old male", NOW);
    expect(r.sex).toBe("male");
    expect(r.confidence.sex).toBe(HIGH_CONFIDENCE);
  });

  it("explicit sex word: female", () => {
    const r = extractFastPath("I'm female, 28", NOW);
    expect(r.sex).toBe("female");
    expect(r.confidence.sex).toBe(HIGH_CONFIDENCE);
  });
});

describe("extractFastPath — bare numbers with no unit word band GHOST, never HIGH", () => {
  it("a bare age with no 'years old'", () => {
    const r = extractFastPath("I'm 34, want to get in shape", NOW);
    expect(r.birthYear).toBe(1992);
    expect(r.confidence.birthYear).toBe(GHOST_CONFIDENCE);
    expect(onboardingConfidenceBand(r.confidence.birthYear)).toBe("ghost");
  });

  it("a bare 4-digit year with no 'born' anchor", () => {
    const r = extractFastPath("1992 I think", NOW);
    expect(r.birthYear).toBe(1992);
    expect(r.confidence.birthYear).toBe(GHOST_CONFIDENCE);
  });

  it("a bare weight number near 'weigh' with no unit", () => {
    const r = extractFastPath("I weigh about 165", NOW);
    expect(r.confidence.weightKg).toBe(GHOST_CONFIDENCE);
    expect(onboardingConfidenceBand(r.confidence.weightKg)).toBe("ghost");
  });

  it("a bare height-range number near 'tall' with no unit", () => {
    const r = extractFastPath("I'm pretty tall, like 178", NOW);
    expect(r.heightCm).toBe(178);
    expect(r.confidence.heightCm).toBe(GHOST_CONFIDENCE);
  });

  it("never promotes a bare number to HIGH confidence, whatever the field", () => {
    const utterances = ["I'm 34", "1992", "I weigh about 165", "I'm pretty tall, like 178"];
    for (const text of utterances) {
      const r = extractFastPath(text, NOW);
      for (const score of Object.values(r.confidence)) expect(score).toBeLessThan(HIGH_CONFIDENCE);
    }
  });
});

describe("extractFastPath — negation (Sol r1 WARN)", () => {
  it("never reads a negated goal as a positive one", () => {
    const r = extractFastPath("I don't want to lose weight right now", NOW);
    expect(r.goal).toBeUndefined();
    expect(r.confidence.goal).toBeUndefined();
  });

  it("never reads a negated sex word as that sex", () => {
    const r = extractFastPath("I'm not male, by the way", NOW);
    expect(r.sex).toBeUndefined();
    expect(r.confidence.sex).toBeUndefined();
  });

  it("still reads an un-negated goal or sex normally", () => {
    expect(extractFastPath("I want to lose weight", NOW).goal).toBe("lose_fat");
    expect(extractFastPath("I'm male", NOW).sex).toBe("male");
  });

  // Sol r2 WARN: a negation in an earlier, unrelated clause must not suppress a later one.
  it("a negation in an earlier clause does not suppress a goal in a later clause", () => {
    expect(extractFastPath("I don't smoke; want to lose fat", NOW).goal).toBe("lose_fat");
  });

  it("a negation in an earlier clause does not suppress a sex word in a later clause", () => {
    expect(extractFastPath("I don't smoke, but I'm male", NOW).sex).toBe("male");
  });

  // Sol r2 WARN: checking only the first occurrence of a pattern missed a later affirmative
  // repeat of the SAME goal after an earlier negated mention of it.
  it("reads a later affirmative repeat even when an earlier mention of the same goal was negated", () => {
    const r = extractFastPath("I don't want to lose weight, actually I do want to lose fat", NOW);
    expect(r.goal).toBe("lose_fat");
    expect(r.confidence.goal).toBe(HIGH_CONFIDENCE);
  });
});

describe("extractFastPath — activity level ordering (Sol r1 WARN)", () => {
  it("reads 'lightly active' as light, not the generic active level", () => {
    const r = extractFastPath("I'm lightly active most days", NOW);
    expect(r.activity).toBe("light");
  });

  it("reads 'moderately active' as moderate, not the generic active level", () => {
    const r = extractFastPath("I'd say I'm moderately active", NOW);
    expect(r.activity).toBe("moderate");
  });

  it("still reads a bare 'active' as the active level", () => {
    expect(extractFastPath("I'm pretty active", NOW).activity).toBe("active");
  });
});

describe("extractFastPath — 'y.o.' age shorthand (Sol r1 NIT)", () => {
  it("reads '34 y.o.' followed by a period", () => {
    const r = extractFastPath("34 y.o. looking to get started", NOW);
    expect(r.birthYear).toBe(1992);
    expect(r.confidence.birthYear).toBe(HIGH_CONFIDENCE);
  });
});

describe("extractFastPath — declining to say (coordinator scope addition)", () => {
  it("reads an explicit decline as sex: unspecified, at high confidence", () => {
    const r = extractFastPath("I'd rather not say, but I'm 34 and want to lose fat", NOW);
    expect(r.sex).toBe("unspecified");
    expect(r.confidence.sex).toBe(HIGH_CONFIDENCE);
  });

  // Sol r2 WARN: an unanchored decline phrase about something ELSE (weight, here) must never
  // override an explicit sex word already given.
  it("an explicit sex word wins over a decline phrase about something else", () => {
    const r = extractFastPath("I am male; prefer not to say my weight", NOW);
    expect(r.sex).toBe("male");
    expect(r.confidence.sex).toBe(HIGH_CONFIDENCE);
  });
});

describe("redactAgeAndSex (coordinator privacy ruling, tests/ai/no-demographics-payload.test.ts)", () => {
  it("strips the exact spans extractFastPath reads as age or sex, nothing else", () => {
    const text = "I'm a 34 year old woman who wants to lose fat";
    const redacted = redactAgeAndSex(text);
    expect(redacted).not.toMatch(/\b34\b/);
    expect(redacted).not.toMatch(/\bwoman\b/);
    expect(redacted).toContain("wants to lose fat");
  });

  it("leaves height, weight and goal content untouched", () => {
    const redacted = redactAgeAndSex("5'10, 165 lbs, want to lose fat");
    expect(redacted).toBe("5'10, 165 lbs, want to lose fat");
  });

  it("redacts a bare age, an explicit sex word, and a decline phrase", () => {
    expect(redactAgeAndSex("I'm 34")).not.toMatch(/34/);
    expect(redactAgeAndSex("I'm male")).not.toMatch(/\bmale\b/);
    expect(redactAgeAndSex("prefer not to say")).not.toMatch(/prefer not to say/);
  });

  it("is case-insensitive, same as the extractors read normalized text", () => {
    expect(redactAgeAndSex("I'm 34 Years Old, a WOMAN")).not.toMatch(/34|woman/i);
  });

  // Sol privacy-round BLOCK: "34-year-old" (hyphenated, no spaces) slipped through untouched.
  it("redacts the hyphenated 'NN-year-old' form, not only the spaced-out one", () => {
    const text = "I am a 34-year-old vegetarian woman and moderately active";
    const redacted = redactAgeAndSex(text);
    expect(redacted).not.toMatch(/34/);
    expect(redacted).not.toMatch(/\bwoman\b/);
    expect(redacted).toContain("vegetarian");
    expect(redacted).toContain("moderately active");
  });

  it("never throws on non-string input", () => {
    expect(redactAgeAndSex(undefined as unknown as string)).toBe("");
  });

  it("collapses the whitespace a removed span leaves behind", () => {
    expect(redactAgeAndSex("I'm 34, 5'10")).not.toMatch(/\s{2,}/);
  });
});

describe("sanitizeDietFlags (Sol privacy-round WARN: a hallucinated reply could echo a " +
  "demographic word back into a diet flag)", () => {
  it("drops a flag containing a digit", () => {
    expect(sanitizeDietFlags(["vegetarian", "34"])).toEqual(["vegetarian"]);
  });

  it("drops a flag that is a sex word", () => {
    expect(sanitizeDietFlags(["woman", "no shellfish"])).toEqual(["no shellfish"]);
  });

  it("returns undefined, not an empty array, when every flag was dropped", () => {
    expect(sanitizeDietFlags(["34", "woman"])).toBeUndefined();
  });

  it("passes undefined through and leaves a clean list untouched", () => {
    expect(sanitizeDietFlags(undefined)).toBeUndefined();
    expect(sanitizeDietFlags(["vegetarian", "no pork"])).toEqual(["vegetarian", "no pork"]);
  });
});

describe("extractFastPath — misses say nothing rather than guess", () => {
  it("empty text yields an empty draft, not a guess", () => {
    expect(extractFastPath("", NOW)).toEqual({ confidence: {} });
  });

  it("text with no recognizable field yields an empty draft", () => {
    expect(extractFastPath("just saying hello", NOW)).toEqual({ confidence: {} });
  });

  it("a combined sentence resolves every field it can, independently", () => {
    const r = extractFastPath("I'm a 34 year old male, 5'10, 165 lbs, want to build muscle", NOW);
    expect(r.sex).toBe("male");
    expect(r.birthYear).toBe(1992);
    expect(r.heightCm).toBeCloseTo(177.8, 1);
    expect(r.weightKg).toBeCloseTo(74.84, 1);
    expect(r.goal).toBe("gain_muscle");
    expect(r.confidence.sex).toBe(HIGH_CONFIDENCE);
    expect(r.confidence.birthYear).toBe(HIGH_CONFIDENCE);
    expect(r.confidence.heightCm).toBe(HIGH_CONFIDENCE);
    expect(r.confidence.weightKg).toBe(HIGH_CONFIDENCE);
    expect(r.confidence.goal).toBe(HIGH_CONFIDENCE);
  });
});
