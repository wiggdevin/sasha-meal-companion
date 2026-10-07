/**
 * Phase A persistence. lib/plan-day-client.ts's own header states the hazard: the SQL plan_days
 * branch REPLACES the whole row from the payload, so every op has to carry every plan-level field
 * or it silently erases the ones it left out.
 *
 * `item_overrides` is now the fifth such field. These tests are here because the dangerous failure
 * is not "saving an edit does nothing" — it is "toggling Floor Day, or picking a swap, quietly
 * deletes the edits made to that day".
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as outbox from "@/lib/sync/outbox";
import { allOps, getRow } from "@/lib/sync/idb";
import { __resetStoreCache, getDay } from "@/lib/store";
import { saveItemOverride, saveMealEdit, saveSwap, toggleFloorDay } from "@/lib/plan-day-client";
import type { FoodComponent } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const DATE = "2026-09-14";
const wholeMilk: FoodComponent = {
  name: "Whole milk", qty: 1, unit: "cup", role: "free",
  macros: { kcal: 168, protein: 8, carbs: 12, fat: 9 },
};

const lastPayload = async () => {
  const ops = await allOps(h);
  return ops[ops.length - 1]?.payload as Record<string, unknown> | undefined;
};

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  globalThis.localStorage?.clear?.();
  // The legacy store is module-cached, and without localStorage in node it would otherwise carry
  // one test's overrides into the next.
  __resetStoreCache();
});

describe("saveItemOverride", () => {
  it("queues the slot's whole component list for sync", async () => {
    await saveItemOverride(DATE, "coffee", { baseMealId: "coffee-latte", components: [wholeMilk] });
    const payload = await lastPayload();
    expect(payload?.item_overrides).toMatchObject({
      coffee: { baseMealId: "coffee-latte", components: [wholeMilk], mutationId: expect.any(String) },
    });
  });

  it("keeps an edit to one slot from disturbing another", async () => {
    await saveItemOverride(DATE, "coffee", { baseMealId: "coffee-latte", components: [wholeMilk] });
    await saveItemOverride(DATE, "meal-1", { baseMealId: "m1", components: [] });
    const payload = await lastPayload();
    const overrides = payload?.item_overrides as Record<string, unknown>;
    expect(Object.keys(overrides).sort()).toEqual(["coffee", "meal-1"]);
  });

  it("clears one slot's edit without touching the others", async () => {
    await saveItemOverride(DATE, "coffee", { baseMealId: "coffee-latte", components: [wholeMilk] });
    await saveItemOverride(DATE, "meal-1", { baseMealId: "m1", components: [] });
    await saveItemOverride(DATE, "coffee", null);
    const overrides = (await lastPayload())?.item_overrides as Record<string, unknown>;
    expect(Object.keys(overrides)).toEqual(["meal-1"]);
  });
});

describe("the other plan-day writes", () => {
  it("toggling Floor Day does not delete the edits made that day", async () => {
    await saveItemOverride(DATE, "coffee", { baseMealId: "coffee-latte", components: [wholeMilk] });
    await toggleFloorDay(DATE);
    const payload = await lastPayload();
    expect(payload?.item_overrides).toMatchObject({
      coffee: { baseMealId: "coffee-latte", components: [wholeMilk], mutationId: expect.any(String) },
    });
  });

  it("picking a swap does not delete them either", async () => {
    await saveItemOverride(DATE, "coffee", { baseMealId: "coffee-latte", components: [wholeMilk] });
    await saveSwap(DATE, "meal-1", "some-meal-id");
    const payload = await lastPayload();
    expect(payload?.item_overrides).toMatchObject({
      coffee: { baseMealId: "coffee-latte", components: [wholeMilk], mutationId: expect.any(String) },
      "meal-1": { baseMealId: null, components: [], followPlan: true,
        mutationId: expect.any(String) },
    });
  });
});


describe("saveMealEdit", () => {
  it("makes a cleared card visible again when food is authored, but keeps a time-only clear", async () => {
    await saveItemOverride(DATE, "meal-1", { baseMealId: null, components: [], cleared: true });
    await saveMealEdit(DATE, "meal-1", null, { planned: [], time: "13:15" });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]?.cleared).toBe(true);
    await saveMealEdit(DATE, "meal-1", null, { planned: [], components: [wholeMilk] });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]).toMatchObject({ components: [wholeMilk] });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]).not.toHaveProperty("cleared");
    expect((await lastPayload())?.item_overrides).toMatchObject({
      "meal-1": { components: [wholeMilk], time: "13:15" },
    });
  });

  it("persists the dish title with the date-specific override", async () => {
    await saveMealEdit(DATE, "meal-1", "breakfast", {
      planned: [], components: [wholeMilk], title: "Eggs on toast",
    });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]).toMatchObject({
      title: "Eggs on toast", components: [wholeMilk],
    });
    expect((await lastPayload())?.item_overrides).toMatchObject({
      "meal-1": { title: "Eggs on toast", components: [wholeMilk] },
    });
  });

  it("drops a swapped title when returning its contents to the suggested plan", async () => {
    await saveMealEdit(DATE, "meal-1", "suggested:meal-1", {
      planned: [wholeMilk], components: [wholeMilk], title: "Previous swap",
    });
    await saveMealEdit(DATE, "meal-1", "suggested:meal-1", {
      planned: [wholeMilk], components: null,
    });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]).toMatchObject({
      baseMealId: "suggested:meal-1", components: [wholeMilk], followPlan: true,
      mutationId: expect.any(String),
    });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]).not.toHaveProperty("title");
    expect((await lastPayload())?.item_overrides).toMatchObject({
      "meal-1": { followPlan: true, mutationId: expect.any(String) },
    });
  });

  it("clears blank titles and trims storage titles to the 80-character schema limit", async () => {
    await saveMealEdit(DATE, "meal-1", "breakfast", {
      planned: [], components: [wholeMilk], title: "Existing title",
    });
    await saveMealEdit(DATE, "meal-1", "breakfast", {
      planned: [], title: " \n\t ",
    });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]).not.toHaveProperty("title");

    await saveMealEdit(DATE, "meal-1", "breakfast", {
      planned: [], title: `  ${"x".repeat(90)}  `,
    });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]?.title).toBe("x".repeat(80));
    expect((await lastPayload())?.item_overrides).toMatchObject({
      "meal-1": { title: "x".repeat(80) },
    });
  });

  it("changes one materialized date without changing the next date", async () => {
    const next = "2026-09-15";
    await saveMealEdit(DATE, "meal-1", "breakfast", {
      planned: [], components: [wholeMilk], title: "First title",
    });
    await saveMealEdit(next, "meal-1", "breakfast", {
      planned: [], components: [wholeMilk], title: "Series title",
    });
    await saveMealEdit(DATE, "meal-1", "breakfast", {
      planned: [], components: [], title: "Later edit",
    });
    expect(getDay(DATE)?.itemOverrides?.["meal-1"]?.title).toBe("Later edit");
    expect(getDay(next)?.itemOverrides?.["meal-1"]?.title).toBe("Series title");
  });

  it("persists portions, trimmed note and time in exactly one durable operation", async () => {
    await saveMealEdit(DATE, "coffee", "coffee-latte", {
      planned: [], components: [wholeMilk], note: "  Felt comfortable  ", time: "13:15",
    });
    const ops = await allOps(h);
    expect(ops).toHaveLength(1);
    expect(ops[0].entity).toBe("plan_days");
    expect(ops[0].entity_id).toBe(DATE);
    expect(ops[0].payload).toMatchObject({
      local_date: DATE, slot_notes: { coffee: "Felt comfortable" },
      item_overrides: { coffee: { baseMealId: "coffee-latte", components: [wholeMilk], time: "13:15" } },
    });
    expect(await getRow(h, "plan_days", DATE)).toMatchObject(ops[0].payload);
    expect(getDay(DATE)?.notes?.coffee).toBe("Felt comfortable");
    expect(getDay(DATE)?.itemOverrides?.coffee).toMatchObject({ components: [wholeMilk], time: "13:15" });
  });

  it("preserves other slots and dates when changing only the time", async () => {
    await saveMealEdit(DATE, "meal-1", "lunch", { planned: [], components: [], note: "Lunch note", time: "14:00" });
    await saveMealEdit("2026-09-15", "coffee", "coffee-latte", { planned: [], note: "Tomorrow", time: "09:00" });
    const otherDate = structuredClone(getDay("2026-09-15"));
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [wholeMilk], time: "08:15" });
    const day = getDay(DATE)!;
    expect(day.itemOverrides?.coffee).toEqual({ baseMealId: "coffee-latte", components: [wholeMilk], followPlan: true, time: "08:15" });
    expect(day.itemOverrides?.["meal-1"]).toMatchObject({ baseMealId: "lunch", components: [],
      time: "14:00", mutationId: expect.any(String) });
    expect(day.notes).toEqual({ "meal-1": "Lunch note" });
    expect(getDay("2026-09-15")).toEqual(otherDate);
    expect((await lastPayload())?.slot_notes).toEqual(day.notes);
  });

  it("preserves custom portions when moving an already edited meal", async () => {
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], components: [wholeMilk], note: "Earlier note" });
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], time: "09:45" });
    expect(getDay(DATE)?.itemOverrides?.coffee).toMatchObject({ baseMealId: "coffee-latte",
      components: [wholeMilk], time: "09:45", mutationId: expect.any(String) });
    expect(getDay(DATE)?.notes?.coffee).toBe("Earlier note");
  });

  it("returns portions to the plan while keeping its rescheduled time", async () => {
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], components: [wholeMilk], time: "09:45" });
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], components: null, note: "  " });
    expect(getDay(DATE)?.itemOverrides?.coffee).toMatchObject({ baseMealId: "coffee-latte",
      components: [], followPlan: true, time: "09:45", mutationId: expect.any(String) });
    expect(getDay(DATE)?.notes?.coffee).toBeUndefined();
  });

  it("removes a date-specific time without disturbing custom portions", async () => {
    await saveMealEdit(DATE, "coffee", "coffee-latte", {
      planned: [], components: [wholeMilk], time: "09:45",
    });
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], time: null });
    expect(getDay(DATE)?.itemOverrides?.coffee).toMatchObject({
      baseMealId: "coffee-latte", components: [wholeMilk], mutationId: expect.any(String),
    });
  });

  it.each(["24:00", "12:60", "9:15", "", "-1:00"])("rejects invalid time %s before mutating or queueing", async (time) => {
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], note: "Keep me", time: "08:00" });
    const before = structuredClone(getDay(DATE));
    const opsBefore = await allOps(h);
    await expect(saveMealEdit(DATE, "coffee", "coffee-latte", {
      planned: [], components: [wholeMilk], note: "Must not land", time,
    })).rejects.toThrow("valid meal time");
    expect(getDay(DATE)).toEqual(before);
    expect(await allOps(h)).toEqual(opsBefore);
  });
});


it("does not partially save portions or note when durable enqueue fails", async () => {
  await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], note: "Existing", time: "08:00" });
  const before = structuredClone(getDay(DATE));
  const opsBefore = await allOps(h);
  const enqueue = vi.spyOn(outbox, "enqueueWithRow").mockRejectedValueOnce(new Error("Disk unavailable"));
  try {
    await expect(saveMealEdit(DATE, "coffee", "coffee-latte", {
      planned: [], components: [wholeMilk], note: "Replacement", time: "10:15",
    })).rejects.toThrow("Disk unavailable");
    expect(getDay(DATE)).toEqual(before);
    expect(await allOps(h)).toEqual(opsBefore);
  } finally {
    enqueue.mockRestore();
  }
});

it("serializes concurrent different-slot edits into complete rows with sequential revisions", async () => {
  await Promise.all([
    saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], time: "08:15", note: "Coffee" }),
    saveMealEdit(DATE, "meal-1", "lunch", { planned: [], time: "13:00", note: "Lunch" }),
  ]);
  const day = getDay(DATE)!;
  expect(Object.keys(day.itemOverrides ?? {}).sort()).toEqual(["coffee", "meal-1"]);
  expect(day.notes).toEqual({ coffee: "Coffee", "meal-1": "Lunch" });
  const ops = await allOps(h);
  expect(ops.map((op) => [op.kind, op.base_rev])).toEqual([["create", null], ["update", 1]]);
  expect(ops[1].payload.item_overrides).toEqual(day.itemOverrides);
  expect(await getRow(h, "plan_days", DATE)).toMatchObject({ rev: 2, item_overrides: day.itemOverrides });
});

it("a failed writer releases the queued next save without carrying its failed patch", async () => {
  const spy = vi.spyOn(outbox, "enqueueWithRow").mockRejectedValueOnce(new Error("Disk unavailable"));
  try {
    const results = await Promise.allSettled([
      saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], time: "08:15" }),
      saveMealEdit(DATE, "meal-1", "lunch", { planned: [], time: "13:00" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(Object.keys(getDay(DATE)?.itemOverrides ?? {})).toEqual(["meal-1"]);
    expect((await allOps(h)).map((op) => [op.kind, op.base_rev])).toEqual([["create", null]]);
  } finally { spy.mockRestore(); }
});

it("serializes fresh reads in toggles and slot-map helpers too", async () => {
  await Promise.all([toggleFloorDay(DATE), toggleFloorDay(DATE),
    saveSwap(DATE, "meal-1", "lunch"), saveSwap(DATE, "meal-2", "dinner")]);
  expect(getDay(DATE)).toMatchObject({ floorDay: false,
    swaps: { "meal-1": "lunch", "meal-2": "dinner" } });
});

it("does not advance the legacy log timestamp for a plan-only edit", async () => {
  const { updateDay } = await import("@/lib/store");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-14T10:00:00Z"));
    updateDay(DATE, { gut: "good" });
    vi.setSystemTime(new Date("2026-09-14T10:10:00Z"));
    await saveMealEdit(DATE, "coffee", "coffee-latte", { planned: [], time: "08:15" });
    expect(getDay(DATE)?.updatedAt).toBe("2026-09-14T10:00:00.000Z");
  } finally { vi.useRealTimers(); }
});
