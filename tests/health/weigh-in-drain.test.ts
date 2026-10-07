/**
 * T8 §2, the drain doing its job: `components/SyncBootstrap.tsx` emptying the pending list after a
 * successful sync, one batch at a time.
 *
 * What is here is one drain on its own — what it sends, what it keeps, what it does with an answer,
 * and what happens when no answer comes. Two things happening at once — a save overlapping a drain,
 * an account changing under one, two tabs writing the same list — is
 * tests/health/weigh-in-races.test.ts. The doubles both files run on are
 * tests/health/weigh-in-harness.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWeighInDrain, drainWeighIns, readPendingWeighIns, saveWeighIn,
} from "@/lib/health/weigh-in-client";
import {
  account, bodies, fail, offline, ok, resetWeighInWorld, TZ, USER_A,
} from "./weigh-in-harness";

beforeEach(resetWeighInWorld);

describe("the drain", () => {
  /**
   * The zone is part of what she typed, not a property of the phone at posting time: it is what
   * turns a local date into 07:00 of THAT morning. Typed in Los Angeles, drained after she lands in
   * Denver, it must still stamp the Los Angeles morning.
   */
  it("posts the zone the weigh-in was saved with, not the one the phone is in now", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: "America/Los_Angeles" });

    const moved = vi.fn(async () => ok());
    await drainWeighIns(account(), { fetchImpl: moved, tz: "America/Denver" });
    expect(bodies(moved)).toEqual([{ localDate: "2026-09-17", lb: 170, tz: "America/Los_Angeles" }]);
  });

  /**
   * Only the route's own 422 is final. A 400 can come from something that never reached the route —
   * a proxy, a captive portal, an HTML error page — and treating that as "the server will never
   * accept this" deleted the only copy of a weigh-in over a network fault.
   */
  it("keeps a weigh-in a 400 refused, and sends it when the route answers properly", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    const proxy = vi.fn(async () => new Response("<html>Bad Request</html>",
      { status: 400, headers: { "content-type": "text/html" } }));
    expect(await drainWeighIns(account(), { fetchImpl: proxy })).toEqual({ posted: 0, pending: 1 });
    expect(await readPendingWeighIns(account())).toHaveLength(1);

    __resetWeighInDrain();
    const route = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: route })).toEqual({ posted: 1, pending: 0 });
    expect(bodies(route)).toEqual([{ localDate: "2026-09-17", lb: 170, tz: TZ }]);
  });

  it("drains after the next successful sync, and the sync after that posts nothing", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    const online = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: online })).toEqual({ posted: 1, pending: 0 });
    expect(online).toHaveBeenCalledTimes(1);
    expect(await readPendingWeighIns(account())).toEqual([]);

    __resetWeighInDrain();
    expect(await drainWeighIns(account(), { fetchImpl: online })).toEqual({ posted: 0, pending: 0 });
    expect(online).toHaveBeenCalledTimes(1);
  });

  it("keeps a day the drain could not post, and drops one the server refuses", async () => {
    await saveWeighIn("2026-09-16", 10, { fetchImpl: offline(), tz: TZ });
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    const mixed = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) =>
      JSON.parse(String(init?.body)).lb === 10 ? fail(422) : fail(500));
    expect(await drainWeighIns(account(), { fetchImpl: mixed })).toEqual({ posted: 0, pending: 1 });
    expect(await readPendingWeighIns(account())).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 170, tz: TZ } }]);
  });

  it("runs one drain at a time, however many syncs land together", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const slow = vi.fn(async () => { await parked; return ok(); });

    const first = drainWeighIns(account(), { fetchImpl: slow });
    await Promise.resolve();
    const second = drainWeighIns(account(), { fetchImpl: slow });
    release();
    expect(await first).toEqual({ posted: 1, pending: 0 });
    expect(await second).toEqual({ posted: 1, pending: 0 });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  /**
   * The drain settles the RECORD it posted, not the day it belongs to. She can type a correction
   * while the batch is in the air, and a settle by date alone would delete that newer record
   * without ever having sent it — the correction would vanish on both sides.
   */
  it("keeps a correction queued while the batch was in flight, and posts it next", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const slow = vi.fn(async () => { await parked; return ok(); });

    const draining = drainWeighIns(account(), { fetchImpl: slow });
    await Promise.resolve();
    await saveWeighIn("2026-09-17", 171, { fetchImpl: offline(), tz: TZ });
    release();
    await draining;

    expect(await readPendingWeighIns(account())).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 171, tz: TZ } }]);

    __resetWeighInDrain();
    const next = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: next })).toEqual({ posted: 1, pending: 0 });
    expect(bodies(next)).toEqual([{ localDate: "2026-09-17", lb: 171, tz: TZ }]);
  });
});

/**
 * A request that never answers is not the same as one that fails: nothing rejects, so without a
 * deadline the drain's promise never settles, and because every later caller JOINS the run already
 * going, one hung POST took the drain out for the life of the page — every sync after it a no-op.
 */
describe("a drain whose request never answers", () => {
  /**
   * Only `setTimeout` is faked. `fake-indexeddb` runs its own requests on the event loop, so faking
   * everything freezes the pending list itself and nothing in this file can reach the drain at all.
   */
  const withFrozenClock = async (run: () => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  };

  /**
   * The drain makes several IndexedDB round trips before it reaches the POST, and those run on the
   * real event loop (`setImmediate`, which is not faked). Advancing the clock before the request is
   * out would fire nothing, so wait for it first.
   */
  const untilRequested = async (f: { mock: { calls: unknown[] } }) => {
    for (let turn = 0; turn < 200 && f.mock.calls.length === 0; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(f.mock.calls.length).toBeGreaterThan(0);
  };

  /** Never answers, and never rejects — the case a transport that ignores its signal produces. */
  const hungFetch = () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>(() => {});
    });
    return { fetchImpl, signals };
  };

  it("gives up on the deadline, aborts the request, and leaves the weigh-in parked", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });
    const hung = hungFetch();

    await withFrozenClock(async () => {
      const draining = drainWeighIns(account(), { fetchImpl: hung.fetchImpl, timeoutMs: 10_000 });
      await untilRequested(hung.fetchImpl);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await draining).toEqual({ posted: 0, pending: 1 });
    });

    expect(hung.signals[0]?.aborted).toBe(true);
    expect(await readPendingWeighIns(account())).toHaveLength(1);
  });

  it("lets the next sync start a fresh drain instead of joining the stuck one", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });
    const hung = hungFetch();

    await withFrozenClock(async () => {
      const first = drainWeighIns(account(), { fetchImpl: hung.fetchImpl, timeoutMs: 10_000 });
      await untilRequested(hung.fetchImpl);
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
    });

    // No __resetWeighInDrain(): the run must have taken itself off the map on its own.
    const online = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: online })).toEqual({ posted: 1, pending: 0 });
    expect(bodies(online)).toEqual([{ localDate: "2026-09-17", lb: 170, tz: TZ }]);
  });
});
