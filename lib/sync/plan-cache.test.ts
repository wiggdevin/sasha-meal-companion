import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import { __resetStoreCache, getDay, loadStore, updateDay } from "@/lib/store";
import { saveItemOverride } from "@/lib/plan-day-client";
import { resolveDay } from "@/lib/resolve";
import { getCursor, putRow, setCursor } from "./idb";
import { serializePlanDay } from "./plan-day-queue";
import { restoreCachedPlanDays } from "./plan-cache";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const date = "2026-09-15";
const coffee = { baseMealId: "coffee-latte", components: [], followPlan: true, time: "10:00" };
const row = { user_id: "a", local_date: date, rev: 3, item_overrides: { coffee }, slot_notes: {} };
beforeEach(async () => {
  h = await resetTestAccount("a");
  globalThis.indexedDB = new IDBFactory();
  __resetStoreCache();
});
it("restores an already consumed cached plan into a missing Today store without replaying the cursor", async () => {
  await putRow(h, "plan_days", date, row);
  await setCursor(h, 18);
  expect(getDay(date)).toBeUndefined();
  expect(await restoreCachedPlanDays(h)).toBe(1);
  expect(resolveDay(loadStore(), date).slots.find((slot) => slot.slot === "coffee")?.time).toBe("10:00");
  expect(await getCursor(h)).toBe(18);
  expect(await restoreCachedPlanDays(h)).toBe(0);
});
// Eaten ticks are a plan field now (PRD R3, `plan_days.eaten_slots`), so the cached row
// carries them and the restore owns them — the same way it owns `itemOverrides`.
const eatenAt = "2026-09-15T09:00:00Z";
it("restores the plan's eaten tick and preserves local logs, water and marks", async () => {
  await putRow(h, "plan_days", date, {
    ...row, eaten_slots: { coffee: { eaten_at: eatenAt, changed_at: eatenAt } },
  });
  updateDay(date, { waterMl: 480, eaten: { coffee: "done" }, extras: [], gut: "good" });
  const stamp = getDay(date)?.updatedAt;
  await restoreCachedPlanDays(h);
  expect(getDay(date)).toMatchObject({ waterMl: 480, extras: [], gut: "good", updatedAt: stamp });
  expect(getDay(date)?.eaten?.coffee).toBe(eatenAt);
});
it("never restores another account's or ownerless cached row", async () => {
  await putRow(h, "plan_days", date, { ...row, user_id: "b" });
  expect(await restoreCachedPlanDays(h)).toBe(0);
  await putRow(h, "plan_days", date, { ...row, user_id: undefined });
  expect(await restoreCachedPlanDays(h)).toBe(0);
  expect(getDay(date)).toBeUndefined();
});
it("does not overwrite a queued local edit even if the legacy store was lost", async () => {
  await putRow(h, "plan_days", date, row);
  await saveItemOverride(date, "coffee", { ...coffee, time: "11:00" });
  __resetStoreCache();
  expect(await restoreCachedPlanDays(h)).toBe(0);
  expect(getDay(date)).toBeUndefined();
});
it("preserves existing normalized authority even after the pending op is no longer present", async () => {
  await putRow(h, "plan_days", date, row);
  await restoreCachedPlanDays(h);
  updateDay(date, { itemOverrides: { coffee: { ...coffee, time: "12:00" } } });
  expect(await restoreCachedPlanDays(h)).toBe(0);
  expect(getDay(date)?.itemOverrides?.coffee?.time).toBe("12:00");
});
it("cancels queued recovery when the authenticated identity changes", async () => {
  await putRow(h, "plan_days", date, row);
  let release!: () => void;
  const held = serializePlanDay(date, () => new Promise<void>((resolve) => { release = resolve; }));
  await Promise.resolve();
  let current = true;
  const recovery = restoreCachedPlanDays(h, () => current);
  current = false;
  release();
  await held;
  expect(await recovery).toBe(0);
  expect(getDay(date)).toBeUndefined();
});
it("serializes recovery with a concurrent local edit so the local intent wins", async () => {
  await putRow(h, "plan_days", date, row);
  await Promise.all([restoreCachedPlanDays(h), saveItemOverride(date, "coffee", { ...coffee, time: "14:00" })]);
  expect(getDay(date)?.itemOverrides?.coffee?.time).toBe("14:00");
});
it("skips malformed plan data", async () => {
  await putRow(h, "plan_days", date, { ...row, item_overrides: { coffee: { ...coffee, time: "bad" } } });
  expect(await restoreCachedPlanDays(h)).toBe(0);
  expect(getDay(date)).toBeUndefined();
});
