import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { rankFoods, type RankResult } from "@/lib/policy/profiles/rank-foods";
import type { ProfileInstance } from "@/lib/policy/profiles/types";
import { ruleId } from "@/lib/policy/profiles/types";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";

function instance(overrides: Partial<ProfileInstance> & { profileId: string }): ProfileInstance {
  return { source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z", rules: [], options: {}, ...overrides };
}

describe("rankFoods (§4 map §7.2, §9 R5)", () => {
  it("never changes a verdict: evaluatePolicy is unaffected by calling it", () => {
    const evidence = { foodRefId: null, allergenTags: [], category: [], onEatsList: false, onAvoidList: false };
    const before = evaluatePolicy(TEST_PROFILE, evidence);

    const flexitarian = instance({
      profileId: "flexitarian",
      rules: [{
        id: ruleId("flexitarian", "meat"), profileId: "flexitarian", facet: "meat",
        strength: "limit", hardBasis: null, evidenceStrength: "moderate", confirmation: "confirmed",
        expiresAt: null,
      }],
    });
    rankFoods([flexitarian], { meat: "present" });

    const after = evaluatePolicy(TEST_PROFILE, evidence);
    expect(after).toEqual(before);
  });

  it("return type carries no verdict field", () => {
    const result: RankResult = rankFoods([], {});
    expect(Object.keys(result).sort()).toEqual(["reasons", "score"]);
  });

  it("penalizes a limited facet only when it reads present, and only when confirmed", () => {
    const unconfirmed = instance({
      profileId: "flexitarian",
      rules: [{
        id: ruleId("flexitarian", "meat"), profileId: "flexitarian", facet: "meat",
        strength: "limit", hardBasis: null, evidenceStrength: "moderate", confirmation: "unconfirmed",
        expiresAt: null,
      }],
    });
    expect(rankFoods([unconfirmed], { meat: "present" }).score).toBe(0);

    const confirmed: ProfileInstance = { ...unconfirmed,
      rules: unconfirmed.rules.map((r) => ({ ...r, confirmation: "confirmed" })) };
    expect(rankFoods([confirmed], { meat: "present" }).score).toBe(-2);
    expect(rankFoods([confirmed], { meat: "absent" }).score).toBe(0);
    expect(rankFoods([confirmed], {}).score).toBe(0); // unknown never scores
  });

  it("boosts a preferred facet and combines across profiles and rules", () => {
    const pescoPlus = instance({
      profileId: "pescatarian_plus_poultry",
      rules: [
        { id: ruleId("pescatarian_plus_poultry", "omega3_rich"), profileId: "pescatarian_plus_poultry",
          facet: "omega3_rich", strength: "prefer", hardBasis: null, evidenceStrength: "moderate",
          confirmation: "confirmed", expiresAt: null },
        { id: ruleId("pescatarian_plus_poultry", "red_meat"), profileId: "pescatarian_plus_poultry",
          facet: "red_meat", strength: "avoid", hardBasis: null, evidenceStrength: "moderate",
          confirmation: "confirmed", expiresAt: null },
      ],
    });
    const result = rankFoods([pescoPlus], { omega3_rich: "present", red_meat: "present" });
    expect(result.score).toBe(3 - 5);
    expect(result.reasons).toHaveLength(2);
  });

  it("never applies a rank weight to a 'never' rule — hard blocks stay evaluatePolicy's job", () => {
    const hard = instance({
      profileId: "allergy_milk",
      rules: [{
        id: ruleId("allergy_milk", "contains_dairy"), profileId: "allergy_milk", facet: "contains_dairy",
        strength: "never", hardBasis: "allergy", evidenceStrength: "regulatory",
        confirmation: "confirmed", expiresAt: null,
      }],
    });
    expect(rankFoods([hard], { contains_dairy: "present" })).toEqual({ score: 0, reasons: [] });
  });
});
