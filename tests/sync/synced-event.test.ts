// @vitest-environment jsdom
/**
 * W047 (a): SYNCED_EVENT fires only when a pass changed this phone's data (rows applied or
 * projected, ops settled), when the error line changed, or on the account's first pass. Every
 * listener re-reads on it, so a quiet pass costs one feed read and nothing more.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSyncPasses, SYNCED_EVENT, syncOnce } from "@/lib/sync/client";
import { enqueue } from "@/lib/sync/outbox";
import type { ChangeRow, OpsResponse, SyncOp } from "@/lib/sync/types";
import { defaultStore, saveStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const foodSpies = vi.hoisted(() => ({ loadAccountFoodSnapshot: vi.fn() }));
vi.mock("@/lib/sync/food-refs", () => ({ loadAccountFoodSnapshot: foodSpies.loadAccountFoodSnapshot }));

let h: AccountHandle;
let events = 0;
const count = () => { events += 1; };

/** The server double: the feed it answers next, whether it is reachable, and every request. */
let feed: ChangeRow[] = [];
let reachable = true;
let requests: string[] = [];
let seq = 0;

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

const fetchFn = (async (url: string, init?: RequestInit) => {
  requests.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
  if (!reachable) throw new TypeError("Failed to fetch");
  if (url.startsWith("/api/sync/changes")) {
    const changes = feed;
    feed = [];
    return json({ changes, next_cursor: changes.at(-1)?.seq ?? seq, has_more: false });
  }
  const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
  return json({ results: body.ops.map((o) => ({ op_id: o.op_id, status: "applied", rev: 2, seq: ++seq })),
    server_time: "2026-10-17T08:00:01.000Z" } satisfies OpsResponse);
}) as unknown as typeof fetch;

const pass = async () => {
  requests = [];
  const before = events;
  await syncOnce(h, { fetchFn }).catch(() => undefined);
  return { events: events - before, requests };
};

const water = (date: string): SyncOp => ({ op_id: crypto.randomUUID(), entity: "water_log", entity_id: date,
  kind: "update", base_rev: 1, payload: { local_date: date, cups: 4 }, client_ts: "2026-10-17T08:00:00.000Z" });

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  resetSyncPasses();
  foodSpies.loadAccountFoodSnapshot.mockReset().mockResolvedValue({
    foods: [{ id: "f1", name: "Greek yogurt", per_100g: { protein: 10, carbohydrate: 4, fat_total: 0.4 }, rev: 1 }],
    prefs: [{ food_ref_id: "r1", status: "eats", rev: 1 }],
    refs: [{ id: "r1", user_food_id: "f1" }],
  });
  saveStore(defaultStore());
  feed = []; reachable = true; seq = 0; events = 0;
  window.addEventListener(SYNCED_EVENT, count);
});
afterEach(() => {
  window.removeEventListener(SYNCED_EVENT, count);
  vi.restoreAllMocks();
});

describe("SYNCED_EVENT per pass (W047 a)", () => {
  it("the first pass announces; a pass that changed nothing is one feed read and no event", async () => {
    expect(await pass()).toEqual({ events: 1, requests: ["GET /api/sync/changes"] });
    // The same server, the same foods: nothing changed on this phone.
    expect(await pass()).toEqual({ events: 0, requests: ["GET /api/sync/changes"] });
    expect(await pass()).toEqual({ events: 0, requests: ["GET /api/sync/changes"] });
  });

  it("a pull that applied a row announces", async () => {
    await pass();
    feed = [{ seq: ++seq, entity: "water_log", entity_key: "2026-10-16", rev: 1, op: "create",
      at: "2026-10-16T08:00:00.000Z", current: { local_date: "2026-10-16", cups: 2, rev: 1 } }];
    expect((await pass()).events).toBe(1);
    expect((await pass()).events).toBe(0);
  });

  it("a food changed outside the feed (a direct membership write) announces", async () => {
    await pass();
    foodSpies.loadAccountFoodSnapshot.mockResolvedValue({
      foods: [{ id: "f1", name: "Greek yogurt", per_100g: { protein: 10, carbohydrate: 4, fat_total: 0.4 }, rev: 1 }],
      prefs: [{ food_ref_id: "r1", status: "avoid", rev: 2 }],
      refs: [{ id: "r1", user_food_id: "f1" }],
    });
    expect((await pass()).events).toBe(1);
    expect((await pass()).events).toBe(0);
  });

  it("a push that settled ops announces", async () => {
    await pass();
    await enqueue(h, water("2026-10-17"), 1_000);
    const result = await pass();
    expect(result.requests).toEqual(["GET /api/sync/changes", "POST /api/sync/ops"]);
    expect(result.events).toBe(1);
    expect((await pass()).events).toBe(0);
  });

  it("the error line changing announces; the same failure again does not", async () => {
    await pass();
    reachable = false;
    expect((await pass()).events).toBe(1);
    expect((await pass()).events).toBe(0);
    reachable = true;
    // Back online: the error clears, which the card needs to show.
    expect((await pass()).events).toBe(1);
    expect((await pass()).events).toBe(0);
  });
});
