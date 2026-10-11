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
import { handleLogEntryResult, MAX_UPDATE_REBASES, movedFields } from "./log-entry-ops";
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

/**
 * Audit 2026-10-10 A077: her note op carries the WHOLE note, and the rebase joined it to the
 * server's note on any conflict, even one another device caused without touching the note. Her
 * rewrite came back with the old text in front of it, and a cleared note came back.
 */
describe("a note refused because another device changed something else", () => {
  const server = (note: string | null) => ({
    ...conflict, current: { ...SERVER, note },
  }) as OpResult;

  it("keeps her rewrite instead of joining it to the text she rewrote", async () => {
    const op = noteOp({ note_base: "felt fine",
      payload: { ...noteOp().payload, note: "felt fine, then good" } });
    await putOp(h, op);
    await handleLogEntryResult(h, server("felt fine"), op);
    const [left] = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left.payload.note).toBe("felt fine, then good");
  });

  it("keeps her clear instead of bringing the old note back", async () => {
    const op = noteOp({ note_base: "felt fine", payload: { ...noteOp().payload, note: null } });
    await putOp(h, op);
    await handleLogEntryResult(h, server("felt fine"), op);
    const [left] = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left.payload.note).toBeNull();
  });

  it("still keeps both when the other device changed the note too", async () => {
    const op = noteOp({ note_base: null });
    await putOp(h, op);
    await handleLogEntryResult(h, server("a bit heavy"), op);
    const [left] = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left.payload.note).toBe("a bit heavy\nfelt fine");
  });

  it("re-aims on the server's note, so a second refusal adds nothing", async () => {
    const op = noteOp({ note_base: null });
    await putOp(h, op);
    await handleLogEntryResult(h, server("a bit heavy"), op);
    const [once] = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(once.note_base).toBe("a bit heavy");
    // Another device moves the entry; the note stays theirs-plus-hers.
    await handleLogEntryResult(h, { ...conflict, current_rev: 3,
      current: { ...SERVER, rev: 3, note: "a bit heavy" } } as OpResult, once);
    const [twice] = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(twice.payload.note).toBe("a bit heavy\nfelt fine");
    expect(twice.base_rev).toBe(3);
  });
});

describe("a coach move the server refused", () => {
  const BEFORE = "2026-11-02T17:00:00.000Z";
  const MOVED = "2026-11-02T13:30:00.000Z";
  /** A retime queued against rev 1: the time moved, the base records where it was. */
  const moveOp = (over: Partial<OutboxOp> = {}): OutboxOp => noteOp({
    payload: { ...noteOp().payload, note: null, eaten_at: MOVED },
    base_fields: { eaten_at: BEFORE, local_date: "2026-11-02", tz: "UTC" }, note_base: null, ...over,
  });

  it("keeps the new time on the server's row instead of reading the move as a note", async () => {
    const op = moveOp();
    await putOp(h, op);

    expect(await handleLogEntryResult(h, conflict, op)).toBe(true);

    const [left] = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left.base_rev).toBe(2);
    expect(left.payload).toMatchObject({ eaten_at: MOVED, items: SERVER.items, note: null });
    // Re-based on the server's placement; the move keeps its own time for the next conflict.
    expect(left.base_fields).toEqual({ eaten_at: BEFORE, local_date: "2026-11-02", tz: "UTC" });
    expect(left.field_stamps).toEqual({ eaten_at: op.client_ts });
  });

  it("lets a later move on the other device stand", async () => {
    const op = moveOp();
    await putOp(h, op);
    const later = { ...conflict, current: { ...SERVER, eaten_at: "2026-11-02T19:00:00.000Z",
      updated_at: "2026-11-02T18:00:00.000Z" } } as OpResult;

    await handleLogEntryResult(h, later, op);

    const [left] = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left.payload.eaten_at).toBe("2026-11-02T19:00:00.000Z");
    expect(left.base_fields).toBeUndefined();
  });

  it("keeps a move queued behind a refused note, with the note", async () => {
    const note = noteOp();
    const move = moveOp({ op_id: "55555555-5555-4555-8555-555555555555", seq: 2,
      payload: { ...noteOp().payload, note: "felt fine", eaten_at: MOVED },
      client_ts: "2026-11-02T17:06:00.000Z", note_base: "felt fine" });
    await putOp(h, note);
    await putOp(h, move);

    await handleLogEntryResult(h, conflict, note);

    const left = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left).toHaveLength(1);
    expect(left[0].payload).toMatchObject({ eaten_at: MOVED, note: "felt fine" });
  });

  it("judges a run of moves whole: a move and its Undo cancel out", () => {
    const there = { payload: { eaten_at: MOVED }, base_fields: { eaten_at: BEFORE }, client_ts: "2026-11-02T17:05:00Z" };
    const back = { payload: { eaten_at: BEFORE }, base_fields: { eaten_at: MOVED }, client_ts: "2026-11-02T17:06:00Z" };
    expect(movedFields([there, back], { ...SERVER, updated_at: "2026-11-02T17:10:00Z" }, "2026-11-02T17:10:00Z"))
      .toEqual({ fields: {} });
  });

  it("dates the move by its own time, not by a note folded after it", () => {
    const move = { payload: { eaten_at: MOVED }, base_fields: { eaten_at: BEFORE },
      client_ts: "2026-11-02T17:10:00Z", field_stamps: { eaten_at: "2026-11-02T17:05:00Z" } };
    const remote = { ...SERVER, eaten_at: "2026-11-02T19:00:00.000Z" };
    expect(movedFields([move], remote, "2026-11-02T17:08:00Z").fields).toEqual({});
  });

  it("compares instants, not spellings, and moves time, date and zone together", () => {
    const move = { payload: { eaten_at: MOVED, local_date: "2026-11-02", tz: "UTC" },
      base_fields: { eaten_at: BEFORE, local_date: "2026-11-02", tz: "UTC" }, client_ts: "2026-11-02T17:05:00.000Z" };
    // The same server time spelt "+00:00" is not a remote move.
    const same = movedFields([move], { ...SERVER, eaten_at: "2026-11-02T17:00:00+00:00" },
      "2026-11-02T17:09:00.000999+00:00");
    expect(same.fields).toEqual({ eaten_at: MOVED, local_date: "2026-11-02", tz: "UTC" });
    // A remote date change made earlier than the move: the move wins whole, its date with it.
    const earlier = movedFields([move], { ...SERVER, local_date: "2026-11-03" }, "2026-11-02T17:04:00.000Z");
    expect(earlier.fields).toMatchObject({ eaten_at: MOVED, local_date: "2026-11-02" });
  });
});
