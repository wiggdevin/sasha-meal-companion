import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetStoreCache, getDay, loadStore, setOnSave, updateDay } from "@/lib/store";
import { resolveDay } from "@/lib/resolve";
import { saveEatenSlot, saveItemOverride, saveMealEdit, saveRecipeEatenSlot,
  saveSlotNote, saveSwap, toggleFloorDay } from "@/lib/plan-day-client";
import { allOps, deleteOp, getRow, putRow } from "./idb";
import { saveDayComplete } from "@/lib/plan-day-mark";
import { restoreCachedPlanDays } from "./plan-cache";
import { eatenRecipeSnapshot } from "@/lib/recipes/eaten-snapshot";
import { withAcceptedRecipeSelections } from "@/lib/recipes/accepted-overlay";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import { pullChanges } from "./client";
import type { ChangeRow } from "./types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";
import type { ConsumedRecipeSnapshot } from "@/lib/types";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let h: AccountHandle;

const date = "2026-09-14";
const override = { baseMealId: "coffee-latte", components: [], followPlan: true,
  time: "13:15", title: "Afternoon latte" };
function change(rev = 1): ChangeRow {
  return { seq: rev, rev, entity: "plan_days", entity_key: date, op: "update",
    at: "2026-09-15T12:00:00Z", current: { local_date: date, rev,
      day_type_override: "rest", floor_day: false, swaps: {}, slot_notes: { coffee: "Later today" },
      item_overrides: { coffee: override },
      eaten_slots: { coffee: { eaten_at: "2026-09-15T09:00:00Z", changed_at: "2026-09-15T09:00:00Z" } },
      updated_at: "2026-09-15T12:00:00Z" } };
}
async function pull(...changes: ChangeRow[]) {
  return pullChanges(h, 0, { fetchFn: async () => Response.json({ changes,
    next_cursor: changes.at(-1)?.seq ?? 0, has_more: false }) });
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  __resetStoreCache();
});
afterEach(() => { setOnSave(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("plan_days pull reaches Today", () => {
  it("projects a second device's time, note and day type into the resolved day", async () => {
    const onSave = vi.fn();
    setOnSave(onSave);
    await pull(change());
    expect(getDay(date)?.itemOverrides?.coffee).toEqual(override);
    const day = resolveDay(loadStore(), date);
    const coffee = day.slots.find((slot) => slot.slot === "coffee");
    expect(coffee).toMatchObject({ time: "13:15", note: "Later today",
      meal: { name: "Afternoon latte" } });
    // This saved eaten mark is historical data, so its old recorded meal remains visible
    // and counted even though a fresh date no longer receives a default coffee card.
    expect(coffee?.components.map((item) => item.name)).toEqual(["Espresso", "Oat milk"]);
    expect(day.consumed.kcal).toBe(125);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("projects server eaten marks while preserving extras and water", async () => {
    updateDay(date, { eaten: { coffee: "2026-09-14T12:00:00Z" }, waterMl: 480,
      weightLb: 140, gut: "good", extras: [] });
    await pull(change());
    expect(getDay(date)).toMatchObject({ eaten: { coffee: "2026-09-15T09:00:00Z" },
      waterMl: 480, weightLb: 140, gut: "good", extras: [] });
  });

  it("marks a day fully logged, keeps the mark on other plan writes, and clears it (step E6)", async () => {
    await saveDayComplete(date, true);
    const marked = getDay(date)?.dayCompleteAt;
    expect(marked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const ops = await allOps(h);
    expect(ops.at(-1)?.payload).toMatchObject({ day_complete_at: marked });
    await toggleFloorDay(date);
    expect((await allOps(h)).at(-1)?.payload).not.toHaveProperty("day_complete_at");
    expect(getDay(date)?.dayCompleteAt).toBe(marked);
    await saveDayComplete(date, false);
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ day_complete_at: null });
    expect(getDay(date)?.dayCompleteAt).toBeUndefined();
  });

  it("projects a server mark and leaves the local mark alone when the row has no column", async () => {
    const marked = { ...change(), current: { ...change().current,
      day_complete_at: "2026-09-14T21:00:00Z" } };
    await pull(marked);
    expect(getDay(date)?.dayCompleteAt).toBe("2026-09-14T21:00:00Z");
    await pull(change(2));
    expect(getDay(date)?.dayCompleteAt).toBe("2026-09-14T21:00:00Z");
    const cleared = { ...change(3), current: { ...change(3).current, day_complete_at: null } };
    await pull(cleared);
    expect(getDay(date)?.dayCompleteAt).toBeUndefined();
  });

  it("queues a complete eaten map before projecting a tick and keeps an untick tombstone", async () => {
    await saveEatenSlot(date, "meal-1", "2026-09-15T12:00:00Z", "2026-09-15T12:00:00Z");
    expect(getDay(date)?.eaten).toEqual({ "meal-1": "2026-09-15T12:00:00Z" });
    expect((await getRow(h, "plan_days", date))?.eaten_slots).toEqual({
      "meal-1": { eaten_at: "2026-09-15T12:00:00Z", changed_at: "2026-09-15T12:00:00Z" },
    });

    await saveEatenSlot(date, "meal-1", null, "2026-09-15T13:00:00Z");
    expect(getDay(date)?.eaten).toEqual({});
    expect((await getRow(h, "plan_days", date))?.eaten_slots).toEqual({
      "meal-1": { eaten_at: null, changed_at: "2026-09-15T13:00:00Z" },
    });
  });

  it("keeps actual recipe history separate from the accepted plan through reload and untick", async () => {
    const selected = { id: "accepted", localDate: date, slotId: "meal-3", recipeId: "recipe",
      recipeRevisionId: "recipe-v1", recipeName: "Stew", servingFraction: 1.7847,
      nutritionSnapshot: Object.fromEntries(Object.entries({ kcal: 593.9928, protein: 40,
        carbs: 70, fat: 12 }).map(([key, value]) => [key,
        { value, status: "estimated", sourceRevisionId: null }])),
      ingredientSnapshot: [], exactFitAvailable: false, approximateFitAvailable: true,
      evidenceIssues: [], planRevision: 1 } as AcceptedRecipeSelection;
    const actual = eatenRecipeSnapshot(selected, 0.25);
    const mark = { eaten_at: "2026-09-15T12:00:00Z", changed_at: "2026-09-15T12:00:00Z",
      history_epoch: crypto.randomUUID(),
      consumed: { baseMealId: "recipe:recipe-v1", title: "Stew", components: [actual] } };
    const serverRow = { user_id: h.userId, local_date: date, rev: 1,
      item_overrides: {}, eaten_slots: { "meal-3": mark } };
    let finish!: (response: Response) => void;
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const saving = saveRecipeEatenSlot(date, "meal-3", selected, 0.25, crypto.randomUUID());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(getDay(date)?.eaten?.["meal-3"]).toBeUndefined();
    expect(await getRow(h, "plan_days", date)).toBeUndefined();
    expect(await allOps(h)).toHaveLength(0);
    finish(Response.json({ row: serverRow }));
    await saving;
    const first = await getRow(h, "plan_days", date);
    expect(first?.item_overrides).toEqual({});
    expect(first).toMatchObject({ eaten_slots: { "meal-3": { consumed: {
      components: [{ macros: { kcal: expect.closeTo(83.2, 1) } }],
    } } } });
    expect(resolveDay(withAcceptedRecipeSelections(loadStore(), []), date)
      .slots.find((slot) => slot.slot === "meal-3")?.macros.kcal).toBeCloseTo(83.2, 1);
    for (const op of await allOps(h)) await deleteOp(h, op.op_id);
    await putRow(h, "plan_days", date, { ...first, user_id: h.userId });
    __resetStoreCache();
    expect(await restoreCachedPlanDays(h)).toBe(1);
    expect(resolveDay(withAcceptedRecipeSelections(loadStore(), [selected]), date).consumed.kcal).toBe(83);
    fetcher.mockImplementationOnce(async () => Response.json({ error: "accepted_plan_changed" },
      { status: 409 }));
    await expect(saveRecipeEatenSlot(date, "meal-3", selected, 0.25,
      crypto.randomUUID())).rejects.toThrow(/meal changed/);
    await expect(saveEatenSlot(date, "meal-3", "2026-09-15T12:30:00Z",
      "2026-09-15T12:30:00Z")).rejects.toThrow(/already logged/);
    expect(await getRow(h, "plan_days", date)).toMatchObject({ eaten_slots: { "meal-3": {
      consumed: { baseMealId: "recipe:recipe-v1", title: "Stew", components: [actual] },
    } } });
    const undone = { eaten_at: null, changed_at: "2026-09-15T13:00:00Z",
      history_epoch: crypto.randomUUID() };
    fetcher.mockImplementationOnce(async () => Response.json({ row: { ...serverRow, rev: 2,
      eaten_slots: { "meal-3": undone } } }));
    await saveEatenSlot(date, "meal-3", null, "2026-09-15T13:00:00Z");
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ method: "DELETE" });
    expect(await getRow(h, "plan_days", date)).toMatchObject({ eaten_slots: { "meal-3": {
      ...undone,
    } } });
    expect((await getRow(h, "plan_days", date))?.item_overrides).toEqual({});
    for (const op of await allOps(h)) await deleteOp(h, op.op_id);
    __resetStoreCache();
    expect(await restoreCachedPlanDays(h)).toBe(1);
    const planned = resolveDay(withAcceptedRecipeSelections(loadStore(), [selected]), date)
      .slots.find((slot) => slot.slot === "meal-3");
    expect(planned?.eaten).toBe(false);
    expect(planned?.macros.kcal).toBe(593.9928);
    expect(planned?.components[0].qty).toBe(1.7847);
  });

  it("leaves no optimistic intake or queued operation when the server rejects a stale selection", async () => {
    const selected = { id: crypto.randomUUID(), localDate: date, slotId: "meal-3",
      planRevision: 1 } as AcceptedRecipeSelection;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "accepted_plan_changed" },
      { status: 409 })));
    await expect(saveRecipeEatenSlot(date, "meal-3", selected, 0.25,
      crypto.randomUUID())).rejects.toThrow(/meal changed/);
    expect(getDay(date)?.eaten?.["meal-3"]).toBeUndefined();
    expect(await getRow(h, "plan_days", date)).toBeUndefined();
    expect(await allOps(h)).toHaveLength(0);
  });

  it("retries a timed-out recipe undo with one request id and no optimistic untick", async () => {
    const consumed: ConsumedRecipeSnapshot = { baseMealId: "recipe:revision-1", title: "Stew", components: [{
      name: "Stew", qty: 0.25, unit: "whole", role: "free",
      macros: { kcal: 83, protein: 5, carbs: 9, fat: 2 },
    }] };
    const mark = { eaten_at: "2026-09-15T12:00:00Z", changed_at: "2026-09-15T12:00:00Z",
      history_epoch: crypto.randomUUID(), consumed };
    const row = { user_id: h.userId, local_date: date, rev: 2,
      eaten_slots: { "meal-3": mark }, item_overrides: {} };
    await putRow(h, "plan_days", date, row);
    updateDay(date, { eaten: { "meal-3": mark.eaten_at },
      consumedSlots: { "meal-3": consumed } });
    const undone = { eaten_at: null, changed_at: "2026-09-15T13:00:00Z",
      history_epoch: crypto.randomUUID() };
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("transport"))
      .mockResolvedValueOnce(Response.json({ row: { ...row, rev: 3,
        eaten_slots: { "meal-3": undone } } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(saveEatenSlot(date, "meal-3", null, undone.changed_at)).rejects.toThrow();
    expect((await getRow(h, "plan_days", date))?.eaten_slots).toEqual(row.eaten_slots);
    expect(getDay(date)?.eaten?.["meal-3"]).toBe(mark.eaten_at);
    expect(await allOps(h)).toHaveLength(0);
    await saveEatenSlot(date, "meal-3", null, undone.changed_at);
    const first = JSON.parse(fetcher.mock.calls[0][1].body as string);
    const second = JSON.parse(fetcher.mock.calls[1][1].body as string);
    expect(first.requestId).toBe(second.requestId);
    expect(getDay(date)?.eaten?.["meal-3"]).toBeUndefined();
    expect((await getRow(h, "plan_days", date))?.eaten_slots).toEqual({ "meal-3": undone });
  });

  it("gives new identical clears and swap-clears distinct slot intent without marking notes or time", async () => {
    const clear = { baseMealId: "old-meal", components: [], cleared: true };
    await saveItemOverride(date, "meal-1", clear);
    const first = getDay(date)?.itemOverrides?.["meal-1"]?.mutationId;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    await saveSlotNote(date, "meal-1", "Later");
    expect(getDay(date)?.itemOverrides?.["meal-1"]?.mutationId).toBe(first);
    await saveMealEdit(date, "meal-1", "old-meal", { planned: [], time: "13:15" });
    expect(getDay(date)?.itemOverrides?.["meal-1"]?.mutationId).toBe(first);
    await saveItemOverride(date, "meal-1", clear);
    const second = getDay(date)?.itemOverrides?.["meal-1"]?.mutationId;
    expect(second).not.toBe(first);
    await saveSwap(date, "meal-2", "another-meal");
    const swapped = getDay(date)?.itemOverrides?.["meal-2"]?.mutationId;
    await saveSwap(date, "meal-2", null);
    const clearedSwap = getDay(date)?.itemOverrides?.["meal-2"];
    expect(clearedSwap).toMatchObject({ followPlan: true, mutationId: expect.any(String) });
    expect(clearedSwap?.mutationId).not.toBe(swapped);
    expect((await getRow(h, "plan_days", date))?.item_overrides).toMatchObject({
      "meal-1": { mutationId: second }, "meal-2": { mutationId: clearedSwap?.mutationId },
    });
  });

  it("stores the generated meal snapshot with its eaten tick in one plan row", async () => {
    const components = [{ name: "Tofu, firm", role: "protein" as const,
      qty: 5, unit: "oz" as const,
      macros: { kcal: 140, protein: 14, carbs: 3, fat: 7 } }];
    await saveEatenSlot(date, "meal-1", "2026-09-15T12:00:00Z",
      "2026-09-15T12:00:00Z", { baseMealId: "suggested:2026-09-14:meal-1",
        title: "Tofu meal", components });
    expect(getDay(date)?.itemOverrides?.["meal-1"]?.components).toEqual(components);
    expect((await getRow(h, "plan_days", date))?.item_overrides).toMatchObject({
      "meal-1": { components },
    });
    expect((await getRow(h, "plan_days", date))?.eaten_slots).toMatchObject({
      "meal-1": { eaten_at: "2026-09-15T12:00:00Z" },
    });
  });

  it("freezes a time-only generated meal but preserves an explicitly cleared slot", async () => {
    const components = [{ name: "Tofu", role: "protein" as const, qty: 4, unit: "oz" as const,
      macros: { kcal: 120, protein: 13, carbs: 3, fat: 6 } }];
    await saveItemOverride(date, "meal-1", { baseMealId: null, components: [],
      followPlan: true, time: "13:15" });
    await saveEatenSlot(date, "meal-1", "2026-09-15T12:00:00Z",
      "2026-09-15T12:00:00Z", { baseMealId: "suggested:meal-1", title: "Tofu bowl", components });
    expect(getDay(date)?.itemOverrides?.["meal-1"]).toMatchObject({
      time: "13:15", components, title: "Tofu bowl",
    });
    expect(getDay(date)?.itemOverrides?.["meal-1"]?.followPlan).toBeUndefined();
    await saveItemOverride(date, "meal-2", { baseMealId: null, components: [], cleared: true });
    await saveEatenSlot(date, "meal-2", "2026-09-15T12:00:00Z",
      "2026-09-15T12:00:00Z", { baseMealId: "suggested:meal-2", title: "Unsafe", components });
    expect(getDay(date)?.itemOverrides?.["meal-2"]).toMatchObject({ components: [], cleared: true });
  });

  it("keeps a pending local edit in both mirror and Today when an older server row arrives", async () => {
    const local = { ...override, time: "14:30" };
    await saveItemOverride(date, "coffee", local);
    const mirror = await getRow(h, "plan_days", date);
    await pull(change());
    expect(getDay(date)?.itemOverrides?.coffee).toEqual(local);
    expect(await getRow(h, "plan_days", date)).toEqual(mirror);
  });

  it("clears a remote override while retaining the server's eaten mark", async () => {
    await pull(change());
    updateDay(date, { eaten: { coffee: "2026-09-14T12:00:00Z" } });
    const next = change(2);
    next.current!.item_overrides = {};
    next.current!.slot_notes = {};
    await pull(next);
    expect(getDay(date)?.itemOverrides).toEqual({});
    expect(getDay(date)?.notes).toEqual({});
    expect(getDay(date)?.eaten?.coffee).toBe("2026-09-15T09:00:00Z");
  });

  it("clears only plan fields when the normalized row is deleted", async () => {
    await pull(change());
    updateDay(date, { waterMl: 240 });
    await pull({ ...change(2), current: null, op: "delete" });
    expect(await getRow(h, "plan_days", date)).toBeUndefined();
    expect(getDay(date)).toMatchObject({ itemOverrides: {}, notes: {}, waterMl: 240 });
  });

  it("does not replay an older revision over the current day", async () => {
    await pull(change(3));
    const old = change(2);
    old.current!.item_overrides = {};
    await pull(old);
    expect(getDay(date)?.itemOverrides?.coffee).toEqual(override);
  });

  it("quarantines malformed nested data before it can crash Today", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = change();
    bad.current!.item_overrides = { coffee: { ...override, components: "not a list" } };
    await pull(bad);
    expect(getDay(date)).toBeUndefined();
    expect(await getRow(h, "plan_days", date)).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});

it("serializes a remote note projection before a concurrent local time edit snapshots its row", async () => {
  const { applyPulledPlanDay } = await import("./plan-days");
  const { saveMealEdit } = await import("@/lib/plan-day-client");
  updateDay(date, { notes: {} });
  await Promise.all([
    applyPulledPlanDay(h, change()),
    saveMealEdit(date, "meal-1", "lunch", { planned: [], time: "13:00" }),
  ]);
  expect(getDay(date)?.notes?.coffee).toBe("Later today");
  expect((await getRow(h, "plan_days", date))?.slot_notes).toEqual({ coffee: "Later today" });
  const { allOps } = await import("./idb");
  expect((await allOps(h)).at(-1)?.payload.slot_notes).toEqual({ coffee: "Later today" });
});
