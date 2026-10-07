/**
 * A meal recovered onto a day she is not looking at has to say so (Grok pass 23, MEDIUM 2).
 *
 * The catch-up draws a recovered card on the date the request files it under. Log something just
 * before midnight, reopen the app after it, and that date is yesterday: the card goes onto a day
 * she is not on, she sees nothing, and she logs the meal again. Today carries one line about it
 * instead, and tapping the line opens that day.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { savingElsewhere } from "@/lib/log/today-state";
import {
  confirmEntry, markDeleted, markInFlight, markNeedsReconcile, readPending,
} from "@/lib/log/pending";
import { retryPendingReconciles } from "@/lib/log/reconcile";
import { getDay, loadStore, saveStore } from "@/lib/store";
import { enqueue } from "@/lib/sync/outbox";
import type { LogCommitRequest } from "@/lib/log/contract";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const TODAY = "2026-11-02";
const YESTERDAY = "2026-11-01";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

const REQ: LogCommitRequest = {
  entry_id: ENTRY_ID, eaten_at: "2026-11-01T23:50:00.000Z", tz: "UTC", local_date: YESTERDAY,
  slot: "meal-2", method: "search",
  items: [{ id: "bbbbbbbb-2222-4222-8222-222222222222", seq: 1,
    food_ref_id: "cccccccc-3333-4333-8333-333333333333", qty: 1, unit: "g", grams: 100 }],
};

beforeEach(async () => {
  // A record `retryPendingReconciles` finds unsent re-posts through `sendAgain`, which commits
  // for real — its `.finally()` fires a fire-and-forget wake (`wakeIfQueued`) nobody awaits. Give
  // it real turns to settle against the account this test bound, before the next test's
  // `beforeEach` turns the account handle over and the same read throws `AccountChanged`
  // unhandled.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a meal still saving on another day", () => {
  it("is drawn on its own day and announced on the one she is looking at", async () => {
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    // Before anything is sent: the record is hers, and it is not on the day she is looking at.
    expect(await savingElsewhere(TODAY)).toEqual({ date: YESTERDAY, count: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await retryPendingReconciles(h);

    // The card is on the day the request files it under, which is not the day on screen.
    expect((getDay(YESTERDAY)?.extras ?? []).map((e) => e.id)).toEqual([ENTRY_ID]);
    expect(getDay(TODAY)?.extras ?? []).toHaveLength(0);
  });

  it("still knows the day after the server has taken the entry", async () => {
    // The midnight case it exists for: the commit LANDED on yesterday and its row has not been
    // read back yet. `confirmEntry` clears the request and the card, so a line that reads the
    // date off the request went blind exactly when she needed it (Grok pass 24, HIGH 1).
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    await confirmEntry(h, ENTRY_ID);
    await markNeedsReconcile(h, ENTRY_ID, h.userId);
    expect((await readPending(h))[0].request).toBeUndefined();

    expect(await savingElsewhere(TODAY)).toEqual({ date: YESTERDAY, count: 1 });
  });

  it("says nothing when the day on screen is the day it is saving on", async () => {
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    expect(await savingElsewhere(YESTERDAY)).toBeNull();
  });

  it("says nothing about a note still on its way to a meal already logged", async () => {
    // Only a meal that has never landed is "still saving". An undrained note or edit for a day
    // she is not on is not a missing meal, and saying so sends her looking for one that is
    // already there (Grok pass 24, HIGH 2).
    await enqueue(h, {
      op_id: "44444444-4444-4444-8444-444444444444", entity: "log_entries",
      entity_id: ENTRY_ID, kind: "update", base_rev: 4,
      payload: { id: ENTRY_ID, local_date: YESTERDAY, note: "after the gym" },
      client_ts: "2026-11-02T09:00:00.000Z",
    });

    expect(await savingElsewhere(TODAY)).toBeNull();
  });

  it("says nothing about another account's meal", async () => {
    // Records are owned, and every other reader of them checks: the retry, the catch-up, the
    // delete. A line about the previous sign-in's meal offers her a day she cannot even read
    // under this token (Grok pass 24, MEDIUM 3).
    await markInFlight(h, ENTRY_ID, "user-b", { request: REQ, baseRev: 0 });
    await enqueue(h, {
      op_id: "55555555-5555-4555-8555-555555555555", entity: "log_entries",
      entity_id: ENTRY_ID, kind: "create", base_rev: null,
      payload: { ...REQ, id: ENTRY_ID } as unknown as Record<string, unknown>,
      client_ts: "2026-11-01T23:50:00.000Z",
    });

    expect(await savingElsewhere(TODAY)).toBeNull();
  });

  it("says nothing about a meal she has deleted", async () => {
    // Her delete is the last word, and a create still sitting in the outbox for it is not a meal
    // on its way — it is a write about to be dropped (Grok pass 24, MEDIUM 4).
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    await enqueue(h, {
      op_id: "66666666-6666-4666-8666-666666666666", entity: "log_entries",
      entity_id: ENTRY_ID, kind: "create", base_rev: null,
      payload: { ...REQ, id: ENTRY_ID } as unknown as Record<string, unknown>,
      client_ts: "2026-11-01T23:50:00.000Z",
    });
    await markDeleted(h, ENTRY_ID, { userId: h.userId });

    expect(await savingElsewhere(TODAY)).toBeNull();
  });

  it("is a line on Today that opens that day", () => {
    // No renderer in this repo, so the wiring is read from the source.
    const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/savingElsewhere\(/);
    expect(page).toMatch(/selectDate\(elsewhere\.date\)/);
    expect(page).toMatch(/still saving/);
  });
});
