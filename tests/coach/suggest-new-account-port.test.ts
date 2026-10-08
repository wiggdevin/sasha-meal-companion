/**
 * The server port behind the suggestion fast path (run 5, lane G).
 *
 * `defaultPorts(...).suggest` used to reject whenever the turn's own day had no target:
 * `suggestionTarget` threw `Profile setup is required before ranking by target fit.`, the fast
 * path's catch (lib/server/coach-turn/fast-path.ts) turned that into SUGGEST_RETRY_MESSAGE, and the
 * brand-new account read "I couldn't build those suggestions right now. Please try again."
 *
 * A missing target is a fact about the day, not a failure: the port answers with a neutral,
 * number-free sentence instead. The plan path's own `composeTarget` still throws for needs_profile
 * (tests/coach/compose-target.test.ts) — nothing here changes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defaultPorts } from "@/lib/server/coach-ports";
import type { ComposedMeal } from "@/lib/coach/compose";
import {
  NO_SAVED_FOODS_MESSAGE, NO_TARGET_SUGGEST_MESSAGE, RULE_REVIEW_SUGGEST_MESSAGE, SUGGEST_RETRY_MESSAGE,
} from "@/lib/coach/suggest-messages";

const dayContext = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const lists = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const review = vi.hoisted(() => ({ required: false }));

vi.mock("@/lib/server/day-context", () => ({
  buildDayContext: vi.fn(async () => dayContext.value),
}));
vi.mock("@/lib/server/constraints", () => ({
  getProfile: vi.fn(async () => ({
    profile: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [] },
    rev: 1, reviewRequired: review.required, reviewedAt: null,
  })),
  getRuleReviewStatus: vi.fn(async () => ({
    required: review.required, candidateAllergens: [], candidateCategories: [], rev: 1,
  })),
}));
// Phase 13 slice 4: the port reads the confirmed profile rules beside the constraint row.
vi.mock("@/lib/server/dietary-profiles", () => ({
  readAccountProfileSets: vi.fn(async () => ({ stored: [], all: [] })),
}));
vi.mock("@/lib/server/coach-context", () => ({
  foodLists: vi.fn(async () => lists.value),
  eatsForSuggestions: vi.fn(async () => ({ all: lists.value.eats, anchors: lists.value.eats })),
}));
// Phase 18 W10: the suggest port now also wires `composePoolPorts`' `openWorld`, which reads
// `user_settings.food_world` through the bare `{}` client this file uses — every account here is
// a brand-new, closed-world one, so the read is answered directly instead of faked through a
// Supabase stub this test never otherwise needs.
vi.mock("@/lib/server/meal-snapshot-v3", () => ({
  mealSnapshotV3: vi.fn(async () => ({ world: "closed" })),
}));

const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const clock = { tz: "America/Denver", date: "2026-09-20" };
/** Mirror of the walkthrough's day: Meal 1 planned by the coach and ticked eaten, one logged extra. */
const dayWithNoTarget = {
  date: clock.date, dayType: "rest", targets: null, remaining: null,
  consumed: { kcal: 89, protein: 1.1, carbs: 22.8, fat: 0.3 },
  stillToEat: "Targets are not set. Ask the user to finish the profile.",
  entries: [{ entryId: "e1", at: "12:10", slot: "extra", name: "Banana, raw",
    items: ["100 g Banana, raw - 89 kcal 1.1P 22.8C 0.3F"], macros: "89 kcal 1.1P 22.8C 0.3F" }],
  slots: [
    { slot: "meal-1", label: "Meal 1", title: "Chicken and rice", time: "13:00", state: "eaten",
      items: ["150 g Chicken breast - 248 kcal 46P 0C 5F"], macros: "248 kcal 46P 0C 5F", totals: zero },
    { slot: "meal-2", label: "Meal 2", title: "No meal planned", time: "18:00", state: "empty",
      items: [], macros: "0 kcal 0P 0C 0F", totals: zero },
  ],
};

function listsWith(eats: string[]) {
  return { eats, avoid: [], eatsMore: 0, avoidMore: 0 };
}

function portsForSuggest() {
  return defaultPorts({} as SupabaseClient, {} as SupabaseClient, () => "id-1", clock);
}

/** `suggestOptions` answers a message-only result; the executor port's own type is the cards. */
type SuggestReturn = ComposedMeal[] & { message?: string };

async function suggestOnDay(args: Parameters<ReturnType<typeof portsForSuggest>["suggest"]>[1]) {
  const ports = portsForSuggest();
  return await ports.suggest("u1", args) as SuggestReturn;
}

beforeEach(() => {
  review.required = false;
  dayContext.value = dayWithNoTarget;
  lists.value = listsWith([]);
});

describe("the suggestion port on a day with no target", () => {
  it("resolves for an account with nothing saved instead of rejecting", async () => {
    const result = await suggestOnDay({ kind: "meal", count: 3 });

    expect(result).toHaveLength(0);
    expect(result.message).toBe(NO_SAVED_FOODS_MESSAGE);
    expect(result.message).not.toBe(SUGGEST_RETRY_MESSAGE);
    expect(result.message).not.toContain("Profile setup is required");
  });

  it("resolves with the profile line when foods are saved but the day has no target", async () => {
    lists.value = listsWith(["Chicken breast"]);

    const result = await suggestOnDay({ kind: "meal", count: 3 });

    expect(result).toHaveLength(0);
    expect(result.message).toBe(NO_TARGET_SUGGEST_MESSAGE);
    expect(result.message).not.toBe(SUGGEST_RETRY_MESSAGE);
    expect(result.message).not.toMatch(/\d/);
  });

  it("still answers the nothing-left line when the day has a target and nothing left", async () => {
    dayContext.value = { ...dayWithNoTarget, targets: zero, remaining: zero };
    lists.value = listsWith(["Chicken breast"]);

    const result = await suggestOnDay({ kind: "snack", count: 3 });

    expect(result).toHaveLength(0);
    expect(result.message).toBe("There are no calories left in today's target for a snack.");
  });

  it("answers the rule-review line while inherited food rules await review (R14)", async () => {
    review.required = true;
    dayContext.value = { ...dayWithNoTarget, targets: zero, remaining: zero };
    lists.value = listsWith(["Chicken breast"]);

    const result = await suggestOnDay({ kind: "meal", count: 3, slot: "meal-2" });

    expect(result).toHaveLength(0);
    expect(result.message).toBe(RULE_REVIEW_SUGGEST_MESSAGE);
  });
});
