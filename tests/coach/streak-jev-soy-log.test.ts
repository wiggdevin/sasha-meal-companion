import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";
import { logCommitPolicyIssues, markLoggedActions, RULES_UNREADABLE_MESSAGE } from "@/lib/coach/log-policy";
import { suggestionFoodIdentity } from "@/lib/coach/suggest-policy";
import { TEST_PROFILE as DEFAULT_PROFILE } from "@/tests/helpers/constraint-profile";
import { labelCheckNeeded } from "@/components/coach/editors/not-verified";

const logAction = {
  kind: "log_meal",
  actionId: "action-1",
  date: "2026-09-20",
  slot: "meal-2",
  flagged: [],
  items: [{
    name: "Smoked tofu",
    grams: 100,
    foodRefId: "food-ref-1",
    catalogFoodRevisionId: 467,
    kcalPer100g: 170,
    proteinPer100g: 19,
    carbsPer100g: 3,
    fatPer100g: 9,
    verdict: "unverified",
  }],
} satisfies CoachAction;

describe("streak: cached Jev facets mark logs without refusing them", () => {
  afterEach(() => vi.restoreAllMocks());

  it("marks a soy food off-plan under no_soy and keeps the log action", async () => {
    const result = await markLoggedActions("user-1", [logAction], DEFAULT_PROFILE, {
      evidence: {
        status: "ready",
        preferenceFlags: ["no_soy"],
        byIdentity: {
          "ref:food-ref-1": {
            allergenTags: [],
            policyCategories: [],
            facets: { contains_soy: { p: 0.99, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00.000Z" } },
            noCook: null,
            onEatsList: false,
            onAvoidList: false,
            role: null,
          },
        },
      },
    });

    expect(result.actions).toEqual([expect.objectContaining({
      kind: "log_meal",
      flagged: ["Smoked tofu"],
      items: [expect.objectContaining({ name: "Smoked tofu", verdict: "blocked" })],
    })]);
    expect(result.notices).toEqual(["Off-plan: Smoked tofu."]);
  });

  /**
   * Owner ruling (2026-10-02): religious/user_rule/diet-preference rules fail safe. This test used
   * to pin the opposite: evidence.preferenceFlags.length === 0 skipped marking entirely, on the
   * theory that an account with no active preferences has nothing to lose from an unreadable
   * read. But the real loader's unavailable() (lib/coach/suggest-policy.ts) ALWAYS answers
   * preferenceFlags: [] — whether the account truly has no preferences or the read itself failed
   * are indistinguishable from this evidence alone, so the early return never fired in production
   * and a failed read was silently treated as "nothing to check." It now marks every non-blocked
   * item unverified instead, the same as the branch below with active preferences.
   */
  it("marks the log unverified when evidence is unavailable, even with no active preferences", async () => {
    const result = await markLoggedActions("user-1", [logAction], DEFAULT_PROFILE, {
      evidence: { status: "unavailable", preferenceFlags: [], byIdentity: {} },
    });

    expect(result.actions).toEqual([expect.objectContaining({
      kind: "log_meal",
      flagged: [],
      items: [expect.objectContaining({ name: "Smoked tofu", verdict: "unverified" })],
    })]);
    expect(result.notices).toEqual([
      "Not verified: Smoked tofu (your food rules could not be checked).",
    ]);
  });

  it("adds a visible preference notice for an unverified item", async () => {
    // Phase 18 W2c: "Smoked tofu" now names soy itself and is blocked by its own name, so the
    // unverified case uses a name that says nothing about soy.
    const bar = { ...logAction, items: [{ ...logAction.items[0], name: "Protein bar" }] };
    const result = await markLoggedActions("user-1", [bar], DEFAULT_PROFILE, {
      evidence: {
        status: "ready",
        preferenceFlags: ["no_soy"],
        byIdentity: {},
      },
    });

    expect(result.actions).toEqual([expect.objectContaining({
      kind: "log_meal",
      flagged: [],
      items: [expect.objectContaining({ name: "Protein bar", verdict: "unverified" })],
    })]);
    expect(result.notices).toEqual([
      "Not verified: Protein bar (your no-soy preference).",
    ]);
  });

  it("W2c: blocks a log item by its own name with no evidence row, never by a Jev facet", async () => {
    const result = await markLoggedActions("user-1", [logAction], DEFAULT_PROFILE, {
      evidence: { status: "ready", preferenceFlags: ["no_soy"], byIdentity: {} },
    });
    expect(result.notices).toEqual(["Off-plan: Smoked tofu."]);
  });

  /* sol FIX (t2b review): the card read no reason at all, so a preference gap said "Check the
     label." The marks now travel with the unverified item and name which gap it is. */
  it("carries the marks that tell an allergen gap from a preference gap", async () => {
    const unverifiedItem = async (profile: typeof DEFAULT_PROFILE, byIdentity = {}) => {
      const result = await markLoggedActions("user-1", [logAction], profile,
        { evidence: { status: "ready", preferenceFlags: ["vegetarian"], byIdentity } });
      const action = result.actions[0] as Extract<CoachAction, { kind: "log_meal" }>;
      return action.items[0];
    };
    const allergenGap = await unverifiedItem(DEFAULT_PROFILE);
    expect(allergenGap.marks).toContainEqual({ facet: "gluten", source: "floor", outcome: "unknown" });
    expect(labelCheckNeeded(allergenGap)).toBe(true);
    const preferenceOnly = await unverifiedItem({ ...DEFAULT_PROFILE, avoid_allergens: [] }, {
      "ref:food-ref-1": { allergenTags: [], policyCategories: [], facets: {}, noCook: null,
        onEatsList: false, onAvoidList: false, role: null } });
    expect(preferenceOnly.verdict).toBe("unverified");
    expect(labelCheckNeeded(preferenceOnly)).toBe(false);
  });

  /* 2026-10-01: production blamed EVERY unverified item on the account's whole preference list —
     "Not verified: 2 oz Espresso (your no-pork preference)" and the same line for Jasmine rice,
     neither of which has anything to do with pork. unverifiedNotice took evidence.preferenceFlags
     (every flag the account has at all) instead of the item's OWN marks. Two items, unverified for
     two different reasons, must read two different notices. */
  it("names each item's own unresolved cause instead of the whole account preference list", async () => {
    // Phase 18 W2c: "Bacon" names pork itself (blocked, not unverified); "Breakfast links" says
    // nothing about pork, so it is the genuinely unresolved no-pork item.
    const bacon = { ...logAction.items[0], name: "Bacon", foodRefId: "food-ref-bacon" };
    const links = { ...logAction.items[0], name: "Breakfast links", foodRefId: "food-ref-links" };
    // Plain oats: the class clears pork but not gluten (a cross-contact claim), unlike plain rice.
    const rice = { ...logAction.items[0], name: "Oats", foodRefId: "food-ref-rice" };
    const action = { ...logAction, items: [bacon, links, rice] };

    const result = await markLoggedActions("user-1", [action],
      { ...DEFAULT_PROFILE, avoid_allergens: ["gluten"] }, {
        evidence: {
          status: "ready",
          preferenceFlags: ["no_pork"],
          byIdentity: {
            "ref:food-ref-bacon": { allergenTags: [], policyCategories: [], facets: {},
              noCook: null, onEatsList: false, onAvoidList: false, role: null },
            // No pork word, no class, no label: genuinely unresolved for the preference.
            "ref:food-ref-links": { allergenTags: [], policyCategories: [], facets: {},
              noCook: null, onEatsList: false, onAvoidList: false, role: null },
            // Plain oats: the whole-food class settles no_pork (W2c: a Jev `absent` no longer
            // would, and a label never clears an animal facet), and only the gluten floor stays
            // open, since oats' gluten is a cross-contact claim.
            "ref:food-ref-rice": { allergenTags: [], policyCategories: [], facets: {
              pork: { p: 0.01, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00.000Z" },
            }, foodName: "Oats",
            noCook: null, onEatsList: false, onAvoidList: false, role: null },
          },
        },
      });

    expect(result.notices).toEqual([
      "Off-plan: Bacon.",
      "Not verified: Breakfast links (your no-pork preference).",
      "Not verified: Oats (check the label for gluten).",
    ]);
  });

  /**
   * 2026-10-02 DeepSeek audit: unresolvedPreferenceFlags kept a flag the moment ANY mark on a
   * watched facet read "unknown", ignoring resolvePolicyVerdict's own rule (lib/policy/
   * constraints.ts) that an "unknown" mark is resolved by an "absent" mark on the SAME facet at a
   * lower SOURCE_ORDER. no_peanuts's only facet (contains_peanut) gets exactly that pair here — an
   * ingredient-level "absent" (a complete tag list naming no peanut) and a jev-level "unknown" (no
   * cached judgment) — so it is resolved and must not be blamed. vegetarian's "meat" facet has no
   * such counterpart and stays genuinely unresolved, which is why the item is unverified at all.
   */
  it("does not blame a resolved preference (no_peanuts) for an unrelated unresolved one (vegetarian)", async () => {
    const action = {
      ...logAction,
      // A prepared food: plain rice now resolves vegetarian as a whole food (2026-10-02).
      items: [{ ...logAction.items[0], name: "Granola", foodRefId: "food-ref-1" }],
    };
    const result = await markLoggedActions("user-1", [action],
      { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [] }, {
        evidence: {
          status: "ready",
          preferenceFlags: ["vegetarian", "no_peanuts"],
          byIdentity: {
            "ref:food-ref-1": {
              // Phase 18 W2c: an empty tag list is no longer proof of absence, so the peanut
              // clearance comes from a complete label naming no peanut. "Natural flavor" keeps
              // the same label from clearing vegetarian's "meat" (uncertain origin), so only
              // vegetarian stays unresolved.
              allergenTags: [], policyCategories: [], facets: {},
              foodName: "Granola", ingredientsText: "Oats, sugar, natural flavor.",
              ingredientsTextIsLabel: true,
              noCook: null, onEatsList: false, onAvoidList: false, role: null,
            },
          },
        },
      });

    expect(result.notices).toEqual(["Not verified: Granola (your vegetarian preference)."]);
  });

  it("keeps an Avoid-list block when refreshed evidence has no matching identity", async () => {
    const blocked = {
      ...logAction,
      items: logAction.items.map((item) => ({ ...item, verdict: "blocked" as const })),
    };

    const result = await markLoggedActions("user-1", [blocked], DEFAULT_PROFILE, {
      evidence: { status: "ready", preferenceFlags: [], byIdentity: {} },
    });

    expect(result.actions).toEqual([expect.objectContaining({
      kind: "log_meal",
      flagged: ["Smoked tofu"],
      items: [expect.objectContaining({ name: "Smoked tofu", verdict: "blocked" })],
    })]);
  });

  it("keeps an allergen block when refreshed evidence has no matching identity", async () => {
    const blocked = {
      ...logAction,
      items: logAction.items.map((item) => ({ ...item, verdict: "blocked" as const })),
    };

    const result = await markLoggedActions("user-1", [blocked], DEFAULT_PROFILE, {
      evidence: { status: "ready", preferenceFlags: [], byIdentity: {} },
    });

    expect(result.actions).toEqual([expect.objectContaining({
      kind: "log_meal",
      flagged: ["Smoked tofu"],
      items: [expect.objectContaining({ name: "Smoked tofu", verdict: "blocked" })],
    })]);
  });

  it("marks logs unverified and reports unavailable evidence when preferences are active", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const allowedAction = {
      ...logAction,
      items: logAction.items.map((item) => ({ ...item, verdict: "allowed" as const })),
    };

    const result = await markLoggedActions("user-1", [allowedAction], DEFAULT_PROFILE, {
      evidence: { status: "unavailable", preferenceFlags: ["no_soy"], byIdentity: {} },
    });

    expect(result.actions).toEqual([expect.objectContaining({
      kind: "log_meal",
      flagged: [],
      items: [expect.objectContaining({ name: "Smoked tofu", verdict: "unverified" })],
    })]);
    expect(result.notices).toEqual([
      "Not verified: Smoked tofu (your no-soy preference).",
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[coach-log-policy] evidence unavailable; marking logs unverified",
    );
  });

  it("carries a soy-named food's facet into the commit's persisted flagged result (W2c: the " +
    "name decides, a cached Jev facet alone does not)", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      food_ref_id: "food-ref-1",
      food_revision_id: 467,
      qty: 100,
      unit: "g",
      grams: 100,
    } as const;
    const identity = suggestionFoodIdentity({
      foodRefId: item.food_ref_id,
      catalogFoodRevisionId: item.food_revision_id,
    });
    // No allergen rule here, so the preference path (not the allergen floor) is what blocks.
    const commit = (foodName?: string) => logCommitPolicyIssues({ ...DEFAULT_PROFILE,
      avoid_allergens: [] }, [item], [{
      foodRefId: "food-ref-1",
      allergenTags: [],
      category: [],
      onEatsList: false,
      onAvoidList: false,
      ...(foodName ? { foodName } : {}),
    }], {
      status: "ready",
      preferenceFlags: ["no_soy"],
      byIdentity: {
        [identity]: {
          allergenTags: [],
          policyCategories: [],
          facets: { contains_soy: {
            p: 0.99, rubricVersion: 1, judgedAt: "2026-09-20T00:00:00.000Z",
          } },
          noCook: null,
          onEatsList: false,
          onAvoidList: false,
          role: null,
        },
      },
    });

    // An ingredient-level soy block reads as the allergen word, as a soy tag always did.
    expect(commit("Smoked tofu")).toEqual([{ path: "items.0", message: "blocked:allergen:soy" }]);
    // The same cached Jev positive on a food whose own words say nothing: never blocked. (A
    // preference left unverified has never produced a commit issue; only allergen and profile-rule
    // gaps do.)
    expect(commit()).toEqual([]);
  });

  it("uses active preferences when commit evidence is unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      food_ref_id: "food-ref-1",
      food_revision_id: 467,
      qty: 100,
      unit: "g",
      grams: 100,
    } as const;
    const base = {
      foodRefId: "food-ref-1",
      allergenTags: ["soy"],
      category: [],
      onEatsList: false,
      onAvoidList: false,
      preferenceFlags: ["no_soy"] as const,
    };

    const issues = logCommitPolicyIssues(DEFAULT_PROFILE, [item, item], [base, base], {
      status: "unavailable",
      preferenceFlags: [],
      byIdentity: {},
    });

    expect(issues).toEqual([
      { path: "items.0", message: "blocked:allergen:soy" },
      { path: "items.1", message: "blocked:allergen:soy" },
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reports no PREFERENCE-driven issue when unavailable evidence has no active preferences, " +
    "but still reports the profile's own unverified allergens (sol FIX, review round 2: these " +
    "used to be dropped here entirely — DEFAULT_PROFILE avoids gluten/dairy/apple, and an empty " +
    "tag list with no ingredient text leaves all three no_evidence)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      food_ref_id: "food-ref-1",
      food_revision_id: 467,
      qty: 100,
      unit: "g",
      grams: 100,
    } as const;

    const issues = logCommitPolicyIssues(DEFAULT_PROFILE, [item], [{
      foodRefId: "food-ref-1",
      allergenTags: [],
      category: [],
      onEatsList: false,
      onAvoidList: false,
    }], {
      status: "unavailable",
      preferenceFlags: [],
      byIdentity: {},
    });

    expect(issues).toEqual([
      { path: "items.0", message: "unverified:allergen:gluten" },
      { path: "items.0", message: "unverified:allergen:dairy" },
      { path: "items.0", message: "unverified:allergen:apple" },
      // Phase 18 W2a: the unread evidence port is itself a mark (review r1 BLOCK 2).
      { path: "items.0", message: RULES_UNREADABLE_MESSAGE },
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("sol FIX (review round 2): reports one unverified issue per checkable no_evidence allergen " +
    "— a food with no peanut evidence must still return a mark, contrary to the earlier drop", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      food_ref_id: "food-ref-1",
      food_revision_id: 467,
      qty: 100,
      unit: "g",
      grams: 100,
    } as const;
    const peanutProfile = { ...DEFAULT_PROFILE, avoid_allergens: ["peanut"] };

    const issues = logCommitPolicyIssues(peanutProfile, [item], [{
      foodRefId: "food-ref-1",
      allergenTags: [],
      category: [],
      onEatsList: false,
      onAvoidList: false,
    }], {
      status: "ready",
      preferenceFlags: [],
      byIdentity: {},
    });

    expect(issues).toEqual([{ path: "items.0", message: "unverified:allergen:peanut" }]);
  });

  it("reports no issue for an allowed item (a complete label naming no avoided allergen)", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      food_ref_id: "food-ref-1",
      food_revision_id: 467,
      qty: 100,
      unit: "g",
      grams: 100,
    } as const;
    const peanutProfile = { ...DEFAULT_PROFILE, avoid_allergens: ["peanut"] };

    const issues = logCommitPolicyIssues(peanutProfile, [item], [{
      foodRefId: "food-ref-1",
      allergenTags: [],
      category: [],
      onEatsList: false,
      onAvoidList: false,
      ingredientsText: "Water, sugar, salt.",
      ingredientsTextIsLabel: true,
    }], {
      status: "ready",
      preferenceFlags: [],
      byIdentity: {},
    });

    expect(issues).toEqual([]);
  });

  it("round 13/4: a noncheckable unverified finding (pregnancy/unspecified tuna) still returns " +
    "its own flagged entry on commit, not silently dropped", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000001",
      seq: 1,
      food_ref_id: "food-ref-1",
      food_revision_id: 467,
      qty: 100,
      unit: "g",
      grams: 100,
    } as const;
    const pregnantProfile = { ...DEFAULT_PROFILE, avoid_allergens: [], conditions: ["pregnant"] };

    const issues = logCommitPolicyIssues(pregnantProfile, [item], [{
      foodRefId: "food-ref-1",
      allergenTags: [],
      category: [],
      onEatsList: false,
      onAvoidList: false,
      foodName: "Canned tuna",
      ingredientsText: "Water, salt.",
      ingredientsTextIsLabel: true,
    }], {
      status: "ready",
      preferenceFlags: [],
      byIdentity: {},
    });

    expect(issues).toEqual([{
      path: "items.0",
      message: "unverified:tuna_mercury:Unspecified tuna — mercury varies by species. Check the "
        + "label for the kind, or ask your clinician about mercury limits during pregnancy.",
    }]);
  });
});
