/**
 * Onboarding v2 (BRIEF.md §5): the OnboardingFacts contract in lib/coach/ui-blocks.ts. Sol r1
 * WARN: an earlier draft's zod shape accepted a fact with no matching confidence entry despite
 * the doc comment's claim — these tests pin the enforcement, not just the doc comment.
 */
import { describe, expect, it } from "vitest";
import {
  onboardingConfidenceBand, onboardingFactsSchema, onboardingModelFactsSchema,
} from "@/lib/coach/ui-blocks";

describe("onboardingFactsSchema", () => {
  it("accepts an empty draft", () => {
    expect(onboardingFactsSchema.safeParse({ confidence: {} }).success).toBe(true);
  });

  it("accepts a fact with its matching confidence entry", () => {
    expect(onboardingFactsSchema.safeParse({ goal: "lose_fat", confidence: { goal: 0.9 } }).success)
      .toBe(true);
  });

  it("rejects a fact set with no matching confidence entry at all", () => {
    const result = onboardingFactsSchema.safeParse({ goal: "lose_fat", confidence: {} });
    expect(result.success).toBe(false);
  });

  it("rejects a fact whose confidence entry is for a DIFFERENT field", () => {
    const result = onboardingFactsSchema.safeParse({
      goal: "lose_fat", confidence: { sex: 0.9 },
    });
    expect(result.success).toBe(false);
  });

  it("requires a confidence entry for dietFlags too, the one array field", () => {
    expect(onboardingFactsSchema.safeParse({ dietFlags: ["vegetarian"], confidence: {} }).success)
      .toBe(false);
    expect(onboardingFactsSchema.safeParse(
      { dietFlags: ["vegetarian"], confidence: { dietFlags: 0.8 } },
    ).success).toBe(true);
  });

  it("accepts sex: unspecified (the coordinator's 'prefer not to say' addition)", () => {
    expect(onboardingFactsSchema.safeParse({ sex: "unspecified", confidence: { sex: 0.9 } }).success)
      .toBe(true);
  });

  it("rejects an unknown key (strict)", () => {
    expect(onboardingFactsSchema.safeParse({ confidence: {}, nonsense: true }).success).toBe(false);
  });
});

describe("onboardingModelFactsSchema (coordinator privacy ruling: no demographic field may " +
  "reach the model's reply schema)", () => {
  it("accepts the model's own four fields", () => {
    expect(onboardingModelFactsSchema.safeParse({
      goal: "lose_fat", activity: "moderate", cookingEffort: "minimal", dietFlags: ["vegetarian"],
      confidence: { goal: 0.9, activity: 0.6, cookingEffort: 0.6, dietFlags: 0.8 },
    }).success).toBe(true);
  });

  it("rejects sex, even with a matching confidence entry", () => {
    expect(onboardingModelFactsSchema.safeParse({
      sex: "female", confidence: { sex: 0.9 },
    } as never).success).toBe(false);
  });

  it("rejects birthYear, even with a matching confidence entry", () => {
    expect(onboardingModelFactsSchema.safeParse({
      birthYear: 1992, confidence: { birthYear: 0.9 },
    } as never).success).toBe(false);
  });

  it("rejects heightCm and weightKg too (the coordinator's narrower-than-privacy-strictly-" +
    "requires ruling — the account's own regex reader covers both reliably)", () => {
    expect(onboardingModelFactsSchema.safeParse(
      { heightCm: 178, confidence: { heightCm: 0.9 } } as never,
    ).success).toBe(false);
    expect(onboardingModelFactsSchema.safeParse(
      { weightKg: 75, confidence: { weightKg: 0.9 } } as never,
    ).success).toBe(false);
  });

  it("still requires a confidence entry for every field it sets", () => {
    expect(onboardingModelFactsSchema.safeParse({ goal: "lose_fat", confidence: {} }).success)
      .toBe(false);
  });
});

describe("onboardingConfidenceBand", () => {
  it("bands exactly at the two thresholds", () => {
    expect(onboardingConfidenceBand(0.85)).toBe("high");
    expect(onboardingConfidenceBand(0.86)).toBe("high");
    expect(onboardingConfidenceBand(0.84)).toBe("ghost");
    expect(onboardingConfidenceBand(0.51)).toBe("ghost");
    expect(onboardingConfidenceBand(0.5)).toBe("dropped");
    expect(onboardingConfidenceBand(0)).toBe("dropped");
    expect(onboardingConfidenceBand(undefined)).toBe("none");
  });

  it("treats a non-finite score as absent, not ghost", () => {
    expect(onboardingConfidenceBand(NaN)).toBe("none");
    expect(onboardingConfidenceBand(Infinity)).toBe("none");
    expect(onboardingConfidenceBand(-Infinity)).toBe("none");
  });
});
