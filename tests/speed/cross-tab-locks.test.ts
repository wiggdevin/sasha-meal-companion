/**
 * Two tabs of this PWA share IndexedDB — the outbox, the mirror, the pending records — and share
 * nothing else. A module-level map of live commits is therefore invisible to the other tab, so
 * tab B's drain saw no live commit while tab A's POST was open and settled the same entry from the
 * other side: the round-15 race, restored across tabs (Grok pass 8, HIGH 1).
 *
 * The boundary that does cross a tab is the Web Locks API, which `lib/health/weigh-in-client.ts`
 * already uses for the parked weigh-ins. Node has none, so the other tab is a stub here — the same
 * shape the browser gives, with a set of names "another tab" is holding.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogCommitRequest } from "@/lib/log/contract";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const DATE = "2026-11-02";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";

const REQ: LogCommitRequest = {
  entry_id: ENTRY_ID, eaten_at: "2026-11-02T17:00:00.000Z", tz: "UTC", local_date: DATE,
  slot: "meal-2", method: "search",
  items: [{ id: ITEM_ID, seq: 1, food_ref_id: "cccccccc-3333-4333-8333-333333333333",
    qty: 1, unit: "g", grams: 100 }],
};

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  }),
}));

/**
 * A LockManager shaped like the browser's, queue and all: a plain request WAITS for its turn, an
 * `ifAvailable` one is told `null` at once. `hold` is another tab taking a name.
 */
const held = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

/** When true the manager takes every question and never answers — a wedged lock service. */
let silent = false;

function release(name: string): void {
  held.delete(name);
  const next = waiting.get(name)?.shift();
  if (next) next();
}

/** Another tab takes `name` until the returned function is called. */
function hold(name: string): () => void {
  held.add(name);
  return () => release(name);
}

function turn(name: string): Promise<void> {
  if (!held.has(name)) { held.add(name); return Promise.resolve(); }
  return new Promise<void>((resolve) => {
    const queue = waiting.get(name) ?? [];
    queue.push(() => { held.add(name); resolve(); });
    waiting.set(name, queue);
  });
}

const locks = {
  async request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    if (silent) return new Promise(() => {});
    const options = (typeof a === "function" ? {} : a) as { ifAvailable?: boolean };
    const work = (typeof a === "function" ? a : b) as (lock: unknown) => Promise<unknown>;
    if (options.ifAvailable) {
      if (held.has(name)) return work(null);
      held.add(name);
      try {
        return await work({ name });
      } finally {
        release(name);
      }
    }
    await turn(name);
    try {
      return await work({ name });
    } finally {
      release(name);
    }
  },
};

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  held.clear();
  waiting.clear();
  silent = false;
  vi.stubGlobal("navigator", { locks });
  // `resetModules` gives every test a fresh copy of every module — including the account handle
  // singleton (Phase 9 §0.1). Binding it BEFORE the reset would bind a copy none of this test's
  // (all dynamic) imports below ever see, so the account is bound fresh, from the SAME post-reset
  // registry, after the reset.
  vi.resetModules();
  const { resetTestAccount: freshReset } = await import("@/tests/helpers/account");
  h = await freshReset();
  // A page that has given up on the lock service stays given up; each test is a fresh page.
  const { resetLockWarning } = await import("@/lib/log/web-lock");
  resetLockWarning();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("another tab holding the commit lock", () => {
  it("keeps this tab's drain off the entry, and lets it through once released", async () => {
    const { commitLogEntry } = await import("@/lib/log-commit-client");
    const { drainOutbox } = await import("@/lib/sync/outbox");
    const { allOps } = await import("@/lib/sync/idb");

    // Tab A wrote the entry and is posting it. This tab knows nothing of that POST except the
    // lock: the record and the queued change are all it can see.
    await commitLogEntry(REQ, { fetchImpl: vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch });
    expect(await allOps(h)).toHaveLength(1);
    const letGo = hold(`mc-log-commit:${ENTRY_ID}`);

    const push = vi.fn(async () => ({ results: [], server_time: "2026-11-02T17:00:05.000Z" }));
    await drainOutbox(h, push as never);
    expect(push).not.toHaveBeenCalled();

    letGo();
    const sends = vi.fn(async (ops: { op_id: string }[]) => ({
      results: ops.map((op) => ({ op_id: op.op_id, status: "applied" as const, rev: 9, seq: 3 })),
      server_time: "2026-11-02T17:00:05.000Z",
    }));
    await drainOutbox(h, sends as never);
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it("posts nothing and leaks nothing when the other tab owns the entry", async () => {
    // The lock was asked for without `ifAvailable` and never awaited, so this commit posted while
    // the other tab was posting the same entry, then QUEUED for a lock it would be granted later
    // and hold until the tab died — every later drain standing off for ever (Grok pass 9, HIGH 1).
    const { commitLogEntry } = await import("@/lib/log-commit-client");
    const { allOps } = await import("@/lib/sync/idb");
    const letGo = hold(`mc-log-commit:${ENTRY_ID}`);

    const posts = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: posts });
    expect(posts).not.toHaveBeenCalled();
    expect(await allOps(h)).toHaveLength(0);

    // And nothing of ours is waiting for that name: the other tab's release must not hand this
    // tab a lock it will then sit on.
    letGo();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...held]).toEqual([]);
  });

  it("draws the card anyway when the lock manager never answers", async () => {
    // The card is budgeted at 100 ms from the tap, so the question about the lock has to be cheap.
    // A LockManager that never calls back must not mean a Save that never draws anything
    // (Grok pass 10, MEDIUM 1).
    // Real timers: this drives IndexedDB, which fake ones stall. The budget is a second, and the
    // point of the test is that the commit does not wait past it.
    try {
      silent = true;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { commitLogEntry } = await import("@/lib/log-commit-client");
      const { LOCK_GRANT_BUDGET_MS } = await import("@/lib/log/web-lock");
      const { allOps } = await import("@/lib/sync/idb");
      const posts = vi.fn(async () => new Response(JSON.stringify({ status: "ok", rev: 1 }),
        { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

      const started = Date.now();
      expect(await commitLogEntry(REQ, { fetchImpl: posts })).toMatchObject({ status: "ok" });
      expect(Date.now() - started).toBeLessThan(LOCK_GRANT_BUDGET_MS * 3);
      expect(posts).toHaveBeenCalledTimes(1);
      expect(await allOps(h)).toHaveLength(0);
    } finally {
      silent = false;
    }
  });

  it("still records, queues and posts when no lock is ever granted", async () => {
    // The commit lock was bounded and the records lock was not, so the card was drawn and the
    // write behind it never enqueued, never posted and left no record: the meal was on Today and
    // nowhere else (panel round 11).
    try {
      silent = true;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { commitLogEntry } = await import("@/lib/log-commit-client");
      const { LOCK_GRANT_BUDGET_MS } = await import("@/lib/log/web-lock");
      const { readPending } = await import("@/lib/log/pending");
      const { allOps } = await import("@/lib/sync/idb");
      const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;

      const started = Date.now();
      expect(await commitLogEntry(REQ, { fetchImpl: down })).toEqual({ status: "queued" });
      expect(Date.now() - started).toBeLessThan(LOCK_GRANT_BUDGET_MS * 4);
      expect(down).toHaveBeenCalledTimes(1);
      expect(await allOps(h)).toHaveLength(1);
      expect(await readPending(h)).toHaveLength(0);
    } finally {
      silent = false;
    }
  });

  it("tells the sheet plainly when another tab owns the entry", async () => {
    const { commitLogEntry, outcomeFor } = await import("@/lib/log-commit-client");
    const { allOps } = await import("@/lib/sync/idb");
    hold(`mc-log-commit:${ENTRY_ID}`);

    const posts = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const result = await commitLogEntry(REQ, { fetchImpl: posts });
    expect(result).toEqual({ status: "owned_elsewhere" });
    expect(outcomeFor(result)).toEqual({
      keep: false, message: "Another tab is saving this. It will show after sync." });
    expect(posts).not.toHaveBeenCalled();
    expect(await allOps(h)).toHaveLength(0);
  });

  it("leaves the record alone while the other tab is still posting it", async () => {
    const { commitLogEntry } = await import("@/lib/log-commit-client");
    const { readPending } = await import("@/lib/log/pending");
    const { retryPendingReconciles } = await import("@/lib/log/reconcile");

    void commitLogEntry(REQ, { fetchImpl: vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch });
    await vi.waitFor(async () => { expect(await readPending(h)).toHaveLength(1); });
    // That commit is this tab's; pretend it is the other one's, which is all the record can say.
    const { resetLiveCommits } = await import("@/lib/log/live-commits");
    resetLiveCommits();
    held.clear();
    const letGo = hold(`mc-log-commit:${ENTRY_ID}`);

    await retryPendingReconciles(h);
    expect((await readPending(h))[0].state).toBe("in_flight");

    // Nobody is posting it any more: the other tab let go, and the hanging commit's own hold went
    // with the page that owned it.
    letGo();
    held.clear();
    await retryPendingReconciles(h);
    expect((await readPending(h))[0]?.state ?? "gone").not.toBe("in_flight");
  });
});

describe("the records lock", () => {
  it("waits its turn rather than writing beside the other tab", async () => {
    // `ifAvailable` is the wrong question for this one: `null` means another document HOLDS it,
    // and carrying on is two tabs' read-modify-write on one `meta` key — the lost clear from
    // pass 8, back again (panel round 12, item 1).
    const { markInFlight, readPending } = await import("@/lib/log/pending");
    const letGo = hold("mc-pending-records");

    let landed = false;
    const write = markInFlight(h, ENTRY_ID, "user-a").then(() => { landed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(landed).toBe(false);
    expect(await readPending(h)).toHaveLength(0);

    letGo();
    await write;
    expect(landed).toBe(true);
    expect(await readPending(h)).toHaveLength(1);
  });

  it("writes anyway when the manager never answers at all", async () => {
    silent = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { markInFlight, readPending } = await import("@/lib/log/pending");
    await markInFlight(h, ENTRY_ID, "user-a");
    silent = false;
    expect(await readPending(h)).toHaveLength(1);
  });
});

describe("after one unanswered ask", () => {
  it("still hears that another tab owns an entry", async () => {
    // The page-long latch made every later ask answer "granted" without asking, so a tab that
    // owned nothing believed it did and two tabs could commit one entry (panel round 12, item 2).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { commitLogEntry } = await import("@/lib/log-commit-client");
    const { resetLiveCommits } = await import("@/lib/log/live-commits");
    const posts = vi.fn(async () => new Response(JSON.stringify({ status: "ok", rev: 1 }),
      { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    silent = true;
    await commitLogEntry(REQ, { fetchImpl: posts });
    silent = false;
    resetLiveCommits();

    hold(`mc-log-commit:${ENTRY_ID}`);
    const second = await commitLogEntry({ ...REQ, base_rev: 1 }, { fetchImpl: posts });
    expect(second).toEqual({ status: "owned_elsewhere" });
    expect(posts).toHaveBeenCalledTimes(1);
  });

  it("keeps the commit lock live while the records lock is being skipped", async () => {
    // A wedged RECORDS lock is a reason to stop asking for THAT name for a moment. It is never a
    // reason to stop asking who owns an entry (Grok pass 13, item 3).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { underBoundedLock } = await import("@/lib/log/web-lock");
    const { acquireCommitLock } = await import("@/lib/log/live-commits");
    silent = true;
    await underBoundedLock("mc-pending-records", async () => undefined);
    silent = false;

    hold(`mc-log-commit:${ENTRY_ID}`);
    expect(await acquireCommitLock(ENTRY_ID)).toBeNull();
  });

  it("goes on guarding the records key when a commit-lock ask goes quiet", async () => {
    // The wedged window is the records lock's own memory of its own timeout. Setting it from any
    // unanswered ask meant one slow `isHeld` on a busy main thread turned off the guard around
    // every record write for five seconds, and two tabs were back to reading, changing and writing
    // one `meta` key over each other (Grok pass 14, MEDIUM 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { isHeld } = await import("@/lib/log/web-lock");
    const { markInFlight, readPending } = await import("@/lib/log/pending");

    silent = true;
    expect(await isHeld(`mc-log-commit:${ENTRY_ID}`)).toBe(false);
    silent = false;

    // The other tab is mid-write on the records key; this one waits for its turn as ever.
    const letGo = hold("mc-pending-records");
    let landed = false;
    const write = markInFlight(h, ENTRY_ID, "user-a").then(() => { landed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(landed).toBe(false);

    letGo();
    await write;
    expect(await readPending(h)).toHaveLength(1);
  });

  it("still takes the lock when a later ask is granted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { commitLogEntry } = await import("@/lib/log-commit-client");
    const { resetLiveCommits, isCommitting } = await import("@/lib/log/live-commits");
    const posts = vi.fn(async () => new Response(JSON.stringify({ status: "ok", rev: 1 }),
      { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    silent = true;
    await commitLogEntry(REQ, { fetchImpl: posts });
    silent = false;
    resetLiveCommits();

    let holding = false;
    const hanging = vi.fn(async () => {
      holding = held.has(`mc-log-commit:${ENTRY_ID}`);
      return new Response(JSON.stringify({ status: "ok", rev: 2 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await commitLogEntry({ ...REQ, base_rev: 1 }, { fetchImpl: hanging });
    expect(holding).toBe(true);
    expect(await isCommitting(ENTRY_ID)).toBe(false);
  });
});
