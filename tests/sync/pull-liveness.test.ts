/**
 * W026 (audit 2026-10-10 A080, A082): the pull never keeps the outbox from making progress.
 *
 * - The post-pull food and target projections are not the pull: when their direct reads fail,
 *   the feed is still applied, the push still runs, and the pass says what went wrong.
 * - The settings recovery replay resumes from its own watermark, so a feed longer than one pass's
 *   page budget is read to the end across passes and the held settings op is sent.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastError, lastSyncAt, pullChanges, pushOutbox, syncOnce } from "@/lib/sync/client";
import { allOps, getMeta, getRow, setCursor } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import { SETTINGS_RECOVERY_KEY } from "@/lib/sync/settings-recovery";
import type { ChangeRow, OpsResponse, SyncOp } from "@/lib/sync/types";
import { defaultStore, saveStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const foodSpies = vi.hoisted(() => ({ loadAccountFoodSnapshot: vi.fn() }));
vi.mock("@/lib/sync/food-refs", () => ({ loadAccountFoodSnapshot: foodSpies.loadAccountFoodSnapshot }));

let h: AccountHandle;

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  foodSpies.loadAccountFoodSnapshot.mockReset().mockResolvedValue({ foods: [], prefs: [], refs: [] });
  saveStore(defaultStore());
});
afterEach(() => { vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

const WATER: SyncOp = { op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-10-11",
  kind: "update", base_rev: 1, payload: { local_date: "2026-10-11", cups: 4 },
  client_ts: "2026-10-11T08:00:00.000Z" };

describe("a failed post-pull projection (A080)", () => {
  it("still pushes the outbox, stamps the sync, and reports the failure", async () => {
    foodSpies.loadAccountFoodSnapshot.mockRejectedValue(new Error("permission denied for food_refs"));
    await enqueue(h, WATER, 1_000);
    const pushed: SyncOp[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/sync/changes")) {
        return json({ changes: [{ seq: 1, entity: "water_log", entity_key: "2026-10-10", rev: 1,
          op: "create", at: "2026-10-10T08:00:00.000Z",
          current: { local_date: "2026-10-10", cups: 2, rev: 1 } }], next_cursor: 1, has_more: false });
      }
      const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
      pushed.push(...body.ops);
      return json({ results: body.ops.map((o) => ({ op_id: o.op_id, status: "applied", rev: 2, seq: 2 })),
        server_time: "2026-10-11T08:00:01.000Z" } satisfies OpsResponse);
    }) as unknown as typeof fetch;

    const { pull, push } = await syncOnce(h, { fetchFn });
    expect(pull).toMatchObject({ applied: 1, cursor: 1 });
    expect(pull.projectionError).toMatch(/permission denied/);
    expect(push).toMatchObject({ applied: 1, failed: false });
    expect(pushed.map((o) => o.op_id)).toEqual([WATER.op_id]);
    await expect(allOps(h)).resolves.toEqual([]);
    expect(await getRow(h, "water_log", "2026-10-10")).toMatchObject({ cups: 2 });
    await expect(lastSyncAt(h)).resolves.toEqual(expect.any(String));
    await expect(lastError(h)).resolves.toMatch(/permission denied/);
  });
});

describe("the settings recovery replay (A082)", () => {
  const SETTINGS = { time_zone: "America/Los_Angeles", height_cm: 170 };

  /** A feed of `n` one-change pages; settings changes at seqs 2 and n - 1, water otherwise. */
  function longFeed(n: number): { fetchFn: typeof fetch; sinces: number[] } {
    const sinces: number[] = [];
    const change = (seq: number): ChangeRow => (seq === 2 || seq === n - 1)
      ? { seq, entity: "user_settings", entity_key: "settings", rev: seq, op: "update",
        at: "2026-10-11T08:00:00.000Z", current: { ...SETTINGS, height_cm: 160 + seq, rev: seq } }
      : { seq, entity: "water_log", entity_key: `2026-09-${String(seq).padStart(2, "0")}`, rev: 1,
        op: "create", at: "2026-10-11T08:00:00.000Z",
        current: { local_date: `2026-09-${String(seq).padStart(2, "0")}`, cups: 1, rev: 1 } };
    const fetchFn = (async (url: string) => {
      const since = Number(new URL(url, "https://app.test").searchParams.get("since"));
      sinces.push(since);
      const seq = since + 1;
      return json({ changes: seq <= n ? [change(seq)] : [], next_cursor: Math.min(seq, n),
        has_more: seq < n });
    }) as unknown as typeof fetch;
    return { fetchFn, sinces };
  }

  it("resumes where the last pass stopped and reaches the end of a feed longer than one pass", async () => {
    const n = 6;
    await setCursor(h, n);
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "update", base_rev: 3, client_ts: "2026-10-11T09:00:00.000Z",
      payload: { ...SETTINGS, time_zone: "Europe/Lisbon" } }, 1_000);
    const { fetchFn, sinces } = longFeed(n);

    expect(await pullChanges(h, undefined, { fetchFn, maxPages: 2 })).toMatchObject({ hasMore: true });
    expect(await pullChanges(h, undefined, { fetchFn, maxPages: 2 })).toMatchObject({ hasMore: true });
    expect(await pullChanges(h, undefined, { fetchFn, maxPages: 2 })).toMatchObject({ hasMore: false });
    // Each pass picks up where the one before it stopped: never back to 0.
    expect(sinces).toEqual([0, 1, 2, 3, 4, 5]);
    // The replay is done; the newest settings row in the whole feed (rev 5) is the baseline the
    // held op is aimed at below.
    expect(await getRow(h, "user_settings", "settings")).toMatchObject({ time_zone: "Europe/Lisbon" });
    await expect(getMeta(h, SETTINGS_RECOVERY_KEY)).resolves.toBeUndefined();

    // The held op is now sendable.
    const sent: SyncOp[] = [];
    await pushOutbox(h, { fetchFn: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
      sent.push(...body.ops);
      return json({ results: body.ops.map((o) => ({ op_id: o.op_id, status: "applied", rev: n, seq: n + 1 })),
        server_time: "2026-10-11T09:00:01.000Z" });
    }) as unknown as typeof fetch });
    expect(sent.map((o) => o.entity)).toEqual(["user_settings"]);
    expect(sent[0].base_rev).toBe(n - 1);
  });
});
