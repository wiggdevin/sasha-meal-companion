import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EligibleFoods } from "@/lib/server/eligible-foods";
import { BREAKFAST, eats, F, MAIN } from "@/tests/helpers/meal-foods";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let eligible: EligibleFoods;
vi.mock("@/lib/server/eligible-foods", () => ({ eligibleFoods: vi.fn(async () => eligible) }));

const { mealSnapshot } = await import("@/lib/server/meal-snapshot");
const { mealEvidence, parseMealSnapshot, SNAPSHOT_SCHEMA_VERSION } = await import("@/lib/meals/snapshot");
const { planDay } = await import("@/lib/meals/day");

const NOW = new Date("2026-10-04T15:00:00Z");
const day = (n: number) => new Date(Date.parse("2026-10-04T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

/** The account's own food rows (user_foods ids = the phone's local ids here) and their refs. */
const own = (id: string, name: string, per100: [number, number, number], catalog: number | null = null) => ({
  id, user_id: A, name, catalog_food_id: catalog,
  per_100g: { protein: per100[0], carbohydrate: per100[1], fat_total: per100[2] },
});
const FOODS = [own("tuna", "Tuna, canned in water", [25, 0, 1], 501), own("eggs", "Eggs, whole, cooked", [12.6, 0.7, 9.5]),
  own("toast", "Toast, whole wheat", [13, 43, 4.5]), own("banana", "Banana", [1.1, 23, 0.3])];
const userRef = (food: ReturnType<typeof own>): Row => ({ id: `ref-${food.id}`, kind: "user", catalog_food_id: null,
  user_food_id: food.id, user_foods: food });

let entrySeq = 0;
function log(userId: string, ref: string, occasion: string | null, age: number, extra: Row = {}): Row[] {
  const id = `entry-${entrySeq += 1}`;
  return [{ id, user_id: userId, local_date: day(age), occasion, rev: 1, deleted_at: null, note: "secret note",
    eaten_at: `${day(age)}T07:30:00Z`, ...extra }, { entry_id: id, food_ref_id: ref }];
}

function account(logs: Row[][]) {
  return fakeDb({
    food_refs: [...FOODS.map(userRef), { id: "cat-501", kind: "catalog", catalog_food_id: 501, user_food_id: null,
      user_foods: null }, { id: "ref-b-tuna", kind: "user", catalog_food_id: null, user_food_id: "b-tuna", user_foods: null }],
    user_food_prefs: FOODS.map((food) => ({ user_id: A, food_ref_id: `ref-${food.id}`, role: null })),
    user_settings: [{ user_id: A, slot_times: {}, shift_minutes: 0, meals_per_day: 3, time_zone: "UTC" }],
    target_profiles: [],
    catalog_food_revisions: [],
    log_entries: logs.map((pair) => pair[0]),
    log_items: logs.map((pair) => pair[1]),
  });
}

beforeEach(() => {
  eligible = { eligibleRefIds: [...FOODS.map((food) => `ref-${food.id}`), "cat-501"], eligibleFoodIds: FOODS.map((f) => f.id),
    eligibleCatalogFoodIds: [501], excluded: [], rulesRevision: 3, preferenceFlags: [] };
});

const tunaBreakfasts = () => [log(A, "ref-tuna", "breakfast", 1), log(A, "ref-tuna", "breakfast", 3),
  log(A, "cat-501", "breakfast", 5)];

describe("snapshot v2 (D2)", () => {
  it("returns the contract: versions, account, hash and per-food parts, family and occasion evidence", async () => {
    const body = await mealSnapshot(account(tunaBreakfasts()).client, A, NOW);
    expect(body).toMatchObject({ schemaVersion: SNAPSHOT_SCHEMA_VERSION, rankingVersion: "o2.1", accountId: A,
      computedAt: NOW.toISOString(), inputsHash: expect.stringMatching(/^[0-9a-f]{32}$/), eligible });
    // The own row claims its catalog ref: one food, both identities.
    expect(Object.keys(body.foods).sort()).toEqual(["banana", "eggs", "toast", "tuna"]);
    expect(body.foods.tuna).toMatchObject({ userRefId: "ref-tuna", catalogRefId: "cat-501", family: "tuna",
      parts: ["anchor"] });
    expect(body.foods.tuna.occasion.breakfast.source).toBe("history");
    expect(body.foods.tuna.occasion.dinner.source).toBe("curated");
    expect(body.foods.eggs.occasion.breakfast).toEqual({ score: 1, source: "curated" });
    expect(parseMealSnapshot(JSON.parse(JSON.stringify(body)))).not.toBeNull();
  });

  it("returns scores and provenance only: no notes, times, items or log ids", async () => {
    const text = JSON.stringify(await mealSnapshot(account(tunaBreakfasts()).client, A, NOW));
    for (const word of ["secret note", "07:30", "entry-", "food_ref_id", "eaten_at"]) expect(text).not.toContain(word);
  });

  it("reads history with an explicit account filter, live stamped rows only, in a bounded window", async () => {
    const fake = account(tunaBreakfasts());
    await mealSnapshot(fake.client, A, NOW);
    const reads = fake.queries.filter((q) => q.table === "log_entries");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.filters).toEqual(expect.arrayContaining(["eq:user_id", "is:deleted_at", "not:occasion",
        "gte:local_date", "lte:local_date"]));
    }
  });
});

describe("snapshot v2 resilience and provenance", () => {
  it("stores the raw history score, never one with the curated prior baked in (WARN 5)", async () => {
    const body = await mealSnapshot(account(tunaBreakfasts()).client, A, NOW);
    const raw = body.foods.tuna.occasion.breakfast.score;
    expect(raw).toBeGreaterThanOrEqual(0.75);
    expect(raw).toBeLessThan(1);
  });

  it("a history read that fails leaves a curated snapshot, not a failed rules read (WARN 9)", async () => {
    const fake = account(tunaBreakfasts());
    const from = fake.client.from.bind(fake.client);
    (fake.client as unknown as { from: unknown }).from = (table: string) => {
      if (table === "log_entries") throw new Error("column log_entries.occasion does not exist");
      return from(table);
    };
    const body = await mealSnapshot(fake.client, A, NOW);
    expect(body.eligible).toEqual(eligible);
    expect(body.foods.tuna.occasion.breakfast.source).toBe("curated");
  });

  it("an item swap moves the inputs hash even when the entry rev did not (WARN 7)", async () => {
    const before = await mealSnapshot(account(tunaBreakfasts()).client, A, NOW);
    const logs = tunaBreakfasts();
    logs[0][1].food_ref_id = "ref-eggs";
    const after = await mealSnapshot(account(logs).client, A, NOW);
    expect(after.inputsHash).not.toBe(before.inputsHash);
  });
});

describe("catalog-only Eats foods (Sol r5 WARN 3)", () => {
  it("take their parts from the active revision's own nutrition", async () => {
    eligible = { ...eligible, eligibleRefIds: [...eligible.eligibleRefIds, "cat-77"], eligibleCatalogFoodIds: [501, 77] };
    const fake = account([]);
    fake.tables.food_refs.push({ id: "cat-77", kind: "catalog", catalog_food_id: 77, user_food_id: null, user_foods: null });
    fake.tables.catalog_food_revisions.push({ catalog_food_id: 77, is_active: true, description: "Black beans, cooked",
      catalog_food_nutrients: [{ nutrient_code: "protein", amount_per_100g: 8.9 },
        { nutrient_code: "carbohydrate", amount_per_100g: 23.7 }, { nutrient_code: "fat_total", amount_per_100g: 0.5 }] });
    const body = await mealSnapshot(fake.client, A, NOW);
    expect(body.foods["catalog:77"]).toMatchObject({ userRefId: null, catalogRefId: "cat-77" });
    expect(body.foods["catalog:77"].parts).toEqual(["anchor", "starch"]);
  });
});

describe("inputsHash covers what each food is (Sol WARN 6)", () => {
  it("a role change on an eligible food moves the hash", async () => {
    const before = await mealSnapshot(account([]).client, A, NOW);
    const fake = account([]);
    fake.tables.user_food_prefs.find((row) => row.food_ref_id === "ref-toast")!.role = "protein";
    const after = await mealSnapshot(fake.client, A, NOW);
    expect(after.foods.toast.parts).not.toEqual(before.foods.toast.parts);
    expect(after.inputsHash).not.toBe(before.inputsHash);
  });
});

describe("acceptance 7: history follows the account's own live log", () => {
  it("a deleted entry drops a food below the 3-day bar", async () => {
    const logs = tunaBreakfasts();
    logs[2][0].deleted_at = "2026-10-04T09:00:00Z";
    const body = await mealSnapshot(account(logs).client, A, NOW);
    expect(body.foods.tuna.occasion.breakfast.source).toBe("curated");
  });

  it("an edited entry (moved to lunch) changes the signal and the inputs hash", async () => {
    const before = await mealSnapshot(account(tunaBreakfasts()).client, A, NOW);
    const logs = tunaBreakfasts();
    Object.assign(logs[0][0], { occasion: "lunch", rev: 2 });
    const after = await mealSnapshot(account(logs).client, A, NOW);
    expect(after.foods.tuna.occasion.breakfast.source).toBe("curated");
    expect(after.inputsHash).not.toBe(before.inputsHash);
  });

  it("an old row with no stamped occasion is never counted", async () => {
    const logs = tunaBreakfasts();
    logs[1][0].occasion = null;
    const body = await mealSnapshot(account(logs).client, A, NOW);
    expect(body.foods.tuna.occasion.breakfast.source).toBe("curated");
  });

  it("another account's history never appears", async () => {
    const logs = [log(B, "ref-tuna", "breakfast", 1), log(B, "ref-tuna", "breakfast", 2),
      log(B, "cat-501", "breakfast", 3), log(A, "ref-tuna", "breakfast", 4)];
    const body = await mealSnapshot(account(logs).client, A, NOW);
    expect(body.accountId).toBe(A);
    expect(body.foods.tuna.occasion.breakfast.source).toBe("curated");
  });
});

describe("phone/server parity (acceptance 4 for O2)", () => {
  it("identical foods, targets, schedule, date and snapshot give the identical day", async () => {
    const snapshot = await mealSnapshot(account(tunaBreakfasts()).client, A, NOW);
    const foods = eats(F.eggs, F.toast, F.tuna, F.banana, F.oliveOil);
    const slots = [{ id: "meal-1" as const, target: BREAKFAST, clock: "07:30" },
      { id: "meal-2" as const, target: MAIN, clock: "12:30" }, { id: "meal-3" as const, target: MAIN, clock: "18:30" }];
    // The server reads its own object; the phone reads the JSON it was sent, finds its foods by
    // ref (it holds them under other local ids) and lists them in another order.
    const server = planDay("2026-10-04", slots, foods, undefined, mealEvidence(snapshot, foods));
    const wire = parseMealSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(wire).not.toBeNull();
    const phoneFoods = Object.fromEntries(Object.entries(foods).reverse());
    const refs = { tuna: { userRefId: "ref-tuna", catalogRefId: "cat-501" } };
    const phone = planDay("2026-10-04", slots, phoneFoods, undefined, mealEvidence(wire!, phoneFoods, refs));
    expect(JSON.stringify(phone)).toBe(JSON.stringify(server));
    expect(mealEvidence(wire!, phoneFoods, refs).history).toEqual({ "tuna, canned in water": { breakfast: expect.any(Number) } });
  });
});
