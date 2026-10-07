import { describe, expect, it } from "vitest";
import { CONDITION_RULES } from "@/lib/policy/condition-rules";
import { evaluatePolicy } from "@/lib/policy/constraints";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import { advisoryFlags, enforcedFlags, PREFERENCE_FLAGS } from "@/lib/profile/onboarding-state";

describe("condition and onboarding policy boundaries", () => {
  it("keeps the v1 condition table empty and diagnoses no dietary rule", () => {
    expect(CONDITION_RULES).toEqual([]);
    const evidence = {
      foodRefId: null,
      allergenTags: [],
      category: [],
      onEatsList: true,
      onAvoidList: false,
    };
    const withDiagnosis = { ...DEFAULT_PROFILE, conditions: ["ulcerative colitis"] };
    expect(evaluatePolicy(withDiagnosis, evidence)).toEqual(evaluatePolicy(DEFAULT_PROFILE, evidence));
  });

  it("makes every real app preference enforced and none advisory", () => {
    expect(enforcedFlags()).toEqual(PREFERENCE_FLAGS);
    expect(advisoryFlags()).toEqual([]);
  });
});
