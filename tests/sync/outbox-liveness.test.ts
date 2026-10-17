/**
 * W026 (audit 2026-10-10 F15: A079, A076, A074, A137, P09): the outbox's order and liveness.
 *
 * - A row's ops go in queue order: a delete never overtakes a create that is backing off.
 * - A whole-batch refusal charges no op: a lapsed session backs off, a body refusal is split down
 *   to the one op it belongs to.
 * - A conflict rebase is one transaction: a failure part way leaves exactly one op.
 * - A database hiccup never parks an op, and a park is released when another server build answers.
 * - A restore answered with seq 0 never moves the cursor below 0.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getCursor, getRow, putRow, setCursor, type OutboxOp } from "@/lib/sync/idb";
import { SyncHttpError } from "@/lib/sync/client";
import { drainOutbox, enqueue, enqueueWithRow, type PushFn } from "@/lib/sync/outbox";
import { serverTimestampOf } from "@/lib/sync/outbox-conflict";
import type { OpResult, OpsResponse, SyncOp } from "@/lib/sync/types";
import { resetTestAccount } from "@/tests/helpers/account";
import { FakeSyncServer } from "@/tests/helpers/fake-sync-server";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;
const DAY = 24 * 60 * 60 * 1000;
const REF = "0b0c3a52-1d5e-4b7c-8a0f-2f3e4d5c6b7a";

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  vi.spyOn(Math, "random").mockReturnValue(1);
});
afterEach(() => { vi.restoreAllMocks(); });

const response = (results: OpResult[], build?: string): OpsResponse =>
  ({ results, server_time: "2026-10-11T00:00:00.000Z", ...(build ? { server_build: build } : {}) });

function water(day: string, cups: number, over: Partial<SyncOp> = {}): SyncOp {
  return { op_id: crypto.randomUUID(), entity: "water_log", entity_id: day, kind: "update",
    base_rev: 1, payload: { local_date: day, cups }, client_ts: "2026-10-11T08:00:00.000Z", ...over };
}

const applyAll: PushFn = async (ops) =>
  response(ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })));

describe("per-row order (A079)", () => {
  it("never sends a delete ahead of a create that is backing off, so the row is not resurrected", async () => {
    const server = new FakeSyncServer();
    const create: SyncOp = { op_id: crypto.randomUUID(), entity: "favorites_foods", entity_id: REF,
      kind: "create", base_rev: null, payload: { food_ref_id: REF, sort: 1 },
      client_ts: "2026-10-11T08:00:00.000Z" };
    await enqueueWithRow(h, { food_ref_id: REF, sort: 1 }, create, 1_000);

    // The create meets a transient server error and backs off.
    const sent: SyncOp[][] = [];
    const flaky: PushFn = async (ops) => {
      sent.push(ops);
      return response(ops.map((o) => ({ op_id: o.op_id, status: "error" as const, message: "blip" })));
    };
    await drainOutbox(h, flaky, () => 2_000);
    const [backingOff] = await allOps(h);
    expect(backingOff.next_attempt_at).toBeGreaterThan(2_000);

    // The user unstars it inside the backoff window.
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "favorites_foods", entity_id: REF,
      kind: "delete", base_rev: 1, payload: {}, client_ts: "2026-10-11T08:00:01.000Z" }, 2_500);
    const real: PushFn = async (ops) => {
      sent.push(ops);
      return response(ops.map((o) => server.apply(o)));
    };
    const early = await drainOutbox(h, real, () => 2_600);
    expect(early.pushed).toBe(0); // the delete waits behind its create

    await drainOutbox(h, real, () => backingOff.next_attempt_at);
    await drainOutbox(h, real, () => backingOff.next_attempt_at + 1);
    expect(sent.slice(1).map((ops) => ops.map((o) => o.kind))).toEqual([["create"], ["delete"]]);
    expect(server.row("favorites_foods", REF)?.deleted_at).toBeTruthy();
    await expect(allOps(h)).resolves.toEqual([]);
    expect((await getRow(h, "favorites_foods", REF))?.deleted_at).toBeTruthy();
  });
});

describe("a whole-batch refusal (A076)", () => {
  it("charges no op when the session lapsed (401), however many passes meet it", async () => {
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-03"]) await enqueue(h, water(day, 3), 1_000);
    const lapsed: PushFn = async () => { throw new SyncHttpError(401, "unauthorized"); };
    for (let pass = 0; pass < 5; pass += 1) {
      const next = Math.max(...(await allOps(h)).map((o) => o.next_attempt_at));
      expect((await drainOutbox(h, lapsed, () => next)).failed).toBe(true);
    }
    for (const op of await allOps(h)) {
      expect(op.error_attempts).toBe(0);
      expect(op.attempts).toBe(5);
      expect(op.next_attempt_at).toBeLessThan(10 * 60_000);
    }
  });

  it.each([403, 404, 405])("charges no op for a %i on the whole request", async (status) => {
    await enqueue(h, water("2026-10-01", 3), 1_000);
    await drainOutbox(h, async () => { throw new SyncHttpError(status, "refused"); }, () => 2_000);
    expect((await allOps(h))[0]).toMatchObject({ error_attempts: 0, attempts: 1 });
  });

  it("splits a 400 down to the one op the route refused, and sends the others", async () => {
    const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];
    for (const day of days) await enqueue(h, water(day, 3), 1_000);
    const bad = (await allOps(h))[3].op_id;
    const requests: number[] = [];
    const strict: PushFn = async (ops) => {
      requests.push(ops.length);
      if (ops.some((o) => o.op_id === bad)) throw new SyncHttpError(400, "bad request");
      return applyAll(ops);
    };
    const result = await drainOutbox(h, strict, () => 2_000);
    expect(result).toMatchObject({ applied: 4, errored: 1, failed: true });
    const left = await allOps(h);
    expect(left.map((o) => o.op_id)).toEqual([bad]);
    expect(left[0]).toMatchObject({ error_attempts: 1, attempts: 0 });
    expect(requests.length).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(days.length)) + 1);
  });

  it("charges nothing when a split half later meets a dead network", async () => {
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
      await enqueue(h, water(day, 3), 1_000);
    }
    let calls = 0;
    const push: PushFn = async () => {
      calls += 1;
      if (calls === 1) throw new SyncHttpError(400, "bad request");
      throw new Error("offline");
    };
    await drainOutbox(h, push, () => 2_000);
    for (const op of await allOps(h)) expect(op).toMatchObject({ error_attempts: 0, attempts: 1 });
  });
});

describe("a conflict rebase is one transaction (A074)", () => {
  it("leaves exactly the refused op when the rebase write fails part way", async () => {
    const op = water("2026-10-01", 5);
    await enqueueWithRow(h, { local_date: "2026-10-01", cups: 5, rev: 1 }, op, 1_000);
    // The write that lands the rebased op fails after the refused op's delete in the same
    // transaction: a crash between the two steps.
    const store = IDBObjectStore.prototype;
    const put = store.put;
    vi.spyOn(store, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const row = value as Partial<OutboxOp>;
      if (this.name === "outbox" && row.op_id && row.op_id !== op.op_id) {
        throw new DOMException("crash", "UnknownError");
      }
      return put.call(this, value, key);
    });
    await expect(drainOutbox(h, async (ops) => response([{ op_id: ops[0].op_id, status: "conflict",
      entity: "water_log", current_rev: 3, current: { local_date: "2026-10-01", cups: 2, rev: 3 } }]),
    () => 2_000)).rejects.toThrow();
    vi.mocked(store.put).mockRestore();
    const left = await allOps(h);
    expect(left.map((o) => o.op_id)).toEqual([op.op_id]);
    expect(left[0].payload).toMatchObject({ cups: 5 });
  });
});

describe("liveness of parked ops (A137)", () => {
  const erroring = (retryable: boolean, build?: string): PushFn => async (ops) =>
    response(ops.map((o) => ({ op_id: o.op_id, status: "error" as const, message: "db",
      ...(retryable ? { retryable: true } : {}) })), build);

  it("never parks an op for a database hiccup the server marks retryable", async () => {
    await enqueue(h, water("2026-10-01", 3), 1_000);
    for (let pass = 0; pass < 6; pass += 1) {
      const [op] = await allOps(h);
      await drainOutbox(h, erroring(true), () => op.next_attempt_at);
    }
    const [op] = await allOps(h);
    expect(op).toMatchObject({ error_attempts: 0, attempts: 6 });
    expect(op.next_attempt_at).toBeLessThan(DAY);
  });

  it("releases an op parked under one server build when another build answers", async () => {
    await enqueue(h, water("2026-10-01", 3), 1_000);
    await enqueue(h, water("2026-10-02", 3), 1_000);
    const [first] = await allOps(h);
    // Park the first under build A (three refusals), with the second applied alongside.
    for (let pass = 0; pass < 3; pass += 1) {
      const [op] = (await allOps(h)).filter((o) => o.op_id === first.op_id);
      await drainOutbox(h, async (ops) => response(ops.map((o) => o.op_id === first.op_id
        ? { op_id: o.op_id, status: "error" as const, message: "bug" }
        : { op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 }), "build-a"),
      () => op.next_attempt_at);
    }
    const [parked] = await allOps(h);
    expect(parked).toMatchObject({ error_attempts: 3, parked_build: "build-a" });
    expect(parked.next_attempt_at).toBeGreaterThan(300 * DAY);

    // Build A answers again (another op): nothing changes for the parked one.
    await enqueue(h, water("2026-10-03", 3), 10_000);
    await drainOutbox(h, async (ops) => response(ops.map((o) =>
      ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })), "build-a"), () => 20_000);
    expect((await allOps(h))[0].next_attempt_at).toBeGreaterThan(300 * DAY);

    // The fix deploys: build B answers, and the parked op is due again with a fresh budget.
    await enqueue(h, water("2026-10-04", 3), 30_000);
    await drainOutbox(h, async (ops) => response(ops.map((o) =>
      ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })), "build-b"), () => 40_000);
    const [released] = await allOps(h);
    expect(released).toMatchObject({ op_id: first.op_id, error_attempts: 0, attempts: 0,
      next_attempt_at: 40_000 });
    expect(released.parked_build).toBeUndefined();
    const sent: string[] = [];
    await drainOutbox(h, async (ops) => { sent.push(...ops.map((o) => o.op_id)); return applyAll(ops); },
      () => 40_001);
    expect(sent).toEqual([first.op_id]);
  });

  it("releases an op parked before builds were recorded, once a build answers", async () => {
    await enqueue(h, water("2026-10-01", 3), 1_000);
    for (let pass = 0; pass < 3; pass += 1) {
      const [op] = await allOps(h);
      await drainOutbox(h, erroring(false), () => op.next_attempt_at);
    }
    expect((await allOps(h))[0].parked_build).toBeNull();
    await enqueue(h, water("2026-10-02", 3), 50_000);
    await drainOutbox(h, async (ops) => response(ops.map((o) =>
      ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })), "build-a"), () => 60_000);
    expect((await allOps(h))[0]).toMatchObject({ error_attempts: 0, next_attempt_at: 60_000 });
  });

  it("leaves a settings op held for its baseline alone (it spent no error budget)", async () => {
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "update", base_rev: 4, payload: { height_cm: 170 }, client_ts: "2026-10-11T08:00:00.000Z" },
    1_000);
    await enqueue(h, water("2026-10-02", 3), 1_000);
    await drainOutbox(h, async (ops) => response(ops.map((o) =>
      ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })), "build-a"), () => 2_000);
    const [held] = await allOps(h);
    expect(held.entity).toBe("user_settings");
    expect(held.next_attempt_at).toBeGreaterThan(300 * DAY);
  });
});

describe("a restore answered with seq 0 (P09)", () => {
  it("keeps the cursor where it is instead of moving it to -1", async () => {
    await setCursor(h, 0);
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "favorites_foods", entity_id: REF,
      kind: "restore", base_rev: 1, payload: {}, client_ts: "2026-10-11T08:00:00.000Z" }, 1_000);
    await drainOutbox(h, async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 1, seq: 0 }]),
      () => 2_000);
    await expect(getCursor(h)).resolves.toBe(0);
    await expect(allOps(h)).resolves.toEqual([]);
  });

  it("still rewinds to just before a logged change", async () => {
    await setCursor(h, 40);
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "favorites_foods", entity_id: REF,
      kind: "restore", base_rev: 1, payload: {}, client_ts: "2026-10-11T08:00:00.000Z" }, 1_000);
    await drainOutbox(h, async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 1, seq: 12 }]),
      () => 2_000);
    await expect(getCursor(h)).resolves.toBe(11);
  });
});

describe("the conflict's own timestamp (B234)", () => {
  it("serverTimestampOf reads the answer's `at` before any column of the row", () => {
    const row = { updated_at: "2026-10-11T09:00:00.000Z" };
    expect(serverTimestampOf(row, "fallback", "2026-10-11T07:00:00.000Z")).toBe("2026-10-11T07:00:00.000Z");
    expect(serverTimestampOf(row, "fallback", "not a time")).toBe("2026-10-11T09:00:00.000Z");
    expect(serverTimestampOf({}, "fallback")).toBe("fallback");
  });

  it("lets an edit made after the server's write win a field, where `now` used to hand it to the server", async () => {
    const op = water("2026-10-01", 2, { payload: { local_date: "2026-10-01", cups: 2, goal_cups: 12 },
      client_ts: "2026-10-11T08:00:00.000Z" });
    await putRow(h, "water_log", "2026-10-01", { local_date: "2026-10-01", cups: 2, goal_cups: 12, rev: 1 });
    await enqueue(h, op, 1_000);
    const conflict = (at?: string): PushFn => async (ops) => response([{ op_id: ops[0].op_id,
      status: "conflict", entity: "water_log", current_rev: 2, ...(at ? { at } : {}),
      current: { local_date: "2026-10-01", cups: 1, goal_cups: 8, rev: 2 } }]);
    await drainOutbox(h, conflict("2026-10-11T07:00:00.000Z"), () => Date.parse("2026-10-11T10:00:00.000Z"));
    const [rebased] = await allOps(h);
    expect(rebased.payload).toMatchObject({ goal_cups: 12, cups: 2 });
    expect(rebased.base_rev).toBe(2);
  });
});
