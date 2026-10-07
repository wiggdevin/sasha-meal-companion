// @vitest-environment jsdom
/**
 * Phase 17 O4a, review round 1 BLOCK 1: a meal-time or whole-day-shift edit reaches
 * `user_settings.slot_times` / `shift_minutes`, from any writer, so the server's planner and the
 * coach's viewed day read the clocks Today shows. Before this the Settings controls saved both on
 * the phone only: Today said Meal 2 was 09:30 breakfast while the planner said 12:30 lunch.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markAccountReady, type AccountHandle } from "@/lib/device/account";
import { resolveSlotTimes } from "@/lib/plan";
import { scheduleFieldsFromRow } from "@/lib/plan-schedule";
import { slotClocksFor } from "@/lib/shopping/coverage";
import { __resetStoreCache, defaultStore, loadStore, saveStore, setOnScheduleEdit } from "@/lib/store";
import { startAccountSync } from "@/lib/sync/account-sync";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { queueScheduleEdit } from "@/lib/sync/schedule-settings";
import type { Settings } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

let h: AccountHandle;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  h = await resetTestAccount();
  window.localStorage.clear();
  __resetStoreCache();
  saveStore(defaultStore(), { silent: true });
});
afterEach(() => setOnScheduleEdit(null));

/** What the Settings controls do: a local patch of the settings, saved non-silently. */
function edit(patch: Partial<Settings>, opts: { silent?: boolean } = {}): Settings {
  const store = loadStore();
  const settings = { ...store.settings, ...patch };
  saveStore({ ...store, settings }, opts);
  return settings;
}

describe("queueScheduleEdit", () => {
  it("queues the two schedule columns alone, through the settings-intent path", async () => {
    await queueScheduleEdit(h, { slotTimes: { "meal-2": "08:30" }, shiftMinutes: 60 });
    const ops = await allOps(h);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: "user_settings", entity_id: USER_SETTINGS_KEY,
      payload: { slot_times: { "meal-2": "08:30" }, shift_minutes: 60 } });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ slot_times: { "meal-2": "08:30" }, shift_minutes: 60 });
  });

  it("keeps the rest of a known row and records only what changed", async () => {
    await putRow(h, "user_settings", USER_SETTINGS_KEY,
      { rev: 4, meals_per_day: 4, slot_times: {}, shift_minutes: 0 });
    await queueScheduleEdit(h, { slotTimes: {}, shiftMinutes: -30 });
    const [op] = await allOps(h);
    expect(op.payload).toMatchObject({ meals_per_day: 4, slot_times: {}, shift_minutes: -30 });
  });
});

describe("every schedule edit reaches user_settings", () => {
  it("queues a Settings meal-time and shift edit, and the server reads Today's clock", async () => {
    markAccountReady(h);
    const stop = startAccountSync(h, { run: async () => {} });
    const settings = edit({ slotTimes: { "meal-2": "08:30" }, shiftMinutes: 60 });
    await vi.waitFor(async () => expect(await allOps(h)).toHaveLength(1));
    stop();

    const [op] = await allOps(h);
    const today = resolveSlotTimes("rest", settings).find((row) => row.slot === "meal-2");
    const server = slotClocksFor({ mealCount: 3,
      ...scheduleFieldsFromRow(op.payload as Record<string, unknown>) })
      .find((row) => row.slotId === "meal-2");
    expect(today?.time).toBe("09:30");
    expect(server).toMatchObject({ time: "09:30", occasion: "breakfast" });
  });

  it("calls the hook for a schedule change only, never for a silent save (a pull)", () => {
    const seen: Settings[] = [];
    setOnScheduleEdit((_owner, settings) => { seen.push(settings); });
    edit({ mealsPerDay: 4 });
    edit({ slotTimes: { "meal-1": "07:00" } }, { silent: true });
    expect(seen).toHaveLength(0);
    edit({ shiftMinutes: 30 });
    edit({ slotTimes: { "meal-1": "07:15" } });
    expect(seen.map((row) => [row.shiftMinutes, row.slotTimes])).toEqual([
      [30, { "meal-1": "07:00" }], [30, { "meal-1": "07:15" }]]);
  });

  it("queues edits in order, so the last one is what the server gets", async () => {
    markAccountReady(h);
    const calls: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stop = startAccountSync(h, { run: async () => {},
      queueSchedule: async (_h, settings) => {
        if (calls.length === 0) await gate;
        calls.push(settings.shiftMinutes);
      } });
    edit({ shiftMinutes: 30 });
    edit({ shiftMinutes: 45 });
    release();
    await vi.waitFor(() => expect(calls).toEqual([30, 45]));
    stop();
    edit({ shiftMinutes: 60 });
    await Promise.resolve();
    expect(calls).toEqual([30, 45]);
  });
});
