import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getLastError, getRow, putRow } from "@/lib/sync/idb";
import { addCups, addCupsWithRev, getWater, readWaterSettings, setCups, setGoal, setWaterPrefs, undoAddedCups }
  from "@/lib/water-client";
import { lbToKg } from "@/lib/health/units";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/** Flipped per test; read by the mocked write below (finding 66: a failed write must surface,
 *  not vanish as a silent unhandled rejection). */
const flags = vi.hoisted(() => ({ failWrite: false }));

vi.mock("@/lib/sync/idb", async (orig) => {
  const actual = await orig<typeof import("@/lib/sync/idb")>();
  return { ...actual,
    putRow: vi.fn(async (...args: Parameters<typeof actual.putRow>) => {
      if (flags.failWrite) throw new Error("QuotaExceededError");
      return actual.putRow(...args);
    }) };
});

beforeEach(async () => {
  h = await resetTestAccount(); globalThis.indexedDB = new IDBFactory(); flags.failWrite = false;
});

describe("water client", () => {
  it("adds a cup locally and never lets a subtraction go below zero", async () => {
    expect(await addCups("2026-09-19", 1)).toBe(1);
    expect(await addCups("2026-09-19", -3)).toBe(0);
    const ops = await allOps(h);
    expect(ops[0]).toMatchObject({ entity: "water_log", entity_id: "2026-09-19", kind: "create" });
  });

  it("takes back an add only while the day holds what it left: never twice, never over a correction", async () => {
    expect(await addCups("2026-09-19", 4)).toBe(4);
    expect(await addCups("2026-09-19", 2)).toBe(6);
    expect(await undoAddedCups("2026-09-19", 2, 6)).toBe(true);
    expect(await getRow(h, "water_log", "2026-09-19")).toMatchObject({ cups: 4 });
    expect(await undoAddedCups("2026-09-19", 2, 6)).toBe(false); // a second Undo
    expect(await addCups("2026-09-19", 2)).toBe(6);
    await setCups("2026-09-19", 4); // her own correction back to 4
    expect(await undoAddedCups("2026-09-19", 2, 6)).toBe(false);
    expect(await getRow(h, "water_log", "2026-09-19")).toMatchObject({ cups: 4 });
  });

  it("binds the row revision too: 6 → 5 → 6 since the add is not the row the add left", async () => {
    expect(await addCups("2026-09-19", 4)).toBe(4);
    const added = await addCupsWithRev("2026-09-19", 2);
    expect(added.cups).toBe(6);
    await setCups("2026-09-19", 5);
    await setCups("2026-09-19", 6);
    expect(await undoAddedCups("2026-09-19", 2, 6, added.rev!)).toBe(false);
    expect(await getRow(h, "water_log", "2026-09-19")).toMatchObject({ cups: 6 });
    const again = await addCupsWithRev("2026-09-19", 2);
    expect(await undoAddedCups("2026-09-19", 2, again.cups, again.rev!)).toBe(true);
  });

  it("surfaces a failed write instead of letting it vanish silently", async () => {
    flags.failWrite = true;
    await expect(addCups("2026-09-19", 1)).rejects.toThrow();
    expect(await getLastError(h)).not.toBeNull();
  });

  it("sets an absolute count: two quick sets land on the last, never on their sum", async () => {
    await putRow(h, "water_log", "2026-09-19", { local_date: "2026-09-19", cups: 2, rev: 1 });
    // Both rendered from cups 2: as deltas these were +3 and +4 and stored 9 (audit b4b #4).
    const [first, second] = await Promise.all([setCups("2026-09-19", 5), setCups("2026-09-19", 6)]);
    expect([first, second]).toEqual([5, 6]);
    expect(await getRow(h, "water_log", "2026-09-19")).toMatchObject({ cups: 6, rev: 3 });
    expect((await allOps(h)).map((op) => op.base_rev)).toEqual([1, 2]);
    expect(await setCups("2026-09-19", 1)).toBe(1);
  });

  it("keeps the larger count when the local row is already ahead", async () => {
    await putRow(h, "water_log", "2026-09-19", { local_date: "2026-09-19", cups: 5, rev: 2 });
    expect(await addCups("2026-09-19", 1)).toBe(6);
    expect((await allOps(h))[0]).toMatchObject({ kind: "update", base_rev: 2 });
  });

  it("sends the whole settings row when she changes the goal", async () => {
    await putRow(h, "user_settings", "settings", { rev: 4, first_opened_at: "2026-09-01T00:00:00.000Z",
      training_kcal: 2400, rest_kcal: 2100, protein_g: 150, protein_locked: true,
      slot_times: { coffee: "06:30" }, shift_minutes: 0, water_goal_cups: 8,
      water_goal_cups_training: 8, water_goal_cups_rest: 7 });
    expect(await setGoal(10, "training-10")).toBe(10);
    const [op] = await allOps(h);
    expect(op).toMatchObject({ entity: "user_settings", entity_id: "settings", base_rev: 4 });
    expect(op.payload).toMatchObject({ training_kcal: 2400, protein_g: 150,
      water_goal_cups_training: 10, water_goal_cups_rest: 7 });
    const row = await getRow(h, "user_settings", "settings");
    expect(row).toMatchObject({ water_goal_cups_training: 10, water_goal_cups_rest: 7 });
  });

  it("edits the column that belongs to the viewed day's type", async () => {
    await putRow(h, "user_settings", "settings", { rev: 1, water_goal_cups: 8,
      water_goal_cups_training: 10, water_goal_cups_rest: 7 });
    expect(await setGoal(6, "rest")).toBe(6);
    const [op] = await allOps(h);
    expect(op.payload).toMatchObject({ water_goal_cups_training: 10, water_goal_cups_rest: 6 });
    expect(await getRow(h, "user_settings", "settings")).toMatchObject({
      water_goal_cups_training: 10, water_goal_cups_rest: 6 });
  });

  // T6 finding 4: a phone that upgrades from release A has only the legacy goal in IDB. Both
  // split goals must travel, or the untouched one lands on the server's default instead of hers.
  it("materializes both split goals from a legacy-only row before enqueueing", async () => {
    await putRow(h, "user_settings", "settings", { rev: 3, training_kcal: 2400,
      water_goal_cups: 10 });
    expect(await setGoal(6, "rest")).toBe(6);
    const [op] = await allOps(h);
    expect(op.kind).toBe("update");
    expect(op.payload).toMatchObject({ training_kcal: 2400, water_goal_cups: 10,
      water_goal_cups_training: 10, water_goal_cups_rest: 6 });
    expect(await getRow(h, "user_settings", "settings")).toMatchObject({ water_goal_cups: 10,
      water_goal_cups_training: 10, water_goal_cups_rest: 6 });
  });

  it("materializes both split goals on an empty IDB row, from 8", async () => {
    expect(await setGoal(6, "rest")).toBe(6);
    const [op] = await allOps(h);
    expect(op.kind).toBe("create");
    expect(op.payload).toMatchObject({ water_goal_cups: 8, water_goal_cups_training: 8,
      water_goal_cups_rest: 6 });
  });

  it("clamps a goal into the column's range", async () => {
    expect(await setGoal(99, "training-10")).toBe(30);
  });

  it("reads cups and the day's goal together: 8 cups with no weight, in ounces by default", async () => {
    expect(await getWater("2026-09-19", "training-10"))
      .toEqual({ cups: 0, goal: 8, unit: "oz", goalMode: "auto" });
    expect(await getWater("2026-09-19", "rest")).toEqual({ cups: 0, goal: 8, unit: "oz", goalMode: "auto" });
  });

  it("reads a hand-set rest goal on a rest day and the training goal on a training day", async () => {
    await putRow(h, "user_settings", "settings", { rev: 2, water_goal_cups: 8,
      water_goal_cups_training: 10, water_goal_cups_rest: 7 });
    expect(await getWater("2026-09-19", "training-10")).toMatchObject({ cups: 0, goal: 10, goalMode: "manual" });
    expect(await getWater("2026-09-19", "training-7-fasted")).toMatchObject({ goal: 10 });
    expect(await getWater("2026-09-19", "rest")).toMatchObject({ goal: 7 });
  });

  it("derives the goal from the weight when the account never set one: 215 lb is 128 oz", async () => {
    await putRow(h, "user_settings", "settings", { rev: 2, water_goal_cups: 8,
      water_goal_cups_training: 8, water_goal_cups_rest: 8, weight_kg: lbToKg(150) });
    // The caller's weight (the latest weigh-in) wins over the synced profile weight.
    expect(await getWater("2026-09-19", "rest", lbToKg(215))).toMatchObject({ goal: 16, goalMode: "auto" });
    // Without one, the profile weight answers: 150 lb is 88 oz, 11 cups.
    expect(await getWater("2026-09-19", "rest")).toMatchObject({ goal: 11 });
  });

  it("reads the unit and goal mode from diet_prefs.water", async () => {
    await putRow(h, "user_settings", "settings", { rev: 2, water_goal_cups_training: 10,
      water_goal_cups_rest: 10, weight_kg: lbToKg(215),
      diet_prefs: { flags: ["no_dairy"], water: { unit: "cups", goal: "auto" } } });
    expect(await getWater("2026-09-19", "rest")).toEqual({ cups: 0, goal: 16, unit: "cups", goalMode: "auto" });
  });

  it("changes the unit in one diet_prefs op that keeps the dietary flags", async () => {
    await putRow(h, "user_settings", "settings", { rev: 3, training_kcal: 2400,
      diet_prefs: { flags: ["no_dairy"], text: "Keep fibre gentle" } });
    expect(await setWaterPrefs({ unit: "ml" })).toEqual({ unit: "ml" });
    const [op] = await allOps(h);
    expect(op).toMatchObject({ entity: "user_settings", kind: "update", base_rev: 3 });
    expect(op.payload).toMatchObject({ training_kcal: 2400, diet_prefs: {
      flags: ["no_dairy"], text: "Keep fibre gentle", water: { unit: "ml" } } });
    expect((await readWaterSettings()).prefs).toEqual({ unit: "ml" });
  });

  it("puts the account in manual mode when a goal is set by hand", async () => {
    await putRow(h, "user_settings", "settings", { rev: 1, diet_prefs: { flags: [], water: { unit: "oz" } } });
    await setGoal(12, "rest");
    const [op] = await allOps(h);
    expect(op.payload).toMatchObject({ water_goal_cups_rest: 12,
      diet_prefs: { flags: [], water: { unit: "oz", goal: "manual" } } });
    expect(await getWater("2026-09-19", "rest", lbToKg(215))).toMatchObject({ goal: 12, goalMode: "manual" });
  });
});
