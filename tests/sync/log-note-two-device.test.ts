/**
 * Backlog B014: a logged extra's note, written on two devices of one account.
 *
 * Commit 8adb667 made a note sync without replacing the entry's items, and nothing proved what two
 * devices do with it. Here two phones — each its own IndexedDB and its own store — drive the real
 * note client, outbox and pull against one in-memory server that answers as `apply_sync_op` does.
 * They also pin the audit's note findings end to end: a note both phones wrote is kept once each
 * (A139), and a rewrite or clear survives a conflict another device caused without touching the note
 * (A077).
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveExtraNote } from "@/lib/log-note-client";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { allOps, closeAllAccountDbs, getRow } from "@/lib/sync/idb";
import { __resetStoreCache, addExtra, getDay } from "@/lib/store";
import { resetLiveCommits } from "@/lib/log/live-commits";
import { resetTestAccount } from "@/tests/helpers/account";
import { FakeSyncServer } from "@/tests/helpers/fake-sync-server";
import type { AccountHandle } from "@/lib/device/account";
import type { LoggedFood } from "@/lib/types";

let server: FakeSyncServer;

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

// The read-back after an op lands asks the server for the entry; this answers with the fake's row.
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: (_column: string, id: string) => ({
      maybeSingle: async () => ({ data: server.row("log_entries", id) ?? null, error: null }),
    }) }) }),
  }),
}));

const DATE = "2026-10-09";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM = { id: "bbbbbbbb-2222-4222-8222-222222222222", entry_id: ENTRY_ID, seq: 1,
  food_ref_id: "cccccccc-3333-4333-8333-333333333333", qty: 1, unit: "g", grams: 150,
  snapshot: {} };
const ENTRY = { id: ENTRY_ID, local_date: DATE, tz: "UTC", slot: "meal-2", method: "search",
  eaten_at: "2026-10-09T17:00:00.000Z", note: null, items: [ITEM] };
const CARD: LoggedFood = { id: ENTRY_ID, foodId: "rice", name: "Rice", portionLabel: "150 g",
  qty: 1, grams: 150, macros: { kcal: 195, protein: 4, carbs: 42, fat: 0.4 }, at: ENTRY.eaten_at };

type Device = { idb: IDBFactory; window: EventTarget & { localStorage: Storage } };

function device(): Device {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, String(v)); },
    removeItem: (k: string) => { memory.delete(k); },
  } as Storage;
  return { idb: new IDBFactory(), window: Object.assign(new EventTarget(), { localStorage: storage }) };
}

let h: AccountHandle;
let phone: Device;
let tablet: Device;

/** Pick up a device: its own database and its own store. Same account, same server. */
async function on(d: Device): Promise<void> {
  await closeAllAccountDbs();
  globalThis.indexedDB = d.idb;
  (globalThis as { window?: unknown }).window = d.window;
  __resetStoreCache();
}

/** One sync pass, a couple of minutes after the last: past any re-aimed op's backoff. */
async function pass(): Promise<void> {
  vi.setSystemTime(Date.now() + 120_000);
  await pullChanges(h, undefined, { fetchFn: server.fetch });
  await pushOutbox(h, { fetchFn: server.fetch });
}

/** A coach move on a third device: the entry's revision moves and its note does not. */
function movedElsewhere(eatenAt: string): void {
  const row = server.row("log_entries", ENTRY_ID)!;
  const result = server.apply({ op_id: crypto.randomUUID(), entity: "log_entries",
    entity_id: ENTRY_ID, kind: "update", base_rev: Number(row.rev),
    payload: { ...row, eaten_at: eatenAt }, client_ts: new Date().toISOString() });
  expect(result.status).toBe("applied");
}

const serverNote = () => server.row("log_entries", ENTRY_ID)?.note;
const mirrorNote = async () => (await getRow(h, "log_entries", ENTRY_ID))?.note;
const cardNote = () => getDay(DATE)?.extras?.find((extra) => extra.id === ENTRY_ID)?.note;

beforeEach(async () => {
  // Only the clock: fake-indexeddb needs real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  h = await resetTestAccount();
  resetLiveCommits();
  server = new FakeSyncServer();
  server.seed("log_entries", ENTRY_ID, ENTRY);
  phone = device();
  tablet = device();
  for (const d of [phone, tablet]) {
    await on(d);
    addExtra(DATE, CARD);
    await pass();
  }
});

afterEach(() => { vi.useRealTimers(); });

describe("a logged extra's note on two devices", () => {
  it("keeps both phones' notes once each, and both mirrors agree", async () => {
    await on(phone);
    await saveExtraNote(DATE, ENTRY_ID, "felt fine"); // offline for now
    await on(tablet);
    await saveExtraNote(DATE, ENTRY_ID, "a bit heavy");
    await pass();
    expect(serverNote()).toBe("a bit heavy");

    await on(phone);
    await pass(); // refused: the tablet got there first; re-aimed with both notes
    movedElsewhere("2026-10-09T18:30:00.000Z"); // and refused again, with the note unchanged
    await pass(); // re-aimed once more, adding nothing
    await pass(); // lands
    await pass(); // and nothing is left to send or to append
    expect(await allOps(h)).toEqual([]);
    expect(serverNote()).toBe("a bit heavy\nfelt fine");
    expect(await mirrorNote()).toBe("a bit heavy\nfelt fine");
    expect(cardNote()).toBe("a bit heavy\nfelt fine");

    await on(tablet);
    await pass();
    expect(await mirrorNote()).toBe("a bit heavy\nfelt fine");
  });

  it("keeps a rewrite whole when another device moved the entry meanwhile", async () => {
    await on(phone);
    await saveExtraNote(DATE, ENTRY_ID, "felt fine");
    await pass();
    expect(serverNote()).toBe("felt fine");

    await saveExtraNote(DATE, ENTRY_ID, "felt fine, then good");
    movedElsewhere("2026-10-09T18:30:00.000Z");
    await pass();
    await pass();

    expect(await allOps(h)).toEqual([]);
    expect(serverNote()).toBe("felt fine, then good");
    // Their move stands: the re-aimed note rides on the server's row.
    expect(server.row("log_entries", ENTRY_ID)?.eaten_at).toBe("2026-10-09T18:30:00.000Z");
    expect(cardNote()).toBe("felt fine, then good");
  });

  it("keeps a cleared note cleared when another device moved the entry meanwhile", async () => {
    await on(phone);
    await saveExtraNote(DATE, ENTRY_ID, "felt fine");
    await pass();
    await saveExtraNote(DATE, ENTRY_ID, "");
    movedElsewhere("2026-10-09T18:30:00.000Z");
    await pass();
    await pass();

    expect(await allOps(h)).toEqual([]);
    expect(serverNote()).toBeNull();
    expect(cardNote()).toBeUndefined();

    await on(tablet);
    await pass();
    expect(await mirrorNote()).toBeNull();
  });
});
