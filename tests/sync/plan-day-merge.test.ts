/**
 * Audit 2026-10-10 A141 and backlog B091: a day's plan edited on two devices.
 *
 * Every `plan_days` op carried all five plan fields, and a conflict took the newer side's value for
 * each whole field. A swap on one device and Floor Day on another lost one of the two, and the
 * item overrides of two different meals replaced each other. Today never saw the merge either: it
 * reached the mirror and the rebased op, not the legacy day Today reads.
 *
 * Now an update carries only the fields it changed, each with the value it replaced, and a conflict
 * merges slot by slot: a slot one side left alone takes the other side's, and only a slot both
 * changed falls to the newer edit. Two devices drive the real plan client, outbox and pull against
 * tests/helpers/fake-sync-server.ts.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { allOps } from "@/lib/sync/idb";
import {
  saveItemOverride, saveSlotNote, saveSwap, toggleFloorDay,
} from "@/lib/plan-day-client";
import { getDay } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import { FakeSyncServer } from "@/tests/helpers/fake-sync-server";
import { device, onDevice, type Device } from "@/tests/helpers/sync-devices";
import type { AccountHandle } from "@/lib/device/account";
import type { SlotOverride } from "@/lib/types";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

const DAY = "2026-10-09";

let server: FakeSyncServer;
let h: AccountHandle;
let phone: Device;
let tablet: Device;

async function pass(): Promise<void> {
  vi.setSystemTime(Date.now() + 120_000);
  await pullChanges(h, undefined, { fetchFn: server.fetch });
  await pushOutbox(h, { fetchFn: server.fetch });
}

/** Let the clock move between two devices' edits, so "newer" means something. */
function later(): void {
  vi.setSystemTime(Date.now() + 60_000);
}

function leftovers(title: string): SlotOverride {
  return { baseMealId: null, title, followPlan: false, components: [{ name: title, qty: 1,
    unit: "whole", role: "free", macros: { kcal: 400, protein: 30, carbs: 40, fat: 12 } }] };
}

const serverDay = () => server.row("plan_days", DAY)!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  h = await resetTestAccount();
  server = new FakeSyncServer();
  server.seed("plan_days", DAY, { local_date: DAY, day_type_override: null, floor_day: false,
    swaps: {}, slot_notes: {}, item_overrides: {}, eaten_slots: {} });
  phone = device();
  tablet = device();
  for (const d of [phone, tablet]) {
    await onDevice(d);
    await pass();
  }
});

afterEach(() => { vi.useRealTimers(); });

describe("one day's plan edited on two devices", () => {
  it("keeps the phone's Floor Day and swap beside the tablet's swap (A141)", async () => {
    await onDevice(phone); // offline for now
    await toggleFloorDay(DAY);
    await saveSwap(DAY, "meal-1", "oats");
    later();
    await onDevice(tablet);
    await saveSwap(DAY, "meal-2", "eggs");
    await pass();

    await onDevice(phone);
    await pass(); // refused, merged with the tablet's day, re-aimed
    await pass(); // lands
    expect(await allOps(h)).toEqual([]);
    expect(serverDay()).toMatchObject({ floor_day: true, swaps: { "meal-1": "oats", "meal-2": "eggs" } });
    expect(Object.keys(serverDay().item_overrides as object).sort()).toEqual(["meal-1", "meal-2"]);
    // Today, on the phone, shows the merge, not only its own edits.
    expect(getDay(DAY)).toMatchObject({ floorDay: true, swaps: { "meal-1": "oats", "meal-2": "eggs" } });

    await onDevice(tablet);
    await pass();
    expect(getDay(DAY)).toMatchObject({ floorDay: true, swaps: { "meal-1": "oats", "meal-2": "eggs" } });
  });

  it("keeps each device's item override for a different meal (B091)", async () => {
    await onDevice(phone);
    await saveItemOverride(DAY, "meal-1", leftovers("Leftover chili"));
    later();
    await onDevice(tablet);
    await saveItemOverride(DAY, "meal-3", leftovers("Pad thai"));
    await pass();

    await onDevice(phone);
    await pass();
    await pass();
    const overrides = serverDay().item_overrides as Record<string, { title?: string }>;
    expect(overrides["meal-1"]?.title).toBe("Leftover chili");
    expect(overrides["meal-3"]?.title).toBe("Pad thai");
    expect(getDay(DAY)?.itemOverrides?.["meal-3"]?.title).toBe("Pad thai");
  });

  it("lets the newer edit win a slot both devices changed", async () => {
    await onDevice(phone);
    await saveSwap(DAY, "meal-1", "oats");
    later();
    await onDevice(tablet);
    await saveSwap(DAY, "meal-1", "eggs");
    await pass();

    await onDevice(phone);
    await pass();
    await pass();
    expect(serverDay().swaps).toEqual({ "meal-1": "eggs" });
    expect(getDay(DAY)?.swaps).toEqual({ "meal-1": "eggs" });
  });

  it("keeps both notes when both devices wrote one on the same meal", async () => {
    await onDevice(phone);
    await saveSlotNote(DAY, "meal-2", "ate half");
    later();
    await onDevice(tablet);
    await saveSlotNote(DAY, "meal-2", "skipped the rice");
    await pass();

    await onDevice(phone);
    await pass();
    await pass();
    expect(serverDay().slot_notes).toEqual({ "meal-2": "ate half\nskipped the rice" });
  });

  it("sends only the fields an edit changed, each with the value it replaced", async () => {
    await onDevice(phone);
    await toggleFloorDay(DAY);
    const [op] = await allOps(h);
    expect(op.payload).toEqual({ local_date: DAY, floor_day: true });
    expect(op.base_fields).toEqual({ floor_day: false });
  });
});
