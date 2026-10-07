/**
 * D1 §6.1 and PRD R2: no restriction exists in code.
 *
 * Until this run, an account with no `constraint_profiles` row was handed gluten, dairy, apple and
 * five banned categories by `DEFAULT_PROFILE`, and `PUT /api/constraints` answered 422 to any
 * change that dropped one of the three. Those were one person's clinical rules living in a shared
 * constant. They now live only in that person's row — carried there by
 * `20261026090100_neutral_user_defaults.sql` — while code starts every account empty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PROFILE, evaluatePolicy, loadProfile } from "@/lib/policy/constraints";
import { completeRuleReview, getProfile, getRuleReviewStatus, putProfile } from "@/lib/server/constraints";
import {
  constraintPatchForFlags, createOnboardingState, onboardingReducer,
} from "@/lib/profile/onboarding-state";
import { persistCompletedOnboarding } from "@/lib/profile/onboarding-client";
import { defaultSettings } from "@/lib/store";
import type { Settings } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

beforeEach(async () => { await resetTestAccount(); });

type Row = Record<string, unknown> | null;

/** The two shapes lib/server/constraints.ts uses: a maybeSingle read and an update…select. */
function fakeClient(row: Row, applied: { rows: Row[] } = { rows: [] }) {
  return {
    from() {
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
        update(next: Record<string, unknown>) {
          applied.rows.push(next);
          return { eq: () => chain2, select: () => chain2 };
        },
        upsert(next: Record<string, unknown>) { applied.rows.push(next); return chain2; },
      };
      const chain2 = {
        eq: () => chain2, select: () => chain2,
        maybeSingle: async () => ({
          data: row === null ? (applied.rows.at(-1) ?? null) : { ...row, ...(applied.rows.at(-1) ?? {}) },
          error: null,
        }),
      };
      return chain;
    },
  } as never;
}

const ROW = {
  user_id: "u1", rev: 3, conditions: ["ulcerative colitis"], notes: null,
  avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
  banned_categories: ["simple_sugars"], custom_rules: [],
};

describe("the in-memory profile for an account with no row", () => {
  it("restricts nothing at all", () => {
    expect(EMPTY_PROFILE).toEqual({
      avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
    });
    expect(loadProfile(null)).toEqual(EMPTY_PROFILE);
  });

  it("fills only the arrays a partial row leaves out, and fills them empty", () => {
    expect(loadProfile({ avoid_allergens: ["sesame"] })).toEqual({
      avoid_allergens: ["sesame"], avoid_food_ref_ids: [], banned_categories: [], conditions: [],
    });
  });

  it("no longer blocks gluten, dairy or apple on nobody's instruction", () => {
    for (const tag of ["gluten", "dairy", "apple"]) {
      expect(evaluatePolicy(EMPTY_PROFILE, {
        foodRefId: null, allergenTags: [tag], category: [], onEatsList: true, onAvoidList: false,
      }), tag).toEqual({ verdict: "allowed" });
    }
  });

  it("still blocks an allergen the account's own row names, at the top rank", () => {
    const verdict = evaluatePolicy(
      { ...EMPTY_PROFILE, avoid_allergens: ["gluten"] },
      { foodRefId: null, allergenTags: ["Gluten "], category: [], onEatsList: true, onAvoidList: false },
    );
    expect(verdict).toMatchObject({ verdict: "blocked", reason: "allergen:gluten" });
  });
});

describe("getProfile", () => {
  it("returns the stored row with its rev", async () => {
    const { profile, rev } = await getProfile(fakeClient(ROW), "u1");
    expect(rev).toBe(3);
    expect(profile.conditions).toEqual(["ulcerative colitis"]);
    expect(profile.avoid_allergens).toEqual(["gluten", "dairy", "apple"]);
  });

  it("returns an empty profile at rev 0 for an account with no row", async () => {
    const { profile, rev } = await getProfile(fakeClient(null), "u1");
    expect(rev).toBe(0);
    expect(profile).toEqual({
      avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
      conditions: [], notes: null, custom_rules: [],
    });
  });
});

describe("putProfile", () => {
  it("removes any allergen the account asks it to, including a former floor one", async () => {
    const applied = { rows: [] as Row[] };
    const result = await putProfile(fakeClient(ROW, applied), "u1",
      { baseRev: 3, avoidAllergens: ["gluten", "apple"] });
    expect(result.status).toBe("ok");
    expect(applied.rows.at(-1)).toMatchObject({
      rev: 4, avoid_allergens: ["gluten", "apple"],
    });
  });

  it("accepts an empty allergen list", async () => {
    const applied = { rows: [] as Row[] };
    const result = await putProfile(fakeClient(ROW, applied), "u1",
      { baseRev: 3, avoidAllergens: [] });
    expect(result.status).toBe("ok");
    expect(applied.rows.at(-1)).toMatchObject({ avoid_allergens: [] });
  });

  it("still normalizes what it stores", async () => {
    const applied = { rows: [] as Row[] };
    await putProfile(fakeClient(ROW, applied), "u1",
      { baseRev: 3, avoidAllergens: [" Gluten ", "gluten", "", "SOY"] });
    expect(applied.rows.at(-1)).toMatchObject({ avoid_allergens: ["gluten", "soy"] });
  });

  it("inserts the first row at rev 1 even when every array is empty", async () => {
    const applied = { rows: [] as Row[] };
    const result = await putProfile(fakeClient(null, applied), "u1", { baseRev: 0 });
    expect(result.status).toBe("ok");
    expect(applied.rows.at(-1)).toMatchObject({
      user_id: "u1", rev: 1, avoid_allergens: [], banned_categories: [], conditions: [],
    });
  });

  it("returns conflict with the full current profile on a stale baseRev", async () => {
    const result = await putProfile(fakeClient(ROW), "u1", { baseRev: 2, conditions: ["x"] });
    expect(result).toMatchObject({
      status: "conflict", current_rev: 3, entity: "constraint_profiles",
    });
    if (result.status === "conflict") {
      expect(result.value.conditions).toEqual(["ulcerative colitis"]);
    }
  });
});

describe("historical rule review", () => {
  const pending = { ...ROW, rule_review_required: true, rule_reviewed_at: null };

  it("returns only inherited candidate keys and blocks generic removal while pending", async () => {
    expect(await getRuleReviewStatus(fakeClient(pending), "u1")).toEqual({
      required: true, rev: 3,
      candidateAllergens: ["gluten", "dairy", "apple"],
      candidateCategories: ["simple_sugars"],
    });
    await expect(putProfile(fakeClient(pending), "u1", {
      baseRev: 3, avoidAllergens: ["dairy", "apple"],
    })).rejects.toMatchObject({ code: "rule_review_required", status: 409 });
  });

  it("stores explicit per-rule decisions and the marker in one revision-checked write", async () => {
    const applied = { rows: [] as Row[] };
    const choices = { allergens: { gluten: "keep", dairy: "remove", apple: "remove" },
      categories: { simple_sugars: "keep" } } as const;
    const result = await completeRuleReview(fakeClient(pending, applied), "u1", 3, choices);
    expect(result.status).toBe("ok");
    expect(applied.rows.at(-1)).toMatchObject({
      rev: 4, avoid_allergens: ["gluten"], banned_categories: ["simple_sugars"],
      rule_review_required: false,
    });
    expect((applied.rows.at(-1) as Record<string, unknown>).rule_reviewed_at)
      .toEqual(expect.any(String));
    expect(await completeRuleReview(fakeClient(pending), "u1", 2, choices))
      .toMatchObject({ status: "conflict", current_rev: 3 });
  });

  it("requires an answer for each candidate", async () => {
    await expect(completeRuleReview(fakeClient(pending), "u1", 3, {
      allergens: { gluten: "keep" }, categories: { simple_sugars: "keep" },
    })).rejects.toMatchObject({ code: "incomplete_review", status: 400 });
  });
});

describe("onboarding completion", () => {
  function completeState() {
    const base = defaultSettings();
    let state = createOnboardingState(base);
    state = onboardingReducer(state, { type: "set_sex", value: "female" });
    state = onboardingReducer(state, { type: "edit_body", key: "birthYear", value: "1996" });
    state = onboardingReducer(state, { type: "edit_body", key: "heightCm", value: "165" });
    state = onboardingReducer(state, { type: "edit_weight", value: "132" });
    state = onboardingReducer(state, { type: "set_activity", value: "moderate" });
    state = onboardingReducer(state, { type: "set_goal", value: "recomp" });
    return { base, state };
  }

  function deps(profile = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
    conditions: [], notes: null }) {
    const saveConstraints = vi.fn(async () => ({
      status: "ok" as const, profile, rev: 1,
    }));
    return {
      deps: {
        saveLocal: vi.fn(),
        saveSynced: vi.fn(async () => undefined),
        saveWeighIn: vi.fn(async () => null),
        loadConstraints: vi.fn(async () => ({ profile, rev: 0 })),
        saveConstraints,
        localDate: () => "2026-10-26",
        hasWeighIn: () => true,
      } satisfies Parameters<typeof persistCompletedOnboarding>[3],
      saveConstraints,
    };
  }

  it("writes a constraint_profiles row even when no preference chip was chosen", async () => {
    const { base, state } = completeState();
    const { deps: persistence, saveConstraints } = deps();
    const result = await persistCompletedOnboarding(
      base as Settings, state, new Date("2026-10-26T09:00:00.000Z"), persistence,
    );
    expect(result.constraintsSaved).toBe(true);
    expect(saveConstraints).toHaveBeenCalledWith({ baseRev: 0 }, 0);
  });

  it("puts only the chosen chips' rules into that account's row", () => {
    const patch = constraintPatchForFlags(["no_shellfish", "low_fodmap"], {
      avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [],
      conditions: [], notes: null,
    });
    expect(patch).toEqual({
      avoidAllergens: ["shellfish"], bannedCategories: ["onion_garlic", "beans"],
    });
  });

  it("starts onboarding with no training weekday and no preference chip", () => {
    const state = createOnboardingState(defaultSettings());
    expect(state.trainingWeekdays).toEqual([]);
    expect(state.flags).toEqual([]);
  });
});
