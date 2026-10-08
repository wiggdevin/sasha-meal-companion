/**
 * Phase 18 W10 (docs/specs/phase-18-open-world-foods.md §W10, D9 item 4), acceptance 3: the
 * suggestion short-list payload carries only generic candidate identities and meal descriptions —
 * no profile, no rule, no medical note and no account identifier. `suggestPayload` (lib/ai/
 * payloads.ts) is "not a filter": it reconstructs a NEW object from exactly `SuggestState`'s typed
 * fields (slot, wish, candidate foods and macros), so a smuggled extra property on the state or a
 * candidate's items never survives into the request body, the same guarantee
 * tests/ai/no-demographics-payload.test.ts proves for the other Jev builders.
 *
 * A food item is only ever named verbatim when it carries a catalog-pinned revision
 * (`catalogFoodRevisionId` a number) — the same boundary `lib/server/lookup-lane.ts`'s
 * `resolveSubject` already draws for a model-reachable food name. Anything else (the account's
 * own custom or label-scan text) is replaced with a generic, part-based identity
 * (`lib/coach/suggest-rank.ts`'s `jevSafeName`) before the payload is built. A pool-sourced plate
 * this builder cannot cheaply tell apart (an account Favored row vs a bundled universe item,
 * `lib/coach/suggest-pool.ts`) stays out of the Jev shortlist entirely instead.
 */
import { describe, expect, it } from "vitest";
import { suggestPayload } from "@/lib/ai/payloads";
import { rankingState } from "@/lib/coach/suggest-rank";
import type { SuggestInput } from "@/lib/coach/executors";
import type { SuggestionCandidate } from "@/lib/coach/suggest-candidates";

const PROFILE_ROW = {
  weight_kg: 61, activity_level: "moderate", goal: "recomp",
  diet_prefs: { flags: ["vegetarian"], taste: { dislikes: ["f:okra", "t:slimy"] } },
  sex: "female", birth_year: 1990, country_code: "US", cuisines: ["korean"],
};
const ACCOUNT_ID = "9f1b1a2c-0000-4000-8000-000000000099";
const MEDICAL_NOTE = "takes metformin for type 2 diabetes";
const RULE_TEXT = "keeps kosher, no shellfish ever";

function leaked(value: unknown): string[] {
  const text = JSON.stringify(value);
  return [
    "country_code", "birth_year", "1990", "\"US\"", "female", "korean", "okra", "slimy",
    ACCOUNT_ID, "userId", "accountId", "user_id", "account_id",
    MEDICAL_NOTE, "metformin", "diabetes",
    RULE_TEXT, "kosher", "shellfish",
    "weight_kg", "activity_level", "diet_prefs",
  ].filter((needle) => text.includes(needle));
}

function candidate(index: number, extra: Record<string, unknown> = {}): SuggestionCandidate {
  return {
    index,
    fit: 0.9,
    meal: {
      wish: "lunch", slot: null, target: { kcal: 500, protein: 35, carbs: 50, fat: 15 },
      flagged: [], fitsTarget: true, fitNote: null,
      items: [{ name: "Chicken breast", foodRefId: "food:1", catalogFoodRevisionId: null,
        grams: 150, kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6,
        macros: { kcal: 248, protein: 46, carbs: 0, fat: 5 }, verdict: "allowed" as const,
        // A smuggled field on an ITEM, the same attack `no-demographics-payload.test.ts` tries on
        // a whole settings row: nothing here reads past `name`/`grams`.
        ...extra }],
      totals: { kcal: 248, protein: 46, carbs: 0, fat: 5 },
    },
  };
}

describe("W10 acceptance 3: the suggestion short-list payload", () => {
  it("carries no profile, rule, medical note or account identifier even when one is smuggled on", () => {
    const smuggledCandidate: SuggestionCandidate = {
      ...candidate(0, { profile: PROFILE_ROW, accountId: ACCOUNT_ID, medicalNote: MEDICAL_NOTE,
        rule: RULE_TEXT }),
      // A smuggled field on the CANDIDATE itself, one level up from its items.
      ...({ profile: PROFILE_ROW, userId: ACCOUNT_ID } as unknown as Record<string, never>),
    };
    const input: SuggestInput = { kind: "meal", wish: "something light", count: 3 };
    const state = rankingState(input, [smuggledCandidate], undefined);
    const payload = suggestPayload(state, "meal");
    expect(leaked(state)).toEqual([]);
    expect(leaked(payload)).toEqual([]);
    expect(leaked(payload.state)).toEqual([]);
  });

  it("the payload's own shape holds only slot, wish, candidate foods and macros", () => {
    const input: SuggestInput = { kind: "meal", count: 3 };
    const state = rankingState(input, [candidate(0)], undefined);
    const payload = suggestPayload(state, "meal");
    const payloadState = payload.state as unknown as
      { candidates: { foods: { name: string; grams: number }[] }[] };
    expect(Object.keys(payload.state).sort()).toEqual(["candidates", "slot", "wish"]);
    expect(Object.keys(payloadState.candidates[0]).sort()).toEqual(["foods", "index", "macros"]);
    expect(Object.keys(payloadState.candidates[0].foods[0]).sort()).toEqual(["grams", "name"]);
  });

  it("never sends a custom or label-scan item's own name — a part-based identity stands in", () => {
    // "Chicken breast" is a user-chosen label on an account's own row with no catalog revision
    // (catalogFoodRevisionId: null, the fixture's default) — exactly a custom or label-scan food.
    const input: SuggestInput = { kind: "meal", count: 3 };
    const state = rankingState(input, [candidate(0, { part: "protein" })], undefined);
    const payload = suggestPayload(state, "meal");
    expect(leaked(payload)).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain("Chicken breast");
    const payloadState = payload.state as unknown as { candidates: { foods: { name: string }[] }[] };
    expect(payloadState.candidates[0].foods[0].name).toBe("a protein food");
  });

  it("falls back to \"a custom food\" with no template part recorded", () => {
    const input: SuggestInput = { kind: "meal", count: 3 };
    const state = rankingState(input, [candidate(0)], undefined);
    const payload = suggestPayload(state, "meal");
    const payloadState = payload.state as unknown as { candidates: { foods: { name: string }[] }[] };
    expect(payloadState.candidates[0].foods[0].name).toBe("a custom food");
  });

  it("still names a catalog-pinned item verbatim", () => {
    const input: SuggestInput = { kind: "meal", count: 3 };
    const state = rankingState(input, [candidate(0, { catalogFoodRevisionId: 42 })], undefined);
    const payload = suggestPayload(state, "meal");
    const payloadState = payload.state as unknown as { candidates: { foods: { name: string }[] }[] };
    expect(payloadState.candidates[0].foods[0].name).toBe("Chicken breast");
  });
});
