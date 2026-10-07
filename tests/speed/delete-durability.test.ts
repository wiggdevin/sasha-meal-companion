/**
 * The record that says "tell the server about this delete" may only go once the delete is really
 * queued. `enqueue` swallowing a blocked database and the record clearing anyway dropped the only
 * durable trace of her delete (Grok pass 13, HIGH 2).
 *
 * Its own file because the seam is a module mock: `lib/log/delete-entry.ts` imports `enqueue`
 * directly, so the only way to make that write fail is to replace the module for this file alone.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLoggedEntry } from "@/lib/log-commit-client";
import { markDeleted, readPending } from "@/lib/log/pending";
import { retryPendingReconciles } from "@/lib/log/reconcile";
import { loadStore, saveStore } from "@/lib/store";
import { allOps, putRow } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const DATE = "2026-11-02";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";

/** When true the outbox cannot be written to — a blocked database, mid-delete. */
let blocked = false;

vi.mock("@/lib/sync/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/outbox")>();
  return {
    ...actual,
    enqueue: async (...args: Parameters<typeof actual.enqueue>) => {
      if (blocked) throw new Error("the database is blocked");
      return actual.enqueue(...args);
    },
  };
});

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { id: ENTRY_ID, rev: 6, deleted_at: null }, error: null }),
    }) }) }),
  }),
}));

beforeEach(async () => {
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
  blocked = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a delete the outbox could not take", () => {
  it("keeps the record until the delete is queued, and the catch-up queues it", async () => {
    await putRow(h, "log_entries", ENTRY_ID, { id: ENTRY_ID, rev: 6, local_date: DATE, items: [] });
    blocked = true;
    await forgetLoggedEntry(DATE, ENTRY_ID);

    expect(await allOps(h)).toHaveLength(0);
    expect((await readPending(h))[0].state).toBe("deleted");

    blocked = false;
    await retryPendingReconciles(h);
    expect((await allOps(h)).map((o) => o.kind)).toEqual(["delete"]);
    expect(await readPending(h)).toHaveLength(0);
  });

  it("asks the server even about a tombstone nothing confirmed", async () => {
    // No mirror row at all, so `confirmed` is false — and the server has the entry regardless.
    await markDeleted(h, ENTRY_ID);
    await retryPendingReconciles(h);
    const ops = await allOps(h);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(ops[0].base_rev).toBe(6);
  });
});
