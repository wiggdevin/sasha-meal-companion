// @vitest-environment jsdom
/**
 * PR #248 review r1 #6: a scan that A started and that answers after B signed in populates
 * nothing of B's — no offline revision, no queued scan — and hands nothing to B's screen.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { closeAllAccountDbs, openAccountDb } from "@/lib/sync/idb";
import { resolveScan } from "@/lib/barcode/resolve-scan";
import { readPendingScans } from "@/lib/barcode/scan-cache";
import { offlineMatch } from "@/lib/barcode/client";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { foodRulesEpoch, noteFoodRulesChanged } from "@/lib/foods/rules-epoch";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GTIN = "04006381333931";

const resolved = {
  status: "resolved", gtin14: GTIN,
  match: {
    catalogFoodId: 7, revisionId: 70, foodRefId: "dddddddd-4444-4444-8444-444444444444",
    description: "Oats", brand: "Acme", source: "off", catalogVersion: "off-1",
    per100g: {}, portions: [], allergenTags: [], policy: { verdict: "allowed" },
  },
};

async function catalogRows(userId: string): Promise<unknown[]> {
  unbindAccount();
  const h = bindAccount(userId);
  return (await openAccountDb(h)).getAll("catalog_revisions");
}

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("resolveScan across a switch", () => {
  it("caches nothing for B and answers gone when the lookup lands after B binds", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const pending = resolveScan(a, GTIN, undefined, undefined, { fetchImpl: fetchImpl as never });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    bindAccount(B);
    answer(Response.json(resolved));
    await expect(pending).resolves.toEqual({ kind: "gone" });
    expect(await catalogRows(B)).toEqual([]);
  });

  it("queues no scan for B when A's lookup fails after B binds", async () => {
    let fail!: (e: Error) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((_r, reject) => { fail = reject; }));
    const a = bindAccount(A);
    const pending = resolveScan(a, GTIN, undefined, undefined, { fetchImpl: fetchImpl as never });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    bindAccount(B);
    fail(new TypeError("offline"));
    await expect(pending).resolves.toEqual({ kind: "gone" });
    expect(readPendingScans()).toEqual([]);
  });

  it("caches the match for the account that scanned", async () => {
    const fetchImpl = vi.fn(async () => Response.json(resolved));
    const a = bindAccount(A);
    const out = await resolveScan(a, GTIN, undefined, undefined, { fetchImpl: fetchImpl as never });
    expect(out.kind).toBe("resolved");
    expect(await catalogRows(A)).toHaveLength(1);
  });

  it("W014 review: stamps the verdict with the rules epoch from before the lookup", async () => {
    const before = foodRulesEpoch();
    const fetchImpl = vi.fn(async () => {
      noteFoodRulesChanged(); // a rule saved while the lookup is in flight
      return Response.json(resolved);
    });
    const a = bindAccount(A);
    await resolveScan(a, GTIN, undefined, undefined, { fetchImpl: fetchImpl as never });
    const [row] = await catalogRows(A) as CachedRevision[];
    expect(row.rules_epoch).toBe(before);
    expect(offlineMatch(row)?.policy).toEqual({ verdict: "unverified" });
  });
});
