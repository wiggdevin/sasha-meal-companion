/**
 * T9 / C11 live verification against the isolated ai-first-rehearsal branch.
 *
 * Run exactly as documented in docs/plans/2026-09-19-ai-first-companion.md. The script maps the
 * branch-only SUPABASE_TEST_* variables into the runtime variables before importing server code,
 * refuses the production project ref, seeds one deterministic user, and leaves all rehearsal data
 * in place for inspection.
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CoachAction } from "@/lib/coach/actions";
import type { ComposedMeal } from "@/lib/coach/compose";
import type { CoachTurnResponse } from "@/lib/coach/types";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";
const TZ = "America/Denver";
const EMAIL = "t9-live-check@meal-companion.test";
const PASSWORD = "t9-live-check-rehearsal-only";
const PROOF_PATH = join(homedir(), ".claude/goal-state/sasha-ai-first/proof/C11-turns.json");
const ADMIN_KEY_ENV = ["SUPABASE", "SERVICE", "ROLE", "KEY"].join("_");
const FORBIDDEN_ITEM = /apple|gluten|dairy|pouch|honey|syrup|sugar/i;
const SERVER_CHILD_ARG = "--coach-live-react-server-child";

type Macros = { kcal: number; protein: number; carbs: number; fat: number };
type FoodSeed = {
  sourceId: string;
  description: string;
  role: "protein" | "carb" | "fat";
  per100g: Record<string, number>;
};
type TurnProof = {
  sentence: string;
  path: string;
  elapsedMs: number;
  actions: string[];
  cards: number;
  passed: boolean;
  assertions: { name: string; passed: boolean; detail?: string }[];
  response?: CoachTurnResponse;
  error?: string;
};

const SENTENCES = [
  "I woke up late, can you move all my meals by 30 minutes?",
  "make me 5 suggestions from my eats list",
  "suggest a snack that fits my remaining macros",
  "add watermelon to my avoid list",
] as const;

const FOODS: FoodSeed[] = [
  { sourceId: "t9-live-chicken", description: "Chicken breast, roasted", role: "protein",
    per100g: { energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6 } },
  { sourceId: "t9-live-turkey", description: "Turkey breast, roasted", role: "protein",
    per100g: { energy_kcal: 135, protein: 30, carbohydrate: 0, fat_total: 1 } },
  { sourceId: "t9-live-tuna", description: "Tuna, light, canned in water", role: "protein",
    per100g: { energy_kcal: 116, protein: 25.5, carbohydrate: 0, fat_total: 0.8 } },
  { sourceId: "t9-live-salmon", description: "Salmon, cooked", role: "protein",
    per100g: { energy_kcal: 206, protein: 22, carbohydrate: 0, fat_total: 12 } },
  { sourceId: "t9-live-shrimp", description: "Shrimp, cooked", role: "protein",
    per100g: { energy_kcal: 99, protein: 24, carbohydrate: 0.2, fat_total: 0.3 } },
  { sourceId: "t9-live-beef", description: "Beef sirloin, grilled", role: "protein",
    per100g: { energy_kcal: 217, protein: 27, carbohydrate: 0, fat_total: 12 } },
  { sourceId: "t9-live-egg-whites", description: "Egg whites, cooked", role: "protein",
    per100g: { energy_kcal: 52, protein: 10.9, carbohydrate: 0.7, fat_total: 0.2 } },
  { sourceId: "t9-live-pork", description: "Pork tenderloin, roasted", role: "protein",
    per100g: { energy_kcal: 143, protein: 26, carbohydrate: 0, fat_total: 3.5 } },
  { sourceId: "t9-live-rice", description: "Rice, white, cooked", role: "carb",
    per100g: { energy_kcal: 130, protein: 2.7, carbohydrate: 28, fat_total: 0.3 } },
  { sourceId: "t9-live-sweet-potato", description: "Sweet potato, baked", role: "carb",
    per100g: { energy_kcal: 90, protein: 2, carbohydrate: 20.7, fat_total: 0.2 } },
  { sourceId: "t9-live-banana", description: "Banana, raw", role: "carb",
    per100g: { energy_kcal: 89, protein: 1.1, carbohydrate: 22.8, fat_total: 0.3 } },
  { sourceId: "t9-live-tortilla", description: "Corn tortilla", role: "carb",
    per100g: { energy_kcal: 218, protein: 5.7, carbohydrate: 44.6, fat_total: 2.9 } },
  { sourceId: "t9-live-avocado", description: "Avocado, raw", role: "fat",
    per100g: { energy_kcal: 160, protein: 2, carbohydrate: 8.5, fat_total: 14.7 } },
  { sourceId: "t9-live-olive-oil", description: "Olive oil", role: "fat",
    per100g: { energy_kcal: 884, protein: 0, carbohydrate: 0, fat_total: 100 } },
];

/** Read only the two provider keys when the caller has not already sourced .env.local. */
function loadProviderKeys(): void {
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

function configureEnvironment(): void {
  loadProviderKeys();
  const url = process.env.SUPABASE_TEST_URL ?? "";
  const anon = process.env.SUPABASE_TEST_ANON_KEY ?? "";
  const adminKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
  if (!url || !anon || !adminKey || !process.env.SUPABASE_TEST_DB_URL) {
    throw new Error("The ai-first-rehearsal SUPABASE_TEST_* environment is incomplete.");
  }
  if (url.includes(PRODUCTION_REF)) throw new Error("Refusing the production Supabase project.");
  process.env.SUPABASE_URL = url;
  process.env[ADMIN_KEY_ENV] = adminKey;
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anon;
  process.env.COACH_ENABLED = "1";
  process.env.HEALTH_CONTEXT_PROVIDER = "gemini";
  process.env.GEMINI_BILLING_ATTESTED = "1";
  if ((process.env.SUPABASE_URL ?? "").includes(PRODUCTION_REF)) {
    throw new Error("SUPABASE_URL still points at production after rehearsal mapping.");
  }
  if (!process.env.GEMINI_API_KEY || !process.env.TYPESAFE_API_KEY) {
    throw new Error("GEMINI_API_KEY and TYPESAFE_API_KEY are required.");
  }
}

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

function safeError(error: unknown): string {
  let detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const value of [
    process.env.SUPABASE_TEST_URL,
    process.env.SUPABASE_TEST_ANON_KEY,
    process.env.SUPABASE_TEST_SERVICE_ROLE_KEY,
    process.env.SUPABASE_TEST_DB_URL,
    process.env.GEMINI_API_KEY,
    process.env.TYPESAFE_API_KEY,
  ]) {
    if (value) detail = detail.replaceAll(value, "[REDACTED]");
  }
  return detail.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DB_URL]")
    .replace(/https:\/\/[a-z0-9-]+\.supabase\.co/gi, "[REDACTED_SUPABASE_URL]");
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
  if (error || !data.user) throw error ?? new Error("Could not create the T9 test user.");
  return data.user.id;
}

async function signedInClient(): Promise<SupabaseClient> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !data.session) throw error ?? new Error("Could not sign in the T9 test user.");
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    },
  );
}

async function seedRehearsal(db: SupabaseClient, userId: string, date: string): Promise<void> {
  const reset = await db.rpc("test_reset_user", { p_user_id: userId });
  must("test_reset_user", reset.error);

  const { seedCatalogFood } = await import("../tests/log/fixtures");
  const fixtures = [];
  for (const food of FOODS) {
    fixtures.push({ food, fixture: await seedCatalogFood(db, userId, {
      sourceId: food.sourceId,
      description: food.description,
      versionLabel: "t9-live-check-1",
      per100g: food.per100g,
    }) });
  }
  for (const { food, fixture } of fixtures) {
    must("user_food_prefs", (await db.from("user_food_prefs").upsert({
      user_id: userId, food_ref_id: fixture.foodRefId, status: "eats", role: food.role, rev: 1,
    })).error);
  }

  // Two physical catalog rows with the same canonical name prove widening, not just one ref.
  await seedCatalogFood(db, userId, {
    sourceId: "t9-live-watermelon-a", description: "Watermelon, raw",
    versionLabel: "t9-live-check-1",
    per100g: { energy_kcal: 30, protein: 0.6, carbohydrate: 7.6, fat_total: 0.2 },
  });
  await seedCatalogFood(db, userId, {
    sourceId: "t9-live-watermelon-b", description: "Watermelon, raw",
    versionLabel: "t9-live-check-1",
    per100g: { energy_kcal: 30, protein: 0.6, carbohydrate: 7.6, fat_total: 0.2 },
  });

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
    user_id: userId,
    first_opened_at: "2026-08-01T00:00:00.000Z",
    slot_times: {}, shift_minutes: 0, protein_locked: true,
    height_cm: 165, birth_year: 1996, sex: "female", body_fat_pct: null,
    weight_kg: 60, activity_level: "moderate", goal: "recomp",
    training_weekdays: [1, 3, 4, 5], diet_prefs: { flags: ["gluten_free", "dairy_free"] },
    onboarded_at: new Date().toISOString(), rev: 1,
  })).error);
  must("plan_days", (await db.from("plan_days").upsert({
    user_id: userId, local_date: date, floor_day: false, swaps: {}, slot_notes: {},
    item_overrides: {}, rev: 1,
  })).error);

  const eatenAt = new Date().toISOString();
  must("days", (await db.from("days").upsert({
    date,
    data: { date, eaten: { coffee: eatenAt, "meal-1": eatenAt }, updatedAt: eatenAt },
    updated_at: eatenAt,
  })).error);
}

function addAssertion(
  proof: TurnProof,
  name: string,
  condition: boolean,
  detail?: string,
): void {
  proof.assertions.push({ name, passed: condition, ...(condition || !detail ? {} : { detail }) });
  if (!condition) proof.passed = false;
}

function responsePath(response: CoachTurnResponse): string {
  if (response.fastPath) return "fast-path (Jev)";
  if (response.model.modelId) return `LLM (${response.model.provider}/${response.model.modelId})`;
  return "non-generative";
}

function proofFor(sentence: string, elapsedMs: number, response: CoachTurnResponse): TurnProof {
  return {
    sentence,
    path: responsePath(response),
    elapsedMs,
    actions: response.actions.map((action) => action.kind),
    cards: response.composed?.length ?? 0,
    passed: true,
    assertions: [],
    response,
  };
}

function refsOf(action: CoachAction): string[] {
  if (!("foodRefId" in action)) return [];
  return [action.foodRefId, ...(("alsoFoodRefIds" in action && action.alsoFoodRefIds) || [])];
}

function withinRemaining(card: ComposedMeal, remaining: Macros): boolean {
  return (Object.keys(remaining) as (keyof Macros)[])
    .every((key) => card.totals[key] <= remaining[key] + 0.001);
}

function writeProof(payload: unknown): void {
  mkdirSync(join(PROOF_PATH, ".."), { recursive: true });
  writeFileSync(PROOF_PATH, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function printTable(proofs: TurnProof[]): void {
  console.table(proofs.map((proof) => ({
    sentence: proof.sentence,
    path: proof.path,
    "elapsed ms": proof.elapsedMs,
    actions: proof.actions.join(", ") || "none",
    cards: proof.cards,
    result: proof.passed ? "PASS" : "FAIL",
  })));
}

async function main(): Promise<void> {
  configureEnvironment();
  const [{ adminClient }, { runTurn }, { buildDayContext }, { localDateIn },
    { sameNameRefIds }] = await Promise.all([
    import("@/lib/server/admin"),
    import("@/lib/server/coach-turn"),
    import("@/lib/server/day-context"),
    import("@/lib/server/jobs"),
    import("@/lib/server/catalog-names"),
  ]);
  const db = adminClient();
  const userId = await ensureUser(db);
  const client = await signedInClient();
  const date = localDateIn(TZ, new Date());
  await seedRehearsal(db, userId, date);
  const day = await buildDayContext(db, userId, date, TZ);
  if (day.slots.filter((slot) => slot.state === "eaten").length !== 2) {
    throw new Error("Data setup failed: expected exactly two eaten plan slots.");
  }
  const remaining = day.remaining;
  const expectedWatermelonRefs = new Set(await sameNameRefIds(
    client, db, userId, "Watermelon, raw"));
  if (expectedWatermelonRefs.size < 2) {
    throw new Error("Data setup failed: expected at least two same-name watermelon refs.");
  }

  const proofs: TurnProof[] = [];
  let threadId: string | null = null;
  for (const [index, sentence] of SENTENCES.entries()) {
    const started = Date.now();
    try {
      const response = await runTurn(client, db, userId, {
        threadId, messageId: randomUUID(), text: sentence,
        now: new Date().toISOString(), tz: TZ,
      });
      const elapsedMs = Date.now() - started;
      threadId = response.threadId;
      const proof = proofFor(sentence, elapsedMs, response);

      if (index === 0) {
        const action = response.actions[0];
        addAssertion(proof, "fastPath === true", response.fastPath === true);
        addAssertion(proof, "exactly one action", response.actions.length === 1,
          `got ${response.actions.length}`);
        addAssertion(proof, "shift_schedule +30 remaining",
          action?.kind === "shift_schedule" && action.minutes === 30 && action.scope === "remaining",
          JSON.stringify(action ?? null));
        addAssertion(proof, "non-empty reply",
          (response.messages.at(-1)?.content.trim().length ?? 0) > 0);
        addAssertion(proof, "elapsed < 2000 ms", elapsedMs < 2_000, `got ${elapsedMs} ms`);
      } else if (index === 1) {
        const cards = response.composed ?? [];
        const anchors = cards.map((card) => card.anchorProtein?.trim().toLowerCase() ?? "");
        addAssertion(proof, "exactly five composed cards", cards.length === 5,
          `got ${cards.length}`);
        addAssertion(proof, "five distinct protein anchors",
          anchors.length === 5 && anchors.every(Boolean) && new Set(anchors).size === 5,
          JSON.stringify(anchors));
        addAssertion(proof, "every item policy allowed",
          cards.every((card) => card.items.every((item) => item.verdict === "allowed")));
        const forbidden = cards.flatMap((card) => card.items.map((item) => item.name))
          .filter((name) => FORBIDDEN_ITEM.test(name));
        addAssertion(proof, "no forbidden item names", forbidden.length === 0,
          JSON.stringify(forbidden));
      } else if (index === 2) {
        const cards = response.composed ?? [];
        addAssertion(proof, "at least one composed card", cards.length >= 1,
          `got ${cards.length}`);
        addAssertion(proof, "every card <= 300 kcal",
          cards.every((card) => card.totals.kcal <= 300),
          JSON.stringify(cards.map((card) => card.totals.kcal)));
        if (remaining) {
          addAssertion(proof, "every card within today's remaining macros",
            cards.every((card) => withinRemaining(card, remaining)),
            JSON.stringify({ remaining, totals: cards.map((card) => card.totals) }));
        } else {
          // No target revision: there is no remaining-macro bound to check against.
          addAssertion(proof, "no target revision, so no remaining-macro bound",
            day.targets === null, JSON.stringify({ targets: day.targets }));
        }
      } else {
        const action = response.actions.find((candidate) => candidate.kind === "add_to_avoid");
        addAssertion(proof, "add_to_avoid action", action !== undefined,
          JSON.stringify(response.actions));
        const actualRefs = new Set(action ? refsOf(action) : []);
        addAssertion(proof, "all same-name refs grounded",
          expectedWatermelonRefs.size === actualRefs.size
            && [...expectedWatermelonRefs].every((ref) => actualRefs.has(ref)),
          JSON.stringify({ expected: [...expectedWatermelonRefs], actual: [...actualRefs] }));
      }
      proofs.push(proof);
    } catch (error) {
      proofs.push({
        sentence,
        path: "error",
        elapsedMs: Date.now() - started,
        actions: [],
        cards: 0,
        passed: false,
        assertions: [],
        error: safeError(error),
      });
      break;
    }
  }

  const passed = proofs.length === SENTENCES.length && proofs.every((proof) => proof.passed);
  writeProof({
    generatedAt: new Date().toISOString(),
    branch: "ai-first-rehearsal",
    date,
    timezone: TZ,
    remainingBeforeTurns: remaining,
    turns: proofs,
    passed,
  });
  printTable(proofs);
  for (const proof of proofs.filter((item) => !item.passed)) {
    console.error(`FAIL: ${proof.sentence}`);
    for (const assertion of proof.assertions.filter((item) => !item.passed)) {
      console.error(`  ${assertion.name}: ${assertion.detail ?? "failed"}`);
    }
    if (proof.error) console.error(`  ${proof.error}`);
    if (proof.response) console.error(JSON.stringify(proof.response, null, 2));
  }
  console.log(`proof: ${PROOF_PATH}`);
  process.exitCode = passed ? 0 : 1;
}

if (!process.argv.includes(SERVER_CHILD_ARG)) {
  // `lib/ai/typesafe.ts` is intentionally marked server-only. Plain `tsx` resolves that marker's
  // throwing client entry unless this live server harness supplies React's server condition.
  loadProviderKeys();
  const child = spawnSync(process.execPath, [
    ...process.execArgv,
    "--conditions=react-server",
    fileURLToPath(import.meta.url),
    SERVER_CHILD_ARG,
  ], { stdio: "inherit", env: process.env });
  if (child.error) console.error(safeError(child.error));
  process.exitCode = child.status ?? 1;
} else {
  void main().catch((error: unknown) => {
    const detail = safeError(error);
    writeProof({ generatedAt: new Date().toISOString(), passed: false, setupError: detail });
    console.error(detail);
    console.log(`proof: ${PROOF_PATH}`);
    process.exitCode = 1;
  });
}
