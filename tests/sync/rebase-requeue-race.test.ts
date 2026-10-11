/**
 * W011 review (Sol, second pass): a note saved while the drain works out a conflict rebase.
 *
 * The drain reads the ops queued behind the refused note, folds them, and replaces them in one
 * transaction. A save that lands between that read and that write was built on an op the
 * replacement retires; left queued behind the rebase, it carried that op's stale items at a
 * revision the rebase made match, and went over another device's change. The replacement now
 * refuses when the ops behind the refused one changed, and the rebase is worked out again.
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { allOps } from "@/lib/sync/idb";
import { saveExtraNote } from "@/lib/log-note-client";
import { addExtra } from "@/lib/store";
import { resetLiveCommits } from "@/lib/log/live-commits";
import { resetTestAccount } from "@/tests/helpers/account";
import { FakeSyncServer } from "@/tests/helpers/fake-sync-server";
import { device, onDevice } from "@/tests/helpers/sync-devices";
import type { AccountHandle } from "@/lib/device/account";
import type { LoggedFood } from "@/lib/types";

/** Runs once, right after the rebase reads the queue and before it writes. */
const hook = vi.hoisted(() => ({ afterRebaseRead: null as null | (() => Promise<void>) }));

vi.mock("@/lib/sync/idb", async (original) => {
  const actual = await original<typeof import("@/lib/sync/idb")>();
  return { ...actual, allOps: async (...args: Parameters<typeof actual.allOps>) => {
    const ops = await actual.allOps(...args);
    const run = hook.afterRebaseRead;
    if (run && String(new Error().stack).includes("rebaseLogNoteOnce")) {
      hook.afterRebaseRead = null;
      await run();
    }
    return ops;
  } };
});

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let server: FakeSyncServer;
let h: AccountHandle;

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: (_column: string, id: string) => ({
      maybeSingle: async () => ({ data: server.row("log_entries", id) ?? null, error: null }),
    }) }) }),
  }),
}));

const DAY = "2026-10-09";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM = { id: "bbbbbbbb-2222-4222-8222-222222222222", entry_id: ENTRY_ID, seq: 1,
  food_ref_id: "cccccccc-3333-4333-8333-333333333333", qty: 1, unit: "g", grams: 90, snapshot: {} };
const CARD: LoggedFood = { id: ENTRY_ID, foodId: "rice", name: "Rice", portionLabel: "90 g",
  qty: 1, grams: 90, macros: { kcal: 117, protein: 2, carbs: 25, fat: 0.2 },
  at: "2026-10-09T17:00:00.000Z" };

async function pass(): Promise<void> {
  vi.setSystemTime(Date.now() + 120_000);
  await pullChanges(h, undefined, { fetchFn: server.fetch });
  await pushOutbox(h, { fetchFn: server.fetch });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  h = await resetTestAccount();
  resetLiveCommits();
  server = new FakeSyncServer();
  await onDevice(device());
});

afterEach(() => {
  hook.afterRebaseRead = null;
  vi.useRealTimers();
});

describe("a note saved while the drain rebases the one before it", () => {
  it("is folded into the rebase, never left behind it on the folded op's items", async () => {
    server.seed("log_entries", ENTRY_ID, { id: ENTRY_ID, local_date: DAY, tz: "UTC",
      slot: "meal-2", method: "search", eaten_at: CARD.at, note: null, items: [ITEM] });
    addExtra(DAY, CARD);
    await pass();
    await saveExtraNote(DAY, ENTRY_ID, "felt fine");
    await saveExtraNote(DAY, ENTRY_ID, "felt fine, then good");
    // The tablet weighs the portion again: 200 g.
    const current = server.row("log_entries", ENTRY_ID)!;
    expect(server.apply({ op_id: crypto.randomUUID(), entity: "log_entries", entity_id: ENTRY_ID,
      kind: "update", base_rev: Number(current.rev), payload: { ...current,
        items: [{ ...ITEM, grams: 200 }] }, client_ts: new Date().toISOString() }).status)
      .toBe("applied");

    hook.afterRebaseRead = () => saveExtraNote(DAY, ENTRY_ID, "felt fine, then good, slept well");
    for (let i = 0; i < 4; i += 1) await pass();

    expect(await allOps(h)).toEqual([]);
    expect(server.row("log_entries", ENTRY_ID)).toMatchObject({
      note: "felt fine, then good, slept well", items: [{ grams: 200 }] });
  });
});
