/**
 * W027: their delete racing a commit's own settle, and the mirror's revision order.
 *
 * A commit that is done with an entry used to clear its record outright, and a delete that landed
 * between the commit's `isDeleted` check and that clear took the only record still owing the
 * server the delete. Worse, on the offline path the create it had just queued again stayed in the
 * outbox, so the drain built the meal they had removed. `retirePending` keeps a `deleted` record
 * in the same write that reads it, and `markNeedsReconcile` no longer turns one into a read-back.
 *
 * Its own file because the seams are module mocks: the outbox write is where the delete lands.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitLogEntry, forgetLoggedEntry } from "@/lib/log-commit-client";
import { reconcileMirror } from "@/lib/log-commit-settle";
import { resetLiveCommits } from "@/lib/log/live-commits";
import {
  markDeleted, markInFlight, markNeedsReconcile, readPending, retirePending,
} from "@/lib/log/pending";
import type { LogCommitRequest, LogCommitResponse } from "@/lib/log/contract";
import { loadStore, saveStore } from "@/lib/store";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import type { AccountHandle } from "@/lib/device/account";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

let h: AccountHandle;

const DATE = "2026-11-02";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const FOOD_REF = "cccccccc-3333-4333-8333-333333333333";

/** Runs inside the outbox write of the Nth create for the entry, before the write itself. */
let duringCreate: { nth: number; run: () => Promise<void> } | null = null;
let creates = 0;

vi.mock("@/lib/sync/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/outbox")>();
  return {
    ...actual,
    enqueue: async (...args: Parameters<typeof actual.enqueue>) => {
      const op = args[1];
      if (op.entity_id === ENTRY_ID && op.kind === "create") {
        creates += 1;
        if (duringCreate && creates === duringCreate.nth) await duringCreate.run();
      }
      return actual.enqueue(...args);
    },
  };
});

/** The server read every settle and delete makes. `null` is a read that does not see the row. */
let serverRow: Record<string, unknown> | null = null;
let serverError = false;

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => (serverError
        ? { data: null, error: { message: "down" } }
        : { data: serverRow, error: null }),
    }) }) }),
  }),
}));

const REQ: LogCommitRequest = {
  entry_id: ENTRY_ID, eaten_at: "2026-11-02T17:00:00.000Z", tz: "UTC", local_date: DATE,
  slot: "meal-2", method: "search",
  items: [{ id: ITEM_ID, seq: 1, food_ref_id: FOOD_REF, qty: 1, unit: "g", grams: 100 }],
};

const ENTRY: LoggedFood = {
  id: ENTRY_ID, foodId: FOOD_REF, name: "Greek yogurt", portionLabel: "100 g",
  qty: 1, grams: 100, macros: { kcal: 100, protein: 10, carbs: 5, fat: 2 },
  at: REQ.eaten_at,
};

const ITEM = { id: ITEM_ID, entry_id: ENTRY_ID, seq: 1, food_ref_id: FOOD_REF, qty: 1, unit: "g",
  grams: 100, portion_id: null, food_revision_id: null, was_edited: false, confidence: null,
  snapshot: {} };

beforeEach(async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
  resetLiveCommits();
  duringCreate = null;
  creates = 0;
  serverRow = null;
  serverError = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a delete that lands while an offline commit queues itself", () => {
  it("keeps the delete and leaves no create for the drain", async () => {
    // The first create is the write before the POST; the second is the offline path's own
    // re-queue. Their delete lands inside that one: after it emptied the outbox, before the write.
    duringCreate = { nth: 2, run: () => forgetLoggedEntry(DATE, ENTRY_ID, h) };
    const offline = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;

    const result = await commitLogEntry(REQ, { fetchImpl: offline, optimistic: { date: DATE, entry: ENTRY } });

    expect(result).toEqual({ status: "discarded" });
    expect((await allOps(h)).filter((o) => o.kind === "create")).toHaveLength(0);
    // The server read did not see the row, so the delete is still owed and the record says so.
    expect((await readPending(h)).map((r) => r.state)).toEqual(["deleted"]);
  });
});

describe("the record primitives", () => {
  it("retirePending keeps a deleted record and clears any other", async () => {
    await markDeleted(h, ENTRY_ID);
    expect(await retirePending(h, ENTRY_ID)).toEqual({ deleted: true });
    expect((await readPending(h))[0].state).toBe("deleted");

    const other = "dddddddd-4444-4444-8444-444444444444";
    await markInFlight(h, other, h.userId, { request: { ...REQ, entry_id: other }, baseRev: 0 });
    expect(await retirePending(h, other)).toEqual({ deleted: false });
    expect((await readPending(h)).map((r) => r.entryId)).toEqual([ENTRY_ID]);
  });

  it("markNeedsReconcile never turns their delete into a read-back", async () => {
    await markDeleted(h, ENTRY_ID, { confirmed: true });
    await markNeedsReconcile(h, ENTRY_ID, h.userId);
    expect((await readPending(h))[0].state).toBe("deleted");
  });
});

describe("the commit's mirror write", () => {
  it("never puts an older revision over a newer one", async () => {
    // A pull mirrored another device's revision 3 while this commit's answer (revision 1) was
    // in the air, and the read-back that would have corrected the mirror fails.
    await putRow(h, "log_entries", ENTRY_ID, {
      id: ENTRY_ID, rev: 3, local_date: DATE, note: "from the other phone", items: [ITEM],
    });
    serverError = true;
    const answer = { status: "ok", entry_id: ENTRY_ID, rev: 1, items: [ITEM],
      totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 } } as unknown as LogCommitResponse;

    await reconcileMirror(h, REQ, answer, "attempt-1");

    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(3);
    expect(row.note).toBe("from the other phone");
  });

  it("still writes the answer over an older mirrored row", async () => {
    await putRow(h, "log_entries", ENTRY_ID, { id: ENTRY_ID, rev: null, local_date: DATE, items: [] });
    serverError = true;
    const answer = { status: "ok", entry_id: ENTRY_ID, rev: 1, items: [ITEM],
      totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 } } as unknown as LogCommitResponse;

    await reconcileMirror(h, REQ, answer, "attempt-1");

    expect((await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>).rev).toBe(1);
  });
});
