// @vitest-environment jsdom
/**
 * Followups #18: the phone's batching queue for `POST /api/onboarding/events`. Queuing never posts
 * synchronously and never throws; a flush posts in batches of at most 20, oldest first; a failed
 * post drops its batch rather than retrying or blocking the caller.
 *
 * WARN fix: every queued event is bound to the account that was current when it was queued, so a
 * device that queues as account A and then switches to account B before flushing never sends A's
 * events as B's telemetry — the switch clears them instead.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHandle } from "@/lib/device/account";
import { resetTestAccount, TEST_USER } from "@/tests/helpers/account";

const {
  queueOnboardingEvent, flushOnboardingEvents, queuedOnboardingEvents, clearOnboardingEventQueue,
} = await import("@/lib/profile/onboarding-events-client");

let h: AccountHandle;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  h = await resetTestAccount();
  clearOnboardingEventQueue();
});
afterEach(() => { clearOnboardingEventQueue(); });

const json = (status: number, body: unknown = {}) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("queueOnboardingEvent", () => {
  it("buffers the event with a fresh clientEventId and never posts synchronously", () => {
    const fetchImpl = vi.fn();
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const queued = queuedOnboardingEvents();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "step_entered", step: "facts", flowVersion: "onboarding_v2" });
    expect(queued[0].clientEventId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("mints a distinct clientEventId per call, even for the same logical event", () => {
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    const [a, b] = queuedOnboardingEvents();
    expect(a.clientEventId).not.toBe(b.clientEventId);
  });
});

describe("flushOnboardingEvents", () => {
  it("posts the queued batch and empties the queue on success", async () => {
    queueOnboardingEvent({ kind: "step_entered", step: "intro" });
    queueOnboardingEvent({ kind: "step_left", step: "intro", durationMs: 1200 });
    const fetchImpl = vi.fn(json(202, { accepted: 2, rejected: 0 }));
    await flushOnboardingEvents({ account: h, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/onboarding/events");
    const sent = JSON.parse(String(init.body)) as { events: unknown[] };
    expect(sent.events).toHaveLength(2);
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });

  it("splits more than 20 queued events into batches of at most 20", async () => {
    for (let i = 0; i < 25; i += 1) queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    const fetchImpl = vi.fn(json(202, { accepted: 20, rejected: 0 }));
    await flushOnboardingEvents({ account: h, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sizes = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map(([, init]) =>
      (JSON.parse(String(init.body)) as { events: unknown[] }).events.length);
    expect(sizes).toEqual([20, 5]);
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });

  it("drops the batch on a network failure without throwing or re-queuing it", async () => {
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    const fetchImpl = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(flushOnboardingEvents({ account: h, fetchImpl })).resolves.toBeUndefined();
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });

  it("drops the batch on a 4xx/5xx without throwing", async () => {
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    const fetchImpl = vi.fn(json(500));
    await expect(flushOnboardingEvents({ account: h, fetchImpl })).resolves.toBeUndefined();
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });

  it("an empty queue is a no-op", async () => {
    const fetchImpl = vi.fn();
    await flushOnboardingEvents({ account: h, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("concurrent flushes chain rather than race: both calls see the queue drained once", async () => {
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    queueOnboardingEvent({ kind: "step_left", step: "facts", durationMs: 500 });
    const fetchImpl = vi.fn(json(202, { accepted: 1, rejected: 0 }));
    const [first, second] = [
      flushOnboardingEvents({ account: h, fetchImpl }),
      flushOnboardingEvents({ account: h, fetchImpl }),
    ];
    await Promise.all([first, second]);
    // Two queued events, batched together on the first pass (the second finds nothing left).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });
});

describe("account binding (WARN fix)", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";

  it("never sends account A's queued events as account B: flushing under a different handle drops them, unsent", async () => {
    queueOnboardingEvent({ kind: "step_entered", step: "facts" }); // queued while bound as TEST_USER
    const fetchImpl = vi.fn(json(202, { accepted: 0, rejected: 0 }));
    const other: AccountHandle = { userId: OTHER, epoch: h.epoch + 1 };
    await flushOnboardingEvents({ account: other, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });

  it("switching the bound account clears whatever account A left queued", async () => {
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    expect(queuedOnboardingEvents()).toHaveLength(1);
    await resetTestAccount(OTHER);
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });

  it("a flush under the SAME account that queued it still sends normally", async () => {
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    const fetchImpl = vi.fn(json(202, { accepted: 1, rejected: 0 }));
    await flushOnboardingEvents({ account: h, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(queuedOnboardingEvents()).toHaveLength(0);
  });

  it("an event queued with no account bound is dropped, not attributed to whoever binds next", async () => {
    const { unbindAccount } = await import("@/lib/device/account");
    unbindAccount();
    queueOnboardingEvent({ kind: "step_entered", step: "facts" });
    expect(queuedOnboardingEvents()).toHaveLength(0);
    await resetTestAccount(TEST_USER); // restore for other tests / afterEach
  });
});
