import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { closeAllAccountDbs, putRow } from "@/lib/sync/idb";
import { USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { hasHealthField, readWaterGoal, readWaterWindow } from "@/lib/trends/sources";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  globalThis.indexedDB = new IDBFactory();
});

describe("trend sources", () => {
  it("reads stored cups for the window only, keeping 0 and skipping a deleted row", async () => {
    const h = bindAccount(A);
    await putRow(h, "water_log", "2026-10-17", { local_date: "2026-10-17", cups: 0, rev: 1 });
    await putRow(h, "water_log", "2026-10-18", { local_date: "2026-10-18", cups: 6, rev: 2 });
    await putRow(h, "water_log", "2026-10-16", { local_date: "2026-10-16", cups: 4, rev: 1, deleted_at: "x" });
    await putRow(h, "water_log", "2026-01-01", { local_date: "2026-01-01", cups: 9, rev: 1 });
    const cups = await readWaterWindow(h, ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect([...(cups ?? new Map()).entries()]).toEqual([["2026-10-17", 0], ["2026-10-18", 6]]);
  });

  it("resolves the water goal per day type from the settings row, and none without a row", async () => {
    const h = bindAccount(A);
    expect(await readWaterGoal(h)).toBeNull();
    await putRow(h, "user_settings", USER_SETTINGS_KEY, { water_goal_cups_training: 10, water_goal_cups_rest: 8,
      diet_prefs: { flags: [], water: { goalMode: "manual" } } });
    const goal = await readWaterGoal(h);
    expect(goal?.("2026-10-18", "rest")).toBe(8);
    expect(goal?.("2026-10-18", "training-10")).toBe(10);
  });

  it("knows whether a source carries a measure", () => {
    const row = { local_date: "d", steps: null, active_kcal: 120, sleep_minutes: null, body_mass_kg: null,
      sources: [], resting_heart_rate: null, hrv_sdnn: null, readiness_score: null, provenance: {} };
    expect(hasHealthField([row], "active_kcal")).toBe(true);
    expect(hasHealthField([row], "sleep_minutes")).toBe(false);
  });
});
