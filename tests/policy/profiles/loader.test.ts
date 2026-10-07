import { describe, expect, it } from "vitest";
import { PROFILE_DEFINITIONS, profileDefinition } from "@/lib/policy/profiles/catalog";
import { buildProfileInstance, loadProfileCatalog, profileDefinitionFrom }
  from "@/lib/policy/profiles/loader";
import type { RawProfile } from "@/lib/policy/profiles/schema";
import { isActiveHardRule, parseRuleId } from "@/lib/policy/profiles/types";

const milkAllergy: RawProfile = {
  id: "allergy_milk", label: "Milk allergy", category: "allergy_intolerance", synonyms: [],
  hard_avoid_facets: ["contains_dairy"], soft_limit_facets: [], prefer_facets: [],
  target_modifiers: {}, requires_user_confirmation: false, clinician_note: false,
  evidence: { strength: "regulatory", note: null },
  citations: [], hard_basis: "allergy", do: [], dont: [], jev_design: "", options: [],
  time_window: null, flex_model: null, conflicts: [], existing_facets_used: ["contains_dairy"],
  new_facets_needed: [],
};

const pescatarianPlusPoultry: RawProfile = {
  id: "pescatarian_plus_poultry", label: "Mostly pescatarian, sometimes chicken",
  category: "ethical_lifestyle", synonyms: [],
  hard_avoid_facets: [], soft_limit_facets: ["red_meat"], prefer_facets: ["omega3_rich"],
  target_modifiers: {}, requires_user_confirmation: true, clinician_note: false,
  evidence: { strength: "moderate", note: null }, citations: [], hard_basis: null,
  do: [], dont: [], jev_design: "", options: [], time_window: null,
  flex_model: {
    base: { facet: "meat", strength: "avoid" },
    exceptions: [{ facet: "poultry", allowance: "sometimes", strength: "allowed_in_budget" }],
  },
  conflicts: [], existing_facets_used: ["meat"], new_facets_needed: ["poultry", "omega3_rich", "red_meat"],
};

const maoi: RawProfile = {
  id: "maoi", label: "MAO inhibitor", category: "medication_interaction", synonyms: [],
  hard_avoid_facets: ["tyramine_rich", "alcohol"], soft_limit_facets: ["caffeine"], prefer_facets: [],
  target_modifiers: { label_list: "phenelzine: ..." }, requires_user_confirmation: true,
  clinician_note: true, evidence: { strength: "strong", note: null }, citations: [],
  hard_basis: "user_confirmed_safety", do: [], dont: [], jev_design: "", options: [],
  time_window: null, flex_model: null, conflicts: [], existing_facets_used: ["alcohol"],
  new_facets_needed: ["caffeine", "tyramine_rich"],
};

describe("profile catalog loader (§9 R5)", () => {
  it("builds one rule template per hard/soft/prefer facet, with a typed id", () => {
    const def = profileDefinitionFrom(milkAllergy);
    expect(def.templates).toHaveLength(1);
    const [rule] = def.templates;
    expect(rule.facet).toBe("contains_dairy");
    expect(rule.strength).toBe("never");
    expect(rule.hardBasis).toBe("allergy");
    expect(rule.evidenceStrength).toBe("regulatory");
    expect(rule.expiresAt).toBeNull();
    expect(parseRuleId(rule.id)).toEqual({ profileId: "allergy_milk", facet: "contains_dairy" });
  });

  it("normalizes flex_model's prose 'allowed_in_budget' strength to the typed 'sometimes'", () => {
    const def = profileDefinitionFrom(pescatarianPlusPoultry);
    const byFacet = Object.fromEntries(def.templates.map((t) => [t.facet, t]));
    expect(byFacet.meat.strength).toBe("avoid");
    expect(byFacet.poultry.strength).toBe("sometimes");
    expect(byFacet.red_meat.strength).toBe("limit");
    expect(byFacet.omega3_rich.strength).toBe("prefer");
  });

  it("loads a catalog keyed by profile id", () => {
    const catalog = loadProfileCatalog([milkAllergy, pescatarianPlusPoultry]);
    expect([...catalog.keys()]).toEqual(["allergy_milk", "pescatarian_plus_poultry"]);
  });

  it("a hard rule item stays inert until its own facet is confirmed, even when the profile itself is", () => {
    const def = profileDefinitionFrom(milkAllergy);
    const uncomfirmed = buildProfileInstance(def, {
      source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
    });
    expect(uncomfirmed.rules[0].confirmation).toBe("unconfirmed");
    expect(isActiveHardRule(uncomfirmed.rules[0], new Date("2026-09-24"))).toBe(false);

    const confirmed = buildProfileInstance(def, {
      source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
      confirmations: [{ facet: "contains_dairy", confirmed: true }],
    });
    expect(confirmed.rules[0].confirmation).toBe("confirmed");
    expect(isActiveHardRule(confirmed.rules[0], new Date("2026-09-24"))).toBe(true);
  });

  it("a declined hard item never becomes active, and an expired one lapses", () => {
    const def = profileDefinitionFrom(maoi);
    const instance = buildProfileInstance(def, {
      source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
      confirmations: [
        { facet: "tyramine_rich", confirmed: true, expiresAt: "2026-01-01T00:00:00Z" },
        { facet: "alcohol", confirmed: false },
      ],
    });
    const tyramine = instance.rules.find((r) => r.facet === "tyramine_rich")!;
    const alcohol = instance.rules.find((r) => r.facet === "alcohol")!;
    expect(tyramine.confirmation).toBe("confirmed");
    expect(isActiveHardRule(tyramine, new Date("2026-09-24"))).toBe(false); // expired
    expect(alcohol.confirmation).toBe("declined");
    expect(isActiveHardRule(alcohol, new Date("2026-09-24"))).toBe(false);
  });

  it("a soft item (limit/sometimes/prefer) is confirmed with the profile — ranking never blocks", () => {
    const def = profileDefinitionFrom(pescatarianPlusPoultry);
    const instance = buildProfileInstance(def, {
      source: "user_stated", confirmedAt: "2026-09-24T00:00:00Z",
    });
    for (const rule of instance.rules) expect(rule.confirmation).toBe("confirmed");
  });

  it("loads the full real catalog (124 profiles) at build time via the catalog module", () => {
    expect(PROFILE_DEFINITIONS.size).toBe(124);
    expect(profileDefinition("allergy_milk")?.hardBasis).toBe("allergy");
    expect(profileDefinition("celiac")?.hardBasis).toBe("celiac");
    expect(profileDefinition("no-such-profile")).toBeUndefined();
  });

  it("keeps CONDITION_RULES-style diagnosis-only profiles with no permitted hard basis", () => {
    // A medical_condition profile with hard_basis null (soft-only) never produces a "never" rule
    // with a basis, so it can never become an active hard block (matches CONDITION_RULES = []).
    const softOnly = [...PROFILE_DEFINITIONS.values()]
      .find((d) => d.category === "medical_condition" && d.hardBasis === null);
    expect(softOnly).toBeDefined();
    expect(softOnly!.templates.every((t) => t.strength !== "never")).toBe(true);
  });
});
