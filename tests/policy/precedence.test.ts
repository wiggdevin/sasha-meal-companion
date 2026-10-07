import { describe, expect, it } from "vitest";
import { FACET_THRESHOLDS } from "@/lib/foods/facet-thresholds";
import {
  evaluatePolicy,
  resolvePolicyVerdict,
  type PolicyEvidence,
} from "@/lib/policy/constraints";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import { FACET_RULES, type PolicyPreferenceFlag } from "@/lib/policy/facet-rules";

function evidence(overrides: Partial<PolicyEvidence> = {}): PolicyEvidence {
  return {
    foodRefId: null,
    allergenTags: [],
    category: [],
    onEatsList: false,
    onAvoidList: false,
    facetAction: "exclude",
    // Phase 13 §5: these cases are about preference-flag precedence, so the allergens the fixture
    // profile avoids are cleared (the user checked this product) unless a case says otherwise.
    checkedAllergens: ["gluten", "dairy", "apple"],
    ...overrides,
  };
}

const present = (facet: keyof typeof FACET_THRESHOLDS) => ({
  p: FACET_THRESHOLDS[facet].exclude.present,
  rubricVersion: 1,
  judgedAt: "2026-09-20T00:00:00.000Z",
});
const absent = (facet: keyof typeof FACET_THRESHOLDS) => ({
  p: FACET_THRESHOLDS[facet].exclude.absent,
  rubricVersion: 1,
  judgedAt: "2026-09-20T00:00:00.000Z",
});

describe("policy evidence precedence", () => {
  it("resolves shuffled blockers by source precedence rather than input order", () => {
    expect(resolvePolicyVerdict([
      { facet: "meat", source: "jev", outcome: "present" },
      { facet: "beans", source: "category", outcome: "present" },
      { facet: "egg", source: "ingredient", outcome: "present" },
      { facet: "avoid_list", source: "avoid", outcome: "present" },
      { facet: "gluten", source: "floor", outcome: "present" },
    ])).toEqual({ verdict: "blocked", reason: "allergen:gluten" });
  });

  it("does not let a Jev absence clear the gluten floor, and makes no Jev mark (W2c)", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      allergenTags: ["gluten"],
      preferenceFlags: ["no_eggs"],
      facets: { contains_egg: absent("contains_egg") },
    }));

    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("allergen:gluten");
    expect(result.marks?.[0]).toEqual({
      facet: "gluten", source: "floor", outcome: "present",
    });
    expect(result.marks?.some((mark) => mark.source === "jev")).toBe(false);
  });

  it("keeps the Avoid mark ahead of category and Jev evidence", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      onAvoidList: true,
      category: ["beans"],
      preferenceFlags: ["low_fodmap"],
      facets: { beans: absent("beans") },
    }));

    expect(result).toMatchObject({ verdict: "blocked", reason: "avoid_list" });
    const sources = result.marks?.map((mark) => mark.source) ?? [];
    expect(sources[0]).toBe("avoid");
    expect(sources).toContain("category");
    expect(sources).not.toContain("jev");
  });

  it("uses ingredient tags before a conflicting Jev absence", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      allergenTags: ["egg"],
      preferenceFlags: ["no_eggs"],
      facets: { contains_egg: absent("contains_egg") },
    }));

    expect(result).toMatchObject({ verdict: "blocked", reason: "allergen:egg" });
    expect(result.marks?.[0]).toEqual({
      facet: "contains_egg", source: "ingredient", outcome: "present",
    });
  });

  it("keeps missing ingredient evidence unverified when Jev says eggs are absent", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      allergenTags: null,
      onEatsList: true,
      preferenceFlags: ["no_eggs"],
      facets: { contains_egg: absent("contains_egg") },
    }));

    expect(result.verdict).toBe("unverified");
    expect(result.marks ?? []).toContainEqual({
      facet: "contains_egg", source: "ingredient", outcome: "unknown",
    });
  });

  it("W2c: a Jev positive no longer blocks, and a tag list that omits eggs does not clear", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      allergenTags: [],
      preferenceFlags: ["no_eggs"],
      facets: { contains_egg: present("contains_egg") },
    }));

    expect(result.verdict).toBe("unverified");
    expect(result.marks ?? []).toContainEqual({
      facet: "contains_egg", source: "ingredient", outcome: "unknown",
    });
  });

  it("uses only authored policy categories for low FODMAP", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      category: ["onion_garlic"],
      preferenceFlags: ["low_fodmap"],
      facets: { onion_garlic: absent("onion_garlic") },
    }));

    expect(result).toMatchObject({ verdict: "blocked", reason: "category:onion_garlic" });
    expect(result.marks?.[0]).toEqual({
      facet: "onion_garlic", source: "category", outcome: "present",
    });
    expect(result.marks?.filter((mark) => mark.source === "category")).toEqual([
      { facet: "onion_garlic", source: "category", outcome: "present" },
      { facet: "beans", source: "category", outcome: "absent" },
    ]);
    expect(result.marks?.some((mark) => mark.source === "jev")).toBe(false);
  });

  it.each(["present", "absent"] as const)(
    "keeps low FODMAP unverified without authored categories when Jev says %s",
    (outcome) => {
      const judgment = outcome === "present" ? present : absent;
      const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
        category: null,
        preferenceFlags: ["low_fodmap"],
        facets: {
          onion_garlic: judgment("onion_garlic"),
          beans: judgment("beans"),
        },
      }));

      expect(result.verdict).toBe("unverified");
      expect(result.marks?.filter((mark) => mark.source === "category")).toEqual([
        { facet: "onion_garlic", source: "category", outcome: "unknown" },
        { facet: "beans", source: "category", outcome: "unknown" },
      ]);
      expect(result.marks?.some((mark) => mark.source === "jev")).toBe(false);
    },
  );

  it("treats a missing active-preference facet as unverified, never allowed", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      allergenTags: null,
      category: null,
      preferenceFlags: ["vegetarian"],
      facets: {},
    }));

    expect(result.verdict).toBe("unverified");
    expect(result.marks ?? []).toContainEqual({
      facet: "meat", source: "ingredient", outcome: "unknown",
    });
  });

  it("W2c: a Jev meat flag on the logging action neither blocks nor clears", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      facetAction: "mark",
      preferenceFlags: ["vegetarian"],
      facets: { meat: { ...present("meat"), p: FACET_THRESHOLDS.meat.mark.present } },
    }));

    expect(result.verdict).toBe("unverified");
    expect(result.marks?.some((mark) => mark.source === "jev")).toBe(false);
  });

  /** A name that deterministically names each flag's first facet (W2c: Jev no longer can). */
  const NAMES_FIRST_FACET: Record<PolicyPreferenceFlag, string> = {
    vegetarian: "Chicken breast", vegan: "Whole milk", pescatarian: "Chicken breast",
    no_pork: "Pork chop", no_beef: "Beef brisket", no_shellfish: "Shrimp", no_eggs: "Eggs",
    no_soy: "Tofu", no_peanuts: "Peanuts", low_fodmap: "", halal: "Pork chop", kosher: "Pork chop",
  };

  it("blocks every preference when the food's own name or category names its first facet", () => {
    for (const flag of Object.keys(FACET_RULES) as PolicyPreferenceFlag[]) {
      const facet = FACET_RULES[flag][0].facet;
      const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
        preferenceFlags: [flag],
        ...(flag === "low_fodmap" ? { category: [facet] } : { foodName: NAMES_FIRST_FACET[flag] }),
      }));
      expect(result.verdict, flag).toBe("blocked");
      expect(result.marks ?? []).toContainEqual(expect.objectContaining({
        facet, source: flag === "low_fodmap" ? "category" : "ingredient", outcome: "present",
      }));
    }
  });

  it("does not infer halal or kosher from absent forbidden facets", () => {
    for (const flag of ["halal", "kosher"] as const) {
      const facets = Object.fromEntries(FACET_RULES[flag].map(({ facet }) => [facet, absent(facet)]));
      const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
        preferenceFlags: [flag], facets,
      }));
      expect(result.verdict).toBe("unverified");
      expect(result.marks ?? []).toContainEqual({
        facet: flag, source: "ingredient", outcome: "unknown",
      });
    }
  });

  it("allows explicit certification evidence while retaining known-positive blocks", () => {
    const verified = evaluatePolicy(DEFAULT_PROFILE, evidence({
      preferenceFlags: ["halal"],
      verifiedPreferenceFlags: ["halal"],
      facets: {},
    }));
    expect(verified.verdict).toBe("allowed");

    const knownPork = evaluatePolicy(DEFAULT_PROFILE, evidence({
      preferenceFlags: ["halal"],
      verifiedPreferenceFlags: ["halal"],
      foodName: "Pork chop",
    }));
    expect(knownPork.verdict).toBe("blocked");
  });

  it("allows explicit kosher certification when ingredient evidence is missing", () => {
    const result = evaluatePolicy(DEFAULT_PROFILE, evidence({
      allergenTags: null,
      onEatsList: true,
      preferenceFlags: ["kosher"],
      verifiedPreferenceFlags: ["kosher"],
      facets: {},
    }));

    expect(result.verdict).toBe("allowed");
  });
});
