import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateDietaryProfilesDocument } from "@/lib/policy/profiles/schema";

const DOC_PATH = "docs/research/dietary-profiles.draft.json";

function loadRaw(): unknown {
  return JSON.parse(readFileSync(DOC_PATH, "utf8"));
}

describe("dietary profiles document schema (§9 R5, build-time)", () => {
  it("validates the committed research JSON with every reference resolving", () => {
    const result = validateDietaryProfilesDocument(loadRaw());
    if (!result.valid) {
      throw new Error(`${result.issues.length} unresolved reference(s):\n${
        result.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}`);
    }
    expect(result.valid).toBe(true);
    expect(result.data.profiles.length).toBe(124);
    expect(result.data.new_facets.length).toBe(71);
  });

  it("fails on a dangling facet reference", () => {
    const doc = minimalDoc();
    doc.profiles[0].hard_avoid_facets = ["not_a_real_facet"];
    const result = validateDietaryProfilesDocument(doc);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((issue) =>
      issue.path === "profiles[0:allergy_milk].hard_avoid_facets"
      && issue.message.includes("not_a_real_facet"))).toBe(true);
  });

  it("fails on a dangling citation reference", () => {
    const doc = minimalDoc();
    doc.profiles[0].citations = [{ id: "no_such_source", ref: "x", url: "https://example.com" }];
    const result = validateDietaryProfilesDocument(doc);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((issue) => issue.message.includes("no_such_source"))).toBe(true);
  });

  it("fails on a dangling conflicts reference", () => {
    const doc = minimalDoc();
    doc.profiles[0].conflicts = ["not_a_profile (some note)"];
    const result = validateDietaryProfilesDocument(doc);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues.some((issue) => issue.message.includes("not_a_profile"))).toBe(true);
  });

  it("fails when the shape itself is wrong (missing required field)", () => {
    const doc = minimalDoc() as { profiles: Array<Record<string, unknown>> };
    delete doc.profiles[0].hard_basis;
    const result = validateDietaryProfilesDocument(doc);
    expect(result.valid).toBe(false);
  });

  it("accepts a conflicts entry with a parenthetical annotation, and template facet refs", () => {
    const doc = minimalDoc();
    doc.profiles[0].conflicts = ["allergy_milk (self-note)"];
    doc.profiles[0].hard_avoid_facets = ["contains_allergen:mustard", "contains_ingredient:vinegar"];
    const result = validateDietaryProfilesDocument(doc);
    expect(result.valid).toBe(true);
  });
});

type MinimalProfile = {
  id: string; label: string; category: string; synonyms: string[];
  hard_avoid_facets: string[]; soft_limit_facets: string[]; prefer_facets: string[];
  target_modifiers: Record<string, unknown>; requires_user_confirmation: boolean;
  clinician_note: boolean; evidence: { strength: string; note: string | null };
  citations: { id: string; ref: string; url: string }[]; hard_basis: string | null;
  do: string[]; dont: string[]; jev_design: string; options: unknown[];
  time_window: Record<string, unknown> | null; flex_model: Record<string, unknown> | null;
  conflicts: string[]; existing_facets_used: string[]; new_facets_needed: string[];
};

/** A minimal, otherwise-valid document, mutated per test to introduce exactly one break. */
function minimalDoc(): { version: string; date: string; profiles: MinimalProfile[];
  new_facets: unknown[]; sources: Record<string, { ref: string; url: string }>;
  ambiguous_phrases: Record<string, unknown>; existing_facet_fixes: unknown[] } {
  return {
    version: "0.1.0-draft",
    date: "2026-09-23",
    profiles: [{
      id: "allergy_milk",
      label: "Milk allergy",
      category: "allergy_intolerance",
      synonyms: [],
      hard_avoid_facets: ["contains_dairy"],
      soft_limit_facets: [],
      prefer_facets: [],
      target_modifiers: {},
      requires_user_confirmation: false,
      clinician_note: false,
      evidence: { strength: "regulatory", note: "FALCPA" },
      citations: [{ id: "fda_allergens", ref: "FDA", url: "https://example.com" }],
      hard_basis: "allergy",
      do: [],
      dont: [],
      jev_design: "floor rule",
      options: [],
      time_window: null,
      flex_model: null,
      conflicts: [],
      existing_facets_used: ["contains_dairy"],
      new_facets_needed: [],
    }],
    new_facets: [],
    sources: { fda_allergens: { ref: "FDA", url: "https://example.com" } },
    ambiguous_phrases: { _rule: "n/a" },
    existing_facet_fixes: [],
  };
}
