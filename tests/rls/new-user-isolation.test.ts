import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildCoachContext } from "@/lib/server/coach-context";
import { serverStoreFor } from "@/lib/server/day-context";
import { mergeEntity, rebaseOp } from "@/lib/sync/merge";
import type { OpResult, SyncOp } from "@/lib/sync/types";
import { adminClient } from "../helpers/supabase";

const url = process.env.SUPABASE_TEST_URL ?? "";
const anonKey = process.env.SUPABASE_TEST_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const LOCAL = url.startsWith("http://127.0.0.1") && Boolean(anonKey && serviceKey);
const date = "2026-10-26";
const aFirst = { eaten_at: `${date}T12:00:00Z`, changed_at: `${date}T12:00:00Z` };
const bFirst = { eaten_at: `${date}T18:00:00Z`, changed_at: `${date}T18:00:00Z` };
const component = { name: "Catalog plate", qty: 100, unit: "g", role: "carb",
  macros: { kcal: 120, protein: 3, carbs: 26, fat: 1 } };
const itemOverrides = {
  "meal-1": { baseMealId: null, title: "First plate", components: [component] },
  "meal-2": { baseMealId: null, title: "Second plate", components: [component] },
};

function payload(eatenSlots: Record<string, { eaten_at: string | null; changed_at: string }>) {
  return { floor_day: false, swaps: {}, slot_notes: {}, item_overrides: itemOverrides,
    eaten_slots: eatenSlots };
}

function planOp(kind: "create" | "update", baseRev: number | null,
  eatenSlots: Parameters<typeof payload>[0], clientTs: string): SyncOp {
  return { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: date, kind,
    base_rev: baseRev, payload: payload(eatenSlots), client_ts: clientTs };
}

describe.skipIf(!LOCAL)("new-user plan, food, target and coach isolation", () => {
  // Built in `beforeAll`, not at collection: the client throws on a missing URL, and
  // `skipIf(!LOCAL)` only skips the cases — the factory call itself still runs.
  let admin: SupabaseClient;
  const ids: string[] = [];
  let a: { id: string; client: SupabaseClient };
  let b: { id: string; client: SupabaseClient };

  async function account(label: string) {
    const password = `local-${crypto.randomUUID()}-A1!`;
    const email = `newuser-t1-${label}-${Date.now()}-${crypto.randomUUID()}@example.test`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error("user create failed");
    ids.push(created.data.user.id);
    const client = createClient(url, anonKey, { auth: { persistSession: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    return { id: created.data.user.id, client };
  }

  async function apply(accountValue: typeof a, op: SyncOp): Promise<OpResult> {
    const { data, error } = await accountValue.client.rpc("apply_sync_op", {
      p_user_id: accountValue.id, p_op: op,
    });
    if (error) throw error;
    return data as OpResult;
  }

  async function seedAccount(accountValue: typeof a, label: string,
    initial: Parameters<typeof payload>[0]) {
    const settings = await admin.from("user_settings").insert({
      user_id: accountValue.id, first_opened_at: `${date}T00:00:00Z`,
      training_weekdays: [1], activity_level: "moderate", goal: "maintain",
      weight_kg: 70, height_cm: 170, birth_year: 1990, sex: "female",
    });
    if (settings.error) throw settings.error;
    const target = await accountValue.client.rpc("write_target_revision", {
      p_user_id: accountValue.id,
      p_row: {
        effective_from: date, target_source: "derived", mode: "grams",
        training_macros: { kcal: label === "A" ? 2100 : 2200, protein: 130, carbs: 240, fat: 69 },
        rest_macros: { kcal: label === "A" ? 1800 : 1900, protein: 130, carbs: 165, fat: 69 },
        input_weight_kg: 70, input_weight_source: "onboarding", input_training_weekdays: [1],
        input_activity_level: "moderate", input_goal: "maintain", formula_name: "test-v1",
        kcal_min: 1650, protein_g_min: 120, fat_g_min: 50, carb_g_min: 100,
      },
    });
    if (target.error) throw target.error;
    const food = await admin.from("user_foods").insert({
      user_id: accountValue.id, name: `T1 account ${label} food`, kind: "custom",
      per_100g: { energy_kcal: 120, protein: 3, carbohydrate: 26, fat_total: 1 },
    }).select("id").single();
    if (food.error) throw food.error;
    const ref = await admin.from("food_refs").insert({
      kind: "user", user_food_id: food.data.id,
    }).select("id").single();
    if (ref.error) throw ref.error;
    const pref = await admin.from("user_food_prefs").insert({
      user_id: accountValue.id, food_ref_id: ref.data.id, status: "eats", role: "carb",
    });
    if (pref.error) throw pref.error;
    expect(await apply(accountValue, planOp("create", null, initial, `${date}T12:01:00Z`)))
      .toMatchObject({ status: "applied", rev: 1 });
  }

  beforeAll(async () => {
    admin = adminClient();
    [a, b] = await Promise.all([account("a"), account("b")]);
    await Promise.all([
      seedAccount(a, "A", { coffee: aFirst }),
      seedAccount(b, "B", { "meal-1": bFirst }),
    ]);
  });

  afterAll(async () => {
    for (const id of ids) await admin.auth.admin.deleteUser(id);
  });

  it("RLS exposes only the signed-in account and blocks a cross-account update", async () => {
    const [aRows, bRows] = await Promise.all([
      a.client.from("plan_days").select("user_id,eaten_slots"),
      b.client.from("plan_days").select("user_id,eaten_slots"),
    ]);
    expect(aRows.error).toBeNull();
    expect(bRows.error).toBeNull();
    expect(aRows.data).toEqual([{ user_id: a.id, eaten_slots: { coffee: aFirst } }]);
    expect(bRows.data).toEqual([{ user_id: b.id, eaten_slots: { "meal-1": bFirst } }]);

    const denied = await a.client.from("plan_days").update({ floor_day: true })
      .eq("user_id", b.id).eq("local_date", date).select("user_id");
    expect(denied.error).toBeNull();
    expect(denied.data).toEqual([]);
    const untouched = await admin.from("plan_days").select("floor_day")
      .eq("user_id", b.id).eq("local_date", date).single();
    expect(untouched.data?.floor_day).toBe(false);
  });

  it("privileged store and coach reads stay scoped to one account", async () => {
    const [storeA, storeB, coachA, coachB] = await Promise.all([
      serverStoreFor(admin, a.id, date), serverStoreFor(admin, b.id, date),
      buildCoachContext(admin, a.client, a.id, { now: `${date}T13:00:00Z`, tz: "UTC", date }),
      buildCoachContext(admin, b.client, b.id, { now: `${date}T13:00:00Z`, tz: "UTC", date }),
    ]);
    expect(Object.values(storeA.foods).map((food) => food.name)).toEqual(["T1 account A food"]);
    expect(Object.values(storeB.foods).map((food) => food.name)).toEqual(["T1 account B food"]);
    expect(storeA.days[date].eaten).toEqual({ coffee: aFirst.eaten_at });
    expect(storeB.days[date].eaten).toEqual({ "meal-1": bFirst.eaten_at });
    expect(coachA.lists.eats).toEqual(["T1 account A food"]);
    expect(coachB.lists.eats).toEqual(["T1 account B food"]);
    expect(coachA.day.targets?.kcal).toBe(2100);
    expect(coachB.day.targets?.kcal).toBe(2200);
  });

  it("rebases simultaneous ticks per slot and keeps a newer untick tombstone", async () => {
    const meal1 = { eaten_at: `${date}T13:00:00Z`, changed_at: `${date}T13:00:00Z` };
    const meal2 = { eaten_at: `${date}T14:00:00Z`, changed_at: `${date}T14:00:00Z` };
    expect(await apply(a, planOp("update", 1, { coffee: aFirst, "meal-1": meal1 },
      `${date}T13:00:00Z`))).toMatchObject({ status: "applied", rev: 2 });
    const staleOp = planOp("update", 1, { coffee: aFirst, "meal-2": meal2 },
      `${date}T14:00:00Z`);
    const conflict = await apply(a, staleOp);
    expect(conflict).toMatchObject({ status: "conflict", current_rev: 2 });
    if (conflict.status !== "conflict") throw new Error("expected plan conflict");
    const server = conflict.current as Record<string, unknown>;
    const merged = mergeEntity("plan_days", staleOp.payload, server, staleOp.client_ts,
      String(server.updated_at));
    const rebased = rebaseOp(staleOp, merged, conflict.current_rev);
    expect(await apply(a, rebased)).toMatchObject({ status: "applied", rev: 3 });

    const unticked = { eaten_at: null, changed_at: `${date}T15:00:00Z` };
    const finalOp = planOp("update", 3,
      { coffee: unticked, "meal-1": meal1, "meal-2": meal2 }, `${date}T15:00:00Z`);
    expect(await apply(a, finalOp)).toMatchObject({ status: "applied", rev: 4 });

    const [aFeed, bFeed] = await Promise.all([
      a.client.rpc("sync_changes", { p_user_id: a.id, p_since: 0, p_limit: 500 }),
      b.client.rpc("sync_changes", { p_user_id: b.id, p_since: 0, p_limit: 500 }),
    ]);
    expect(aFeed.error).toBeNull();
    expect(bFeed.error).toBeNull();
    const aPlan = (aFeed.data as { entity: string; current: Record<string, unknown> }[])
      .filter((row) => row.entity === "plan_days").at(-1)?.current;
    const bPlan = (bFeed.data as { entity: string; current: Record<string, unknown> }[])
      .filter((row) => row.entity === "plan_days").at(-1)?.current;
    expect(aPlan?.eaten_slots).toEqual({ coffee: unticked, "meal-1": meal1, "meal-2": meal2 });
    expect(bPlan?.eaten_slots).toEqual({ "meal-1": bFirst });

    const [store, coach] = await Promise.all([
      serverStoreFor(admin, a.id, date),
      buildCoachContext(admin, a.client, a.id, { now: `${date}T16:00:00Z`, tz: "UTC", date }),
    ]);
    expect(store.days[date].eaten).toEqual({ "meal-1": meal1.eaten_at, "meal-2": meal2.eaten_at });
    expect(coach.day.slots.find((slot) => slot.slot === "coffee")?.state).not.toBe("eaten");
    expect(coach.day.slots.find((slot) => slot.slot === "meal-1")?.state).toBe("eaten");
    expect(coach.day.slots.find((slot) => slot.slot === "meal-2")?.state).toBe("eaten");
  });
});
