import { describe, expect, it } from "vitest";
import { activeHardRulesFor } from "@/lib/policy/profiles/account-rules";
import { ruleId, type ProfileInstance, type RuleItem } from "@/lib/policy/profiles/types";

const NOW = new Date("2026-09-24T00:00:00Z");

function rule(overrides: Partial<RuleItem> & Pick<RuleItem, "profileId" | "facet">): RuleItem {
  return {
    id: ruleId(overrides.profileId, overrides.facet),
    strength: "never",
    hardBasis: "user_rule",
    evidenceStrength: null,
    confirmation: "confirmed",
    expiresAt: null,
    ...overrides,
  };
}

function instance(profileId: string, rules: RuleItem[]): ProfileInstance {
  return { profileId, source: "user_stated", confirmedAt: NOW.toISOString(), rules, options: {} };
}

describe("activeHardRulesFor", () => {
  it("carries a confirmed allergy rule through to evaluatePolicy's shape", () => {
    const rules = activeHardRulesFor(
      [instance("allergy_peanut", [
        rule({ profileId: "allergy_peanut", facet: "contains_peanut", hardBasis: "allergy" }),
      ])],
      NOW,
    );
    expect(rules.items.map((r) => ({ facet: r.facet, profileId: r.profileId }))).toEqual([{ facet: "contains_peanut", profileId: "allergy_peanut" }]);
  });

  it("drops an unconfirmed medical (user_confirmed_safety) item — R5", () => {
    const rules = activeHardRulesFor(
      [instance("atelvia_interaction", [
        rule({
          profileId: "atelvia_interaction", facet: "contains_ingredient:calcium",
          hardBasis: "user_confirmed_safety", confirmation: "unconfirmed",
        }),
      ])],
      NOW,
    );
    expect(rules.items).toEqual([]);
  });

  it("includes the same medical item once the user confirms it one at a time", () => {
    const rules = activeHardRulesFor(
      [instance("atelvia_interaction", [
        rule({
          profileId: "atelvia_interaction", facet: "contains_ingredient:calcium",
          hardBasis: "user_confirmed_safety", confirmation: "confirmed",
        }),
      ])],
      NOW,
    );
    expect(rules.items.map((r) => ({ facet: r.facet, profileId: r.profileId }))).toEqual([{ facet: "contains_ingredient:calcium", profileId: "atelvia_interaction" }]);
  });

  it("drops a soft (non-'never') rule even when confirmed — ranking's job, not evaluatePolicy's", () => {
    const rules = activeHardRulesFor(
      [instance("ibs_low_fodmap", [
        rule({ profileId: "ibs_low_fodmap", facet: "fodmap_fructan", strength: "limit", hardBasis: null }),
      ])],
      NOW,
    );
    expect(rules.items).toEqual([]);
  });

  it("drops a hard rule that has already expired", () => {
    const rules = activeHardRulesFor(
      [instance("halal", [
        rule({
          profileId: "halal", facet: "pork", hardBasis: "religious",
          expiresAt: "2026-01-01T00:00:00Z",
        }),
      ])],
      NOW,
    );
    expect(rules.items).toEqual([]);
  });

  it("declined never reaches profileRules even though it once had a permitted basis", () => {
    const rules = activeHardRulesFor(
      [instance("vegan", [
        rule({ profileId: "vegan", facet: "gelatin", hardBasis: "user_rule", confirmation: "declined" }),
      ])],
      NOW,
    );
    expect(rules.items).toEqual([]);
  });

  it("mixes rules from several confirmed instances", () => {
    const rules = activeHardRulesFor(
      [
        instance("halal", [rule({ profileId: "halal", facet: "pork", hardBasis: "religious" })]),
        instance("allergy_egg", [rule({ profileId: "allergy_egg", facet: "contains_egg", hardBasis: "allergy" })]),
      ],
      NOW,
    );
    expect(rules.items).toHaveLength(2);
    expect(rules.items.map((r) => r.facet).sort()).toEqual(["contains_egg", "pork"]);
  });
});
