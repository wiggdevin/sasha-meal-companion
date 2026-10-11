// lib/sync/outbox.test.ts
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getCursor, getRow, putOp, putRow, setCursor } from "./idb";
import { SyncHttpError } from "./client";
import {
  backoffMs, drainOutbox, enqueue, enqueueWithRow, MAX_PUSH_BYTES, OUTBOX_QUEUED_EVENT,
  pendingCount, retryParked, type PushFn,
} from "./outbox";
import type { OpResult, OpsResponse, SyncOp } from "./types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

export const OP: SyncOp = {
  op_id: "11111111-1111-4111-8111-111111111111", entity: "water_log",
  entity_id: "2026-09-11", kind: "update", base_rev: 1,
  payload: { local_date: "2026-09-11", cups: 4 }, client_ts: "2026-09-11T10:00:00.000Z",
};

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  // The drain's jitter draws from Math.random; the top of the band is the planned delay itself, so
  // the exact timings below stay what they were. The jitter has its own cases below.
  vi.spyOn(Math, "random").mockReturnValue(1);
});

afterEach(() => { vi.restoreAllMocks(); });

describe("backoffMs", () => {
  it("doubles from one second and stops at a minute at the top of the jitter band", () => {
    const top = () => 1;
    expect([1, 2, 3, 4].map((n) => backoffMs(n, top))).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(backoffMs(10, top)).toBe(60_000);
  });

  it("never waits less than half the planned delay, nor more than the cap", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, () => 0))).toEqual([500, 1_000, 2_000, 4_000]);
    expect(backoffMs(10, () => 0)).toBe(30_000);
    expect(backoffMs(10, () => 0.999)).toBeLessThanOrEqual(60_000);
  });

  it("spreads phones that failed together instead of retrying in lockstep", () => {
    const draws = [0, 0.25, 0.5, 0.75];
    expect(draws.map((r) => backoffMs(3, () => r))).toEqual([2_000, 2_500, 3_000, 3_500]);
  });
});

/**
 * 2026-09-14, Loop 010: tapping "Add a cup" queued its op and nothing pushed it. Waiting 8 s — more
 * than five times SyncBootstrap's 1.5 s save debounce — still showed zero `POST /api/sync/ops`, and
 * the server still held the previous cup count. The op sat in IndexedDB with attempts: 0.
 *
 * SyncBootstrap's own contract is "on open, on return to the tab, when signal comes back, and 1.5 s
 * after a local save". That fourth trigger hangs off `setOnSave` in lib/store.ts — the localStorage
 * store. Water, favorites, recipes, body profile and the estimator write through this outbox and
 * never touch that store, so for them the fourth trigger did not exist: their writes waited for a
 * remount, a tab switch, or an `online` event.
 *
 * The outbox still does not talk to the network (see this file's header). It announces the queued
 * op the same way a targets change is announced, and SyncBootstrap does the pushing.
 */
describe("the queued-op signal", () => {
  // The app runs this in a browser; these tests run in node, where there is no event target. That
  // is the same reason the dispatch itself is optional-chained — so assert on the dispatch.
  const captureEvents = (): { types: string[]; restore: () => void } => {
    const types: string[] = [];
    const had = "dispatchEvent" in globalThis;
    const original = (globalThis as { dispatchEvent?: unknown }).dispatchEvent;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = (e: Event) => {
      types.push(e.type);
      return true;
    };
    return {
      types,
      restore: () => {
        if (had) (globalThis as { dispatchEvent?: unknown }).dispatchEvent = original;
        else delete (globalThis as { dispatchEvent?: unknown }).dispatchEvent;
      },
    };
  };

  it("announces a queued op so a sync can be scheduled", async () => {
    const captured = captureEvents();
    try {
      await enqueue(h, OP);
      expect(captured.types).toEqual([OUTBOX_QUEUED_EVENT]);
    } finally {
      captured.restore();
    }
  });

  it("announces one for a write that carries its mirror row too", async () => {
    const captured = captureEvents();
    try {
      await enqueueWithRow(h, { local_date: "2026-09-11", cups: 4 }, OP);
      expect(captured.types).toEqual([OUTBOX_QUEUED_EVENT]);
    } finally {
      captured.restore();
    }
  });
});

describe("enqueue", () => {
  it("queues an op and counts it as pending", async () => {
    const queued = await enqueue(h, OP, 5_000);
    expect(queued).toMatchObject({ seq: 1, next_attempt_at: 5_000, attempts: 0 });
    await expect(pendingCount(h)).resolves.toBe(1);
  });
  it("refuses an op whose entity_id does not match its payload's key", async () => {
    await expect(enqueue(h, { ...OP, entity_id: "2026-09-12" })).rejects.toThrow(/entity_id/);
  });
  it("accepts a delete whose payload carries no key columns", async () => {
    expect((await enqueue(h, { ...OP, kind: "delete", payload: {} }, 5_000)).kind).toBe("delete");
  });
});

const response = (results: OpResult[]): OpsResponse =>
  ({ results, server_time: "2026-09-11T10:00:05.000Z" });

/**
 * Grok pass 2, HIGH 2: the outbox store is keyed on `op_id`, so a repeat enqueue of the same op
 * replaces rather than duplicates — `drainOutbox` keys its results by op_id and two rows sharing
 * one would have the second silently unanswered. The repeat must also not reset the backoff the
 * first one has been earning, or a failing op jumps the queue every time it is re-offered.
 */
describe("enqueueing the same op twice", () => {
  it("leaves exactly one row", async () => {
    await enqueue(h, OP, 1_000);
    await enqueue(h, OP, 5_000);
    expect(await allOps(h)).toHaveLength(1);
  });

  it("keeps the first row's place in the queue and its attempt count", async () => {
    const first = await enqueue(h, OP, 1_000);
    await putOp(h, { ...first, attempts: 2, next_attempt_at: 9_000 });
    const again = await enqueue(h, OP, 5_000);
    expect(again.seq).toBe(first.seq);
    expect(again.attempts).toBe(2);
    expect(again.next_attempt_at).toBe(9_000);
  });

  it("still takes the newer payload", async () => {
    await enqueue(h, OP, 1_000);
    await enqueue(h, { ...OP, payload: { local_date: "2026-09-11", cups: 9 } }, 5_000);
    expect((await allOps(h))[0].payload).toEqual({ local_date: "2026-09-11", cups: 9 });
  });
});

describe("drainOutbox", () => {
  it("applies a result and bumps the local rev", async () => {
    await putRow(h, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 3, rev: 1 });
    await enqueue(h, OP, 1_000);
    const push: PushFn = async (ops) =>
      response([{ op_id: ops[0].op_id, status: "applied", rev: 2, seq: 17 }]);
    expect(await drainOutbox(h, push, () => 2_000)).toMatchObject({ pushed: 1, applied: 1, failed: false });
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toEqual({
      local_date: "2026-09-11", cups: 4, rev: 2,
    });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("merges a conflict, rebases and re-queues one op", async () => {
    await putRow(h, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 1 });
    await enqueue(h, OP, 1_000);
    const push: PushFn = async (ops) => response([{
      op_id: ops[0].op_id, status: "conflict", entity: "water_log", current_rev: 5,
      current: { local_date: "2026-09-11", cups: 7, rev: 5 },
    }]);
    expect(await drainOutbox(h, push, () => 2_000)).toMatchObject({ conflicts: 1, applied: 0 });
    const queued = await allOps(h);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ base_rev: 5 });
    expect(queued[0].payload).toMatchObject({ cups: 7 });
    expect(queued[0].op_id).not.toBe(OP.op_id);
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toMatchObject({ cups: 7, rev: 5 });
  });

  // The mirror holds the SERVER's row by the time a conflict comes back: syncOnce pulls before it
  // pushes, so pullChanges has already overwritten it. The op's payload is the only record of what
  // she meant, so it must win over the mirror when the local side is rebuilt.
  it("rebases on the op's intent, not on the server row pullChanges left in the mirror", async () => {
    await putRow(h, "plan_days", "2026-09-11", { local_date: "2026-09-11", floor_day: false, rev: 5 });
    const planOp: SyncOp = {
      op_id: "77777777-7777-4777-8777-777777777777", entity: "plan_days",
      entity_id: "2026-09-11", kind: "update", base_rev: 1,
      payload: { local_date: "2026-09-11", floor_day: true }, client_ts: "2026-09-11T10:00:00.000Z",
    };
    await enqueue(h, planOp, 1_000);
    await drainOutbox(h, async (ops) => response([{
      op_id: ops[0].op_id, status: "conflict", entity: "plan_days", current_rev: 5,
      current: {
        local_date: "2026-09-11", floor_day: false, rev: 5,
        updated_at: "2026-09-11T09:00:00.000Z",
      },
    }]), () => 2_000);
    const queued = await allOps(h);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ floor_day: true });
  });

  it("keeps both notes when the mirror already holds the server's note", async () => {
    const FOOD_REF = "88888888-8888-4888-8888-888888888888";
    await putRow(h, "user_food_prefs", FOOD_REF, {
      food_ref_id: FOOD_REF, note: "fine on 9/04", rev: 5,
    });
    const prefOp: SyncOp = {
      op_id: "99999999-9999-4999-8999-999999999999", entity: "user_food_prefs",
      entity_id: FOOD_REF, kind: "update", base_rev: 1,
      payload: { food_ref_id: FOOD_REF, note: "hurt on 9/12" },
      client_ts: "2026-09-11T10:00:00.000Z",
    };
    await enqueue(h, prefOp, 1_000);
    await drainOutbox(h, async (ops) => response([{
      op_id: ops[0].op_id, status: "conflict", entity: "user_food_prefs", current_rev: 5,
      current: {
        food_ref_id: FOOD_REF, note: "fine on 9/04", rev: 5,
        updated_at: "2026-09-11T09:00:00.000Z",
      },
    }]), () => 2_000);
    expect((await allOps(h))[0].payload.note).toBe("fine on 9/04\nhurt on 9/12");
  });

  it("strips the server-owned columns from the rebased payload", async () => {
    await putRow(h, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 1 });
    await enqueue(h, OP, 1_000);
    await drainOutbox(h, async (ops) => response([{
      op_id: ops[0].op_id, status: "conflict", entity: "water_log", current_rev: 5,
      current: {
        local_date: "2026-09-11", cups: 7, rev: 5, seq: 41, user_id: "u1",
        created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-11T09:00:00.000Z",
      },
    }]), () => 2_000);
    const payload = (await allOps(h))[0].payload;
    expect(Object.keys(payload).sort()).toEqual(["cups", "local_date"]);
  });

  it("drops the local row on 'deleted' and never resurrects it", async () => {
    await putRow(h, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 1 });
    await enqueue(h, OP, 1_000);
    await drainOutbox(h, async (ops) => response([{
      op_id: ops[0].op_id, status: "deleted", entity: "water_log",
      deleted_at: "2026-09-11T09:00:00.000Z",
    }]), () => 2_000);
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toBeUndefined();
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("drops the op on 'duplicate'", async () => {
    await enqueue(h, OP, 1_000);
    const result = await drainOutbox(h, 
      async (ops) => response([{ op_id: ops[0].op_id, status: "duplicate" }]), () => 2_000);
    expect(result.dropped).toBe(1);
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("re-queues an 'update' as a fresh create on 'gone', instead of dropping her edit", async () => {
    await enqueue(h, OP, 1_000);
    const result = await drainOutbox(h, 
      async (ops) => response([{ op_id: ops[0].op_id, status: "gone" }]), () => 2_000);
    expect(result.dropped).toBe(0);
    expect(result.errored).toBe(1);
    // Still in the outbox — pendingCount must stay > 0, or SyncStatus reports a false "everything
    // is sent" while her edit never reached the server.
    await expect(pendingCount(h)).resolves.toBe(1);
    const [requeued] = await allOps(h);
    expect(requeued).toMatchObject({
      op_id: OP.op_id, kind: "create", base_rev: null, payload: OP.payload,
    });
  });

  it("drops a 'delete' op on 'gone' and clears any local mirror row to match", async () => {
    const goneDeleteOp: SyncOp = {
      op_id: "22222222-2222-4222-8222-222222222222", entity: "water_log",
      entity_id: "2026-09-11", kind: "delete", base_rev: 1, payload: {},
      client_ts: "2026-09-11T10:00:00.000Z",
    };
    await putRow(h, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 1 });
    await enqueue(h, goneDeleteOp, 1_000);
    await drainOutbox(h, 
      async (ops) => response([{ op_id: ops[0].op_id, status: "gone" }]), () => 2_000);
    await expect(getRow(h, "water_log", "2026-09-11")).resolves.toBeUndefined();
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  const FOOD_ID = "44444444-4444-4444-8444-444444444444";
  const deleteFoodOp: SyncOp = {
    op_id: "55555555-5555-4555-8555-555555555555", entity: "user_foods", entity_id: FOOD_ID,
    kind: "delete", base_rev: 1, payload: {}, client_ts: "2026-09-11T10:00:00.000Z",
  };
  const restoreFoodOp: SyncOp = { ...deleteFoodOp, op_id: "66666666-6666-4666-8666-666666666666", kind: "restore" };

  it("applied + kind 'delete' tombstones the local row instead of merging the (empty) payload", async () => {
    await putRow(h, "user_foods", FOOD_ID, { id: FOOD_ID, name: "Rice", rev: 1, deleted_at: null });
    await enqueue(h, deleteFoodOp, 1_000);
    await drainOutbox(h, 
      async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 2, seq: 20 }]), () => 2_000);
    await expect(getRow(h, "user_foods", FOOD_ID)).resolves.toMatchObject({
      name: "Rice", rev: 2, deleted_at: expect.any(String),
    });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("applied + kind 'restore' clears the tombstone and keeps the row, when the row is here", async () => {
    await putRow(h, "user_foods", FOOD_ID, {
      id: FOOD_ID, name: "Rice", rev: 2, deleted_at: "2026-09-10T00:00:00.000Z",
    });
    await enqueue(h, restoreFoodOp, 1_000);
    await drainOutbox(h, 
      async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 3, seq: 21 }]), () => 2_000);
    await expect(getRow(h, "user_foods", FOOD_ID)).resolves.toMatchObject({
      name: "Rice", rev: 3, deleted_at: null,
    });
  });

  it("applied + kind 'restore' with no local row rolls the cursor back for a re-fetch", async () => {
    await setCursor(h, 25);
    await enqueue(h, restoreFoodOp, 1_000);
    await drainOutbox(h, 
      async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 3, seq: 21 }]), () => 2_000);
    await expect(getCursor(h)).resolves.toBe(20);
    await expect(getRow(h, "user_foods", FOOD_ID)).resolves.toBeUndefined();
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("drops the op and warns on 'unsupported'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await enqueue(h, OP, 1_000);
    const result = await drainOutbox(h, 
      async (ops) => response([{ op_id: ops[0].op_id, status: "unsupported" }]), () => 2_000);
    expect(result.dropped).toBe(1);
    expect(warn).toHaveBeenCalled();
    await expect(pendingCount(h)).resolves.toBe(0);
    warn.mockRestore();
  });

  it("retries an 'error' with backoff, then parks it after three attempts", async () => {
    await enqueue(h, OP, 1_000);
    const errorResult = async (ops: SyncOp[]) =>
      response([{ op_id: ops[0].op_id, status: "error" as const, message: "db is down" }]);
    const first = await drainOutbox(h, errorResult, () => 2_000);
    expect(first.errored).toBe(1);
    expect((await allOps(h))[0]).toMatchObject({ error_attempts: 1, next_attempt_at: 3_000 });
    await drainOutbox(h, errorResult, () => 3_000);
    const third = await drainOutbox(h, errorResult, () => 100_000);
    expect(third.errored).toBe(1);
    const parked = (await allOps(h))[0];
    expect(parked.error_attempts).toBe(3);
    expect(parked.next_attempt_at).toBeGreaterThan(100_000 + 300 * 24 * 60 * 60 * 1000);
    // parked, but still pending — SyncStatus's count must not silently drop it.
    await expect(pendingCount(h)).resolves.toBe(1);
    const spared = await drainOutbox(h, async () => { throw new Error("must not be called"); }, () => 200_000);
    expect(spared.pushed).toBe(0);
  });

  it("backs off and keeps the op when the push throws", async () => {
    await enqueue(h, OP, 1_000);
    const result = await drainOutbox(h, async () => { throw new Error("offline"); }, () => 2_000);
    expect(result).toMatchObject({ failed: true, retryAfterMs: 1_000 });
    expect((await allOps(h))[0]).toMatchObject({ attempts: 1, next_attempt_at: 3_000 });
  });

  it("skips an op that is still backing off", async () => {
    await enqueue(h, OP, 10_000);
    let calls = 0;
    const result = await drainOutbox(h, async () => { calls += 1; return response([]); }, () => 2_000);
    expect([calls, result.pushed]).toEqual([0, 0]);
    await expect(pendingCount(h)).resolves.toBe(1);
  });

  it("pushes at most 200 ops in one request, in queue order", async () => {
    for (let i = 0; i < 205; i += 1) {
      await enqueue(h, { ...OP, op_id: crypto.randomUUID(),
        payload: { local_date: "2026-09-11", cups: i } }, 1_000);
    }
    let seen: SyncOp[] = [];
    await drainOutbox(h, async (ops) => {
      seen = ops;
      return response(ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })));
    }, () => 2_000);
    expect(seen).toHaveLength(200);
    expect(seen[0].payload).toMatchObject({ cups: 0 });
    await expect(pendingCount(h)).resolves.toBe(5);
  });
  // Two offline drains used to spend the same counter the server-error cap reads, so one real
  // server error after a weekend on aeroplane mode parked the op for a year.
  it("keeps the transport and server-error counters apart", async () => {
    await enqueue(h, OP, 1_000);
    const offline: PushFn = async () => { throw new Error("offline"); };
    await drainOutbox(h, offline, () => 2_000);
    await drainOutbox(h, offline, () => 10_000);
    const third = await drainOutbox(h, async (ops) => response([
      { op_id: ops[0].op_id, status: "error" as const, message: "db is down" },
    ]), () => 100_000);
    expect(third.errored).toBe(1);
    const op = (await allOps(h))[0];
    expect(op).toMatchObject({ attempts: 2, error_attempts: 1 });
    expect(op.next_attempt_at).toBeLessThan(100_000 + 24 * 60 * 60 * 1000);
  });

  it("parks a 4xx push instead of retrying it forever", async () => {
    await enqueue(h, OP, 1_000);
    const push: PushFn = async () => { throw new SyncHttpError(400, "bad request"); };
    await drainOutbox(h, push, () => 2_000);
    expect((await allOps(h))[0]).toMatchObject({ error_attempts: 1, attempts: 0 });
    await drainOutbox(h, push, () => 10_000);
    expect((await drainOutbox(h, push, () => 100_000)).failed).toBe(true);
    const parked = (await allOps(h))[0];
    expect(parked.error_attempts).toBe(3);
    expect(parked.next_attempt_at).toBeGreaterThan(100_000 + 300 * 24 * 60 * 60 * 1000);
  });

  it("backs off a 5xx push the way it backs off a dead network", async () => {
    await enqueue(h, OP, 1_000);
    const result = await drainOutbox(h, async () => { throw new SyncHttpError(503, "down"); }, () => 2_000);
    expect(result).toMatchObject({ failed: true, retryAfterMs: 1_000 });
    expect((await allOps(h))[0]).toMatchObject({ attempts: 1, error_attempts: 0, next_attempt_at: 3_000 });
  });

  it("splits a batch that would exceed the body cap", async () => {
    const note = "x".repeat(100_000);
    for (let i = 0; i < 12; i += 1) {
      await enqueue(h, {
        ...OP, op_id: crypto.randomUUID(),
        payload: { local_date: "2026-09-11", cups: i, note },
      }, 1_000);
    }
    let seen: SyncOp[] = [];
    await drainOutbox(h, async (ops) => {
      seen = ops;
      return response(ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })));
    }, () => 2_000);
    expect(seen.length).toBeLessThan(12);
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify({ ops: seen }).length).toBeLessThanOrEqual(MAX_PUSH_BYTES);
  });

  // The body cap is a real HTTP byte limit ("The routes accept a 1 MB body" — outbox.ts), but the
  // batcher measured JS string .length, which counts UTF-16 code units, not UTF-8 bytes. A note in
  // Hiragana (or any script outside Latin-1) is 3 bytes per character on the wire but 1 unit of
  // .length, so a batch the batcher judged as comfortably under budget could actually be sent as a
  // request several times over the real cap — the exact "however big her notes got" case the
  // comment names.
  it("measures the body cap in real UTF-8 bytes, not UTF-16 length, for a multi-byte note", async () => {
    const note = "あ".repeat(200_000); // 200,000 UTF-16 units; 600,000 UTF-8 bytes
    for (let i = 0; i < 4; i += 1) {
      await enqueue(h, {
        ...OP, op_id: crypto.randomUUID(),
        payload: { local_date: "2026-09-11", cups: i, note },
      }, 1_000);
    }
    let seen: SyncOp[] = [];
    await drainOutbox(h, async (ops) => {
      seen = ops;
      return response(ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })));
    }, () => 2_000);
    const realBytes = new TextEncoder().encode(JSON.stringify({ ops: seen })).length;
    expect(realBytes).toBeLessThanOrEqual(MAX_PUSH_BYTES);
  });

  it("backs off an op the server returned no result for", async () => {
    await enqueue(h, OP, 1_000);
    const result = await drainOutbox(h, async () => response([]), () => 2_000);
    expect(result).toMatchObject({ failed: true, retryAfterMs: 1_000 });
    expect((await allOps(h))[0]).toMatchObject({ attempts: 1, next_attempt_at: 3_000 });
  });

  it("ignores a malformed entry in the results array", async () => {
    await enqueue(h, OP, 1_000);
    const result = await drainOutbox(h, 
      async () => response([null as unknown as OpResult]), () => 2_000);
    expect(result.failed).toBe(true);
    await expect(pendingCount(h)).resolves.toBe(1);
  });
});

describe("retryParked", () => {
  it("brings parked ops back and leaves the merely backing-off ones alone", async () => {
    await enqueue(h, OP, 1_000);
    const push: PushFn = async () => { throw new SyncHttpError(400, "bad request"); };
    await drainOutbox(h, push, () => 2_000);
    await drainOutbox(h, push, () => 10_000);
    await drainOutbox(h, push, () => 100_000);
    await enqueue(h, { ...OP, op_id: crypto.randomUUID() }, 200_000);

    await expect(retryParked(h, () => 200_000)).resolves.toBe(1);
    const [first] = await allOps(h);
    expect(first).toMatchObject({ attempts: 0, error_attempts: 0, next_attempt_at: 200_000 });
  });
});

describe("ops carry their owner (Phase 9 §0.5)", () => {
  it("hands every op to the push with user_id equal to the handle's account", async () => {
    await enqueue(h, OP, 1_000);
    await enqueue(h, { ...OP, op_id: crypto.randomUUID() }, 1_000);
    let sent: { user_id?: string }[] = [];
    await drainOutbox(h, async (ops) => { sent = ops; return response([]); }, () => 2_000);
    expect(sent).toHaveLength(2);
    expect(sent.every((o) => o.user_id === h.userId)).toBe(true);
  });

  it("keeps a note edit's base on this device: it never goes on the wire", async () => {
    const row = { local_date: "2026-09-11", cups: 4 };
    await enqueueWithRow(h, row, { ...OP, note_base: "felt fine" }, 1_000);
    let sent: Record<string, unknown>[] = [];
    await drainOutbox(h, async (ops) => { sent = ops; return response([]); }, () => 2_000);
    expect(sent).toHaveLength(1);
    expect("note_base" in sent[0]).toBe(false);
    expect((await allOps(h))[0].note_base).toBe("felt fine");
  });

  it("an account_unbound error parks the op and never deletes it (what an old build does)", async () => {
    await enqueue(h, OP, 1_000);
    for (let i = 0; i < 5; i += 1) {
      const [queued] = await allOps(h);
      await drainOutbox(h, async () => response([
        { op_id: queued.op_id, status: "error", message: "account_unbound" },
      ]), () => queued.next_attempt_at);
    }
    const [kept] = await allOps(h);
    expect(kept.op_id).toBe(OP.op_id);
    expect(kept.next_attempt_at).toBeGreaterThan(300 * 24 * 3600 * 1000);
  });
});
