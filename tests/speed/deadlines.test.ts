/**
 * T0 §2 / AC2 — every client fetch in the five capture-and-coach clients runs through
 * `fetchWithDeadline`, and a server that never answers reaches her as that surface's own copy
 * within its budget rather than as a spinner she has to kill the app to escape.
 *
 * The stub here is the AC's stub: a 60 s server. Fake timers make "within budget" exact.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureMedia, captureText } from "@/lib/capture-client";
import { scanGtin, ScanUnavailable } from "@/lib/barcode/client";
import { commitLogEntry } from "@/lib/log-commit-client";
import { CoachError, postTurn } from "@/lib/coach-client";
import { getFoodDetail, searchFoods } from "@/lib/catalog-client";
import { DEADLINES } from "@/lib/fetch-with-deadline";
import { allOps } from "@/lib/sync/idb";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

// The outbox and IndexedDB are REAL here (fake-indexeddb), because the commit path's whole
// failure behaviour is "queue it", and a stubbed outbox cannot show that it settles in time.
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    auth: { getClaims: async () => ({ data: null }) },
  }),
}));

const SIXTY_SECONDS = 60_000;

/** A server that answers in a minute — which is to say, never, from a phone's point of view. */
function slowServer(): typeof fetch {
  return vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response("{}", { status: 200 })), SIXTY_SECONDS);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  })) as unknown as typeof fetch;
}

/** Run `work`, let exactly `ms` of fake time pass, and hand back whatever it settled to. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  const settled = work.then((v) => v, (e: unknown) => e as T);
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

const CTX = { localDate: "2026-09-17", tz: "America/New_York", slot: "meal-2" as const };

const COMMIT = {
  entry_id: "11111111-1111-4111-8111-111111111111",
  eaten_at: "2026-09-17T12:00:00.000Z", tz: "America/New_York", local_date: "2026-09-17",
  slot: "meal-2" as const, method: "search" as const,
  items: [{ id: "22222222-2222-4222-8222-222222222222", seq: 1,
    food_ref_id: "33333333-3333-4333-8333-333333333333", qty: 1, unit: "g", grams: 100 }],
};

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  // `setImmediate` stays real: fake-indexeddb drives its own transactions on it, and faking it
  // would deadlock every IndexedDB read this path makes before it ever reaches the deadline.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Let fake-indexeddb's real-setImmediate queue drain. */
async function flushImmediates(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

describe("lib/capture-client.ts", () => {
  it("gives up on propose at 25 s and points her at search", async () => {
    const out = await within(DEADLINES.propose,
      captureText("two eggs", { ...CTX, fetchFn: slowServer() }));
    expect(out).toEqual({ kind: "error", status: 0, message: "Capture is resting, try search" });
  });

  it("gives up on the signing call at 5 s", async () => {
    const out = await within(DEADLINES.sign,
      captureMedia("label", new Blob(["x"], { type: "image/jpeg" }), { ...CTX, fetchFn: slowServer() }));
    expect(out).toMatchObject({ kind: "error", message: "Capture is resting, try search" });
  });

  it("gives up on the upload at 20 s, and says it was the upload", async () => {
    const fetchFn = vi.fn((input: unknown, init?: RequestInit) => {
      if (String(input) === "/api/media/sign") {
        return Promise.resolve(new Response(JSON.stringify({
          path: "media/u1/a.jpg", uploadUrl: "https://s.test/u", expiresInSeconds: 60,
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return new Promise<Response>((_r, rej) =>
        init?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError"))));
    }) as unknown as typeof fetch;
    const out = await within(DEADLINES.upload,
      captureMedia("photo", new Blob(["x"], { type: "image/jpeg" }), { ...CTX, fetchFn }));
    expect(out).toMatchObject({ kind: "error", message: "The upload did not finish. Try again." });
  });
});

describe("lib/barcode/client.ts", () => {
  it("gives up on a scan at 8 s, which is the sheet's offline-cache path", async () => {
    const out = await within(DEADLINES.barcode,
      scanGtin({ gtin: "04006381333931" }, { fetchImpl: slowServer() }));
    expect(out).toBeInstanceOf(ScanUnavailable);
  });
});

describe("lib/log-commit-client.ts", () => {
  it("gives up on a commit at 10 s and keeps it in the outbox", async () => {
    const settled = commitLogEntry(COMMIT, { fetchImpl: slowServer() })
      .then((v) => v, (e: unknown) => e);
    await flushImmediates();
    await vi.advanceTimersByTimeAsync(DEADLINES.commit);
    await flushImmediates();
    expect(await settled).toEqual({ status: "queued" });
  });

  /**
   * The panel's AC2 reproduction, with the real outbox behind it: a server that answers only by
   * rejecting when it is aborted. Nothing on this path may wait on anything but the deadline.
   */
  it("settles inside the budget against a server that only answers the abort", async () => {
    const never = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
    })) as unknown as typeof fetch;

    let done = false;
    const p = commitLogEntry(COMMIT, { fetchImpl: never }).then((v) => { done = true; return v; });
    // Real setImmediate turns on both sides of the clock: before it, so the local-first mirror
    // write finishes and the request is actually in flight when the deadline is armed; after it,
    // so the outbox write the timeout path makes can finish too. Both are IndexedDB, and neither
    // is what the commit budget measures — the budget is the wait on the server.
    await flushImmediates();
    await vi.advanceTimersByTimeAsync(DEADLINES.commit + 1_000);
    await flushImmediates();
    expect(done).toBe(true);
    expect(await p).toEqual({ status: "queued" });

    // And "queued" is not a convenient word: the op is there, exactly one of it, ready to drain.
    expect((await allOps(h)).filter((o) => o.entity_id === COMMIT.entry_id)).toHaveLength(1);
  });
});

describe("lib/coach-client.ts", () => {
  it("gives up on a turn at 40 s as a retryable coach error", async () => {
    const out = await within(DEADLINES.coach, postTurn(
      { threadId: null, messageId: "44444444-4444-4444-8444-444444444444", text: "hi" },
      { fetchImpl: slowServer() }));
    expect(out).toBeInstanceOf(CoachError);
    // 503 is the status CoachChat already reads as "retryable" — the Retry button appears.
    expect(out).toMatchObject({ status: 503, code: "timeout" });
  });
});

describe("lib/catalog-client.ts", () => {
  it("gives up on search at 6 s and falls back to the bundled food list", async () => {
    const out = await within(DEADLINES.search, searchFoods("rice", { fetchImpl: slowServer() }));
    expect(out).toMatchObject({ kind: "offline", reason: "network" });
  });

  it("gives up on a food detail at 6 s and blocks rather than logging a zeroed item", async () => {
    const out = await within(DEADLINES.search, getFoodDetail(12, { fetchImpl: slowServer() }));
    expect(out).toEqual({ kind: "blocked" });
  });
});
