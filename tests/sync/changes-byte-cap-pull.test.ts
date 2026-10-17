/**
 * W045: a change-feed page cut at the route's byte cap (`app/api/sync/changes/route.ts`) answers
 * `has_more: true`, and the phone keeps paging from the last whole row until the feed ends. The
 * phone talks to the real route handler here; only the session and the RPC are stubbed.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pullChanges } from "@/lib/sync/client";
import { getCursor, getRow } from "@/lib/sync/idb";
import type { ChangeRow } from "@/lib/sync/types";
import { defaultStore, saveStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const spies = vi.hoisted(() => ({ rpc: vi.fn(), loadAccountFoodSnapshot: vi.fn() }));
vi.mock("@/lib/sync/food-refs", () => ({ loadAccountFoodSnapshot: spies.loadAccountFoodSnapshot }));
vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: async () => ({ userId: "u1", client: { rpc: spies.rpc } }) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));

const { GET } = await import("@/app/api/sync/changes/route");

/** Six water rows of about 700 KB each: two fit under the 2 MB cap, so a page carries two. */
const FEED: ChangeRow[] = Array.from({ length: 6 }, (_, i) => ({
  seq: i + 1, entity: "water_log", entity_key: `2026-10-0${i + 1}`, rev: 1, op: "create",
  at: "2026-10-10T08:00:00.000Z",
  current: { local_date: `2026-10-0${i + 1}`, cups: i + 1, rev: 1, pad: "x".repeat(700_000) },
}));

let h: AccountHandle;

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  spies.loadAccountFoodSnapshot.mockReset().mockResolvedValue({ foods: [], prefs: [], refs: [] });
  spies.rpc.mockReset().mockImplementation(async (_name: string, args: { p_since: number; p_limit: number }) => ({
    data: FEED.filter((c) => c.seq > args.p_since).slice(0, args.p_limit), error: null,
  }));
  saveStore(defaultStore());
});

describe("a byte-capped change feed", () => {
  it("is read to the end across cut pages, each row once", async () => {
    const sinces: number[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      sinces.push(Number(new URL(url, "https://x.test").searchParams.get("since")));
      return GET(new Request(new URL(url, "https://x.test"), init));
    }) as unknown as typeof fetch;

    const pull = await pullChanges(h, undefined, { fetchFn });
    expect(sinces).toEqual([0, 2, 4]);
    expect(pull).toMatchObject({ applied: 6, cursor: 6, hasMore: false, pages: 3 });
    await expect(getCursor(h)).resolves.toBe(6);
    for (const row of FEED) {
      expect(await getRow(h, "water_log", row.entity_key)).toMatchObject({ cups: row.seq });
    }
    expect(spies.rpc.mock.calls.map(([, a]) => a.p_since)).toEqual([0, 2, 4]);
  });
});
