/**
 * A brand-new account must get an answer, never "try again" (run 5, lane G).
 *
 * The walkthrough account — zero `user_foods`, zero `user_food_prefs`, one peanut rule, a target
 * revision, a logged banana and Meal 1 eaten — answered "What should I eat for lunch?" with
 * SUGGEST_RETRY_MESSAGE. That line is printed only by the suggestion fast path's catch (lib/server/coach-turn/fast-path.ts),
 * so the suggest fast path threw. The thrown error, verbatim from a local reproduction:
 *
 *   coach suggestion fast path failed {
 *     error: { name: 'Error', message: 'Profile setup is required before ranking by target fit.' }
 *   }
 *
 * It comes from `suggestionTarget` in lib/server/coach-ports.ts, which threw whenever the turn's
 * own day had no target to rank against — here because the revision was not yet effective on the
 * day the turn asked about (onboarding dates the revision from the UTC `onboardedAt`,
 * lib/profile/onboarding-state.ts:349 → lib/profile/onboarding-client.ts:79-84, so a completion
 * after 18:00 in a negative-offset zone dates it tomorrow). The same account with an effective
 * revision answered "There are no calories left in today's target for a snack." instead, because
 * an empty Eats list returns zero candidates and the fast path reads zero cards as "nothing left".
 *
 * Both accounts are owed an honest, number-free sentence: no saved foods, or no target yet.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import {
  NO_SAVED_FOODS_MESSAGE, NO_TARGET_SUGGEST_MESSAGE, SUGGEST_RETRY_MESSAGE,
} from "@/lib/coach/suggest-messages";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import { adminClient } from "../helpers/supabase";

/** The walkthrough account's own rules: peanut only, no floors, no categories. */
const NEW_ACCOUNT: ConstraintProfile = {
  avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [],
};
/** One meal's share of the account's 1893 kcal rest day. */
const REST_DAY_SHARE = { kcal: 631, protein: 43, carbs: 55, fat: 23 };

function newAccountPorts(overrides: Partial<SuggestPorts> = {}): SuggestPorts {
  return {
    userId: "new-account",
    profile: NEW_ACCOUNT,
    // `null` is the port's "this day has no target": never a throw, never an invented number.
    target: async () => null,
    // R1: zero `user_food_prefs` rows, so nothing is on the Eats list to anchor a card on.
    eatsNames: async () => [],
    searchFoods: vi.fn(async () => []),
    suggestionEvidence: async () => ({ status: "ready", preferenceFlags: [], byIdentity: {} }),
    ...overrides,
  };
}

describe("suggestions for a brand-new account", () => {
  it("answers with the no-saved-foods line instead of throwing", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 3 }, newAccountPorts());

    expect(cards).toHaveLength(0);
    expect(cards.message).toBe(NO_SAVED_FOODS_MESSAGE);
    expect(cards.message).not.toBe(SUGGEST_RETRY_MESSAGE);
    expect(cards.message).not.toMatch(/\d/);
    expect(JSON.parse(JSON.stringify(cards))).toEqual({ cards: [], message: NO_SAVED_FOODS_MESSAGE });
  });

  it("prefers the no-saved-foods line over the revision when both are known", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 3 },
      newAccountPorts({ target: async () => REST_DAY_SHARE }));

    expect(cards).toHaveLength(0);
    expect(cards.message).toBe(NO_SAVED_FOODS_MESSAGE);
  });

  it("answers with the no-target line, not the retry line, when foods exist but the day has no target", async () => {
    const cards = await suggestOptions({ kind: "meal", count: 3 }, newAccountPorts({
      eatsNames: async () => ["Chicken breast"],
    }));

    expect(cards).toHaveLength(0);
    expect(cards.message).toBe(NO_TARGET_SUGGEST_MESSAGE);
    expect(cards.message).not.toBe(SUGGEST_RETRY_MESSAGE);
    expect(cards.message).not.toMatch(/\d/);
  });
});

const url = process.env.SUPABASE_TEST_URL ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const LOCAL = url.startsWith("http://127.0.0.1") && Boolean(anonKey && serviceKey);
const date = "2026-09-20";

/**
 * Jev's own classification of "What should I eat for lunch?" (captured live on 2026-09-21, the
 * walkthrough's question). Stubbing it keeps the fast path the thing under test without a model
 * call, and it is exactly what put the turn on the fast path in the walkthrough.
 */
const CLASSIFIED = {
  intent: "suggest_options" as const,
  confidence: 0.93,
  args: { kind: "meal" as const, count: 3, fitRemaining: false },
  argConfidence: { kind: 0.99, count: 0.97, fitRemaining: 0.97 },
  raw: {},
};

describe.skipIf(!LOCAL)("the walkthrough account's suggestion turn, end to end", () => {
  // Built in `beforeAll`, not at collection: this file must import cleanly with no local env.
  let admin: SupabaseClient;
  const ids: string[] = [];
  let userId = "";
  let client: SupabaseClient;

  beforeAll(() => {
    admin = adminClient();
    // The turn route is flag-gated; the walkthrough runs with the coach on.
    vi.stubEnv("COACH_ENABLED", "1");
  });

  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id);
    vi.unstubAllEnvs();
  });

  async function seed(): Promise<void> {
    const password = `local-${crypto.randomUUID()}-A1!`;
    const email = `newuser-g-${Date.now()}-${crypto.randomUUID()}@example.test`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("create failed");
    userId = created.data.user.id;
    ids.push(userId);
    client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    const settings = await admin.from("user_settings").insert({
      user_id: userId, first_opened_at: `${date}T05:00:00Z`, training_weekdays: [2],
      activity_level: "moderate", goal: "maintain", weight_kg: 60, height_cm: 165,
      birth_year: 1996, sex: "female",
    });
    if (settings.error) throw settings.error;
    const constraints = await admin.from("constraint_profiles").insert({
      user_id: userId, avoid_allergens: ["peanut"], conditions: [],
      banned_categories: [], avoid_food_ref_ids: [],
    });
    if (constraints.error) throw constraints.error;
    // effective_from is tomorrow: the UTC `onboardedAt` a 22:20 MDT completion writes.
    const target = await client.rpc("write_target_revision", {
      p_user_id: userId,
      p_row: {
        effective_from: "2026-09-21", target_source: "derived", mode: "grams",
        training_macros: { kcal: 2100, protein: 130, carbs: 240, fat: 69 },
        rest_macros: { kcal: 1893, protein: 130, carbs: 165, fat: 69 },
        input_weight_kg: 60, input_weight_source: "onboarding", input_training_weekdays: [2],
        input_activity_level: "moderate", input_goal: "maintain", formula_name: "test-v1",
        kcal_min: 1650, protein_g_min: 120, fat_g_min: 50, carb_g_min: 100,
      },
    });
    if (target.error) throw target.error;
    const plan = await admin.from("plan_days").insert({
      user_id: userId, local_date: date,
      item_overrides: { "meal-1": { baseMealId: null, title: "Chicken and rice",
        components: [{ name: "Chicken breast", qty: 150, unit: "g", role: "protein",
          macros: { kcal: 248, protein: 46, carbs: 0, fat: 5 } }] } },
      eaten_slots: { "meal-1": { eaten_at: `${date}T17:00:00Z`, changed_at: `${date}T17:00:00Z` } },
    });
    if (plan.error) throw plan.error;
  }

  async function turn(threadId: string | null) {
    const { runTurn } = await import("@/lib/server/coach-turn");
    return runTurn(client, admin, userId, {
      threadId, messageId: crypto.randomUUID(),
      text: "What should I eat for lunch?", tz: "America/Denver", now: `${date}T04:20:00Z`,
    }, {
      classifyIntent: vi.fn(async () => CLASSIFIED) as never,
      generate: vi.fn(() => { throw new Error("Gemini must not run"); }) as never,
    });
  }

  it("never answers the retry line: no saved foods, then no effective target", async () => {
    await seed();

    const first = await turn(null);
    expect(first.fastPath).toBe(true);
    expect(first.model.modelId).toBe("");
    expect(first.messages.at(-1)?.content).toBe(NO_SAVED_FOODS_MESSAGE);

    const food = await admin.from("user_foods").insert({
      user_id: userId, name: "Chicken breast, grilled", kind: "custom",
      per_100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6 },
    }).select("id").single();
    if (food.error) throw food.error;
    const ref = await admin.from("food_refs").insert({
      kind: "user", user_food_id: food.data.id,
    }).select("id").single();
    if (ref.error) throw ref.error;
    const pref = await admin.from("user_food_prefs").insert({
      user_id: userId, food_ref_id: ref.data.id, status: "eats", role: "protein",
    });
    if (pref.error) throw pref.error;

    const second = await turn(first.threadId);
    expect(second.messages.at(-1)?.content).toBe(NO_TARGET_SUGGEST_MESSAGE);
    expect(second.messages.at(-1)?.content).not.toBe(SUGGEST_RETRY_MESSAGE);
  }, 120_000);
});
