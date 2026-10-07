/**
 * Phase 13 slice 4 (§4, §9 R5): the reply check judges a named food against the account's confirmed
 * profile hard rules. It has no cached facets, so a confirmed rule it cannot clear leaves the food
 * "unverified" (never "allowed"); an unconfirmed medical rule changes nothing.
 */
import { describe, expect, it } from "vitest";
import { checkItem } from "@/lib/coach/policy";
import { checkReply } from "@/lib/coach/reply-check";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { ruleId, type RuleItem } from "@/lib/policy/profiles/types";

const rule = (hardBasis: RuleItem["hardBasis"], confirmation: RuleItem["confirmation"]): RuleItem => ({
  id: ruleId("p", "pork"), profileId: "p", facet: "pork", strength: "never", hardBasis,
  evidenceStrength: null, confirmation, expiresAt: null,
});
const profileWith = (items: RuleItem[]): ConstraintProfile => ({
  avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
  profileRules: { items, asOf: new Date("2026-09-25T00:00:00.000Z") },
});
const evidence = { "Pork chop": {
  foodRefId: "ref-1", allergenTags: [], category: [], onEatsList: true, onAvoidList: false,
}, "House special": {
  foodRefId: "ref-2", allergenTags: [], category: [], onEatsList: true, onAvoidList: false,
} };

function verdictFor(profile: ConstraintProfile, name: keyof typeof evidence = "Pork chop") {
  return checkReply({
    text: `Try the ${name.toLowerCase()}.`, named: [{ name, foodRefId: evidence[name].foodRefId }],
    draft: null, actions: [], evidence, profile,
  }).suggestions[0].verdict;
}

describe("reply check with profile rules", () => {
  it("does not clear a named food under a confirmed religious rule", () => {
    // Phase 18 W2c: the reply check reads the food's own evidence, and "Pork chop" names pork.
    expect(verdictFor(profileWith([rule("religious", "confirmed")]))).toBe("blocked");
    // A name that says nothing about pork cannot be cleared: unverified, never allowed.
    expect(verdictFor(profileWith([rule("religious", "confirmed")]), "House special"))
      .toBe("unverified");
  });

  it("ignores an unconfirmed medical rule", () => {
    expect(verdictFor(profileWith([rule("user_confirmed_safety", "unconfirmed")]))).toBe("allowed");
  });

  it("leaves the facet-less pre-check (checkItem's default) untouched", () => {
    const item = { ...evidence["Pork chop"], name: "Pork chop", grams: null };
    expect(checkItem(item, profileWith([rule("religious", "confirmed")])).verdict).toBe("allowed");
  });
});
