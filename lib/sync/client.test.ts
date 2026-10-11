import "fake-indexeddb/auto";
import { resolveTargets } from "@/lib/targets";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastError, lastSyncAt, pullChanges, pushOutbox, SYNCED_EVENT, syncOnce } from "./client";
import { getCursor, getRow, setCursor } from "./idb";
import { enqueue } from "./outbox";
import { defaultStore, loadStore, saveStore } from "../store";
import type { ChangeRow, ChangesResponse, OpsResponse, SyncOp } from "./types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";
import { bindAccount, unbindAccount } from "@/lib/device/account";

let h: AccountHandle;

function row(seq: number, over: Partial<ChangeRow> = {}): ChangeRow {
  return {
    seq, entity: "water_log", entity_key: "2026-09-11", rev: seq, op: "update",
    at: "2026-09-11T10:00:00.000Z", current: { local_date: "2026-09-11", cups: seq, rev: seq },
    ...over,
  };
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

const pageFn = (body: ChangesResponse) => (async () => jsonResponse(body)) as unknown as typeof fetch;

const idbSpies = vi.hoisted(() => ({
  putRow: vi.fn(),
  actualPutRow: null as null | ((...args: never[]) => Promise<void>),
}));

// A pulled row other than a log entry is written through `putPulledRow` (lib/sync/row-queue.ts).
const rowQueueSpies = vi.hoisted(() => ({
  putPulledRow: vi.fn(),
  actualPutPulledRow: null as null | ((...args: never[]) => Promise<unknown>),
}));

vi.mock("./row-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./row-queue")>();
  rowQueueSpies.actualPutPulledRow = actual.putPulledRow as never;
  return { ...actual, putPulledRow: (...args: unknown[]) => rowQueueSpies.putPulledRow(...args) };
});

const foodSpies = vi.hoisted(() => ({ loadAccountFoodSnapshot: vi.fn() }));
vi.mock("./food-refs", () => ({ loadAccountFoodSnapshot: foodSpies.loadAccountFoodSnapshot }));

vi.mock("./idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./idb")>();
  idbSpies.actualPutRow = actual.putRow as never;
  return { ...actual, putRow: (...args: unknown[]) => idbSpies.putRow(...args) };
});

// `selectAndFreezeSettings` runs only inside drainOutbox's push phase (never during pullChanges),
// so spying on it lets a test throw from the push phase's pre-network IDB work specifically —
// without also breaking the pull phase, which calls a different settings helper.
const settingsSpies = vi.hoisted(() => ({
  selectAndFreezeSettings: vi.fn(),
  actualSelectAndFreezeSettings: null as null | ((...args: never[]) => Promise<unknown>),
}));

vi.mock("./settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings")>();
  settingsSpies.actualSelectAndFreezeSettings = actual.selectAndFreezeSettings as never;
  return {
    ...actual,
    selectAndFreezeSettings: (...args: unknown[]) => settingsSpies.selectAndFreezeSettings(...args),
  };
});

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  idbSpies.putRow.mockReset();
  idbSpies.putRow.mockImplementation(idbSpies.actualPutRow!);
  rowQueueSpies.putPulledRow.mockReset();
  rowQueueSpies.putPulledRow.mockImplementation(rowQueueSpies.actualPutPulledRow!);
  settingsSpies.selectAndFreezeSettings.mockReset();
  settingsSpies.selectAndFreezeSettings.mockImplementation(settingsSpies.actualSelectAndFreezeSettings!);
  foodSpies.loadAccountFoodSnapshot.mockReset().mockResolvedValue({ foods: [], prefs: [], refs: [] });
  saveStore(defaultStore());
});

afterEach(() => {
  vi.useRealTimers();
});

/** The phone's local today for the target cases, so none depends on the runner's clock. Only
 *  Date is faked: fake-indexeddb still needs real timers. */
function pinToday(iso: string): void {
  const [y, m, d] = iso.split("-").map(Number);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(y, m - 1, d, 12));
}

it("exports the neutral v2 sync event", () => {
  expect(SYNCED_EVENT).toBe("meal-companion:synced");
});

describe("pullChanges", () => {
  it("takes a log entry deleted elsewhere off this phone's day, by its row's date or by search", async () => {
    const E1 = "3f1b1a2c-0000-4000-8000-0000000000e1";
    const E2 = "3f1b1a2c-0000-4000-8000-0000000000e2";
    const extra = (id: string) => ({ id, foodId: "meal", name: "Eggs", slot: "snack", qty: 1, grams: 100,
      macros: { kcal: 150, protein: 12, carbs: 1, fat: 10 }, at: "2026-10-05T08:00:00.000Z" });
    const store = loadStore();
    saveStore({ ...store, days: { ...store.days,
      "2026-10-05": { date: "2026-10-05", extras: [extra(E1), extra("keep")] },
      "2026-10-04": { date: "2026-10-04", extras: [extra(E2)] } } } as never);
    await idbSpies.actualPutRow!(h as never, "log_entries" as never, E1 as never,
      { id: E1, local_date: "2026-10-05", rev: 1 } as never);
    await pullChanges(h, 0, { fetchFn: pageFn({ changes: [
      row(1, { entity: "log_entries", entity_key: E1, op: "delete", current: null }),
      row(2, { entity: "log_entries", entity_key: E2, op: "delete",
        current: { id: E2, rev: 2, deleted_at: "2026-10-05T09:00:00.000Z" } }),
    ], next_cursor: 2, has_more: false }) });
    const days = loadStore().days;
    expect(days["2026-10-05"].extras?.map((e) => e.id)).toEqual(["keep"]);
    expect(days["2026-10-04"].extras).toEqual([]);
    await expect(getRow(h, "log_entries", E1)).resolves.toBeUndefined();
  });

  it("searches every day when the hinted day no longer holds the deleted entry (moved locally)", async () => {
    const E3 = "3f1b1a2c-0000-4000-8000-0000000000e3";
    const store = loadStore();
    saveStore({ ...store, days: { ...store.days,
      "2026-10-05": { date: "2026-10-05", extras: [] },
      "2026-10-06": { date: "2026-10-06", extras: [{ id: E3, foodId: "meal", name: "Eggs", slot: "snack",
        qty: 1, grams: 100, macros: { kcal: 150, protein: 12, carbs: 1, fat: 10 },
        at: "2026-10-06T08:00:00.000Z" }] } } } as never);
    await pullChanges(h, 0, { fetchFn: pageFn({ changes: [
      row(1, { entity: "log_entries", entity_key: E3, op: "delete",
        current: { id: E3, rev: 2, local_date: "2026-10-05", deleted_at: "2026-10-06T09:00:00.000Z" } }),
    ], next_cursor: 1, has_more: false }) });
    expect(loadStore().days["2026-10-06"].extras).toEqual([]);
  });

  it("writes each ChangeRow.current into its entity store", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ changes: [row(1), row(2)], next_cursor: 2, has_more: false }));
    const result = await pullChanges(h, 0, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toMatchObject({ applied: 2, cursor: 2, hasMore: false, pages: 1 });
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toEqual({
      local_date: "2026-09-11", cups: 2, rev: 2,
    });
    expect(fetchFn.mock.calls[0][0]).toBe("/api/sync/changes?since=0&limit=500");
  });

  it("maps a pulled user_settings profile into the local Settings object", async () => {
    const current = {
      height_cm: 165,
      birth_year: 1996,
      sex: "female",
      body_fat_pct: 19.5,
      weight_kg: 57.6,
      activity_level: "moderate",
      goal: "recomp",
      training_weekdays: [1, 3, 4, 5],
      diet_prefs: { flags: ["no_dairy"], text: "Keep fibre gentle" },
      onboarded_at: "2026-09-19T18:00:00.000Z",
      rev: 1,
    };
    await pullChanges(h, 0, {
      fetchFn: pageFn({
        changes: [row(1, { entity: "user_settings", entity_key: "settings", current })],
        next_cursor: 1,
        has_more: false,
      }),
    });

    expect(loadStore().settings).toMatchObject({
      heightCm: 165,
      birthYear: 1996,
      sex: "female",
      bodyFatPct: 19.5,
      weightKg: 57.6,
      activityLevel: "moderate",
      goal: "recomp",
      trainingWeekdays: [1, 3, 4, 5],
      dietPrefs: { flags: ["no_dairy"], text: "Keep fibre gentle" },
      onboardedAt: "2026-09-19T18:00:00.000Z",
    });
  });

  it("mirrors the latest target profile into the phone cache and its pins", async () => {
    const current = {
      id: "00000000-0000-4000-8000-000000000001",
      user_id: "00000000-0000-4000-8000-000000000010",
      effective_from: "2026-09-19",
      rev: 4,
      mode: "grams",
      target_source: "manual",
      training_macros: { kcal: 2200, protein: 130, carbs: 250, fat: 76 },
      rest_macros: { kcal: 1800, protein: 130, carbs: 150, fat: 76 },
      pin_training_kcal: 2200,
      pin_rest_kcal: null,
      pin_protein_g: 130,
      input_weight_kg: 59.25,
      input_weight_source: "weigh-in",
      input_training_weekdays: [1, 3, 4, 5],
      input_activity_level: "moderate",
      input_goal: "recomp",
      formula_name: "profile-energy-v1",
    };
    await pullChanges(h, 0, {
      fetchFn: pageFn({
        changes: [row(1, {
          entity: "target_profiles",
          entity_key: current.id,
          rev: 4,
          current,
        })],
        next_cursor: 1,
        has_more: false,
      }),
    });

    expect(loadStore().settings).toMatchObject({
      trainingKcal: 2200,
      restKcal: null,
      proteinG: 130,
      activeTargetProfile: {
        id: current.id,
        revision: 4,
        source: "manual",
        training: current.training_macros,
        rest: current.rest_macros,
      },
    });
  });

  it("keeps an older pulled revision in the dated history without making it current (#16)", async () => {
    pinToday("2026-10-06");
    const base = {
      user_id: "00000000-0000-4000-8000-000000000010", mode: "grams",
      target_source: "derived", pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
      input_weight_kg: 60, input_weight_source: "weigh-in", input_training_weekdays: [1],
      input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
      rest_macros: { kcal: 1700, protein: 120, carbs: 160, fat: 66 },
    };
    const newer = { ...base, id: "00000000-0000-4000-8000-000000000002",
      effective_from: "2026-10-05", rev: 5,
      training_macros: { kcal: 2200, protein: 130, carbs: 250, fat: 76 } };
    const older = { ...base, id: "00000000-0000-4000-8000-000000000001",
      effective_from: "2026-10-01", rev: 4,
      training_macros: { kcal: 1900, protein: 120, carbs: 200, fat: 70 } };
    await pullChanges(h, 0, {
      fetchFn: pageFn({
        changes: [
          row(1, { entity: "target_profiles", entity_key: newer.id, rev: 5, current: newer }),
          row(2, { entity: "target_profiles", entity_key: older.id, rev: 4, current: older }),
        ],
        next_cursor: 2,
        has_more: false,
      }),
    });

    const settings = loadStore().settings;
    expect(settings.activeTargetProfile?.revision).toBe(5);
    expect(settings.targetHistory?.map((r) => [r.effectiveFrom, r.revision]))
      .toEqual([["2026-10-01", 4], ["2026-10-05", 5]]);
  });

  it("makes a lower rev with a later effective date current, whatever the pull order (#16)", async () => {
    pinToday("2026-10-06");
    const base = {
      user_id: "00000000-0000-4000-8000-000000000010", mode: "grams",
      target_source: "derived", pin_rest_kcal: null, pin_protein_g: null,
      input_weight_kg: 60, input_weight_source: "weigh-in", input_training_weekdays: [1],
      input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
      rest_macros: { kcal: 1700, protein: 120, carbs: 160, fat: 66 },
      training_macros: { kcal: 1900, protein: 120, carbs: 200, fat: 70 },
    };
    const highRev = { ...base, id: "00000000-0000-4000-8000-000000000003",
      effective_from: "2026-09-20", rev: 9, pin_training_kcal: null };
    const laterDate = { ...base, id: "00000000-0000-4000-8000-000000000004",
      effective_from: "2026-09-25", rev: 8, pin_training_kcal: 1900 };
    await pullChanges(h, 0, {
      fetchFn: pageFn({
        changes: [
          row(1, { entity: "target_profiles", entity_key: laterDate.id, rev: 8, current: laterDate }),
          row(2, { entity: "target_profiles", entity_key: highRev.id, rev: 9, current: highRev }),
        ],
        next_cursor: 2,
        has_more: false,
      }),
    });

    const settings = loadStore().settings;
    expect(settings.activeTargetProfile?.id).toBe(laterDate.id);
    expect(settings.trainingKcal).toBe(1900);
  });

  it("leaves a malformed-only account at needs_profile (#23)", async () => {
    pinToday("2026-10-06");
    const malformed = {
      id: "00000000-0000-4000-8000-000000000005",
      user_id: "00000000-0000-4000-8000-000000000010", effective_from: "2026-09-20", rev: 1,
      mode: "grams", target_source: "derived",
      training_macros: { kcal: null, protein: 120, carbs: 200, fat: 70 },
      rest_macros: { kcal: 1700, protein: 120, carbs: 160, fat: 66 },
      pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
      input_weight_kg: 60, input_weight_source: "weigh-in", input_training_weekdays: [1],
      input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
    };
    await pullChanges(h, 0, {
      fetchFn: pageFn({
        changes: [row(1, { entity: "target_profiles", entity_key: malformed.id, rev: 1,
          current: malformed })],
        next_cursor: 1,
        has_more: false,
      }),
    });

    const settings = loadStore().settings;
    expect(settings.activeTargetProfile ?? null).toBeNull();
    expect(resolveTargets("training-10", settings, "2026-09-21")).toBeNull();
  });

  describe("a cached target the mirror no longer backs (#23)", () => {
    const base = {
      user_id: "00000000-0000-4000-8000-000000000010", mode: "grams",
      target_source: "derived", pin_training_kcal: 1900, pin_rest_kcal: null, pin_protein_g: null,
      input_weight_kg: 60, input_weight_source: "weigh-in", input_training_weekdays: [1],
      input_activity_level: "moderate", input_goal: "recomp", formula_name: "profile-energy-v1",
      rest_macros: { kcal: 1700, protein: 120, carbs: 160, fat: 66 },
      training_macros: { kcal: 1900, protein: 120, carbs: 200, fat: 70 },
    };
    const id = "00000000-0000-4000-8000-000000000006";
    const revision = {
      id, revision: 1, source: "derived", effectiveFrom: "2026-09-20",
      training: { kcal: 1900, protein: 120, carbs: 200, fat: 70 },
      rest: { kcal: 1700, protein: 120, carbs: 160, fat: 66 },
      pins: { trainingKcal: 1900, restKcal: null, proteinG: null },
      inputs: { effectiveDate: "2026-09-20", weightKg: 60, weightSource: "weigh-in",
        trainingWeekdays: [1], activity: "moderate", goal: "recomp", goalRateBpWeek: 0,
        formulaName: "profile-energy-v1" },
      seed: null,
    } as const;

    beforeEach(() => pinToday("2026-10-06"));

    function cache(activeTargetProfile: unknown): void {
      const store = defaultStore();
      saveStore({ ...store, settings: { ...store.settings, trainingKcal: 1900,
        activeTargetProfile: activeTargetProfile as never,
        targetHistory: activeTargetProfile ? [activeTargetProfile as never] : [] } });
    }

    it("returns an existing coerced cache to needs_profile when the only row is malformed", async () => {
      // The pre-fix client stored Number(null) as a 0 kcal training target.
      cache({ ...revision, training: { kcal: 0, protein: 120, carbs: 200, fat: 70 } });
      const malformed = { ...base, id, effective_from: "2026-09-20", rev: 1,
        training_macros: { kcal: null, protein: 120, carbs: 200, fat: 70 } };
      await pullChanges(h, 0, { fetchFn: pageFn({
        changes: [row(1, { entity: "target_profiles", entity_key: id, rev: 1, current: malformed })],
        next_cursor: 1, has_more: false }) });

      const settings = loadStore().settings;
      expect(settings.activeTargetProfile ?? null).toBeNull();
      expect(settings.trainingKcal).toBeNull();
      expect(resolveTargets("training-10", settings, "2026-09-21")).toBeNull();

      // A later pass with an already-consumed cursor keeps it there.
      await pullChanges(h, 1, { fetchFn: pageFn({ changes: [], next_cursor: 1, has_more: false }) });
      expect(loadStore().settings.activeTargetProfile ?? null).toBeNull();
    });

    it("does not resurrect a deleted current row", async () => {
      cache(revision);
      await pullChanges(h, 0, { fetchFn: pageFn({
        changes: [
          row(1, { entity: "target_profiles", entity_key: id, rev: 1,
            current: { ...base, id, effective_from: "2026-09-20", rev: 1 } }),
          row(2, { entity: "target_profiles", entity_key: id, rev: 1, op: "delete", current: null }),
        ],
        next_cursor: 2, has_more: false }) });
      expect(loadStore().settings.activeTargetProfile ?? null).toBeNull();

      await pullChanges(h, 2, { fetchFn: pageFn({ changes: [], next_cursor: 2, has_more: false }) });
      expect(loadStore().settings.activeTargetProfile ?? null).toBeNull();
    });

    it("keeps a saved revision whose row has not been pulled yet", async () => {
      cache(revision);
      await pullChanges(h, 0, { fetchFn: pageFn({ changes: [], next_cursor: 0, has_more: false }) });
      const settings = loadStore().settings;
      expect(settings.activeTargetProfile?.id).toBe(id);
      expect(resolveTargets("training-10", settings, "2026-09-21")?.macros.kcal).toBe(1900);
    });

    it("keeps a pulled future-dated first revision out of current until its date", async () => {
      pinToday("2026-09-19");
      const future = { ...base, id, effective_from: "2026-09-20", rev: 1 };
      await pullChanges(h, 0, { fetchFn: pageFn({
        changes: [row(1, { entity: "target_profiles", entity_key: id, rev: 1, current: future })],
        next_cursor: 1, has_more: false }) });
      expect(loadStore().settings.activeTargetProfile ?? null).toBeNull();
      expect(loadStore().settings.targetHistory?.map((r) => r.id)).toEqual([id]);

      pinToday("2026-09-20");
      await pullChanges(h, 1, { fetchFn: pageFn({ changes: [], next_cursor: 1, has_more: false }) });
      expect(loadStore().settings.activeTargetProfile?.id).toBe(id);
      expect(loadStore().settings.trainingKcal).toBe(1900);
    });

    it("leaves an unsaved onboarding preview alone", async () => {
      const preview = { training: revision.training, rest: revision.rest };
      cache(null);
      const store = loadStore();
      saveStore({ ...store, settings: { ...store.settings, activeTargetProfile: preview } });
      await pullChanges(h, 0, { fetchFn: pageFn({ changes: [], next_cursor: 0, has_more: false }) });
      expect(loadStore().settings.activeTargetProfile).toEqual(preview);
      expect(loadStore().settings.trainingKcal).toBe(1900);
    });
  });

  it("refreshes the phone food projection after pulled foods and preferences", async () => {
    const foodId = "00000000-0000-4000-8000-000000000021";
    const refId = "00000000-0000-4000-8000-000000000022";
    foodSpies.loadAccountFoodSnapshot.mockResolvedValue({
      foods: [{ id: foodId, name: "Brown rice", per_100g: {
        protein: 2.6, carbohydrate: 23, fat_total: 0.9,
      }, catalog_food_id: null, deleted_at: null, updated_at: "2026-09-20T12:00:00.000Z" }],
      prefs: [{ food_ref_id: refId, status: "eats", role: "carb",
        updated_at: "2026-09-20T12:01:00.000Z" }],
      refs: [{ id: refId, user_food_id: foodId }],
    });
    await pullChanges(h, 0, {
      fetchFn: pageFn({
        changes: [
          row(1, {
            entity: "user_foods",
            entity_key: foodId,
            current: {
              id: foodId,
              name: "Brown rice",
              per_100g: { protein: 2.6, carbohydrate: 23, fat_total: 0.9 },
              updated_at: "2026-09-20T12:00:00.000Z",
            },
          }),
          row(2, {
            entity: "user_food_prefs",
            entity_key: refId,
            current: {
              food_ref_id: refId,
              status: "eats",
              role: "carb",
              updated_at: "2026-09-20T12:01:00.000Z",
            },
          }),
        ],
        next_cursor: 2,
        has_more: false,
      }),
    });

    expect(loadStore().foods[foodId]).toMatchObject({
      name: "Brown rice",
      status: "eats",
      role: "carb",
    });
    expect(loadStore().foods[foodId].perUnit.protein).toBeCloseTo(0.026);
    expect(loadStore().foods[foodId].perUnit.carbs).toBeCloseTo(0.23);
    expect(loadStore().foods[foodId].perUnit.fat).toBeCloseTo(0.009);
  });

  it("hydrates direct server food writes despite an empty feed and consumed cursor", async () => {
    const foodId = "00000000-0000-4000-8000-000000000021";
    const refId = "00000000-0000-4000-8000-000000000022";
    await setCursor(h, 7);
    foodSpies.loadAccountFoodSnapshot.mockResolvedValue({
      foods: [{ id: foodId, name: "Brown rice", per_100g: {}, deleted_at: null }],
      prefs: [{ food_ref_id: refId, status: "avoid" }],
      refs: [{ id: refId, user_food_id: foodId }],
    });
    await pullChanges(h, undefined, { fetchFn: pageFn({ changes: [], next_cursor: 7,
      has_more: false }) });
    expect(loadStore().foods[foodId].status).toBe("avoid");
    // A new bind simulates page reload without clearing the consumed cursor or account DB.
    unbindAccount();
    h = bindAccount(h.userId);
    await pullChanges(h, undefined, { fetchFn: pageFn({ changes: [], next_cursor: 7,
      has_more: false }) });
    expect(loadStore().foods[foodId].status).toBe("avoid");
    expect(foodSpies.loadAccountFoodSnapshot).toHaveBeenCalledTimes(2);
  });

  it("repairs the same mounted account when direct food writes arrive after an empty snapshot", async () => {
    const foodId = "00000000-0000-4000-8000-000000000021";
    const refId = "00000000-0000-4000-8000-000000000022";
    await pullChanges(h, 0, { fetchFn: pageFn({ changes: [], next_cursor: 0,
      has_more: false }) });
    expect(loadStore().foods).toEqual({});
    foodSpies.loadAccountFoodSnapshot.mockResolvedValue({
      foods: [{ id: foodId, name: "Tofu", per_100g: {}, deleted_at: null }],
      prefs: [{ food_ref_id: refId, status: "eats" }],
      refs: [{ id: refId, user_food_id: foodId }],
    });
    await pullChanges(h, undefined, { fetchFn: pageFn({ changes: [], next_cursor: 0,
      has_more: false }) });
    expect(loadStore().foods[foodId].status).toBe("eats");
    expect(foodSpies.loadAccountFoodSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not replace an optimistic local food edit on a later no-change pull", async () => {
    const foodId = "00000000-0000-4000-8000-000000000021";
    foodSpies.loadAccountFoodSnapshot.mockResolvedValue({
      foods: [{ id: foodId, name: "Brown rice", per_100g: {}, deleted_at: null }],
      prefs: [], refs: [],
    });
    await pullChanges(h, 0, { fetchFn: pageFn({ changes: [
      row(1, { entity: "user_foods", entity_key: foodId,
        current: { id: foodId, name: "Brown rice", per_100g: {} } }),
    ], next_cursor: 1, has_more: false }) });
    const store = loadStore();
    saveStore({ ...store, foods: { ...store.foods,
      [foodId]: { ...store.foods[foodId], status: "eats" } } });
    await enqueue(h, { op_id: "11111111-1111-4111-8111-111111111111",
      entity: "food_membership", entity_id: "22222222-2222-4222-8222-222222222222",
      kind: "update", base_rev: null,
      payload: { id: "22222222-2222-4222-8222-222222222222",
        name_norm: "brown rice", status: "eats", rev: 1 },
      client_ts: "2026-09-20T12:00:00.000Z" });
    await pullChanges(h, undefined, { fetchFn: pageFn({ changes: [], next_cursor: 1,
      has_more: false }) });
    expect(loadStore().foods[foodId].status).toBe("eats");
  });

  it("preserves the server note when a queued membership change has no note edit", async () => {
    const foodId = "00000000-0000-4000-8000-000000000021";
    const refId = "00000000-0000-4000-8000-000000000022";
    foodSpies.loadAccountFoodSnapshot.mockResolvedValue({
      foods: [{ id: foodId, name: "Tofu", per_100g: {}, deleted_at: null }],
      prefs: [{ food_ref_id: refId, status: "avoid", note: "Old note" }],
      refs: [{ id: refId, user_food_id: foodId }],
    });
    await enqueue(h, { op_id: "11111111-1111-4111-8111-111111111111",
      entity: "food_membership", entity_id: "22222222-2222-4222-8222-222222222222",
      kind: "update", base_rev: null,
      payload: { id: "22222222-2222-4222-8222-222222222222",
        name_norm: "tofu", status: "eats", note: null, rev: 1 },
      client_ts: "2026-09-20T12:00:00.000Z" });
    await pullChanges(h, 0, { fetchFn: pageFn({ changes: [], next_cursor: 0,
      has_more: false }) });
    expect(loadStore().foods[foodId].status).toBe("eats");
    // Membership's null note is a no-op. Explicit note clears use save_food_note
    // with a row revision check, so an old queued status change cannot erase it.
    expect(loadStore().foods[foodId].note).toBe("Old note");
  });

  it("keeps an unsent food-row edit while the canonical snapshot still has the old row", async () => {
    const foodId = "00000000-0000-4000-8000-000000000021";
    foodSpies.loadAccountFoodSnapshot.mockResolvedValue({
      foods: [{ id: foodId, name: "Brown rice", per_100g: {}, deleted_at: null }],
      prefs: [], refs: [],
    });
    await pullChanges(h, 0, { fetchFn: pageFn({ changes: [], next_cursor: 0,
      has_more: false }) });
    const store = loadStore();
    saveStore({ ...store, foods: { ...store.foods,
      [foodId]: { ...store.foods[foodId], name: "My brown rice" } } });
    await enqueue(h, { op_id: "33333333-3333-4333-8333-333333333333",
      entity: "user_foods", entity_id: foodId, kind: "update", base_rev: 1,
      payload: { id: foodId, name: "My brown rice" }, client_ts: "2026-09-20T12:00:00.000Z" });
    await pullChanges(h, undefined, { fetchFn: pageFn({ changes: [], next_cursor: 0,
      has_more: false }) });
    expect(loadStore().foods[foodId].name).toBe("My brown rice");
  });

  it("deletes the row when current is null", async () => {
    await pullChanges(h, 0, { fetchFn: pageFn({ changes: [row(1)], next_cursor: 1, has_more: false }) });
    await pullChanges(h, 1, {
      fetchFn: pageFn({ changes: [row(2, { op: "delete", current: null })], next_cursor: 2, has_more: false }),
    });
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toBeUndefined();
  });

  it("starts from the stored cursor and saves the next one only after the page is applied", async () => {
    await setCursor(h, 41);
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ changes: [row(42)], next_cursor: 42, has_more: false }));
    await pullChanges(h, undefined, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(fetchFn.mock.calls[0][0]).toBe("/api/sync/changes?since=41&limit=500");
    await expect(getCursor(h)).resolves.toBe(42);
  });

  // One row this client cannot address must not stop every other device from ever syncing again.
  it("quarantines a row it cannot address and still advances the cursor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setCursor(h, 41);
    const good = row(42, {
      entity_key: "2026-09-12", current: { local_date: "2026-09-12", cups: 9, rev: 42 },
    });
    const result = await pullChanges(h, undefined, {
      fetchFn: pageFn({
        changes: [row(42, { entity_key: "not-a-date" }), good], next_cursor: 42, has_more: false,
      }),
    });
    expect(result).toMatchObject({ applied: 1, skipped: 1, cursor: 42 });
    await expect(getCursor(h)).resolves.toBe(42);
    expect(warn).toHaveBeenCalled();
    await expect(getRow(h, "water_log", "2026-09-12")).resolves.toMatchObject({ cups: 9 });
    warn.mockRestore();
  });

  it("leaves the cursor alone when writing a row genuinely fails", async () => {
    await setCursor(h, 41);
    rowQueueSpies.putPulledRow.mockRejectedValue(new Error("disk is full"));
    await expect(pullChanges(h, undefined, {
      fetchFn: pageFn({ changes: [row(42)], next_cursor: 42, has_more: false }),
    })).rejects.toThrow(/disk is full/);
    await expect(getCursor(h)).resolves.toBe(41);
  });

  it("follows has_more across pages", async () => {
    const pages: ChangesResponse[] = [
      { changes: [row(1)], next_cursor: 1, has_more: true },
      { changes: [row(2)], next_cursor: 2, has_more: false },
    ];
    const fetchFn = vi.fn(async () => jsonResponse(pages.shift()!));
    const result = await pullChanges(h, 0, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toMatchObject({ applied: 2, cursor: 2, pages: 2, hasMore: false });
  });

  it("throws on a non-2xx response", async () => {
    await expect(pullChanges(h, 0, {
      fetchFn: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
    })).rejects.toThrow(/429/);
  });
});

const OP: SyncOp = {
  op_id: "11111111-1111-4111-8111-111111111111", entity: "water_log",
  entity_id: "2026-09-11", kind: "update", base_rev: 1,
  payload: { local_date: "2026-09-11", cups: 4 }, client_ts: "2026-09-11T10:00:00.000Z",
};

describe("pushOutbox", () => {
  it("POSTs the due ops to /api/sync/ops and applies the results", async () => {
    await enqueue(h, OP, 1_000);
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { ops: SyncOp[] };
      return jsonResponse({
        results: body.ops.map((o) => ({ op_id: o.op_id, status: "applied", rev: 2, seq: 9 })),
        server_time: "2026-09-11T10:00:05.000Z",
      } satisfies OpsResponse);
    });
    const result = await pushOutbox(h, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(result).toMatchObject({ pushed: 1, applied: 1, failed: false });
    expect(fetchFn.mock.calls[0][0]).toBe("/api/sync/ops");
    expect(fetchFn.mock.calls[0][1].method).toBe("POST");
  });

  it("reports a failure instead of throwing when the route is down", async () => {
    await enqueue(h, OP, 1_000);
    const result = await pushOutbox(h, {
      fetchFn: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
    });
    expect(result.failed).toBe(true);
  });
});

describe("syncOnce", () => {
  it("pulls, then pushes, then stamps the last sync", async () => {
    const order: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      order.push(url);
      if (url.startsWith("/api/sync/changes")) {
        return jsonResponse({ changes: [], next_cursor: 0, has_more: false });
      }
      const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
      return jsonResponse({
        results: body.ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 9 })),
        server_time: "2026-09-11T10:00:05.000Z",
      } satisfies OpsResponse);
    });
    await enqueue(h, OP, 1_000);
    await syncOnce(h, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(order[0]).toContain("/api/sync/changes");
    expect(order[1]).toBe("/api/sync/ops");
    await expect(lastSyncAt(h)).resolves.toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(lastError(h)).resolves.toBeNull();
  });

  it("runs once more for a write queued while it was pushing, not twice at once", async () => {
    // A wake that arrives mid-pass used to be dropped: the caller was handed the running pass,
    // whose push had already read the outbox, so the new write waited for something else to wake
    // the sync. Starting a second drain beside the first is the other half of the same bug — two
    // drains push the same op and race the settle (Grok pass 18, MEDIUM 3).
    const pushes: SyncOp[][] = [];
    let letPush: (() => void) | null = null;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/sync/changes")) {
        return jsonResponse({ changes: [], next_cursor: 0, has_more: false });
      }
      const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
      pushes.push(body.ops);
      if (pushes.length === 1) await new Promise<void>((resolve) => { letPush = resolve; });
      return jsonResponse({
        results: body.ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 9 })),
        server_time: "2026-09-11T10:00:05.000Z",
      } satisfies OpsResponse);
    }) as unknown as typeof fetch;

    await enqueue(h, OP, 1_000);
    const first = syncOnce(h, { fetchFn });
    await vi.waitFor(() => { expect(letPush).not.toBeNull(); });

    // A second write is queued while that push is open — it cannot be in the ops already sent.
    await enqueue(h, {
      ...OP, op_id: "22222222-2222-4222-8222-222222222222", entity_id: "2026-09-12",
      payload: { local_date: "2026-09-12", cups: 2 },
    }, 1_000);
    // Two more wakes while that push is open. Neither starts a drain of its own.
    const second = syncOnce(h, { fetchFn });
    const third = syncOnce(h, { fetchFn });
    expect(pushes).toHaveLength(1);

    (letPush as unknown as () => void)();
    await Promise.all([first, second, third]);
    await vi.waitFor(() => { expect(pushes).toHaveLength(2); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // One further drain, and the write queued mid-push is in it.
    expect(pushes).toHaveLength(2);
    expect(pushes[1].map((o) => o.entity_id)).toEqual(["2026-09-12"]);
  });

  it("does not stamp a sync that failed, and says what went wrong", async () => {
    await enqueue(h, OP, 1_000);
    const fetchFn = (async (url: string) =>
      url.startsWith("/api/sync/changes")
        ? jsonResponse({ changes: [], next_cursor: 0, has_more: false })
        : new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const { push } = await syncOnce(h, { fetchFn });
    expect(push.failed).toBe(true);
    await expect(lastSyncAt(h)).resolves.toBeNull();
    await expect(lastError(h)).resolves.toEqual(expect.any(String));
  });

  it("records the error and rethrows when the pull itself fails", async () => {
    await expect(syncOnce(h, {
      fetchFn: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    })).rejects.toThrow(/500/);
    await expect(lastError(h)).resolves.toMatch(/500/);
    await expect(lastSyncAt(h)).resolves.toBeNull();
  });

  // A pre-network throw during the push phase (e.g. a QuotaExceededError while freezing the
  // outbox's pending settings op) must surface the same way a pull failure already does —
  // recorded via setLastError, not silently discarded before it ever reaches the network.
  it("records the error and rethrows when the push phase throws before the network call", async () => {
    settingsSpies.selectAndFreezeSettings.mockRejectedValueOnce(new Error("quota exceeded"));
    const fetchFn = (async (url: string) =>
      url.startsWith("/api/sync/changes")
        ? jsonResponse({ changes: [], next_cursor: 0, has_more: false })
        : jsonResponse({ results: [], server_time: "2026-09-11T10:00:05.000Z" })) as unknown as typeof fetch;
    await expect(syncOnce(h, { fetchFn })).rejects.toThrow(/quota exceeded/);
    await expect(lastError(h)).resolves.toMatch(/quota exceeded/);
    await expect(lastSyncAt(h)).resolves.toBeNull();
  });
});
