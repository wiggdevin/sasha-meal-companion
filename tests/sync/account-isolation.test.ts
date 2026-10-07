// @vitest-environment jsdom
/**
 * Phase 9 §0.2 / §0.8 on a shared phone: nothing of account A is read, written, sent, shown or
 * settled under account B, and A's unsent work survives and sends as A.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountChanged, accountHandle, bindAccount, unbindAccount, type AccountHandle,
} from "@/lib/device/account";

/** The read-to-write interval is controlled, not guessed: `getRow` waits for `gate` after it has
 *  read, so a test switches exactly between the read and the write. */
const control = vi.hoisted(() => ({
  gate: null as Promise<void> | null, readDone: null as (() => void) | null,
}));
vi.mock("@/lib/sync/idb", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sync/idb")>();
  return { ...real, getRow: async (...args: Parameters<typeof real.getRow>) => {
    const row = await real.getRow(...args);
    control.readDone?.();
    if (control.gate) await control.gate;
    return row;
  } };
});
/** The authoritative read-back after a commit: nothing there yet, so nothing is mirrored from it. */
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    from: () => ({ select: () => {
      const empty = {
        eq: () => empty, order: () => empty, gt: () => empty,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return empty;
    } }),
  }),
}));

const {
  accountDbName, allOps, allRows, getMeta, getRow, putRow,
} = await import("@/lib/sync/idb");
const { addCups } = await import("@/lib/water-client");
const { commitLogEntry } = await import("@/lib/log-commit-client");
const { LOG_QUEUED_EVENT, PENDING_LOG_KEY } = await import("@/lib/log/pending");
const { __setDepartureDeps, beginDeparture } = await import("@/lib/device/departure");
const { newPage } = await import("@/tests/helpers/new-page");
const { savePlanDay } = await import("@/lib/plan-day-client");
const { syncOnce } = await import("@/lib/sync/client");
const { readCache, writeCache } = await import("@/lib/coach-client");
const { getDay, loadStore } = await import("@/lib/store");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "2026-09-22";

function sampleCommit() {
  const entryId = crypto.randomUUID();
  return {
    entry_id: entryId, eaten_at: "2026-09-22T12:00:00.000Z", tz: "UTC", local_date: DATE,
    slot: "meal-2" as const, method: "search" as const,
    items: [{ id: crypto.randomUUID(), seq: 1, food_ref_id: "cccccccc-3333-4333-8333-333333333333",
      qty: 1, unit: "g", grams: 100, confidence: 0.4 }],
  };
}

function sampleEntry(req: ReturnType<typeof sampleCommit>) {
  return { id: req.entry_id, foodId: "rice", name: "Rice", portionLabel: "100 g", qty: 1,
    grams: 100, macros: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 }, at: req.eaten_at };
}

function acceptedBody(req: ReturnType<typeof sampleCommit>) {
  return { status: "ok", entry_id: req.entry_id, rev: 1, items: [],
    totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 } };
}

/**
 * The reload boundary, as AuthGate runs it: the page freezes A at once (synchronously), makes A's
 * state durable, "reloads", and the new page binds `next` at its cold start.
 */
function switchTo(next: string): Promise<void> {
  __setDepartureDeps({ reload: () => {} });
  const leaving = beginDeparture();
  return leaving.then(async () => { await newPage(next); });
}

beforeEach(async () => {
  control.gate = null; control.readDone = null;
  await newPage(null);
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("a write that spans a switch", () => {
  it("writes nothing when the account changes between its read and its write", async () => {
    const a = bindAccount(A);
    await putRow(a, "water_log", DATE, { local_date: DATE, cups: 2, rev: 1, user_id: A });
    let release!: () => void;
    control.gate = new Promise<void>((r) => { release = r; });
    const read = new Promise<void>((r) => { control.readDone = r; });
    const pending = addCups(DATE, 1);
    await read;
    bindAccount(B);
    release();
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    control.gate = null;
    expect(await allOps(bindAccount(B))).toEqual([]);
    unbindAccount();
    const a2 = bindAccount(A);
    expect(await getRow(a2, "water_log", DATE)).toMatchObject({ cups: 2, rev: 1 });
    expect(await allOps(a2)).toEqual([]);
  });
});

describe("a log commit across a switch", () => {
  it("a commit already running when the page starts leaving A finishes as A; B gets nothing of it", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("x-smc-account")).toBe(A);
      return new Response("{}", { status: 200 });
    });
    bindAccount(A);
    let switched: Promise<void> = Promise.resolve();
    const onLog = () => {
      window.removeEventListener(LOG_QUEUED_EVENT, onLog);
      switched = switchTo(B);
    };
    window.addEventListener(LOG_QUEUED_EVENT, onLog);
    const req = sampleCommit();
    await commitLogEntry(req, {
      fetchImpl: fetchImpl as never, optimistic: { date: DATE, entry: sampleEntry(req) as never },
    });
    await switched;
    // audit plan r1 finding 1: A's database survives the switch, and B's holds nothing of A's
    expect((await indexedDB.databases()).map((d) => d.name)).toContain(accountDbName(A));
    const b = accountHandle();
    expect(b.userId).toBe(B);
    expect(await allRows(b, "log_entries")).toEqual([]);
    expect(await allOps(b)).toEqual([]);
    expect(getDay(DATE)?.extras ?? []).toEqual([]);
    await newPage(A);
    expect(getDay(DATE)?.extras?.map((e) => e.id)).toEqual([req.entry_id]);
  });

  it("a commit answered after a switch writes into neither database (the delayed writer)", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const req = sampleCommit();
    const pending = commitLogEntry(req, { fetchImpl: fetchImpl as never });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const beforeA = await allRows(a, "log_entries");
    const opsBefore = (await allOps(a)).map((o) => o.op_id);
    const b = bindAccount(B);
    answer(new Response(JSON.stringify(acceptedBody(req)), { status: 200 }));
    await expect(pending).resolves.toEqual({ status: "owned_elsewhere" });
    expect(await allRows(b, "log_entries")).toEqual([]);
    expect(await allOps(b)).toEqual([]);
    unbindAccount();
    const a2 = bindAccount(A);
    expect(await allRows(a2, "log_entries")).toEqual(beforeA);
    // Nothing of A's was settled away: its queued write is still there to send as A.
    expect((await allOps(a2)).map((o) => o.op_id)).toEqual(opsBefore);
  });

  it("keeps A's card, record and queued write when the server says the session is B's (409)", async () => {
    const fetchImpl = vi.fn(async () => Response.json(
      { error: "account_mismatch", message: "another account" }, { status: 409 }));
    const a = bindAccount(A);
    const req = sampleCommit();
    const result = await commitLogEntry(req, {
      fetchImpl: fetchImpl as never, optimistic: { date: DATE, entry: sampleEntry(req) as never },
    });
    expect(result).toEqual({ status: "owned_elsewhere" });
    expect(getDay(DATE)?.extras?.map((e) => e.id)).toEqual([req.entry_id]);
    expect((await allOps(a)).filter((o) => o.entity_id === req.entry_id)).toHaveLength(1);
    expect(await getRow(a, "log_entries", req.entry_id)).toBeTruthy();
    const records = await getMeta<{ entryId: string }[]>(a, PENDING_LOG_KEY);
    expect(records?.map((r) => r.entryId)).toContain(req.entry_id);
  });
});

describe("the shared-phone headline case (spec §0.8)", () => {
  it("A's offline plan_days op and coach transcript never reach B; A's op sends as A later", async () => {
    const pushed: { user: string; ops: { user_id?: string }[] }[] = [];
    const server = (user: string) => vi.fn(async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("x-smc-account")).toBe(user);
      if (String(url).startsWith("/api/sync/changes")) {
        return new Response(JSON.stringify({ changes: [], next_cursor: 0, has_more: false }));
      }
      const body = JSON.parse(String(init.body)) as { ops: { op_id: string; user_id?: string }[] };
      pushed.push({ user, ops: body.ops });
      return new Response(JSON.stringify({ results: body.ops.map((o) =>
        ({ op_id: o.op_id, status: "applied", rev: 1, seq: 1 })), server_time: new Date().toISOString() }));
    }) as unknown as typeof fetch;

    const a = bindAccount(A);
    await savePlanDay(DATE, { floorDay: true });          // queued, never sent: A is offline
    writeCache(a, "thread-1", { messages: [{ role: "user", text: "A only" } as never], actions: [] });

    await switchTo(B);
    const b: AccountHandle = accountHandle();
    await syncOnce(b, { fetchFn: server(B) });
    expect(pushed.filter((p) => p.user === B).flatMap((p) => p.ops)).toEqual([]);
    expect(await allRows(b, "plan_days")).toEqual([]);
    expect(readCache(b, "thread-1").messages).toEqual([]);
    expect(Object.keys(loadStore().days)).toEqual([]);

    await switchTo(A);
    const a2 = accountHandle();
    await syncOnce(a2, { fetchFn: server(A) });
    const sent = pushed.filter((p) => p.user === A).flatMap((p) => p.ops);
    expect(sent).toHaveLength(1);
    expect(sent[0].user_id).toBe(A);
  });
});
