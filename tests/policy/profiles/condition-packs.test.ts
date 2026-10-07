import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONDITION_RULES } from "@/lib/policy/condition-rules";
import { evaluatePolicy } from "@/lib/policy/constraints";
import {
  availableConditionPacks, CLINICIAN_ADVICE_FIRST_NOTE, conditionPackFrom, conditionPacks,
  conditionPacksEnabled,
} from "@/lib/policy/profiles/condition-packs";
import type { RawProfile } from "@/lib/policy/profiles/schema";
import { isActiveHardRule, ruleId } from "@/lib/policy/profiles/types";

function rawProfile(overrides: Partial<RawProfile> & { id: string }): RawProfile {
  return {
    label: overrides.id, category: "medical_condition", synonyms: [],
    hard_avoid_facets: [], soft_limit_facets: [], prefer_facets: [], target_modifiers: {},
    requires_user_confirmation: true, clinician_note: true,
    evidence: { strength: "moderate", note: null }, citations: [{ id: "src1", ref: "r", url: "u" }],
    hard_basis: null, do: [], dont: [], jev_design: "", options: [], time_window: null,
    flex_model: null, conflicts: [], existing_facets_used: [], new_facets_needed: [],
    ...overrides,
  };
}

const hypertension = rawProfile({
  id: "hypertension", soft_limit_facets: ["high_sodium"], evidence: { strength: "strong", note: null },
  citations: [{ id: "dash_source", ref: "DASH", url: "https://example.com" }],
});

const maoiLike = rawProfile({
  id: "maoi_like", category: "clinician_directive",
  hard_avoid_facets: ["tyramine_rich"], hard_basis: "user_confirmed_safety",
});

const diagnosisOnly = rawProfile({ id: "ulcerative_colitis", soft_limit_facets: [], prefer_facets: [] });

describe("condition packs (§4 DECIDED, §9 R5)", () => {
  it("keeps CONDITION_RULES empty — a diagnosis alone still never blocks", () => {
    expect(CONDITION_RULES).toEqual([]);
  });

  it("builds a pack from a soft-rule condition profile, with one source per rule", () => {
    const pack = conditionPackFrom(hypertension);
    expect(pack).not.toBeNull();
    expect(pack!.softRules).toEqual([
      { facet: "high_sodium", strength: "limit", evidenceStrength: "strong", sourceCitationId: "dash_source" },
    ]);
    expect(pack!.clinicianNote).toBe(CLINICIAN_ADVICE_FIRST_NOTE);
    expect(pack!.confirmableSafetyItems).toEqual([]);
  });

  it("carries user_confirmed_safety items as confirmable candidates, never pre-confirmed", () => {
    const pack = conditionPackFrom(maoiLike);
    expect(pack!.confirmableSafetyItems).toEqual([{ facet: "tyramine_rich", hardBasis: "user_confirmed_safety" }]);
  });

  it("a pack's confirmable safety item stays inert to evaluatePolicy until confirmed (table-driven)", () => {
    const pack = conditionPackFrom(maoiLike)!;
    const [item] = pack.confirmableSafetyItems;
    const unconfirmedRule = {
      id: ruleId(pack.profileId, item.facet), profileId: pack.profileId, facet: item.facet,
      strength: "never" as const, hardBasis: item.hardBasis, evidenceStrength: "strong" as const,
      confirmation: "unconfirmed" as const, expiresAt: null,
    };
    expect(isActiveHardRule(unconfirmedRule, new Date())).toBe(false);
    const result = evaluatePolicy(
      { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] },
      { foodRefId: null, allergenTags: [], category: [], onEatsList: false, onAvoidList: false,
        ingredientsText: "tyramine-rich aged cheese",
        profileRules: { items: [unconfirmedRule], asOf: new Date() } }, // passed, and still inert
    );
    expect(result.verdict).toBe("allowed");

    const confirmedRule = { ...unconfirmedRule, confirmation: "confirmed" as const };
    expect(isActiveHardRule(confirmedRule, new Date())).toBe(true);
  });

  it("returns null for an unrelated category, and for a profile with no soft or safety content", () => {
    expect(conditionPackFrom(rawProfile({ id: "allergy_milk", category: "allergy_intolerance",
      hard_basis: "allergy", hard_avoid_facets: ["contains_dairy"] }))).toBeNull();
    expect(conditionPackFrom(diagnosisOnly)).toBeNull();
  });

  it("conditionPacksEnabled defaults off, and only \"1\" turns it on", () => {
    expect(conditionPacksEnabled({ CONDITION_PACKS_ENABLED: undefined })).toBe(false);
    expect(conditionPacksEnabled({ CONDITION_PACKS_ENABLED: "true" })).toBe(false);
    expect(conditionPacksEnabled({ CONDITION_PACKS_ENABLED: "1" })).toBe(true);
  });

  it("availableConditionPacks is empty whenever the flag is off, regardless of how many exist", () => {
    const profiles = [hypertension, maoiLike];
    expect(availableConditionPacks(profiles, { CONDITION_PACKS_ENABLED: undefined })).toEqual([]);
    expect(availableConditionPacks(profiles, { CONDITION_PACKS_ENABLED: "1" }).length).toBe(2);
  });

  it("builds a real pack list from the full research document", () => {
    const doc = JSON.parse(readFileSync("docs/research/dietary-profiles.draft.json", "utf8")) as {
      profiles: RawProfile[];
    };
    const packs = conditionPacks(doc.profiles);
    expect(packs.length).toBeGreaterThan(10);
    expect(packs.every((pack) => pack.clinicianNote === CLINICIAN_ADVICE_FIRST_NOTE)).toBe(true);
    // Every soft rule's citation, when present, must be one of that profile's own citation ids.
    const byId = new Map(doc.profiles.map((p) => [p.id, p]));
    for (const pack of packs) {
      const ids = new Set(byId.get(pack.profileId)!.citations.map((c) => c.id));
      for (const rule of pack.softRules) {
        if (rule.sourceCitationId !== null) expect(ids.has(rule.sourceCitationId)).toBe(true);
      }
    }
  });
});
