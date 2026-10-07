import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { CoachTurnResponse } from "@/lib/coach/types";
import type { Assertion } from "./coach-streak-state";
import { targetRevisionFixture } from "./coach-streak-target-fixture";
import type { Fixture } from "@/tests/log/fixtures";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";
export const TIMEZONE = "America/Denver";
const EMAIL = "coach-streak@meal-companion.test";
const PASSWORD = "coach-streak-branch-only";
const ADMIN_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const FORBIDDEN_ITEM = /apple|gluten|dairy|pouch|honey|syrup|sugar/i;

type Macros = { kcal: number; protein: number; carbs: number; fat: number };
type FoodSeed = {
  sourceId: string;
  description: string;
  role: "protein" | "carb" | "fat";
  per100g: Record<string, number>;
  list?: "eats" | "avoid";
  allergenTags?: string[];
};
export type SeedContext = {
  /** Null when the seeded account has no target revision: there is nothing left to spend. */
  remaining: Macros | null;
  expectedWatermelonRefs: Set<string>;
  fixtures: Map<string, Fixture>;
  activityContextPresent: boolean;
};
export type LiveHarness = {
  db: SupabaseClient;
  client: SupabaseClient;
  userId: string;
  date: string;
  seed: () => Promise<SeedContext>;
};

const FOODS: FoodSeed[] = [
  { sourceId: "streak-chicken", description: "Chicken breast, roasted", role: "protein",
    per100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6 }, list: "eats" },
  { sourceId: "streak-turkey", description: "Turkey breast, roasted", role: "protein",
    per100g: { energy_kcal: 135, protein: 30, carbohydrate: 0, fat_total: 1 }, list: "eats" },
  { sourceId: "streak-tuna", description: "Tuna, light, canned in water", role: "protein",
    per100g: { energy_kcal: 116, protein: 25.5, carbohydrate: 0, fat_total: 0.8 }, list: "eats" },
  { sourceId: "streak-salmon", description: "Salmon, cooked", role: "protein",
    per100g: { energy_kcal: 206, protein: 22, carbohydrate: 0, fat_total: 12 }, list: "eats" },
  { sourceId: "streak-shrimp", description: "Shrimp, cooked", role: "protein",
    per100g: { energy_kcal: 99, protein: 24, carbohydrate: 0.2, fat_total: 0.3 }, list: "eats" },
  { sourceId: "streak-beef", description: "Beef sirloin, grilled", role: "protein",
    per100g: { energy_kcal: 217, protein: 27, carbohydrate: 0, fat_total: 12 }, list: "eats" },
  { sourceId: "streak-eggs", description: "Eggs, cooked", role: "protein",
    per100g: { energy_kcal: 155, protein: 12.6, carbohydrate: 1.1, fat_total: 10.6 }, list: "eats" },
  { sourceId: "streak-egg-whites", description: "Egg whites, cooked", role: "protein",
    per100g: { energy_kcal: 52, protein: 10.9, carbohydrate: 0.7, fat_total: 0.2 }, list: "eats" },
  { sourceId: "streak-pork", description: "Pork tenderloin, roasted", role: "protein",
    per100g: { energy_kcal: 143, protein: 26, carbohydrate: 0, fat_total: 3.5 }, list: "eats" },
  { sourceId: "streak-tofu", description: "Tofu, firm", role: "protein",
    per100g: { energy_kcal: 144, protein: 17.3, carbohydrate: 2.8, fat_total: 8.7 } },
  { sourceId: "streak-smoked-tofu", description: "Smoked tofu", role: "protein",
    per100g: { energy_kcal: 170, protein: 19, carbohydrate: 3, fat_total: 9 } },
  { sourceId: "streak-greek-yogurt", description: "Greek yogurt, plain", role: "protein",
    per100g: { energy_kcal: 97, protein: 9, carbohydrate: 3.9, fat_total: 5 },
    allergenTags: ["dairy"] },
  { sourceId: "streak-rice", description: "Rice, white, cooked", role: "carb",
    per100g: { energy_kcal: 130, protein: 2.7, carbohydrate: 28, fat_total: 0.3 }, list: "eats" },
  { sourceId: "streak-sweet-potato", description: "Sweet potato, baked", role: "carb",
    per100g: { energy_kcal: 90, protein: 2, carbohydrate: 20.7, fat_total: 0.2 }, list: "eats" },
  { sourceId: "streak-banana", description: "Banana, raw", role: "carb",
    per100g: { energy_kcal: 89, protein: 1.1, carbohydrate: 22.8, fat_total: 0.3 }, list: "eats" },
  { sourceId: "streak-tortilla", description: "Corn tortilla", role: "carb",
    per100g: { energy_kcal: 218, protein: 5.7, carbohydrate: 44.6, fat_total: 2.9 }, list: "eats" },
  { sourceId: "streak-avocado", description: "Avocado, raw", role: "fat",
    per100g: { energy_kcal: 160, protein: 2, carbohydrate: 8.5, fat_total: 14.7 }, list: "eats" },
  { sourceId: "streak-olive-oil", description: "Olive oil", role: "fat",
    per100g: { energy_kcal: 884, protein: 0, carbohydrate: 0, fat_total: 100 }, list: "eats" },
];

export function loadProviderKeys(): void {
  const allowed = new Set(["GEMINI_API_KEY", "TYPESAFE_API_KEY"]);
  let source = "";
  try { source = readFileSync(".env.local", "utf8"); } catch { return; }
  for (const raw of source.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(raw);
    if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

export function configureEnvironment(branchName: string, activityContextEnabled = false): void {
  loadProviderKeys();
  const url = process.env.SUPABASE_TEST_URL ?? "";
  const anon = process.env.SUPABASE_TEST_ANON_KEY ?? "";
  const adminKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
  if (!url || !anon || !adminKey || !process.env.SUPABASE_TEST_DB_URL) {
    throw new Error(`The ${branchName} SUPABASE_TEST_* environment is incomplete.`);
  }
  if (url.includes(PRODUCTION_REF)) throw new Error("Refusing the production Supabase project.");
  process.env.SUPABASE_URL = url;
  process.env[ADMIN_KEY_ENV] = adminKey;
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anon;
  process.env.COACH_ENABLED = "1";
  process.env.HEALTH_CONTEXT_PROVIDER = "gemini";
  process.env.GEMINI_BILLING_ATTESTED = "1";
  if (activityContextEnabled) process.env.COACH_ACTIVITY_CONTEXT_ENABLED = "true";
  if (!process.env.GEMINI_API_KEY || !process.env.TYPESAFE_API_KEY) {
    throw new Error("GEMINI_API_KEY and TYPESAFE_API_KEY are required.");
  }
}

export function safeError(error: unknown): string {
  let detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const value of [
    process.env.SUPABASE_TEST_URL, process.env.SUPABASE_TEST_ANON_KEY,
    process.env.SUPABASE_TEST_SERVICE_ROLE_KEY, process.env.SUPABASE_TEST_DB_URL,
    process.env.GEMINI_API_KEY, process.env.TYPESAFE_API_KEY,
    process.env.SUPABASE_ACCESS_TOKEN,
  ]) {
    if (value) detail = detail.replaceAll(value, "[REDACTED]");
  }
  return detail.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DB_URL]")
    .replace(/https:\/\/[a-z0-9-]+\.supabase\.co/gi, "[REDACTED_SUPABASE_URL]");
}

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function ensureUser(db: SupabaseClient): Promise<string> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((user) => user.email === EMAIL);
    if (found) {
      const updated = await db.auth.admin.updateUserById(found.id, { password: PASSWORD });
      if (updated.error) throw updated.error;
      return found.id;
    }
    if (data.users.length < 200) break;
  }
  const { data, error } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("Could not create the streak test user.");
  return data.user.id;
}

async function signedInClient(): Promise<SupabaseClient> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !data.session) throw error ?? new Error("Could not sign in the streak test user.");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    },
  );
}

async function seedRehearsal(
  db: SupabaseClient,
  userId: string,
  date: string,
): Promise<{ legacyDaySeeded: boolean; fixtures: Map<string, Fixture> }> {
  must("test_reset_user", (await db.rpc("test_reset_user", { p_user_id: userId })).error);
  const { seedCatalogFood } = await import("@/tests/log/fixtures");
  const fixtures = new Map<string, Awaited<ReturnType<typeof seedCatalogFood>>>();
  for (const food of FOODS) {
    const fixture = await seedCatalogFood(db, userId, {
      sourceId: food.sourceId,
      description: food.description,
      // Local Docker already carries the shared active fixture version. A second active label for
      // fdc_branded violates catalog_versions_one_active_per_source before any live turn can run.
      versionLabel: "test-1",
      per100g: food.per100g,
      ...(food.allergenTags ? { allergenTags: food.allergenTags } : {}),
    });
    fixtures.set(food.sourceId, fixture);
    if (food.sourceId === "streak-smoked-tofu") {
      must("catalog_ingredients", (await db.from("catalog_ingredients").upsert({
        food_revision_id: fixture.revisionId,
        seq: 0,
        name: "soybeans",
        raw_text: "soybeans, water, salt",
        allergen_tags: [],
      }, { onConflict: "food_revision_id,seq" })).error);
    }
    if (food.list) {
      must("user_food_prefs", (await db.from("user_food_prefs").upsert({
        user_id: userId, food_ref_id: fixture.foodRefId,
        status: food.list, role: food.role, rev: 1,
      })).error);
    }
  }
  for (const suffix of ["a", "b"]) {
    await seedCatalogFood(db, userId, {
      sourceId: `streak-watermelon-${suffix}`,
      description: "Watermelon, raw",
      versionLabel: "test-1",
      per100g: { energy_kcal: 30, protein: 0.6, carbohydrate: 7.6, fat_total: 0.2 },
    });
  }
  must("constraint_profiles", (await db.from("constraint_profiles").upsert({
    user_id: userId,
    conditions: ["ulcerative colitis"],
    notes: null,
    avoid_allergens: ["gluten", "dairy", "apple"],
    avoid_food_ref_ids: [],
    banned_categories: ["simple_sugars", "pouches", "ultra_processed", "onion_garlic", "legumes"],
    rev: 1,
  })).error);
  must("user_settings", (await db.from("user_settings").upsert({
    user_id: userId, first_opened_at: "2026-08-01T00:00:00.000Z",
    slot_times: {}, shift_minutes: 0, protein_locked: true,
    height_cm: 165, birth_year: 1996, sex: "female", body_fat_pct: null,
    weight_kg: 60, activity_level: "moderate", goal: "recomp",
    training_weekdays: [1, 3, 4, 5], diet_prefs: { flags: ["gluten_free", "dairy_free"] },
    onboarded_at: new Date().toISOString(), rev: 1,
  })).error);
  must("write_target_revision", (await db.rpc("write_target_revision",
    { p_user_id: userId, p_row: targetRevisionFixture(date) })).error);
  must("plan_days", (await db.from("plan_days").upsert({
    user_id: userId, local_date: date, floor_day: false, swaps: {}, slot_notes: {},
    item_overrides: {}, rev: 1,
  })).error);

  const source = await db.from("health_sources").insert({
    user_id: userId, kind: "manual", device_label: "coach streak fixture",
  }).select("id").single();
  must("health_sources", source.error);
  const sourceId = source.data?.id;
  if (!sourceId) throw new Error("Data setup failed: health source id is missing.");
  const dayMs = 86_400_000;
  const shiftedDate = (days: number) => new Date(Date.parse(`${date}T12:00:00.000Z`) + days * dayMs)
    .toISOString().slice(0, 10);
  must("health_samples", (await db.from("health_samples").insert([-14, -7, 0].map((days, index) => ({
    user_id: userId,
    source_id: sourceId,
    type: "body_mass",
    value: 59.2 + index * 0.4,
    unit: "kg",
    start_time: `${shiftedDate(days)}T12:00:00.000Z`,
    end_time: `${shiftedDate(days)}T12:00:00.000Z`,
    tz: TIMEZONE,
    vendor_sample_id: `coach-streak-weight-${index}`,
  })))).error);

  const rice = fixtures.get("streak-rice");
  if (!rice) throw new Error("Data setup failed: rice fixture is missing.");
  for (const [index, days] of [0, -2, -5].entries()) {
    const localDate = shiftedDate(days);
    const entryId = randomUUID();
    must("log_entries", (await db.from("log_entries").insert({
      id: entryId, user_id: userId, eaten_at: `${localDate}T18:00:00.000Z`, tz: TIMEZONE,
      local_date: localDate, slot: "meal-1", method: "text", rev: 1,
    })).error);
    must("log_items", (await db.from("log_items").insert({
      id: randomUUID(), entry_id: entryId, seq: 1, qty: 200, unit: "g",
      food_ref_id: rice.foodRefId, food_revision_id: rice.revisionId, grams: 200,
      snapshot: {
        energy_kcal_calc: { amount: 420 + index * 40 },
        protein: { amount: 18 }, carbohydrate: { amount: 72 }, fat_total: { amount: 8 },
      },
    })).error);
  }
  const eatenAt = new Date().toISOString();
  const legacyDay = await db.from("days").upsert({
    date,
    data: { date, eaten: { coffee: eatenAt, "meal-1": eatenAt }, updatedAt: eatenAt },
    updated_at: eatenAt,
  });
  if (legacyDay.error) {
    const missingLegacyTable = legacyDay.error.code === "PGRST205"
      && legacyDay.error.message.includes("public.days");
    if (!missingLegacyTable) must("days", legacyDay.error);
    return { legacyDaySeeded: false, fixtures };
  }
  return { legacyDaySeeded: true, fixtures };
}

export async function openHarness(
  branchName: string,
  activityContextEnabled = false,
): Promise<LiveHarness> {
  configureEnvironment(branchName, activityContextEnabled);
  const [{ adminClient }, { buildCoachContext, renderCoachContext }, { buildDayContext },
    { localDateIn }, { sameNameRefIds }] =
    await Promise.all([
      import("@/lib/server/admin"), import("@/lib/server/coach-context"),
      import("@/lib/server/day-context"),
      import("@/lib/server/jobs"), import("@/lib/server/catalog-names"),
    ]);
  const db = adminClient();
  const userId = await ensureUser(db);
  const client = await signedInClient();
  const date = localDateIn(TIMEZONE, new Date());
  return {
    db, client, userId, date,
    seed: async () => {
      const seeded = await seedRehearsal(db, userId, date);
      const day = await buildDayContext(db, userId, date, TIMEZONE);
      const expectedEaten = seeded.legacyDaySeeded ? 2 : 0;
      if (day.slots.filter((slot) => slot.state === "eaten").length !== expectedEaten) {
        throw new Error(`Data setup failed: expected exactly ${expectedEaten} eaten plan slots.`);
      }
      const refs = new Set(await sameNameRefIds(client, db, userId, "Watermelon, raw"));
      if (refs.size < 2) throw new Error("Data setup failed: expected two watermelon refs.");
      const coachContext = await buildCoachContext(db, client, userId, {
        now: new Date().toISOString(), tz: TIMEZONE, date,
      });
      return {
        remaining: day.remaining,
        expectedWatermelonRefs: refs,
        fixtures: seeded.fixtures,
        activityContextPresent: renderCoachContext(coachContext).includes('"activity":{'),
      };
    },
  };
}

function assertion(name: string, passed: boolean, detail: string): Assertion {
  return { name, passed, detail };
}

function refsOf(action: CoachAction): string[] {
  if (!("foodRefId" in action)) return [];
  return [action.foodRefId, ...(("alsoFoodRefIds" in action && action.alsoFoodRefIds) || [])];
}

function withinRemaining(card: ComposedMeal, remaining: Macros): boolean {
  return (Object.keys(remaining) as (keyof Macros)[])
    .every((key) => card.totals[key] <= remaining[key] + 0.001);
}

/** Preserve the four C11 assertions in addition to the generic corpus contract. */
export function liveCheckAssertions(
  caseId: string,
  response: CoachTurnResponse,
  context: SeedContext,
): Assertion[] {
  if (caseId === "devin-shift-late-30") {
    const action = response.actions[0];
    return [assertion("C11 +30 remaining shift",
      response.actions.length === 1 && action?.kind === "shift_schedule"
        && action.minutes === 30 && action.scope === "remaining",
      JSON.stringify(action ?? null))];
  }
  if (caseId === "devin-five-eats-suggestions") {
    const cards = response.composed ?? [];
    const anchors = cards.map((card) => card.anchorProtein?.trim().toLowerCase() ?? "");
    const forbidden = cards.flatMap((card) => card.items.map((item) => item.name))
      .filter((name) => FORBIDDEN_ITEM.test(name));
    return [
      assertion("C11 distinct protein anchors",
        anchors.length === 5 && anchors.every(Boolean) && new Set(anchors).size === 5,
        JSON.stringify(anchors)),
      assertion("C11 policy-clean cards",
        cards.every((card) => card.items.every((item) => item.verdict === "allowed"))
          && forbidden.length === 0,
        JSON.stringify(forbidden)),
    ];
  }
  if (caseId === "devin-remaining-snack") {
    const cards = response.composed ?? [];
    const remaining = context.remaining;
    return [
      assertion("C11 snack <= 300 kcal", cards.every((card) => card.totals.kcal <= 300),
        JSON.stringify(cards.map((card) => card.totals.kcal))),
      remaining
        ? assertion("C11 snack within remaining macros",
          cards.every((card) => withinRemaining(card, remaining)),
          JSON.stringify({ remaining, totals: cards.map((card) => card.totals) }))
        // No target revision seeded: there is no remaining-macro bound to hold the cards to.
        : assertion("C11 snack has no remaining-macro bound", true,
          JSON.stringify({ remaining: null })),
    ];
  }
  if (caseId === "devin-watermelon-avoid") {
    const action = response.actions.find((candidate) => candidate.kind === "add_to_avoid");
    const actual = new Set(action ? refsOf(action) : []);
    const expected = context.expectedWatermelonRefs;
    return [assertion("C11 all same-name watermelon refs",
      actual.size === expected.size && [...expected].every((ref) => actual.has(ref)),
      JSON.stringify({ expected: [...expected], actual: [...actual] }))];
  }
  return [];
}
