/**
 * skip_slot / restore_slot write through Today's own Clear path (saveItemOverride + clearMeal),
 * and Undo puts the previous override back only while the slot still holds what was written.
 * The plan-day client is an in-memory fake over the real store shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlotId, SlotOverride, Store } from "@/lib/types";

const fake = vi.hoisted(() => ({ store: null as unknown as import("@/lib/types").Store,
  writes: [] as { date: string; slot: string; override: unknown }[] }));

vi.mock("@/lib/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/store")>()),
  loadStore: () => fake.store,
}));
vi.mock("@/lib/plan-day-client", () => ({
  saveItemOverride: vi.fn(async (date: string, slot: SlotId, override: SlotOverride | null) => {
    fake.writes.push({ date, slot, override });
    const day = fake.store.days[date] ?? { date };
    const itemOverrides = { ...(day.itemOverrides ?? {}) };
    if (override === null) delete itemOverrides[slot];
    else itemOverrides[slot] = { ...override, mutationId: `m${fake.writes.length}` };
    fake.store = { ...fake.store, days: { ...fake.store.days, [date]: { ...day, itemOverrides } } };
    return fake.store.days[date];
  }),
}));

import { defaultStore } from "@/lib/store";
import { plannedSlotIds, scaledSlotTarget } from "@/lib/resolve";
import { applyRestoreSlot, applySkipSlot, slotState, undoSkipSlot } from "@/lib/coach/apply-skip";
import { applyBindingFor } from "@/lib/coach/actions/apply";
import { coachActionSchema, groundedCoachActionSchema } from "@/lib/coach/actions";

const DATE = "2026-10-03";
const DAY = { kcal: 2000, protein: 150, carbs: 200, fat: 66 };

function account(): Store {
  const store = defaultStore();
  store.settings = { ...store.settings, trainingWeekdays: [], ruleReviewReady: true,
    activeTargetProfile: { revision: 1, training: DAY, rest: DAY,
      pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
  return store;
}

const action = <K extends "skip_slot" | "restore_slot">(kind: K, slot: string) =>
  ({ kind, date: DATE, slot, actionId: "a1", flagged: [] }) as never;

beforeEach(() => { fake.store = account(); fake.writes = []; });

describe("skip_slot", () => {
  it("parses on the strict and replay boundaries, and is bound on the client", () => {
    expect(coachActionSchema.safeParse({ kind: "skip_slot", date: DATE, slot: "meal-5" }).success).toBe(true);
    expect(coachActionSchema.safeParse({ kind: "skip_slot", date: DATE, slot: "coffee" }).success).toBe(false);
    expect(groundedCoachActionSchema.safeParse(
      { kind: "restore_slot", date: DATE, slot: "meal-2", actionId: "a1", flagged: [] }).success).toBe(true);
    expect(applyBindingFor("skip_slot")).toBeDefined();
    expect(applyBindingFor("restore_slot")).toBeDefined();
  });

  it("writes Today's Clear for that date and gives the share to the open meals", async () => {
    const slots = plannedSlotIds(fake.store, DATE, "rest");
    const last = slots.at(-1)!;
    const result = await applySkipSlot(action("skip_slot", last));
    expect(result.status).toBe("applied");
    expect(fake.writes).toEqual([{ date: DATE, slot: last,
      override: { baseMealId: null, components: [], cleared: true } }]);
    expect(scaledSlotTarget(fake.store, DATE, "rest", slots[0])?.kcal)
      .toBeCloseTo(DAY.kcal / (slots.length - 1), 5);
  });

  it("refuses an eaten meal without writing", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[0];
    fake.store.days[DATE] = { date: DATE, eaten: { [slot]: `${DATE}T08:00:00Z` } };
    const result = await applySkipSlot(action("skip_slot", slot));
    expect(result).toMatchObject({ status: "failed" });
    expect(fake.writes).toHaveLength(0);
  });

  it("undoes to the exact previous override, and leaves a later edit alone", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[1];
    const time: SlotOverride = { baseMealId: "m1", components: [], followPlan: true, time: "13:15" };
    fake.store.days[DATE] = { date: DATE, itemOverrides: { [slot]: time } };
    const result = await applySkipSlot(action("skip_slot", slot));
    if (result.status !== "applied") throw new Error("not applied");
    expect(fake.store.days[DATE].itemOverrides?.[slot]).toMatchObject({ cleared: true, time: "13:15" });
    await undoSkipSlot(result.token as never);
    expect(fake.store.days[DATE].itemOverrides?.[slot]).toMatchObject(time);
    expect(fake.store.days[DATE].itemOverrides?.[slot]?.cleared).toBeUndefined();

    const again = await applySkipSlot(action("skip_slot", slot));
    if (again.status !== "applied") throw new Error("not applied");
    fake.store.days[DATE].itemOverrides![slot] = { baseMealId: null, components: [], title: "Later" };
    await expect(undoSkipSlot(again.token as never)).rejects.toThrow("has changed since");
  });
});

describe("skip_slot Undo reads a stable slot state (2026-10-03 audit)", () => {
  it("still undoes after a sync re-write changed only the key order", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[1];
    const time: SlotOverride = { baseMealId: "m1", components: [], followPlan: true, time: "13:15" };
    fake.store.days[DATE] = { date: DATE, itemOverrides: { [slot]: time } };
    const result = await applySkipSlot(action("skip_slot", slot));
    if (result.status !== "applied") throw new Error("not applied");
    const written = fake.store.days[DATE].itemOverrides![slot];
    const reordered = Object.fromEntries(Object.entries({ ...written }).reverse());
    fake.store.days[DATE].itemOverrides![slot] = reordered as SlotOverride;
    await undoSkipSlot(result.token as never);
    expect(fake.store.days[DATE].itemOverrides?.[slot]).toMatchObject(time);
  });

  it("skip → restore → skip: the first skip's Undo leaves the second skip alone (review t4r10 #5)", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[1];
    const first = await applySkipSlot(action("skip_slot", slot));
    if (first.status !== "applied") throw new Error("not applied");
    expect((await applyRestoreSlot(action("restore_slot", slot))).status).toBe("applied");
    expect((await applySkipSlot(action("skip_slot", slot))).status).toBe("applied");
    const second = fake.store.days[DATE].itemOverrides![slot];
    await expect(undoSkipSlot(first.token as never)).rejects.toThrow("has changed since");
    expect(fake.store.days[DATE].itemOverrides![slot]).toEqual(second);
  });

  it("keeps the previous override it read, even if the stored one is mutated afterwards", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[1];
    const time: SlotOverride = { baseMealId: "m1", components: [], followPlan: true, time: "13:15" };
    fake.store.days[DATE] = { date: DATE, itemOverrides: { [slot]: time } };
    const result = await applySkipSlot(action("skip_slot", slot));
    if (result.status !== "applied") throw new Error("not applied");
    time.cleared = true;
    time.time = "20:00";
    expect((result.token as { previous: SlotOverride }).previous).toEqual(
      { baseMealId: "m1", components: [], followPlan: true, time: "13:15" });
  });

  it("reads a later real edit as a change", () => {
    const base: SlotOverride = { baseMealId: "m1", components: [], cleared: true };
    expect(slotState(base)).toBe(slotState({ cleared: true, components: [], baseMealId: "m1" }));
    // A later identical write is a different write.
    expect(slotState({ ...base, mutationId: "a" })).not.toBe(slotState({ ...base, mutationId: "b" }));
    expect(slotState(base)).not.toBe(slotState({ ...base, title: "Later" }));
    expect(slotState(null)).not.toBe(slotState(base));
  });
});

describe("restore_slot", () => {
  it("brings a skipped meal back to the plan, and its Undo skips it again", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[2];
    const skipped = await applySkipSlot(action("skip_slot", slot));
    expect(skipped.status).toBe("applied");
    const restored = await applyRestoreSlot(action("restore_slot", slot));
    if (restored.status !== "applied") throw new Error("not applied");
    // A followPlan shell with no food (resolves like no override), marked by its own write.
    expect(fake.store.days[DATE].itemOverrides?.[slot]).toMatchObject({ followPlan: true, components: [] });
    expect(typeof fake.store.days[DATE].itemOverrides?.[slot]?.mutationId).toBe("string");
    await undoSkipSlot(restored.token as never);
    expect(fake.store.days[DATE].itemOverrides?.[slot]).toMatchObject({ cleared: true });
  });

  it("skip → restore → skip → restore: the first restore's Undo leaves the later edits alone (review t4r11 #1)", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[2];
    expect((await applySkipSlot(action("skip_slot", slot))).status).toBe("applied");
    const firstRestore = await applyRestoreSlot(action("restore_slot", slot));
    if (firstRestore.status !== "applied") throw new Error("not applied");
    expect((await applySkipSlot(action("skip_slot", slot))).status).toBe("applied");
    expect((await applyRestoreSlot(action("restore_slot", slot))).status).toBe("applied");
    const latest = fake.store.days[DATE].itemOverrides?.[slot];
    await expect(undoSkipSlot(firstRestore.token as never)).rejects.toThrow("has changed since");
    expect(fake.store.days[DATE].itemOverrides?.[slot]).toEqual(latest);
  });

  it("fails for a meal that is not skipped", async () => {
    const slot = plannedSlotIds(fake.store, DATE, "rest")[0];
    expect(await applyRestoreSlot(action("restore_slot", slot))).toMatchObject({ status: "failed" });
  });
});
