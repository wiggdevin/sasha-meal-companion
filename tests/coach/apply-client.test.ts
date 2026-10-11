import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import type { FoodComponent, ResolvedDay, Store } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const mocks = vi.hoisted(() => ({
  addExtra: vi.fn(),
  allOps: vi.fn(),
  commitLogEntry: vi.fn(),
  getRow: vi.fn(),
  loadStore: vi.fn(),
  removeExtra: vi.fn(),
  enqueue: vi.fn(),
  resolveDay: vi.fn(),
  saveMealEdit: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  addExtra: mocks.addExtra,
  upsertExtra: mocks.addExtra, // a new coach card is an upsert: one entry, one card
  loadStore: mocks.loadStore,
  removeExtra: mocks.removeExtra,
}));
vi.mock("@/lib/resolve", () => ({ resolveDay: mocks.resolveDay }));
vi.mock("@/lib/plan-day-client", () => ({ saveMealEdit: mocks.saveMealEdit }));
vi.mock("@/lib/log-commit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-commit-client")>();
  return { ...actual, commitLogEntry: mocks.commitLogEntry };
});
vi.mock("@/lib/sync/outbox", () => ({
  enqueue: mocks.enqueue,
  USER_SETTINGS_KEY: "settings",
  mutateUserSettings: vi.fn(),
}));
vi.mock("@/lib/sync/idb", () => ({
  allOps: mocks.allOps, getRow: mocks.getRow, closeAllAccountDbs: vi.fn(),
}));

import {
  ACTION_TIMEOUT_MS, ACTION_TIMEOUT_REASON, UNDO_TIMEOUT_REASON,
  ACTION_PENDING_REASON, UNDO_PENDING_REASON, applyCoachAction, undoCoachAction,
} from "@/lib/coach/apply-client";
import { applySetSlotMeal } from "@/lib/coach/apply-slot";
import { buffered, resetTimings } from "@/lib/timing";

// These tests drive the phone's own token path with no server: the phone is offline, so no
// coach Undo record is sent and the token decides (lib/coach/undo-client.ts).
vi.stubGlobal("navigator", { onLine: false });

const DATE = "2026-09-16";
const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const FOOD_REF = "33333333-3333-4333-8333-333333333333";
let storage: Map<string, string>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const chicken: FoodComponent = {
  name: "Chicken breast", qty: 100, unit: "g", role: "protein",
  macros: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
};
const rice: FoodComponent = {
  name: "White rice", qty: 100, unit: "g", role: "carb",
  macros: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 },
};

function grounded(overrides: Partial<GroundedActionItem> = {}): GroundedActionItem {
  return {
    name: "Chicken breast", grams: 150, foodRefId: FOOD_REF,
    catalogFoodRevisionId: 77, kcalPer100g: 165, proteinPer100g: 31,
    carbsPer100g: 0, fatPer100g: 3.6, verdict: "allowed", ...overrides,
  };
}

function storeWithOverride(override?: Store["days"][string]["itemOverrides"]): Store {
  return { days: { [DATE]: { date: DATE, itemOverrides: override } } } as unknown as Store;
}

function groundedNamed(name: string) {
  const { grams: _grams, ...named } = grounded({ name });
  return named;
}

function day(components: FoodComponent[] = [chicken, rice], time = "08:00"): ResolvedDay {
  return {
    date: DATE, dayType: "training-7-fasted", isFloorDay: false,
    targets: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, extras: [],
    consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, waterCups: 0,
    slots: [{ slot: "meal-1", time, label: "Meal 1",
      meal: { id: "breakfast", name: "Breakfast", slot: "meal-1", components,
        macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, prepMinutes: 0, tags: [] },
      components, macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, eaten: false }],
  };
}

let h: AccountHandle;

beforeEach(async () => {
  vi.clearAllMocks();
  h = await resetTestAccount();
  storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  mocks.loadStore.mockReturnValue(storeWithOverride());
  mocks.resolveDay.mockReturnValue(day());
  mocks.saveMealEdit.mockResolvedValue({ date: DATE });
  mocks.commitLogEntry.mockResolvedValue({ status: "ok", entry_id: ENTRY_ID, rev: 1,
    items: [], totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 } });
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.allOps.mockResolvedValue([]);
  mocks.getRow.mockResolvedValue(undefined);
  resetTimings();
});

afterEach(() => { vi.useRealTimers(); resetTimings(); });

describe("applyCoachAction", () => {
  it("logs one grounded meal at the slot time and mirrors it into Today", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    const action: CoachAction = {
      actionId: "a-log", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded()], note: "  Felt fine  ", flagged: [],
    };

    const result = await applyCoachAction(action, {
      tz: "America/Los_Angeles", now: new Date("2026-09-16T17:00:00.000Z"),
    });

    expect(mocks.commitLogEntry).toHaveBeenCalledWith({
      entry_id: ENTRY_ID,
      title: "Chicken breast",
      eaten_at: "2026-09-16T15:00:00.000Z",
      tz: "America/Los_Angeles",
      local_date: DATE,
      slot: "meal-1",
      method: "text",
      note: "Felt fine",
      items: [{
        id: ITEM_ID, seq: 1, food_ref_id: FOOD_REF, qty: 150, unit: "g", grams: 150,
        portion_id: null, food_revision_id: 77, was_edited: false,
      }],
    }, { fetchImpl: undefined, account: h });
    expect(mocks.addExtra).toHaveBeenCalledWith(DATE, expect.objectContaining({
      id: ENTRY_ID, name: "Chicken breast", slot: "meal-1", grams: 150, note: "Felt fine",
    }));
    expect(result).toMatchObject({ status: "applied", token: { kind: "log_meal", entryId: ENTRY_ID } });
  });

  it("uses the supplied dish title for the commit and Today card", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    await applyCoachAction({
      actionId: "a-titled-log", kind: "log_meal", date: DATE, slot: "snack",
      title: "Spaghetti bolognese", items: [grounded()], flagged: [],
    } as CoachAction, { tz: "UTC", now: new Date("2026-09-16T12:00:00.000Z") });
    expect(mocks.commitLogEntry.mock.calls[0][0]).toMatchObject({
      title: "Spaghetti bolognese", slot: "snack",
    });
    expect(mocks.addExtra).toHaveBeenCalledWith(DATE, expect.objectContaining({
      name: "Spaghetti bolognese", slot: "snack",
    }));
  });

  it("passes a null catalog revision through to the commit contract", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    await applyCoachAction({
      actionId: "a-null-revision", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded({ catalogFoodRevisionId: null })], flagged: [],
    }, { tz: "UTC" });
    expect(mocks.commitLogEntry.mock.calls[0][0].items[0].food_revision_id).toBeNull();
  });

  it("treats an offline queued log as applied", async () => {
    const queued: unknown[] = [];
    mocks.enqueue.mockImplementation(async (_h: unknown, op: unknown) => { queued.push(op); });
    mocks.allOps.mockImplementation(async () => queued);
    mocks.commitLogEntry.mockImplementationOnce(async (request) => {
      await mocks.enqueue(h, {
        op_id: "44444444-4444-4444-8444-444444444444",
        entity: "log_entries", entity_id: request.entry_id, kind: "create", base_rev: null,
        payload: { ...request, id: request.entry_id }, client_ts: "2026-09-16T12:00:00.000Z",
      });
      return { status: "queued" };
    });
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    const result = await applyCoachAction({
      actionId: "a-log", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded()], flagged: [],
    }, { tz: "UTC" });
    expect(result).toMatchObject({ status: "applied", token: { baseRev: null } });
    expect(mocks.addExtra).toHaveBeenCalledOnce();
    if (result.status !== "applied") throw new Error("expected an applied result");
    await undoCoachAction("a-log", result.token);
    expect(queued).toHaveLength(2);
    expect(queued).toEqual([
      expect.objectContaining({ entity_id: ENTRY_ID, kind: "create", base_rev: null }),
      expect.objectContaining({ entity_id: ENTRY_ID, kind: "delete", base_rev: 1 }),
    ]);
    expect(mocks.removeExtra).toHaveBeenCalledWith(DATE, ENTRY_ID);
  });

  it("applies the same actionId only once", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    const action: CoachAction = {
      actionId: "a-idempotent", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded()], flagged: [],
    };
    const first = await applyCoachAction(action, { tz: "UTC" });
    const second = await applyCoachAction(action, { tz: "UTC" });
    expect(first).toEqual(second);
    expect(mocks.commitLogEntry).toHaveBeenCalledOnce();
    expect(mocks.addExtra).toHaveBeenCalledOnce();
  });

  it("keeps a timed-out write guarded and records its late success", async () => {
    vi.useFakeTimers();
    const commit = deferred<Awaited<ReturnType<typeof mocks.commitLogEntry>>>();
    mocks.commitLogEntry.mockReturnValueOnce(commit.promise);
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    const action: CoachAction = {
      actionId: "a-late", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded()], flagged: [],
    };
    const settled = vi.fn();
    const pending = applyCoachAction(action, { tz: "UTC", onSettled: settled });
    await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ status: "failed", reason: ACTION_TIMEOUT_REASON });
    await expect(applyCoachAction(action, { tz: "UTC" }))
      .resolves.toEqual({ status: "failed", reason: ACTION_PENDING_REASON });
    expect(mocks.commitLogEntry).toHaveBeenCalledOnce();

    commit.resolve({ status: "ok", entry_id: ENTRY_ID, rev: 1,
      items: [], totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 } });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ status: "applied" })));
    expect(JSON.parse(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-late`) ?? "null"))
      .toMatchObject({ status: "applied" });
    expect(mocks.commitLogEntry).toHaveBeenCalledOnce();
  });

  it("refuses to log an item with incomplete catalog nutrition before committing (audit #20)", async () => {
    const result = await applyCoachAction({
      actionId: "a-sparse", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded({ name: "Mystery bar", proteinPer100g: null, fatPer100g: null })], flagged: [],
    }, { tz: "UTC", now: new Date("2026-09-16T12:00:00.000Z") });
    expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/Mystery bar has incomplete nutrition/) });
    expect(mocks.commitLogEntry).not.toHaveBeenCalled();
    expect(mocks.addExtra).not.toHaveBeenCalled();
  });

  it.each([-50, 0, Number.NaN, Number.POSITIVE_INFINITY, 2001])(
    "refuses to log %s g before committing, so no negative or zero gram payload is sent (Grok round 6)",
    async (grams) => {
      const result = await applyCoachAction({
        actionId: `a-bad-${String(grams)}`, kind: "log_meal", date: DATE, slot: "meal-1",
        items: [grounded({ name: "Banana", grams })], flagged: [],
      }, { tz: "UTC", now: new Date("2026-09-16T12:00:00.000Z") });
      expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/Banana needs an amount/) });
      expect(mocks.commitLogEntry).not.toHaveBeenCalled();
      expect(mocks.addExtra).not.toHaveBeenCalled();
    });

  it("does not retain a recall record for a failed apply", async () => {
    mocks.commitLogEntry.mockResolvedValueOnce({ status: "invalid", issues: [] });
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    await applyCoachAction({
      actionId: "a-failed", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded()], flagged: [],
    }, { tz: "UTC" });
    expect(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-failed`)).toBeNull();
  });

  it("retains only the newest 50 applied action records", async () => {
    for (let index = 0; index < 51; index += 1) {
      await applyCoachAction({
        actionId: `a-capped-${index}`, kind: "move_slot", date: DATE, slot: "meal-1",
        time: "19:30", flagged: [],
      }, { tz: "UTC" });
    }
    expect(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-capped-0`)).toBeNull();
    expect(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-capped-1`)).not.toBeNull();
    expect(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-capped-50`)).not.toBeNull();
    expect([...storage.keys()].filter((key) => key.startsWith(`smc:u:${h.userId}:coach-action:a-capped-`)))
      .toHaveLength(50);
  });

  it("adds one grounded component without resizing the existing lines", async () => {
    const action: CoachAction = {
      actionId: "a-add", kind: "add_slot_item", date: DATE, slot: "meal-1",
      item: grounded({ name: "Avocado", grams: 50, kcalPer100g: 160,
        proteinPer100g: 2, carbsPer100g: 8.5, fatPer100g: 14.7 }), flagged: [],
    };
    const result = await applyCoachAction(action, { tz: "UTC" });
    const edit = mocks.saveMealEdit.mock.calls[0][3];
    expect(mocks.saveMealEdit).toHaveBeenCalledWith(DATE, "meal-1", "breakfast",
      expect.objectContaining({ planned: [chicken, rice] }));
    expect(edit.components).toEqual([
      chicken, rice,
      { name: "Avocado", qty: 50, unit: "g", role: "free",
        macros: { kcal: 80, protein: 1, carbs: 4.3, fat: 7.4 } },
    ]);
    expect(edit.components[0]).toBe(chicken);
    expect(edit.components[1]).toBe(rice);
    expect(result.status).toBe("applied");
  });

  it("removes only the case-insensitive substring match", async () => {
    const result = await applyCoachAction({
      actionId: "a-remove", kind: "remove_slot_item", date: DATE, slot: "meal-1",
      ...groundedNamed("RICE"), flagged: [],
    }, { tz: "UTC" });
    expect(mocks.saveMealEdit.mock.calls[0][3].components).toEqual([chicken]);
    expect(mocks.saveMealEdit.mock.calls[0][3].components[0]).toBe(chicken);
    expect(result.status).toBe("applied");
  });

  it("prefers an exact case-insensitive name over substring matches", async () => {
    const egg = { ...chicken, name: "Egg" };
    const eggplant = { ...rice, name: "Eggplant" };
    const eggs = { ...chicken, name: "Eggs" };
    mocks.resolveDay.mockReturnValue(day([eggplant, egg, eggs]));
    const result = await applyCoachAction({
      actionId: "a-exact", kind: "remove_slot_item", date: DATE, slot: "meal-1",
      ...groundedNamed("egg"), flagged: [],
    }, { tz: "UTC" });
    expect(result.status).toBe("applied");
    expect(mocks.saveMealEdit.mock.calls[0][3].components).toEqual([eggplant, eggs]);
  });

  it("fails when a substring name matches more than one line", async () => {
    mocks.resolveDay.mockReturnValue(day([
      { ...rice, name: "Eggplant" }, { ...chicken, name: "Eggs" },
    ]));
    const result = await applyCoachAction({
      actionId: "a-ambiguous", kind: "remove_slot_item", date: DATE, slot: "meal-1",
      ...groundedNamed("egg"), flagged: [],
    }, { tz: "UTC" });
    expect(result).toEqual({ status: "failed", reason: expect.stringMatching(/more than one/i) });
    expect(mocks.saveMealEdit).not.toHaveBeenCalled();
  });

  it("sets one matching line from grounded macros without resizing its neighbor", async () => {
    const result = await applyCoachAction({
      ...grounded({ name: "chicken" }), actionId: "a-set", kind: "set_slot_item",
      date: DATE, slot: "meal-1", name: "chicken", grams: 150, flagged: [],
    }, { tz: "UTC" });
    const components = mocks.saveMealEdit.mock.calls[0][3].components as FoodComponent[];
    expect(components).toEqual([
      { name: "Chicken breast", qty: 150, unit: "g", role: "protein",
        macros: { kcal: 248, protein: 46.5, carbs: 0, fat: 5.4 } },
      rice,
    ]);
    expect(components[1]).toBe(rice);
    expect(result.status).toBe("applied");
  });

  it("fails closed when no component name matches", async () => {
    const result = await applyCoachAction({
      actionId: "a-remove", kind: "remove_slot_item", date: DATE, slot: "meal-1",
      ...groundedNamed("salmon"), flagged: [],
    }, { tz: "UTC" });
    expect(result).toEqual({ status: "failed", reason: expect.stringContaining("salmon") });
    expect(mocks.saveMealEdit).not.toHaveBeenCalled();
  });

  it("moves one slot without changing its component override", async () => {
    const result = await applyCoachAction({
      actionId: "a-move", kind: "move_slot", date: DATE, slot: "meal-1",
      time: "19:30", flagged: [],
    }, { tz: "UTC" });
    expect(mocks.saveMealEdit).toHaveBeenCalledWith(DATE, "meal-1", "breakfast",
      { planned: [chicken, rice], time: "19:30" });
    expect(result.status).toBe("applied");
  });

  it("materializes one titled override for every date in a meal series", async () => {
    const dates = [DATE, "2026-09-17", "2026-09-18"];
    const result = await applyCoachAction({
      actionId: "a-series", kind: "set_slot_meal", from: DATE, dates,
      slot: "meal-1", title: "Chicken and rice", items: [grounded()], flagged: [],
    } as CoachAction, { tz: "UTC" });
    expect(mocks.saveMealEdit.mock.calls.map((call) => call[0])).toEqual(dates);
    for (const call of mocks.saveMealEdit.mock.calls) {
      expect(call[3]).toMatchObject({ title: "Chicken and rice",
        components: [expect.objectContaining({ name: "Chicken breast" })] });
    }
    expect(result).toMatchObject({ status: "applied", token: {
      kind: "set_slot_meal", dates: dates.map((date) => ({ date })),
    } });
    expect(mocks.removeExtra).not.toHaveBeenCalled();
  });

  it("does not materialize the same series twice when its action id is replayed", async () => {
    const action = { actionId: "a-series-replay", kind: "set_slot_meal", from: DATE,
      dates: [DATE, "2026-09-17"], slot: "meal-1", title: "Chicken and rice",
      items: [grounded()], flagged: [] } as CoachAction;
    const first = await applyCoachAction(action, { tz: "UTC" });
    const second = await applyCoachAction(action, { tz: "UTC" });
    expect(second).toEqual(first);
    expect(mocks.saveMealEdit).toHaveBeenCalledTimes(2);
  });

  it("rolls back every completed date when a later series write fails", async () => {
    mocks.saveMealEdit.mockResolvedValueOnce({ date: DATE })
      .mockResolvedValueOnce({ date: "2026-09-17" })
      .mockRejectedValueOnce(new Error("Disk unavailable"));
    const result = await applyCoachAction({
      actionId: "a-series-fails", kind: "set_slot_meal", from: DATE,
      dates: [DATE, "2026-09-17", "2026-09-18"], slot: "meal-1",
      title: "Chicken and rice", items: [grounded()], flagged: [],
    } as CoachAction, { tz: "UTC" });
    expect(result).toEqual({ status: "failed", reason: "Disk unavailable" });
    expect(mocks.saveMealEdit.mock.calls.map((call) => [call[0], call[3].components, call[3].title]))
      .toEqual([
        [DATE, [expect.objectContaining({ name: "Chicken breast" })], "Chicken and rice"],
        ["2026-09-17", [expect.objectContaining({ name: "Chicken breast" })], "Chicken and rice"],
        ["2026-09-18", [expect.objectContaining({ name: "Chicken breast" })], "Chicken and rice"],
        ["2026-09-17", null, null], [DATE, null, null],
      ]);
  });

  it("keeps the original apply error when rollback also fails and names unrestored dates", async () => {
    const applyError = new Error("Disk unavailable");
    const restoreError = new Error("Restore unavailable");
    mocks.saveMealEdit.mockResolvedValueOnce({ date: DATE })
      .mockRejectedValueOnce(applyError)
      .mockRejectedValueOnce(restoreError);
    const action = {
      actionId: "a-series-double-fails", kind: "set_slot_meal" as const, from: DATE,
      dates: [DATE, "2026-09-17"], slot: "meal-1" as const,
      title: "Chicken and rice", items: [grounded()], flagged: [],
    } as CoachAction;

    let caught: unknown;
    try { await applySetSlotMeal(action as Extract<CoachAction, { kind: "set_slot_meal" }>); }
    catch (error) { caught = error; }

    expect(caught).toBe(applyError);
    expect(caught).toMatchObject({
      message: expect.stringContaining(DATE),
      cause: restoreError,
    });
  });

  it("settles a stalled apply as failed at the action timeout", async () => {
    vi.useFakeTimers();
    mocks.saveMealEdit.mockReturnValueOnce(new Promise(() => {}));
    const pending = applyCoachAction({
      actionId: "a-timeout", kind: "move_slot", date: DATE, slot: "meal-1",
      time: "19:30", flagged: [],
    }, { tz: "UTC", fastPath: true });
    await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ status: "failed", reason: ACTION_TIMEOUT_REASON });
    expect(buffered()).toEqual([expect.objectContaining({
      path: "coach-action", step: "action-failed",
    })]);
  });
});

describe("undoCoachAction", () => {
  it("undoes a materialized meal series with one composite token", async () => {
    const previous = { baseMealId: "breakfast", components: [rice], title: "Rice bowl" };
    mocks.loadStore.mockReturnValue({ days: {
      [DATE]: { date: DATE, itemOverrides: { "meal-1": previous } },
      "2026-09-17": { date: "2026-09-17" },
    } } as unknown as Store);
    const applied = await applyCoachAction({
      actionId: "a-series-undo", kind: "set_slot_meal", from: DATE,
      dates: [DATE, "2026-09-17"], slot: "meal-1", title: "Chicken and rice",
      items: [grounded()], flagged: [],
    } as CoachAction, { tz: "UTC" });
    if (applied.status !== "applied") throw new Error("expected applied series");
    // The store now holds what the series wrote; Undo only restores a slot still in that state.
    const written = (applied.token as { dates: { date: string; applied?: FoodComponent[] }[] }).dates;
    mocks.loadStore.mockReturnValue({ days: Object.fromEntries(written.map((row) => [row.date, {
      date: row.date, itemOverrides: { "meal-1": { baseMealId: "breakfast",
        components: row.applied, title: "Chicken and rice" } } }])) } as unknown as Store);
    mocks.saveMealEdit.mockClear();
    await undoCoachAction("a-series-undo", applied.token);
    expect(mocks.saveMealEdit).toHaveBeenNthCalledWith(1, "2026-09-17", "meal-1", "breakfast",
      { planned: [chicken, rice], components: null, title: null });
    expect(mocks.saveMealEdit).toHaveBeenNthCalledWith(2, DATE, "meal-1", "breakfast",
      { planned: [chicken, rice], components: [rice], title: "Rice bowl" });
  });

  it("removes the logged extra and queues a normalized log-entry tombstone", async () => {
    localStorage.setItem(`smc:u:${h.userId}:coach-action:a-undo`, JSON.stringify({ status: "applied" }));
    await undoCoachAction("a-undo", {
      kind: "log_meal", date: DATE, entryId: ENTRY_ID, baseRev: 1,
    }, { fastPath: true });
    expect(mocks.removeExtra).toHaveBeenCalledWith(DATE, ENTRY_ID);
    expect(mocks.enqueue).toHaveBeenCalledWith(h, expect.objectContaining({
      entity: "log_entries", entity_id: ENTRY_ID, kind: "delete", base_rev: 1, payload: {},
    }));
    expect(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-undo`)).toBeNull();
    expect(buffered()).toEqual([expect.objectContaining({
      path: "coach-action", step: "action-undone",
    })]);
  });

  it.each(["add_slot_item", "remove_slot_item", "set_slot_item"] as const)(
    "restores the previous override after %s", async (kind) => {
      await undoCoachAction(`a-${kind}`, { kind, date: DATE, slot: "meal-1", baseMealId: "breakfast",
        planned: [chicken, rice], previous: { baseMealId: "breakfast", components: [rice] } });
      expect(mocks.saveMealEdit).toHaveBeenCalledWith(DATE, "meal-1", "breakfast",
        { planned: [chicken, rice], components: [rice] });
    });

  it("returns a first-time component edit to the plan", async () => {
    await undoCoachAction("a-first-edit", { kind: "add_slot_item", date: DATE, slot: "meal-1",
      baseMealId: "breakfast", planned: [chicken, rice], previous: null });
    expect(mocks.saveMealEdit).toHaveBeenCalledWith(DATE, "meal-1", "breakfast",
      { planned: [chicken, rice], components: null });
  });

  it("restores a prior move time or removes a first-time time override", async () => {
    await undoCoachAction("a-move-one", { kind: "move_slot", date: DATE, slot: "meal-1",
      baseMealId: "breakfast", planned: [chicken, rice], previous: {
        baseMealId: "breakfast", components: [chicken, rice], followPlan: true, time: "08:00",
      } });
    await undoCoachAction("a-move-two", { kind: "move_slot", date: DATE, slot: "meal-1",
      baseMealId: "breakfast", planned: [chicken, rice], previous: null });
    expect(mocks.saveMealEdit).toHaveBeenNthCalledWith(1, DATE, "meal-1", "breakfast",
      { planned: [chicken, rice], time: "08:00" });
    expect(mocks.saveMealEdit).toHaveBeenNthCalledWith(2, DATE, "meal-1", "breakfast",
      { planned: [chicken, rice], time: null });
  });

  it("rejects a stalled undo at the action timeout with a plain reason", async () => {
    vi.useFakeTimers();
    mocks.saveMealEdit.mockReturnValueOnce(new Promise(() => {}));
    const pending = undoCoachAction("a-timeout-undo", {
      kind: "move_slot", date: DATE, slot: "meal-1",
      baseMealId: "breakfast", planned: [chicken, rice], previous: null });
    const rejected = expect(pending).rejects.toThrow(UNDO_TIMEOUT_REASON);
    await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
    await rejected;
  });

  it("guards a timed-out undo until its underlying write settles", async () => {
    vi.useFakeTimers();
    const save = deferred<unknown>();
    mocks.saveMealEdit.mockReturnValueOnce(save.promise);
    localStorage.setItem(`smc:u:${h.userId}:coach-action:a-late-undo`, JSON.stringify({ status: "applied" }));
    const token = { kind: "move_slot" as const, date: DATE, slot: "meal-1" as const,
      baseMealId: "breakfast", planned: [chicken, rice], previous: null };
    const settled = vi.fn();
    const pending = undoCoachAction("a-late-undo", token, { onSettled: settled });
    const rejected = expect(pending).rejects.toThrow(UNDO_TIMEOUT_REASON);
    await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
    await rejected;
    await expect(undoCoachAction("a-late-undo", token)).rejects.toThrow(UNDO_PENDING_REASON);
    expect(mocks.saveMealEdit).toHaveBeenCalledOnce();

    save.resolve({ date: DATE });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith({ status: "undone" }));
    expect(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-late-undo`)).toBeNull();
    expect(mocks.saveMealEdit).toHaveBeenCalledOnce();
  });
  it("says a coach log's nutrition_unchecked once, and never remembers it", async () => {
    mocks.commitLogEntry.mockResolvedValueOnce({ status: "ok", entry_id: ENTRY_ID, rev: 1,
      items: [], totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 },
      nutrition_unchecked: true });
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    const result = await applyCoachAction({
      actionId: "a-unchecked", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded()], flagged: [],
    }, { tz: "UTC" });
    expect(result).toMatchObject({ status: "applied", nutritionUnchecked: true });
    const stored = JSON.parse(localStorage.getItem(`smc:u:${h.userId}:coach-action:a-unchecked`) ?? "{}");
    expect(stored.status).toBe("applied");
    expect(stored).not.toHaveProperty("nutritionUnchecked");
  });

  it("leaves nutritionUnchecked off a coach log the server checked", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(ENTRY_ID).mockReturnValueOnce(ITEM_ID);
    const result = await applyCoachAction({
      actionId: "a-checked", kind: "log_meal", date: DATE, slot: "meal-1",
      items: [grounded()], flagged: [],
    }, { tz: "UTC" });
    expect(result.status).toBe("applied");
    expect(result).not.toHaveProperty("nutritionUnchecked");
  });

  it("reports nutrition_unchecked from the commit that puts a deleted entry back", async () => {
    const token = { kind: "delete_entry" as const, date: DATE,
      entry: { id: ENTRY_ID, foodId: "meal", name: "Chicken", portionLabel: "1 item", qty: 1, grams: 150,
        macros: { kcal: 248, protein: 46, carbs: 0, fat: 5 }, at: "2026-09-16T15:00:00.000Z", tz: "UTC" },
      slot: "meal-1" as const, eatenAt: "2026-09-16T15:00:00.000Z",
      items: [{ foodRefId: FOOD_REF, grams: 150, name: "Chicken", revisionId: 77 }] };
    mocks.commitLogEntry.mockResolvedValueOnce({ status: "ok", entry_id: "x", rev: 1, items: [],
      totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 }, nutrition_unchecked: true });
    expect(await undoCoachAction("a-del-unchecked", token)).toEqual({ nutritionUnchecked: true });
    expect(mocks.addExtra).toHaveBeenCalledWith(DATE, expect.objectContaining({ name: "Chicken" }));
    expect(await undoCoachAction("a-del-checked", token)).toBeUndefined();
  });
});
