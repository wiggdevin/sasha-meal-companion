import { describe, expect, it } from "vitest";
import { activeHardRulesFor } from "@/lib/policy/profiles/account-rules";
import {
  LEGACY_PREFERENCE_FLAGS, legacyInstanceFromCatalog, legacyProfileIdsFor,
  profileInstancesForLegacyFlag, profileInstancesForLegacyFlags,
} from "@/lib/policy/profiles/legacy-flags";
import { rankFoods } from "@/lib/policy/profiles/rank-foods";
import { PREFERENCE_FLAGS } from "@/lib/profile/onboarding-state";

const NOW = "2026-09-24T00:00:00Z";

describe("LEGACY_PREFERENCE_FLAGS", () => {
  it("names exactly the 12 flags onboarding-state.ts still enforces", () => {
    expect([...LEGACY_PREFERENCE_FLAGS].sort()).toEqual([...PREFERENCE_FLAGS].sort());
  });
});

describe("profileInstancesForLegacyFlag", () => {
  it.each([
    ["vegetarian", ["vegetarian_lacto_ovo"]],
    ["vegan", ["vegan"]],
    ["pescatarian", ["pescatarian"]],
    ["no_shellfish", ["allergy_crustacean", "allergy_mollusc"]],
    ["no_eggs", ["allergy_egg"]],
    ["no_soy", ["allergy_soy"]],
    ["no_peanuts", ["allergy_peanut"]],
    ["low_fodmap", ["ibs_low_fodmap"]],
    ["halal", ["halal"]],
    ["kosher", ["kosher"]],
  ] as const)("%s maps onto %j, every hard item pre-confirmed", (flag, expectedIds) => {
    const instances = profileInstancesForLegacyFlag(flag, NOW);
    expect(instances.map((instance) => instance.profileId).sort()).toEqual([...expectedIds].sort());
    for (const instance of instances) {
      expect(instance.confirmedAt).toBe(NOW);
      expect(instance.source).toBe("user_stated");
      for (const rule of instance.rules) {
        if (rule.strength === "never" && rule.hardBasis !== null) {
          expect(rule.confirmation).toBe("confirmed");
          // None of the 12 legacy flags is medical: user_confirmed_safety never appears here.
          expect(rule.hardBasis).not.toBe("user_confirmed_safety");
        }
      }
    }
  });

  it.each(["no_pork", "no_beef"] as const)(
    "%s mints a minimal confirmed user_rule instance the catalog does not model",
    (flag) => {
      const [instance] = profileInstancesForLegacyFlag(flag, NOW);
      expect(instance.rules).toHaveLength(1);
      expect(instance.rules[0].strength).toBe("never");
      expect(instance.rules[0].hardBasis).toBe("user_rule");
      expect(instance.rules[0].confirmation).toBe("confirmed");
      expect(instance.rules[0].facet).toMatch(/^contains_ingredient:/);
    },
  );

  it("every confirmed hard rule reaches evaluatePolicy's profileRules", () => {
    const instances = profileInstancesForLegacyFlag("halal", NOW);
    const rules = activeHardRulesFor(instances, new Date(NOW));
    expect(rules.items.length).toBeGreaterThan(0);
    expect(rules.items.every((rule) => rule.profileId === "halal")).toBe(true);
  });

  it("vegan's soft prefer facets reach rankFoods without needing a separate confirmation", () => {
    const instances = profileInstancesForLegacyFlag("vegan", NOW);
    const { score, reasons } = rankFoods(instances, { protein_dense: "present" });
    expect(score).toBeGreaterThan(0);
    expect(reasons.some((r) => r.facet === "protein_dense")).toBe(true);
  });
});

describe("profileInstancesForLegacyFlags", () => {
  it("flattens several flags and keeps every flag's own rows distinct", () => {
    const instances = profileInstancesForLegacyFlags(["halal", "no_peanuts"], NOW);
    expect(instances.map((i) => i.profileId).sort()).toEqual(["allergy_peanut", "halal"]);
  });

  it("an empty flag list produces no instances", () => {
    expect(profileInstancesForLegacyFlags([], NOW)).toEqual([]);
  });
});

describe("legacyInstanceFromCatalog (deepseek FIX, p13-s4 review)", () => {
  it("never confirms a user_confirmed_safety item, even for a catalog id a flag could name", () => {
    // No legacy flag maps to a medical profile today; the guard is in code, not only the header.
    const instance = legacyInstanceFromCatalog("g6pd_deficiency", NOW)!;
    const fava = instance.rules.find((rule) => rule.facet === "fava_bean");
    expect(fava?.hardBasis).toBe("user_confirmed_safety");
    expect(fava?.confirmation).not.toBe("confirmed");
  });
});

describe("legacyProfileIdsFor", () => {
  it("names every profile id the set flags synthesize, catalog-backed or minted", () => {
    expect([...legacyProfileIdsFor(["no_shellfish", "no_pork", "halal"])].sort()).toEqual([
      "allergy_crustacean", "allergy_mollusc", "halal", "legacy_no_pork",
    ]);
  });
});
