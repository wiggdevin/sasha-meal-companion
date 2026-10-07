/**
 * What the drain does about a `log_entries` op the server refused.
 *
 * A create is settled from the server: the entry exists, and this phone's items are not the
 * server's (Grok pass 25, HIGH 1). An UPDATE is not that. The only update this app queues is the
 * note she typed on a card (`lib/log-note-client.ts`), and settling one the same way deleted it:
 * the line she wrote never reached the server, and the read-back then put the server's empty note
 * on her card (Grok pass 28, HIGH 1). It is re-aimed instead — her note, the server's row.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleLogEntryResult, MAX_UPDATE_REBASES } from "./log-entry-ops";
import { allOps, getRow, putOp, type OutboxOp } from "./idb";
import { PARK_MS } from "./settings";
import type { OpResult } from "./types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const FOOD_REF = "33333333-3333-4333-8333-333333333333";

function item(grams: number): Record<string, unknown> {
  return { id: ITEM_ID, food_ref_id: FOOD_REF, seq: 1, grams, qty: 1, unit: "portion",
    snapshot: { iron: { amount: 2 } } };
}

/** The row the server holds now: a revision on, an item changed, and no note of its own. */
const SERVER = {
  id: ENTRY_ID, rev: 2, note: null, items: [item(400)], eaten_at: "2026-11-02T17:00:00.000Z",
  tz: "UTC", local_date: "2026-11-02", slot: "meal-2", method: "search",
};

/** Her note, queued against the revision the entry had when she typed it. */
function noteOp(over: Partial<OutboxOp> = {}): OutboxOp {
  return {
    op_id: "44444444-4444-4444-8444-444444444444", entity: "log_entries", entity_id: ENTRY_ID,
    kind: "update", base_rev: 1, seq: 1, error_attempts: 0, next_attempt_at: 0,
    client_ts: "2026-11-02T17:05:00.000Z",
    payload: { id: ENTRY_ID, rev: 1, note: "felt fine", items: [item(90)],
      eaten_at: SERVER.eaten_at, tz: "UTC", local_date: "2026-11-02", slot: "meal-2",
      method: "search" },
    ...over,
  } as OutboxOp;
}

const conflict: OpResult = {
  op_id: "44444444-4444-4444-8444-444444444444", status: "conflict", entity: "log_entries",
  current_rev: 2, current: SERVER,
} as OpResult;

beforeEach(async () => {
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a note the server refused", () => {
  it("is re-aimed at the revision the server holds, with her note and the server's items", async () => {
    const op = noteOp();
    await putOp(h, op);

    expect(await handleLogEntryResult(h, conflict, op)).toBe(true);

    const left = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left).toHaveLength(1);
    expect(left[0].base_rev).toBe(2);
    expect(left[0].payload.note).toBe("felt fine");
    // The other device's items, never this phone's stale ones under the server's revision.
    expect(left[0].payload.items).toEqual(SERVER.items);
    // And the mirror holds what the server actually has.
    expect(await getRow(h, "log_entries", ENTRY_ID)).toMatchObject({ rev: 2, items: SERVER.items });
  });

  it("is parked rather than deleted once it has been refused too often", async () => {
    const op = noteOp({ error_attempts: MAX_UPDATE_REBASES - 1 });
    await putOp(h, op);

    expect(await handleLogEntryResult(h, conflict, op)).toBe(true);

    const left = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left).toHaveLength(1);
    expect(left[0].payload.note).toBe("felt fine");
    expect(left[0].next_attempt_at).toBeGreaterThanOrEqual(Date.now() + PARK_MS - 1_000);
  });
});
