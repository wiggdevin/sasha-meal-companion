import { describe, expect, it } from "vitest";
import { catalogSummaries, profileSummary } from "@/lib/policy/profiles/catalog-summary";

describe("profileSummary", () => {
  it("carries the catalog's own plain-language do/dont copy for a known profile", () => {
    const summary = profileSummary("allergy_milk");
    expect(summary).not.toBeNull();
    expect(summary!.label).toBe("Milk allergy");
    expect(summary!.hardBasis).toBe("allergy");
    expect(summary!.do.length).toBeGreaterThan(0);
    expect(summary!.dont.length).toBeGreaterThan(0);
    expect(summary!.synonyms).toContain("dairy allergy");
    expect(summary!.items).toEqual([
      { facet: "contains_dairy", strength: "never", hardBasis: "allergy" },
    ]);
  });

  it("returns null for an id the catalog does not carry", () => {
    expect(profileSummary("not_a_real_profile")).toBeNull();
  });
});

describe("profileSummary options (§4: religious entries offer options, not one fixed rule)", () => {
  it("carries each boolean variant with its label and default", () => {
    const halal = profileSummary("halal")!;
    expect(halal.options).toEqual(expect.arrayContaining([
      { id: "zabiha_meat_only", label: "Meat must be halal-slaughtered", default: true },
      { id: "no_non_fish_seafood", label: expect.any(String), default: false },
      { id: "no_carmine", label: expect.any(String), default: false },
    ]));
  });

  it("leaves out a variant whose answer is not yes/no (the instance model stores booleans)", () => {
    expect(profileSummary("halal")!.options.some((option) => option.id === "gelatin_rule"))
      .toBe(false);
    expect(profileSummary("kosher")!.options.map((option) => option.id))
      .toEqual(expect.arrayContaining(["passover", "kitniyot", "gelatin_if_certified"]));
  });
});

describe("catalogSummaries", () => {
  it("lists every profile the validated document carries, each with a non-empty label", () => {
    const summaries = catalogSummaries();
    expect(summaries.length).toBeGreaterThan(100);
    for (const summary of summaries) {
      expect(summary.label.length).toBeGreaterThan(0);
      expect(summary.id.length).toBeGreaterThan(0);
    }
  });

  it("is stable and side-effect free across calls", () => {
    expect(catalogSummaries()).toEqual(catalogSummaries());
  });
});
