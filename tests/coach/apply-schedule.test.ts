import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachAction } from "@/lib/coach/actions";
import type { ResolvedDay, ResolvedSlot, Store } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  loadStore: vi.fn(),
  resolveDay: vi.fn(),
  savePlanDay: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ loadStore: mocks.loadStore }));
vi.mock("@/lib/resolve", () => ({ resolveDay: mocks.resolveDay }));
vi.mock("@/lib/plan-day-client", () => ({ savePlanDay: mocks.savePlanDay }));

import { applyCoachAction, undoCoachAction } from "@/lib/coach/apply-client";
import { applyShiftSchedule, undoShiftSchedule } from "@/lib/coach/apply-schedule";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

// These tests drive the phone's own token path with no server: the phone is offline, so no
// coach Undo record is sent and the token decides (lib/coach/undo-client.ts).
vi.stubGlobal("navigator", { onLine: false });

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const DATE = "2026-09-21";
const times = ["08:00", "10:30", "13:00", "16:30", "19:30"];
const slots = ["meal-1", "meal-2", "meal-3", "meal-4", "meal-5"] as const;

function resolvedSlots(): ResolvedSlot[] {
  return slots.map((slot, index) => ({
    slot, time: times[index], label: slot, eaten: index < 2,
    eatenAt: index < 2 ? `${DATE}T${times[index]}:00.000Z` : undefined,
    meal: { id: `meal-${index}`, name: slot, slot, components: [],
      macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 }, prepMinutes: 0, tags: [] },
    components: [], macros: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  }));
}

function store(overrides: Partial<Store["days"][string]["itemOverrides"]> = {}): Store {
  return {
    firstOpenedAt: "2026-09-01T00:00:00.000Z",
    settings: {
      slotTimes: Object.fromEntries(slots.map((slot, index) => [slot, times[index]])),
      mealsPerDay: 5,
      shiftMinutes: 0, trainingKcal: null, restKcal: null, proteinG: null,
      proteinLocked: true, changedAt: null,
      // Explicit now that there is no weekday default: an empty list is rest-only
      // (design §6.3), and this fixture needs the five training-day slots.
      trainingWeekdays: [1, 3, 4, 5],
    },
    days: { [DATE]: {
      date: DATE, eaten: { "meal-1": `${DATE}T08:00:00.000Z`,
        "meal-2": `${DATE}T10:30:00.000Z` }, itemOverrides: overrides,
    } },
    foods: {}, version: 1,
  };
}

function day(): ResolvedDay {
  return {
    date: DATE, dayType: "training-10", isFloorDay: false,
    targets: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    waterCups: 0, extras: [], slots: resolvedSlots(),
  };
}

function action(scope: "all" | "remaining", minutes: number, actionId = "shift-1"):
  Extract<CoachAction, { kind: "shift_schedule" }> {
  return { kind: "shift_schedule", actionId, flagged: [], date: DATE, minutes, scope };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", {
    values: new Map<string, string>(),
    getItem(this: { values: Map<string, string> }, key: string) { return this.values.get(key) ?? null; },
    setItem(this: { values: Map<string, string> }, key: string, value: string) { this.values.set(key, value); },
    removeItem(this: { values: Map<string, string> }, key: string) { this.values.delete(key); },
  });
  mocks.loadStore.mockReturnValue(store());
  mocks.resolveDay.mockReturnValue(day());
  mocks.savePlanDay.mockResolvedValue({ date: DATE });
});

describe("shift_schedule apply and undo", () => {
  it("moves only the three uneaten slots for remaining +30", async () => {
    const result = await applyShiftSchedule(action("remaining", 30));
    expect(mocks.savePlanDay).toHaveBeenCalledTimes(1);
    expect(mocks.savePlanDay.mock.calls[0][1].itemOverrides).toMatchObject({
      "meal-3": { time: "13:30" }, "meal-4": { time: "17:00" },
      "meal-5": { time: "20:00" },
    });
    expect(mocks.savePlanDay.mock.calls[0][1].itemOverrides["meal-1"]).toBeUndefined();
    expect(mocks.savePlanDay.mock.calls[0][1].itemOverrides["meal-2"]).toBeUndefined();
    expect(result).toMatchObject({ status: "applied", token: { kind: "shift_schedule" } });
  });

  it("moves all five slots for all -60", async () => {
    await applyShiftSchedule(action("all", -60));
    const overrides = mocks.savePlanDay.mock.calls[0][1].itemOverrides;
    expect(slots.map((slot) => [slot, overrides[slot].time])).toEqual([
      ["meal-1", "07:00"], ["meal-2", "09:30"], ["meal-3", "12:00"],
      ["meal-4", "15:30"], ["meal-5", "18:30"],
    ]);
  });

  it("clamps a shifted slot at 23:59", async () => {
    const nextStore = store();
    nextStore.settings.slotTimes["meal-5"] = "23:45";
    mocks.loadStore.mockReturnValue(nextStore);
    await applyShiftSchedule(action("all", 30));
    expect(mocks.savePlanDay.mock.calls[0][1].itemOverrides["meal-5"].time).toBe("23:59");
  });

  it("undo restores every prior per-date time", async () => {
    const nextStore = store({ "meal-4": {
      baseMealId: "meal-3", components: [], followPlan: true, time: "17:15",
    } });
    mocks.loadStore.mockReturnValue(nextStore);
    const result = await applyShiftSchedule(action("all", 30));
    if (result.status !== "applied" || result.token.kind !== "shift_schedule") {
      throw new Error("expected shift token");
    }
    mocks.savePlanDay.mockClear();
    await undoShiftSchedule(result.token);
    expect(mocks.savePlanDay).toHaveBeenCalledTimes(1);
    expect(mocks.savePlanDay.mock.calls[0][1].itemOverrides).toEqual({
      "meal-4": { baseMealId: "meal-3", components: [], followPlan: true, time: "17:15" },
    });
  });

  it("is idempotent when the dispatcher sees the same actionId again", async () => {
    const first = await applyCoachAction(action("remaining", 30, "same-id"), { tz: "UTC" });
    const second = await applyCoachAction(action("remaining", 30, "same-id"), { tz: "UTC" });
    expect(first).toEqual(second);
    expect(mocks.savePlanDay).toHaveBeenCalledTimes(1);
    if (first.status === "applied") await undoCoachAction("same-id", first.token);
  });
});
