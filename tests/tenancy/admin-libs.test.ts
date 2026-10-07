/**
 * Spec 3.5 (Phase 9 slice 3), server helpers that hold the admin client: each runs for real
 * against the database for user A while user B holds canary rows. Each case has a B-side control
 * (the same call for B sees B's canary), so a canary that never reaches any output cannot make the
 * A-side check pass, and every row B owns is compared by value before and after.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { loadSuggestionEvidence } from "@/lib/coach/suggest-policy";
import { reserveSpend, settleSpend } from "@/lib/ai/spend";
import { recordCoachIntentEvent } from "@/lib/server/coach-intent-telemetry";
import { dayTotalsPrivileged } from "@/lib/server/day-totals";
import { withTokenUser } from "@/lib/server/privileged";
import { defaultPorts } from "@/lib/server/coach-ports";
import { composePoolPorts } from "@/lib/server/compose-pool-ports";
import { roleAdvicePorts } from "@/lib/server/coach-role-advice";
import { runDirectBlockTool } from "@/lib/coach/blocks";
import { ensureUserFoodFacets } from "@/lib/foods/facet-warm";
import { sameNameRefIds } from "@/lib/server/catalog-names";
import { foodKey, inputHash } from "@/lib/foods/facet-keys";
import { OCCASION_RUBRIC_VERSION, RUBRIC_VERSION } from "@/lib/foods/facets";
import { occasionFacetEvidence } from "@/lib/server/occasion-facets";
import { dropCatalogFoods, seedCatalogFood } from "../log/fixtures";
import { mintToken, toBytea } from "@/lib/server/tokens";
import { accountSnapshot, purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

const CANARY_KCAL = 4242.4242;
const CANARY_KG = 77.7;
const CANARY_P = 0.123;
const CANARY_WEEK_KCAL = 3131;
const CANARY_FACET = `canary-${crypto.randomUUID()}`;
const CANARY_FACET_P = 0.777;
const DATE = "2020-04-04";

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await adminClient().from(table).insert(row).select("*").single();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return String((data as { id?: string }).id ?? "");
}

async function userFoodRef(owner: string, name: string): Promise<string> {
  const foodId = await insert("user_foods", { user_id: owner, name, kind: "custom",
    allergen_tags: ["canary-tag"] });
  return insert("food_refs", { kind: "user", user_food_id: foodId });
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("admin-client helpers answer only for their account", () => {
  let a: TestUser;
  let b: TestUser;
  let bRef = "";

  beforeAll(async () => {
    assertLocalTargets();
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    bRef = await userFoodRef(b.id, "canary food of B");
    await insert("user_food_prefs", { user_id: b.id, food_ref_id: bRef, status: "avoid",
      role: "protein" });
    const entry = await insert("log_entries", { id: crypto.randomUUID(), user_id: b.id,
      eaten_at: `${DATE}T12:00:00Z`, tz: "UTC", local_date: DATE, slot: "meal-1", method: "text" });
    await insert("log_items", { id: crypto.randomUUID(), entry_id: entry, seq: 1, qty: 1,
      unit: "g", grams: 100, food_ref_id: bRef,
      snapshot: { energy_kcal: { amount: CANARY_KCAL, unit: "kcal" } } });
    await insert("ai_calls", { user_id: b.id, purpose: "tenancy", provider: "test",
      model_id: "m", sdk_version: "1", cost_estimate: 999 });
  });

  beforeEach(() => {
    vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "5");
    // B's $999 canary also lands in the global day total (scale S2); lift the ceiling so these
    // cases prove the per-user cap and ledger only.
    vi.stubEnv("AI_GLOBAL_DAILY_SPEND_CAP_USD", "1000000");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await purge([a.id, b.id]);
  });

  it("suggestion evidence: B's food, mark and facets never become A's evidence", async () => {
    // A cached facet judgment for B's user food (read through lib/foods/facets readFacets), with a
    // canary probability: B's evidence must carry it, A's must not.
    const food = await adminClient().from("food_refs")
      .select("user_foods(id, rev, name, brand, ingredients_text)").eq("id", bRef).single();
    expect(food.error).toBeNull();
    const uf = (food.data as unknown as { user_foods: { id: string; rev: number; name: string;
      brand: string | null; ingredients_text: string | null } }).user_foods;
    const facet = await adminClient().from("food_facets").upsert({
      food_key: foodKey({ kind: "user_food", id: uf.id, rev: uf.rev }),
      input_hash: inputHash({ name: uf.name, brand: uf.brand, ingredientsText: uf.ingredients_text }),
      facet: "human_food", rubric_version: RUBRIC_VERSION, p: CANARY_P, model: "tenancy",
      user_id: b.id });
    expect(facet.error).toBeNull();
    const item = { foodRefId: bRef, catalogFoodRevisionId: null } as never;
    const forB = await loadSuggestionEvidence(b.id, [item], { needsNoCook: false });
    expect(JSON.stringify(forB)).toContain("canary-tag");
    expect(JSON.stringify(forB)).toContain(String(CANARY_P));
    const before = accountSnapshot(b.id);
    const forA = await loadSuggestionEvidence(a.id, [item], { needsNoCook: false });
    expect(JSON.stringify(forA)).not.toContain("canary-tag");
    expect(JSON.stringify(forA)).not.toContain(String(CANARY_P));
    expect(forA.status === "ready" ? Object.keys(forA.byIdentity) : []).toEqual([]);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("occasion facets: A never gets facet evidence for B's food, B does", async () => {
    // A v2 breakfast_fit judgment for B's user food with a canary probability. The snapshot's
    // facets source re-reads every user food under the asking account, so passing B's food id
    // as A's yields nothing, while B's own read maps the canary.
    const food = await adminClient().from("food_refs").select("user_foods(id, rev, name, brand, ingredients_text)")
      .eq("id", bRef).single();
    expect(food.error).toBeNull();
    const uf = (food.data as unknown as { user_foods: { id: string; rev: number; name: string;
      brand: string | null; ingredients_text: string | null } }).user_foods;
    const canaryP = 0.913;
    const facet = await adminClient().from("food_facets").upsert({
      food_key: foodKey({ kind: "user_food", id: uf.id, rev: uf.rev }),
      input_hash: inputHash({ name: uf.name, brand: uf.brand, ingredientsText: uf.ingredients_text }),
      facet: "breakfast_fit", rubric_version: OCCASION_RUBRIC_VERSION, p: canaryP, model: "tenancy",
      user_id: b.id });
    expect(facet.error).toBeNull();
    const gate = { open: true as const, rubricVersion: OCCASION_RUBRIC_VERSION, calibrationId: "canary",
      thresholds: { breakfast: 0.5, lunch: 0.5, dinner: 0.5, snack: 0.5 } };
    const asked = [{ id: "x", kind: "user_food" as const, userFoodId: uf.id }];
    const forB = await occasionFacetEvidence(adminClient(), b.id, asked, { gate });
    expect(forB.scores.x?.breakfast).toBeGreaterThan(0.5);
    const before = accountSnapshot(b.id);
    const forA = await occasionFacetEvidence(adminClient(), a.id, asked, { gate });
    expect(forA.scores).toEqual({});
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("day totals: A's privileged totals exclude B's canary intake", async () => {
    const forB = await dayTotalsPrivileged(adminClient(), b.id, DATE);
    expect(JSON.stringify(forB)).toContain(String(CANARY_KCAL));
    const forA = await dayTotalsPrivileged(adminClient(), a.id, DATE);
    expect(JSON.stringify(forA)).not.toContain(String(CANARY_KCAL));
  });

  it("spend cap: B's spend never counts against A's own cap", async () => {
    await expect(reserveSpend(adminClient(), b.id, 0.01)).rejects.toMatchObject({ status: 429 });
    const held = await reserveSpend(adminClient(), a.id, 0.01);
    await settleSpend(adminClient(), held, 0);
  });

  it("intent telemetry: A's event is filed under A and leaves B's rows", async () => {
    const before = accountSnapshot(b.id);
    const latency = 700_000 + Math.floor(Math.random() * 1000);
    await recordCoachIntentEvent(adminClient(), a.id, { intent: "question",
      winningConfidence: 0.9, minArgumentConfidence: null, fastPathTaken: false,
      fallbackReason: "none", latencyMs: latency });
    const rows = await adminClient().from("coach_intent_events").select("user_id")
      .eq("latency_ms", latency);
    expect(rows.error).toBeNull();
    expect(rows.data).toEqual([{ user_id: a.id }]);
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("coach ports: A's food search and day totals never return B's canaries", async () => {
    // Food search needs an active catalog version; seed one so the case does not depend on which
    // suite ran first.
    await seedCatalogFood(adminClient(), a.id, { sourceId: `tenancy-ports-${crypto.randomUUID()}`,
      description: "Tenancy ports food", per100g: { protein: 1 } });
    const clock = { tz: "UTC", date: DATE };
    const portsFor = async (user: TestUser) =>
      defaultPorts(await userClient(user), adminClient(), () => crypto.randomUUID(), clock);
    const [forA, forB] = [await portsFor(a), await portsFor(b)];
    const read = async (ports: typeof forA, userId: string) => JSON.stringify([
      await ports.searchFoods(userId, "canary food of B", 5),
      await ports.dayTotals(userId, DATE),
    ]);
    const bSees = await read(forB, b.id);
    expect(bSees).toContain(bRef);
    expect(bSees).toContain(String(CANARY_KCAL));
    const before = accountSnapshot(b.id);
    const aSees = await read(forA, a.id);
    expect(aSees).not.toContain(bRef);
    expect(aSees).not.toContain(String(CANARY_KCAL));
    expect(accountSnapshot(b.id)).toEqual(before);
    await dropCatalogFoods(adminClient(), "tenancy-ports-");
  });

  it("compose pool ports: A's compose_meal pool and ref map never see B's canary Eats food", async () => {
    // Phase 18 W9: a compose_meal direct wish fills missing plate parts from this pool, which is
    // the account's Eats intersected with eligibleFoods' CURRENT admission (W9 Sol r3 BLOCK).
    // That gate requires a name it can classify as a real, unbranded whole food (lib/policy/
    // whole-foods.ts) with no other evidence row — "chicken breast" matches its poultry pattern
    // exactly (anchored, no extra words), so the row is identified by id, not by a decorated name.
    const canaryFoodId = await insert("user_foods", { user_id: b.id, name: "Chicken breast",
      kind: "custom", allergen_tags: [] });
    const canaryEatsRef = await insert("food_refs", { kind: "user", user_food_id: canaryFoodId });
    await insert("user_food_prefs", { user_id: b.id, food_ref_id: canaryEatsRef, status: "eats",
      role: "protein" });
    const before = accountSnapshot(b.id);
    const portsFor = async (user: TestUser) => composePoolPorts(await userClient(user), adminClient());
    const [poolsA, poolsB] = await Promise.all([portsFor(a), portsFor(b)]);
    const [forA, forB] = await Promise.all([poolsA.pool!(a.id), poolsB.pool!(b.id)]);
    expect(forB[canaryFoodId]?.name).toBe("Chicken breast");
    expect(forA[canaryFoodId]).toBeUndefined();
    const [refsForA, refsForB] = await Promise.all([poolsA.poolRefs!(a.id), poolsB.poolRefs!(b.id)]);
    expect(refsForB[canaryFoodId]).toBe(canaryEatsRef);
    expect(refsForA[canaryFoodId]).toBeUndefined();
    expect(accountSnapshot(b.id)).toEqual(before);
  });

  it("role advice: A's stored-role lookup never returns B's role for B's food", async () => {
    expect((await roleAdvicePorts(adminClient(), b.id).storedRoles([bRef])).get(bRef))
      .toBe("protein");
    const forA = await roleAdvicePorts(adminClient(), a.id).storedRoles([bRef]);
    expect(forA.get(bRef) ?? null).toBeNull();
  });

  it("coach chart blocks: A's weight chart never plots B's canary weigh-ins", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const src = await insert("health_sources", { user_id: b.id, kind: "health_auto_export",
      device_label: "tenancy" });
    for (const daysAgo of [1, 2, 3]) {
      const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      await insert("health_samples", { user_id: b.id, source_id: src, type: "body_mass",
        value: CANARY_KG, unit: "kg", start_time: at, end_time: at, tz: "UTC",
        vendor_sample_id: `tenancy-chart-${daysAgo}` });
    }
    const chart = (userId: string) => runDirectBlockTool("show_chart",
      { chart: "weight_trend", days: 30 }, { admin: adminClient(), userId, date: today,
        tz: "UTC", context: null, profile: {} as never, newId: () => crypto.randomUUID(),
        weightUnit: "kg" });
    const forB = JSON.stringify(await chart(b.id));
    expect(forB).toContain(String(CANARY_KG));
    const forA = JSON.stringify(await chart(a.id));
    expect(forA).not.toContain(String(CANARY_KG));
  });

  it("coach chart blocks: A's kcal week never takes its days from B's log", async () => {
    // Review r5 finding 2: kcal_week reads daily_energy through the admin client. B logs three
    // recent days; both users have an active target, so a regression in the user filter would
    // hand A a chart built on B's dates.
    const today = new Date().toISOString().slice(0, 10);
    for (const user of [a, b]) {
      await insert("target_profiles", { user_id: user.id, effective_from: "2020-01-01",
        kcal_train: 2000, kcal_rest: 2000, authored_by: "user", mode: "grams", protein_g: 100,
        fat_g: 60, carb_g: 265, protein_g_min: 100, target_source: "manual",
        training_macros: { kcal: 2000, protein: 100, carbs: 265, fat: 60 },
        rest_macros: { kcal: 2000, protein: 100, carbs: 265, fat: 60 },
        input_weight_kg: 70, input_weight_source: "onboarding", input_training_weekdays: [1],
        input_activity_level: "moderate", input_goal: "maintain", formula_name: "tenancy" });
    }
    const snapshot = { energy_kcal: { amount: CANARY_WEEK_KCAL, unit: "kcal" },
      energy_kcal_calc: { amount: CANARY_WEEK_KCAL, unit: "kcal" } };
    for (const daysAgo of [0, 1, 2]) {
      const day = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
      const entry = await insert("log_entries", { id: crypto.randomUUID(), user_id: b.id,
        eaten_at: `${day}T12:00:00Z`, tz: "UTC", local_date: day, slot: "meal-1",
        method: "text" });
      await insert("log_items", { id: crypto.randomUUID(), entry_id: entry, seq: 1, qty: 1,
        unit: "g", grams: 100, food_ref_id: bRef, snapshot });
    }
    const chart = async (userId: string) => (await runDirectBlockTool("show_chart",
      { chart: "kcal_week" }, { admin: adminClient(), userId, date: today, tz: "UTC",
        context: null, profile: {} as never, newId: () => crypto.randomUUID() })) as
      { data: { points?: number }; block: unknown };
    const forB = await chart(b.id);
    expect(forB.data.points).toBeGreaterThan(0);
    expect(JSON.stringify(forB.block)).toContain(String(CANARY_WEEK_KCAL));
    const forA = await chart(a.id);
    expect(forA.data.points ?? 0).toBe(0);
    expect(JSON.stringify(forA)).not.toContain(String(CANARY_WEEK_KCAL));
  });

  it("facet warming: judgments are written under the food's owner; A cannot warm B's food",
    async () => {
      // The real write path (review r5 finding 3): TypeSafe is stubbed at the network edge and
      // answers every question; ensureUserFoodFacets then upserts food_facets for real.
      vi.stubEnv("TYPESAFE_API_KEY", "tenancy-key");
      vi.stubEnv("AI_DAILY_SPEND_CAP_USD", "100000");
      const calls: string[] = [];
      const real = globalThis.fetch;
      vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("https://api.typesafe.ai/")) return real(input, init);
        const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
        calls.push(String(init?.body));
        const answers = Object.fromEntries(Object.keys(body.questions)
          .map((k) => [k, { type: "noul", noul: CANARY_FACET_P }]));
        return new Response(JSON.stringify({ model: "jev", answers,
          usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      }) as typeof fetch);
      try {
        const foodOf = async (owner: string, name: string) => {
          const ref = await userFoodRef(owner, name);
          const row = await adminClient().from("food_refs").select("user_food_id")
            .eq("id", ref).single();
          return row.data?.user_food_id as string;
        };
        const [bFood, aFood] = [await foodOf(b.id, `${CANARY_FACET} of B`),
          await foodOf(a.id, "tenancy food of A")];
        const facetRows = async (foodId: string) => {
          const { data, error } = await adminClient().from("food_facets")
            .select("user_id, p").like("food_key", `user_food:${foodId}:%`);
          if (error) throw new Error(error.message);
          return data ?? [];
        };

        const before = accountSnapshot(b.id);
        const byA = await ensureUserFoodFacets([bFood], { userId: a.id });
        expect(byA.judged + byA.writes).toBe(0);
        expect(calls.join("\n")).not.toContain(CANARY_FACET);
        expect(await facetRows(bFood)).toEqual([]);
        expect(accountSnapshot(b.id)).toEqual(before);

        const byB = await ensureUserFoodFacets([bFood], { userId: b.id });   // control
        expect(byB.writes).toBeGreaterThan(0);
        const bRows = await facetRows(bFood);
        expect(bRows.length).toBe(byB.writes);
        expect(bRows.every((r) => r.user_id === b.id)).toBe(true);

        const own = await ensureUserFoodFacets([aFood], { userId: a.id });
        expect(own.writes).toBeGreaterThan(0);
        expect((await facetRows(aFood)).every((r) => r.user_id === a.id)).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });

  it("same-name refs: A's avoid-family lookup returns shared catalog refs, never B's food",
    async () => {
      const name = `Tenancyzz ${crypto.randomUUID().slice(0, 8)}`;
      const bFood = await userFoodRef(b.id, name);
      const catalog = await seedCatalogFood(adminClient(), a.id, {
        sourceId: `tenancy-names-${crypto.randomUUID()}`, description: `${name}, raw`,
        per100g: { protein: 1 } });
      const before = accountSnapshot(b.id);
      const refs = await sameNameRefIds(await userClient(a), adminClient(), a.id, name);
      expect(refs).toContain(catalog.foodRefId);   // control: the lookup really ran
      expect(refs).not.toContain(bFood);
      const kinds = await adminClient().from("food_refs").select("kind").in("id", refs);
      expect(kinds.error).toBeNull();
      expect((kinds.data ?? []).every((r) => r.kind === "catalog")).toBe(true);
      expect(accountSnapshot(b.id)).toEqual(before);
      await dropCatalogFoods(adminClient(), "tenancy-names-");
    });

  it("token boundary: each token resolves to its own user, never the other", async () => {
    const tokens: Record<string, string> = {};
    for (const u of [a, b]) {
      const { raw, hash } = mintToken();
      await insert("api_tokens", { user_id: u.id, label: "tenancy", token_hash: toBytea(hash),
        scopes: ["read"] });
      tokens[u.id] = raw;
    }
    const whoAmI = (raw: string) => withTokenUser(new Request("https://app.test/api/mcp",
      { headers: { authorization: `Bearer ${raw}` } }), "read", async (ctx) => ctx.userId);
    expect(await whoAmI(tokens[a.id])).toBe(a.id);
    expect(await whoAmI(tokens[b.id])).toBe(b.id);
  });
});
