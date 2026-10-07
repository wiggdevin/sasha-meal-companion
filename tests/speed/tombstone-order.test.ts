/**
 * A tombstone is the server's last word, and retiring the record must not depend on anything that
 * happens after it (panel round 13).
 *
 * Its own file because the seam is a module mock: `lib/log/reconcile.ts` imports `removeExtra`
 * directly, so the only way to make clearing the card fail is to replace the store module for this
 * file alone. Everything else here is the real thing — the same IndexedDB, the same records.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitLogEntry, pendingEntryIds, retryPendingReconciles } from "@/lib/log-commit-client";
import { loadStore, saveStore } from "@/lib/store";
import type { LogCommitRequest } from "@/lib/log/contract";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const DATE = "2026-11-02";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";

let serverRead: Record<string, unknown> | null = null;
let reads = 0;

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return {
    ...actual,
    removeExtra: () => { throw new Error("the store is gone"); },
  };
});

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => { reads += 1; return { data: serverRead, error: null }; } }) }) }),
  }),
}));

const REQ: LogCommitRequest = {
  entry_id: ENTRY_ID, eaten_at: "2026-11-02T17:00:00.000Z", tz: "UTC", local_date: DATE,
  slot: "meal-2", method: "search",
  items: [{ id: ITEM_ID, seq: 1, food_ref_id: "cccccccc-3333-4333-8333-333333333333",
    qty: 1, unit: "g", grams: 100 }],
};

function jsonFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

beforeEach(async () => {
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
  serverRead = null;
  reads = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a tombstone", () => {
  it("retires the record even when clearing the card throws", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }) });
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);

    serverRead = { id: ENTRY_ID, rev: 8, local_date: DATE,
      deleted_at: "2026-11-02T18:00:00.000Z", items: [] };
    await retryPendingReconciles(h);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);

    const after = reads;
    await retryPendingReconciles(h);
    await retryPendingReconciles(h);
    expect(reads).toBe(after);
  });
});
