/**
 * T0 §3 / AC3 — the optimistic commit.
 *
 * The outbox was already the failure path; this makes it the normal one. The entry reaches the
 * local store and the IDB mirror BEFORE the post, marked pending, so Today shows the card at once
 * with the treatment `LoggedExtraCard` already draws. The server reply then reconciles it, or —
 * for a genuine refusal — takes it back out, because a rejected commit must never sit in her log
 * as a silent phantom (audit 2026-09-13 #6).
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localDateFor } from "@/lib/log/contract";
import { saveExtraNote } from "@/lib/log-note-client";
import { commitLogEntry, committedEntry, forgetLoggedEntry, LOG_QUEUED_EVENT, logEntryStates,
  outcomeFor, pendingEntryIds, reconcileEntry, retryPendingReconciles,
  retryUnsavedCommit } from "@/lib/log-commit-client";
import { getDay, loadStore, saveStore, upsertExtra } from "@/lib/store";
import { allOps, deleteOp, getRow, putRow } from "@/lib/sync/idb";

import { drainOutbox, OUTBOX_QUEUED_EVENT, type PushFn } from "@/lib/sync/outbox";
import {
  countAttempt, FREE_ATTEMPTS, isDeleted, isInFlight, markDeleted, markInFlight,
  markNeedsReconcile, MAX_ATTEMPTS, MAX_UNCONFIRMED, readPending,
} from "@/lib/log/pending";
import { reconcileFromServer } from "@/lib/log/reconcile";
import { HOLD_BUDGET_MS, isCommitting, resetLiveCommits } from "@/lib/log/live-commits";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Spend a record's whole read budget, which is what makes it `stale`. */
async function capRecord(entryId: string): Promise<void> {
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) await countAttempt(h, entryId, Date.now() + i * DAY_MS);
}

import type { LogCommitRequest, LogCommitResponse } from "@/lib/log/contract";
import type { LoggedFood } from "@/lib/types";
import { entryMacros, snapshotMacros } from "@/lib/resolve";
import { commitNutritionUnchecked } from "@/lib/nutrition-display";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/** What the authoritative `log_entries` + `log_items` read answers with, per test. */
let serverRead: Record<string, unknown> | null = null;
function readsServerRow(row: Record<string, unknown> | null): void {
  serverRead = row;
  readRow = null;
}

/** A read that does something first — the world moving while a pass is running. */
let readRow: (() => Promise<Record<string, unknown> | null>) | null = null;
function reader(fn: () => Promise<Record<string, unknown> | null>): void { readRow = fn; }

/** Who is signed in, and how many times the authoritative row has been asked for. */
let signedInAs: string | null = "user-a";
let reads = 0;
function signIn(userId: string | null): void { signedInAs = userId; }

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: signedInAs === null ? null : { claims: { sub: signedInAs } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => {
        reads += 1;
        const data = readRow === null ? serverRead : await readRow();
        return { data, error: null };
      } }) }) }),
  }),
}));

const DATE = "2026-11-02";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";

const REQ: LogCommitRequest = {
  entry_id: ENTRY_ID, eaten_at: "2026-11-02T17:00:00.000Z", tz: "UTC", local_date: DATE,
  slot: "meal-2", method: "search",
  items: [{ id: ITEM_ID, seq: 1, food_ref_id: "cccccccc-3333-4333-8333-333333333333",
    qty: 1, unit: "g", grams: 100, confidence: 0.4 }],
};

const ENTRY: LoggedFood = {
  id: ENTRY_ID, foodId: "rice", name: "Rice", portionLabel: "100 g", qty: 1, grams: 100,
  macros: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 }, at: REQ.eaten_at,
};

/** A stored item as the server now reports it: whole, not just what changed. */
function serverItem(id: string, grams: number): LogCommitResponse["items"][number] {
  return {
    id, entry_id: ENTRY_ID, seq: 1, food_ref_id: "cccccccc-3333-4333-8333-333333333333",
    qty: 1, unit: "g", grams, portion_id: null, food_revision_id: null,
    was_edited: false, confidence: null, snapshot: {} as never,
  };
}

const OK: LogCommitResponse = {
  status: "ok", entry_id: ENTRY_ID, rev: 1,
  items: [serverItem(ITEM_ID, 100)],
  totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 },
};

/**
 * A server that answers, and whose body never arrives: the stream errors where a timed-out body
 * would have run out of budget. Both are the same thing to a caller — an answer nobody read.
 */
function unreadable(status: number) {
  return vi.fn(async () => new Response(
    new ReadableStream({ start(c) { c.error(new Error("the body never arrived")); } }),
    { status, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;
}

function jsonFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
}

/** A post that never settles, so the assertions land while the server is still thinking. */
function hangingFetch() {
  return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
}

const optimistic = { date: DATE, entry: ENTRY };

/**
 * vitest's environment is `node`, so there is no `window` and no `localStorage`. The store falls
 * back to memory on its own; what this shim adds is the event target, because "Today repaints at
 * once" is exactly a `LOG_QUEUED_EVENT` dispatch.
 */
const bus = new EventTarget();
const memory = new Map<string, string>();
const fakeWindow = Object.assign(bus, {
  localStorage: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => { memory.set(k, String(v)); },
    removeItem: (k: string) => { memory.delete(k); },
  },
});

beforeEach(async () => {
  // Several tests deliberately leave a commit in flight against a server that never answers. Its
  // local-first step keeps working for a few turns after the test ends, so let those finish
  // before the database is swapped — otherwise a stray write lands in the NEXT test's store.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  h = await resetTestAccount();
  // A fresh IndexedDB per test: the outbox is what makes a card pending, and one test's queued
  // op would otherwise still be sitting there in the next.
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  signIn("user-a");
  reads = 0;
  // Several tests leave a POST hanging on purpose. In the app a hanging fetch is bounded by the
  // commit deadline, so the hold releases; here it never would, and the next test would join it.
  resetLiveCommits();
  (globalThis as { window?: unknown }).window = fakeWindow;
  memory.clear();
  saveStore({ ...loadStore(), days: {} });
  serverRead = null;
});

describe("the local write comes first", () => {
  it("puts the card on Today before the server has answered", async () => {
    void commitLogEntry(REQ, { fetchImpl: hangingFetch(), optimistic });
    await vi.waitFor(() => expect(getDay(DATE)?.extras).toHaveLength(1));
    expect(getDay(DATE)?.extras?.[0].id).toBe(ENTRY_ID);
    expect(await pendingEntryIds()).toContain(ENTRY_ID);
  });

  it("mirrors the entry into IDB with the items the request carries", async () => {
    void commitLogEntry(REQ, { fetchImpl: hangingFetch(), optimistic });
    await vi.waitFor(async () => expect(await getRow(h, "log_entries", ENTRY_ID)).toBeTruthy());
    const row = (await getRow(h, "log_entries", ENTRY_ID)) as Record<string, unknown>;
    expect(row.method).toBe("search");
    expect((row.items as { confidence: number }[])[0].confidence).toBe(0.4);
  });

  it("tells Today a card appeared, so it repaints without waiting for a sync", async () => {
    const seen: string[] = [];
    const listener = () => seen.push("queued");
    bus.addEventListener(LOG_QUEUED_EVENT, listener);
    void commitLogEntry(REQ, { fetchImpl: hangingFetch(), optimistic });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    bus.removeEventListener(LOG_QUEUED_EVENT, listener);
  });
});

describe("the reply reconciles it", () => {
  it("clears the pending mark on a good commit and keeps the one card", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });

  it("marks the entry off-plan from the server's own flags", async () => {
    const flagged = { ...OK, flagged: [{ path: "items.0", message: "blocked:allergen:gluten" }] };
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, flagged), optimistic });
    expect(getDay(DATE)?.extras?.[0].flags).toEqual(["gluten"]);
  });

  it("takes the card back out when the server genuinely refuses it", async () => {
    const result = await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(422, { status: "invalid", issues: [] }), optimistic,
    });
    expect(result).toMatchObject({ status: "invalid" });
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });
});

describe("with the server down", () => {
  it("keeps the card, keeps it pending, and queues exactly one op", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const result = await commitLogEntry(REQ, { fetchImpl, optimistic });
    expect(result).toEqual({ status: "queued" });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    expect(await pendingEntryIds()).toContain(ENTRY_ID);
  });

  it("adds no second card, and clears the queued op once the retry lands", async () => {
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, optimistic });
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    // The server has it now, so the op that existed to retry it is gone: a drain that still
    // pushed it would commit the same entry twice.
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
  });
});

/**
 * The panel's AC3, read strictly: the local-first write is what `commitLogEntry` DOES, not an
 * option a caller may pass. `optimistic` only says which card to put on Today — the pending mark
 * and the IDB mirror happen for every commit, including one made from a screen that has no card.
 */
describe("with no card to show — the mirror and the mark still come first", () => {
  it("marks the entry pending before the post", async () => {
    let pendingDuringPost: Set<string> | null = null;
    const fetchImpl = vi.fn(async () => {
      pendingDuringPost = await pendingEntryIds();
      return new Response(JSON.stringify(OK), { status: 200,
        headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl });
    expect(pendingDuringPost!).toContain(ENTRY_ID);
  });

  it("mirrors the entry, built from the request, before the post", async () => {
    let rowDuringPost: unknown = null;
    const fetchImpl = vi.fn(async () => {
      rowDuringPost = await getRow(h, "log_entries", ENTRY_ID);
      return new Response(JSON.stringify(OK), { status: 200,
        headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl });
    expect(rowDuringPost).toBeTruthy();
    expect(rowDuringPost).toMatchObject({ id: ENTRY_ID, slot: "meal-2", method: "search" });
    expect((rowDuringPost as { items: { id: string }[] }).items[0].id).toBe(ITEM_ID);
    // An unacknowledged entry has no revision, so nothing can base an edit on one.
    expect((rowDuringPost as { rev: unknown }).rev).toBeNull();
  });

  it("clears the mark and reconciles rev, totals and flagged on a 2xx", async () => {
    const body = { ...OK, rev: 4,
      flagged: [{ path: "items.0", message: "blocked:allergen:gluten" }] };
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, body) });
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
    const row = (await getRow(h, "log_entries", ENTRY_ID)) as Record<string, unknown>;
    expect(row.rev).toBe(4);
    expect(row.totals).toEqual(OK.totals);
    expect(row.flagged).toEqual(body.flagged);
  });

  it("keeps the mark on a 503, with exactly one op, and one drain clears it", async () => {
    const result = await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }) });
    expect(result).toEqual({ status: "queued" });
    expect(await pendingEntryIds()).toContain(ENTRY_ID);
    const queued = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(queued).toHaveLength(1);

    const push: PushFn = async (ops) => ({
      results: ops.map((op) => ({ op_id: op.op_id, status: "applied" as const, rev: 1, seq: 9 })),
      server_time: "2026-11-02T17:00:05.000Z",
    });
    // The real clock: an op's next_attempt_at is stamped from it at enqueue time, so a frozen
    // one in the past would make nothing due and the drain a no-op.
    readsServerRow(serverRow);
    await drainOutbox(h, push);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });

  it("takes the mirror row back out when the server genuinely refuses", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(422, { status: "invalid", issues: [] }) });
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toBeUndefined();
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });

  it("leaves a row it did not create when the commit is refused", async () => {
    const existing = { id: ENTRY_ID, rev: 3, slot: "meal-1", items: [] };
    await putRow(h, "log_entries", ENTRY_ID, existing);
    await commitLogEntry({ ...REQ, base_rev: 3 },
      { fetchImpl: jsonFetch(410, { status: "gone" }) });
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toEqual(existing);
  });
});

/**
 * A 2xx is the server saying it has the entry. Whatever happens afterwards — a body that is not
 * contract-shaped, a mirror write that throws, anything at all — the op must not reach the
 * outbox, because a queued replay of an entry the server already holds is a second commit.
 */
describe("once the server has answered 2xx", () => {
  it("returns the parsed answer and queues nothing when the body has no items", async () => {
    // The panel's fixture: a 200 whose body carries no `entry_id` and no `items`. The row is
    // still readable, so the entry settles from it and the mark clears.
    readsServerRow(serverRow);
    const result = await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(200, { status: "ok", rev: 1, totals: {}, flagged: [] }),
    });
    expect(result.status).toBe("ok");
    expect(await pendingEntryIds()).toEqual(new Set());
    expect(await allOps(h)).toHaveLength(0);
  });

  it("queues nothing when reconciling the card itself throws", async () => {
    // `flagged` is not an array, so the card's own reconcile blows up after the 2xx.
    const result = await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(200, { ...OK, flagged: "gluten" }),
      optimistic,
    });
    expect(result.status).toBe("ok");
    expect(await pendingEntryIds()).toEqual(new Set());
    expect(await allOps(h)).toHaveLength(0);
  });

  it("keeps the row, unacknowledged, when the answer names no items", async () => {
    // MEDIUM 8: an answer that named no items cannot vouch for ours, so its revision does not go
    // onto them. The row waits for the authoritative read instead.
    await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(200, { status: "ok", rev: 1, totals: {} }),
    });
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toMatchObject({ rev: null });
  });

  it("still queues when the server asked to be retried", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(429, { error: "slow down" }) });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
  });
});

/**
 * Grok 4.6 adversarial review, HIGH 1 and HIGH 3, and the MEDIUM items around them: what the
 * outbox holds after a commit, and what a 2xx is allowed to take away.
 */
describe("the outbox holds one op per entry, and a 2xx clears it", () => {
  it("drops the queued op when a later attempt succeeds", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }), optimistic });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    // The server holds the entry now; a drain that still pushed this op would commit it twice.
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);

    const pushed: unknown[] = [];
    const push: PushFn = async (ops) => {
      pushed.push(...ops);
      return { results: ops.map((op) => ({ op_id: op.op_id, status: "applied" as const, rev: 1, seq: 9 })),
        server_time: "2026-11-02T17:00:05.000Z" };
    };
    await drainOutbox(h, push);
    expect(pushed).toHaveLength(0);
  });

  it("queues one op, not two, for two failed attempts at the same entry", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }) });
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }) });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
  });
});

describe("a 2xx never takes the card or the row away", () => {
  it("keeps both when the body is empty", async () => {
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, {}), optimistic });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toBeTruthy();
    expect(await allOps(h)).toHaveLength(0);
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });

  it("keeps both when the body has a rev but no items, without taking that rev", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 1 }), optimistic });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    const row = (await getRow(h, "log_entries", ENTRY_ID)) as Record<string, unknown>;
    expect(row.rev).toBeNull();
    expect(await allOps(h)).toHaveLength(0);
    // And it stays pending, because a row with no revision is not one she can edit: the mark is
    // a claim about the mirror, not about the POST (Grok pass 4, HIGH 2).
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("keeps both when reconciling the card throws", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, flagged: "gluten" }), optimistic });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toBeTruthy();
  });
});

describe("a refusal", () => {
  it("keeps the card on a conflict and takes the server's own revision", async () => {
    const entity = { id: ENTRY_ID, rev: 9, note: "other device", items: [
      { id: ITEM_ID, grams: 175, snapshot: { energy_kcal: { amount: 200 } } }] };
    await commitLogEntry({ ...REQ, base_rev: 1 }, {
      fetchImpl: jsonFetch(409, { status: "conflict", current_rev: 9, entity }), optimistic,
    });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toMatchObject({ rev: 9 });
  });

  it("still takes the card away on an invalid", async () => {
    await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(422, { status: "invalid", issues: [] }), optimistic,
    });
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });
});

/**
 * Grok 4.6 HIGH 2: the sheet handed `onAdd` the object it built BEFORE the commit, and
 * `upsertExtra` replaces by id — so the server's off-plan flags and its grams were overwritten by
 * the pre-server copy a moment after being reconciled onto the card.
 */
describe("committedEntry", () => {
  it("hands back the reconciled card, not the object the sheet started with", async () => {
    const flagged = { ...OK, flagged: [{ path: "items.0", message: "blocked:allergen:gluten" }] };
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, flagged), optimistic });
    expect(committedEntry(DATE, ENTRY)).toMatchObject({ id: ENTRY_ID, flags: ["gluten"] });
  });

  it("takes the server's grams for each item it knows", async () => {
    const card: LoggedFood = { ...ENTRY, items: [{
      id: ITEM_ID, seq: 1, food_ref_id: REQ.items[0].food_ref_id, grams: 90, qty: 1, unit: "g",
      snapshot: {}, foodId: "rice", name: "Rice", portionLabel: "90 g", macros: ENTRY.macros,
    }] };
    await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(200, { ...OK, items: [{ id: ITEM_ID, grams: 100, snapshot: {} }] }),
      optimistic: { date: DATE, entry: card },
    });
    expect(committedEntry(DATE, card).items?.[0].grams).toBe(100);
  });

  it("falls back to what it was given when no card was written", () => {
    expect(committedEntry("2026-12-25", ENTRY)).toBe(ENTRY);
  });
});

/** Grok 4.6 MEDIUM 6: the capture confirm sheet commits optimistically too. */
describe("commitDraft", () => {
  it("puts a card on Today for a captured draft before the server answers", async () => {
    const { commitDraft } = await import("@/lib/capture-client");
    const draft = {
      draftId: "3b1f0c62-3d2c-4a52-9a1e-0c2f5d8a7b10", method: "photo" as const, notes: [],
      spend: { usedToday: 1, softCap: 30 },
      items: [{ seq: 1, label: "Rice", foodRefId: "cccccccc-3333-4333-8333-333333333333",
        catalogFoodRevisionId: 910, grams: 100, qty: 1, unit: "g", portionId: null,
        confidence: 0.9, policy: { verdict: "allowed" as const }, alternatives: [],
        autoResolved: true }],
    };
    const at = new Date("2026-11-02T17:00:00.000Z");
    // Not awaited: the point is that the card is there while the post is still in flight.
    void commitDraft(draft, {}, {
      entryId: ENTRY_ID, eatenAt: at, tz: "UTC", slot: "meal-2",
      fetchImpl: hangingFetch(),
    });
    // "UTC", the tz passed above — never the process's own zone.
    const date = localDateFor(at.toISOString(), "UTC")!;
    await vi.waitFor(() => expect(getDay(date)?.extras).toHaveLength(1));
    expect(getDay(date)?.extras?.[0]).toMatchObject({ id: ENTRY_ID, name: "Rice" });
    expect(await pendingEntryIds()).toContain(ENTRY_ID);
  });
});

/**
 * Panel round 5, defect 1: a mirrored row the commit did not create must survive a refusal. The
 * pre-write read is how the commit learns what to put back; when that read fails there is nothing
 * to put back, so the only safe move is not to overwrite the row in the first place.
 */
describe("when the mirror cannot be read before the write", () => {
  const seeded = { id: ENTRY_ID, rev: 3, slot: "meal-1", method: "search", items: [] };

  it("leaves an existing row untouched, and a refusal does not lose it", async () => {
    await putRow(h, "log_entries", ENTRY_ID, seeded);
    const idb = await import("@/lib/sync/idb");
    const read = vi.spyOn(idb, "getRow").mockRejectedValueOnce(new Error("blocked"));

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(422, { status: "invalid", issues: [] }) });

    read.mockRestore();
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toMatchObject({ rev: 3 });
  });

  it("takes the card back out when the mirror could not be read", async () => {
    // The card is drawn BEFORE the mirror is read, so removing it must not depend on a rollback
    // that read failed: `rollbackMirror` rightly refuses to guess, and a refused meal was left on
    // Today and then driven toward "Logged, details catching up" (Grok pass 15, MEDIUM 2).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const idb = await import("@/lib/sync/idb");
    const read = vi.spyOn(idb, "getRow").mockRejectedValueOnce(new Error("blocked"));

    const result = await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(422, { status: "invalid", issues: [] }), optimistic });

    read.mockRestore();
    expect(outcomeFor(result).keep).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("keeps the card when a later attempt's row is the one in the mirror", async () => {
    // A later attempt's row is optimistic until the server answers, so it has no revision yet.
    // Requiring one meant the first attempt's 4xx took away the card the second POST was still
    // settling (Grok pass 16, MEDIUM 4).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let refuse!: (res: Response) => void;
    const held = vi.fn(() => new Promise<Response>((resolve) => { refuse = resolve; })) as unknown as typeof fetch;
    const first = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    // The second attempt, as it happens on a browser with no Web Locks: a new row, a new attempt.
    resetLiveCommits();
    const posting = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: posting, optimistic });
    await vi.waitFor(() => { expect(posting).toHaveBeenCalledTimes(1); });

    refuse(new Response(JSON.stringify({ status: "invalid", issues: [] }), { status: 422,
      headers: { "content-type": "application/json" } }));
    await first;
    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
  });

  it("still marks the entry pending and still posts", async () => {
    const idb = await import("@/lib/sync/idb");
    const read = vi.spyOn(idb, "getRow").mockRejectedValueOnce(new Error("blocked"));
    const fetchImpl = jsonFetch(200, OK);

    await commitLogEntry(REQ, { fetchImpl });

    read.mockRestore();
    expect(fetchImpl).toHaveBeenCalled();
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });

  it("still reconciles from the answer on a 2xx, so the entry is mirrored either way", async () => {
    const idb = await import("@/lib/sync/idb");
    const read = vi.spyOn(idb, "getRow").mockRejectedValueOnce(new Error("blocked"));

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 4 }) });

    read.mockRestore();
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toMatchObject({ rev: 4 });
  });
});

/**
 * Panel round 5, defect 2. An answer can share our item's id and still describe a different food:
 * another device replaced what was under that id between our commit and this reply. Taking the
 * revision beside those items while keeping OUR food_ref_id is the silent overwrite the whole
 * diverged branch exists to prevent — the next offline note edit would send our food at their
 * revision, and the server would accept it.
 */
/**
 * Panel round 7, item 3: the mirror stores the SERVER's items, verbatim, with the server's
 * revision. An answer can carry our item id and a different food ref — another device replaced
 * what sits under that id — and merging the two produced a row the server never stored: our food,
 * their revision, which the next offline note edit would then send back as fact.
 */
describe("what the mirror takes from a 2xx", () => {
  it("keeps the client's own keys out of a note edit's payload too", async () => {
    // The mirror row a note is built from may be an optimistic one this commit wrote, which
    // carries the attempt id. The payload is a `log_entries` write, so it may not.
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 12 }), optimistic });
    const { saveExtraNote } = await import("@/lib/log-note-client");
    upsertExtra(DATE, { ...ENTRY, items: [{ id: ITEM_ID, seq: 1,
      food_ref_id: REQ.items[0].food_ref_id, grams: 100, qty: 1, unit: "g", snapshot: {},
      foodId: "rice", name: "Rice", portionLabel: "100 g", macros: ENTRY.macros }] });
    await saveExtraNote(DATE, ENTRY_ID, "with butter");

    const op = (await allOps(h)).find((o) => o.entity_id === ENTRY_ID);
    expect(op).toBeTruthy();
    expect(Object.keys(op!.payload).filter((k) => k.startsWith("_"))).toEqual([]);
  });

  it("keeps no key of the client's own on an acknowledged row", async () => {
    // The attempt id is bookkeeping for the rollback, not a column. Left on the acknowledged row
    // it survives into `saveExtraNote`'s payload, which POSTs a `log_entries` write with a field
    // the table does not have (Grok pass 10, HIGH 2).
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 12 }) });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(12);
    expect(Object.keys(row).filter((k) => k.startsWith("_"))).toEqual([]);
  });


  it("keeps no field of ours when the answer names whole items", async () => {
    const theirs = { ...serverItem(ITEM_ID, 100),
      food_ref_id: "77777777-7777-4777-8777-777777777777" };
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 12, items: [theirs] }) });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(12);
    expect((row.items as Record<string, unknown>[])[0]).toEqual(theirs);
  });

  it("takes an unfamiliar item id just as readily — the server knows what it stored", async () => {
    const theirs = serverItem("99999999-9999-4999-8999-999999999999", 400);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 12, items: [theirs] }) });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(12);
    expect((row.items as { id: string }[])[0].id).toBe(theirs.id);
  });

  it("refuses a revision over items too thin to edit from", async () => {
    // The server returns whole rows now, but an older deploy — or a proxy that trims a body —
    // can still answer with `{id, grams, snapshot}`. Stamping the revision onto those makes a row
    // that looks editable and is not: the note path builds a POST with no food_ref_id, the server
    // names it invalid, and the refusal rolls back a meal the server still holds. Unacknowledged
    // is the honest state, and the authoritative read settles it (panel round 10, item 3).
    const thin = { id: ITEM_ID, grams: 100, snapshot: {} };
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 12, items: [thin] }) });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBeNull();
    expect((row.items as { id: string }[])[0].id).toBe(ITEM_ID);
    expect((row.items as { food_ref_id?: string }[])[0].food_ref_id).toBeDefined();
  });

  it("keeps our items, and no revision, when the answer names none", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }) });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBeNull();
    expect((row.items as { id: string }[])[0].id).toBe(ITEM_ID);
  });
});

describe("killed mid-flight", () => {
  it("leaves exactly one op behind, and one drain sends it once", async () => {
    // The POST never settles: from IndexedDB's point of view this is indistinguishable from the
    // tab being closed a moment after the tap.
    void commitLogEntry(REQ, { fetchImpl: hangingFetch(), optimistic });
    // Wait for the WHOLE local-first step, not just the op: the mirror write is the last thing it
    // does, and leaving it in flight would let it land after the next test has swapped the
    // database out from under it.
    await vi.waitFor(async () => {
      expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
      expect(await getRow(h, "log_entries", ENTRY_ID)).toBeTruthy();
    });

    const pushed: { op_id: string }[] = [];
    const push: PushFn = async (ops) => {
      pushed.push(...ops);
      return { results: ops.map((op) => ({ op_id: op.op_id, status: "applied" as const, rev: 1, seq: 9 })),
        server_time: "2026-11-02T17:00:05.000Z" };
    };
    // This page is still alive and its POST is still in the air, so the drain leaves the write
    // where it is however long it waits: no clock makes a live request stop being live
    // (panel round 15). The kill itself — fresh modules, same database — is the case above.
    readsServerRow(serverRow);
    await drainOutbox(h, push, () => Date.now() + 120_000);
    expect(pushed).toHaveLength(0);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
  });

  it("queues the op before the POST goes out, not after it fails", async () => {
    let opsAtPost = 0;
    const fetchImpl = vi.fn(async () => {
      opsAtPost = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID).length;
      return new Response(JSON.stringify(OK), { status: 200,
        headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl });
    expect(opsAtPost).toBe(1);
  });

  it("clears it again the moment the server acknowledges the entry", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
  });

  it("leaves it alone when the server could not be reached", async () => {
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await commitLogEntry(REQ, { fetchImpl: down, optimistic })).toEqual({ status: "queued" });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
  });

  it("has the durable record down before it paints the card", async () => {
    // A card with no record is a meal she can SEE while nothing on the phone is sending it and
    // nothing can send it again: no mark, no request, no "try again". A kill or a blocked
    // database in that gap is exactly the meal she would not log twice (Grok pass 21, HIGH 1).
    const store = await import("@/lib/store");
    const real = store.upsertExtra;
    let atPaint: Promise<unknown[]> | null = null;
    const painted = vi.spyOn(store, "upsertExtra").mockImplementation((date, entry) => {
      atPaint ??= readPending(h);
      return real(date, entry);
    });

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }), optimistic });

    painted.mockRestore();
    expect(atPaint).not.toBeNull();
    // The record was already on disk at the moment the card went up.
    expect(await (atPaint as unknown as Promise<unknown[]>)).toHaveLength(1);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
  });

  it("settles a conflicted create from the server rather than merging the payload", async () => {
    // Every commit queues before it posts, so a drain answering `conflict` for a CREATE is an
    // ordinary path. The generic rule merged `{...mirror, ...payload}` at the server's revision —
    // this phone's items under a revision the server has moved past, which is the one row the
    // commit path exists to refuse. The next note then based on it and was refused in turn
    // (Grok pass 25, HIGH 1).
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, optimistic });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);

    readsServerRow(serverRow);
    const push = vi.fn(async (ops: { op_id: string }[]) => ({
      results: ops.map((op) => ({
        op_id: op.op_id, status: "conflict" as const, entity: "log_entries",
        current_rev: 6, current: { ...serverRow },
      })),
      server_time: "2026-11-02T17:00:05.000Z",
    }));
    await drainOutbox(h, push as unknown as PushFn);

    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(6);
    // The server's own items, not the ones this phone asked for.
    expect((row.items as Record<string, unknown>[])[0].grams).toBe(175);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
  });

  it("keeps a note she typed while a later commit settles", async () => {
    // Her note is its own queued write, aimed at the revision the entry had when she typed it.
    // Settling ANOTHER commit for the same entry dropped every op it found, so the note went with
    // it — and the read-back then wrote the server's empty note over hers (pass 27, HIGH 2).
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    await saveExtraNote(DATE, ENTRY_ID, "after the gym");
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);

    // She changes the meal itself a moment later, and that commit lands.
    readsServerRow({ ...serverRow, rev: 7 });
    await commitLogEntry({ ...REQ, base_rev: 6 },
      { fetchImpl: jsonFetch(200, { ...OK, rev: 7 }), optimistic });

    const left = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(left.map((o) => o.kind)).toEqual(["update"]);
    expect(getDay(DATE)?.extras?.[0].note).toBe("after the gym");
  });

  it("wakes a drain again once the entry is nobody's to hold", async () => {
    // `enqueue` wakes one before the POST, and that drain finds the entry held and skips it. The
    // hold goes in the commit's own `finally`, and nothing said so — the write sat in the outbox
    // until something unrelated woke the sync (Grok pass 17, HIGH 1).
    const types: string[] = [];
    const had = "dispatchEvent" in globalThis;
    const original = (globalThis as { dispatchEvent?: unknown }).dispatchEvent;
    (globalThis as { dispatchEvent?: unknown }).dispatchEvent = (e: Event) => {
      types.push(e.type);
      return true;
    };
    try {
      const result = await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }), optimistic });
      expect(result).toEqual({ status: "queued" });
      // Every wake so far came from an `enqueue` while this commit still held the entry, so every
      // drain they woke skipped it. The one that counts arrives after the hold has gone.
      const whileHeld = types.filter((t) => t === OUTBOX_QUEUED_EVENT).length;
      await vi.waitFor(() => {
        expect(types.filter((t) => t === OUTBOX_QUEUED_EVENT).length).toBeGreaterThan(whileHeld);
      });
    } finally {
      if (had) (globalThis as { dispatchEvent?: unknown }).dispatchEvent = original;
      else delete (globalThis as { dispatchEvent?: unknown }).dispatchEvent;
    }
    // And the second wake is one a drain can act on: nothing holds the entry any more.
    expect(await isCommitting(ENTRY_ID)).toBe(false);
    const push = vi.fn(async (ops: { op_id: string }[]) => ({
      results: ops.map((op) => ({ op_id: op.op_id, status: "applied" as const, rev: 9, seq: 3 })),
      server_time: "2026-11-02T17:00:05.000Z",
    }));
    await drainOutbox(h, push as unknown as PushFn);
    expect(push).toHaveBeenCalledTimes(1);
  });
});

/**
 * Grok pass 2, HIGH 2: a commit that timed out and queued, then answered on a retry, left the op
 * behind. A `conflict` is the case that bites — the entity another device won is applied locally,
 * and the stale op would then be replayed against it.
 */
describe("a final answer drops the queued op", () => {
  const FINAL: [string, number, unknown][] = [
    ["conflict", 409, { status: "conflict", current_rev: 9,
      entity: { id: ENTRY_ID, rev: 9, items: [] } }],
    ["invalid", 422, { status: "invalid", issues: [] }],
    ["gone", 410, { status: "gone" }],
    ["deleted", 409, { status: "deleted", deleted_at: "2026-11-02T18:00:00.000Z" }],
    ["stale_revision", 409, { status: "stale_revision",
      food_ref_id: "cccccccc-3333-4333-8333-333333333333", revision_id: 7 }],
  ];

  it.each(FINAL)("drops it after a timeout answered %s", async (_name, status, body) => {
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, optimistic });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(status, body), optimistic });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    // The record goes with it for every refusal that keeps nothing. A conflict is the exception:
    // it keeps the entity the body handed back, and that one names no items, so the entry is
    // still waiting for a row something can edit.
    const stillPending = [...await pendingEntryIds()].includes(ENTRY_ID);
    expect(stillPending).toBe(_name === "conflict");
  });

  it("keeps it for a transient answer, which is the whole point of having one", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }), optimistic });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
  });
});

/**
 * Grok pass 2, MEDIUM 6: a 2xx means the server took it. The sheet said "could not log that"
 * beside a card that was staying — two statements about one entry, one of them false.
 */
describe("what the sheet is told", () => {
  it("reports success for a 2xx whose body could not be read", () => {
    const outcome = outcomeFor({ status: "accepted" });
    expect(outcome.keep).toBe(true);
    expect(outcome.message).toBe("Logged. The details will catch up in a moment.");
  });

  it("reports success for a conflict — the entry exists, another device got there first", () => {
    expect(outcomeFor({ status: "conflict", current_rev: 9, entity: {} })).toEqual({
      keep: true, message: "Logged. Another device had already changed this one.",
    });
  });

  it("still refuses what the server actually refused", () => {
    expect(outcomeFor({ status: "invalid", issues: [] }).keep).toBe(false);
    expect(outcomeFor({ status: "gone" }).keep).toBe(false);
  });

  it("hands the sheet `accepted` rather than a refusal when the body is unreadable", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json at all", {
      status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    const result = await commitLogEntry(REQ, { fetchImpl, optimistic });
    expect(result.status).toBe("accepted");
    expect(getDay(DATE)?.extras).toHaveLength(1);
  });
});

/** MEDIUM 8: the server's revision never goes onto the request's own items. */
describe("an answer with no items", () => {
  it("leaves the row without a revision rather than stamping one on our items", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }) });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown> | undefined;
    if (row === undefined) return;                      // the authoritative read may have won
    expect(row.rev).toBeNull();
  });
});

/**
 * Panel round 7, items 4 and 5.
 */
describe("a conflict's entity", () => {
  const entity = { id: ENTRY_ID, rev: 4, note: "other device", items: [
    { id: ITEM_ID, grams: 175, snapshot: { energy_kcal: { amount: 200 } } }] };

  it("puts its revision on the card, so Today can tell it from an unacknowledged entry", async () => {
    await commitLogEntry({ ...REQ, base_rev: 1 }, {
      fetchImpl: jsonFetch(409, { status: "conflict", current_rev: 4, entity }), optimistic,
    });
    expect(getDay(DATE)?.extras?.[0].rev).toBe(4);
  });

  it("brings the card's note and item numbers up with it", async () => {
    const card = { ...ENTRY, items: [{
      id: ITEM_ID, seq: 1, food_ref_id: REQ.items[0].food_ref_id, grams: 90, qty: 1, unit: "g",
      snapshot: {}, foodId: "rice", name: "Rice", portionLabel: "90 g", macros: ENTRY.macros,
    }] };
    await commitLogEntry({ ...REQ, base_rev: 1 }, {
      fetchImpl: jsonFetch(409, { status: "conflict", current_rev: 4, entity }),
      optimistic: { date: DATE, entry: card },
    });
    const logged = getDay(DATE)?.extras?.[0];
    expect(logged?.note).toBe("other device");
    expect(logged?.items?.[0].grams).toBe(175);
  });

  it("leaves an entry whose entity named no items still needing a row", async () => {
    // A conflict keeps what the body hands back, but an entity with no items is not a row the
    // note path can edit, so the record stays and the read-back settles it (Grok pass 5,
    // MEDIUM 4).
    readsServerRow(null);
    await commitLogEntry({ ...REQ, base_rev: 1 }, {
      fetchImpl: jsonFetch(409, { status: "conflict", current_rev: 4,
        entity: { id: ENTRY_ID, rev: 4, items: [] } }), optimistic,
    });
    expect(getDay(DATE)?.extras).toHaveLength(1);
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("is a refusal when settle threw partway through, because nothing was kept", async () => {
    // The rollback ran and then something after it threw. `kept` starting at true meant the sheet
    // was told "logged, another device got there first" over a card settle had just removed, and
    // the sheet put it back (Grok pass 5, MEDIUM 4). Anything short of a completed keep is a
    // refusal. Here `removeExtra` throws after the mirror has been rolled back.
    const store = await import("@/lib/store");
    const spy = vi.spyOn(store, "removeExtra").mockImplementation(() => {
      throw new Error("the store is gone");
    });
    const result = await commitLogEntry({ ...REQ, base_rev: 1 }, {
      fetchImpl: jsonFetch(409, { status: "conflict", current_rev: 4 }), optimistic,
    });
    spy.mockRestore();
    expect(outcomeFor(result).keep).toBe(false);
  });

  it("is a refusal when the body names no entity, because settle kept nothing", async () => {
    // `conflict` normally means "the entry exists, another device got there first", and the card
    // is brought up to the entity the body hands back. A 409 with no entity hands back nothing:
    // settle rolls the mirror back and takes the card out, so telling the sheet "keep it" puts
    // the card straight back on Today over a row that is gone (Grok pass 4, MEDIUM 4).
    const result = await commitLogEntry({ ...REQ, base_rev: 1 }, {
      fetchImpl: jsonFetch(409, { status: "conflict", current_rev: 4 }), optimistic,
    });
    expect(outcomeFor(result).keep).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });
});

describe("a 2xx with an empty object body", () => {
  it("is accepted: the card stays and the sheet is told it worked", async () => {
    const result = await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, {}), optimistic });
    expect(outcomeFor(result).keep).toBe(true);
    expect(getDay(DATE)?.extras).toHaveLength(1);
  });

  it("keeps the pending mark, replaces no items and takes no revision", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, {}), optimistic });
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
    expect(await allOps(h)).toHaveLength(0);
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBeNull();
    expect((row.items as { id: string }[])[0].id).toBe(ITEM_ID);
  });

  it("still lets a named 4xx refusal be a refusal", async () => {
    const result = await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(422, { status: "invalid", issues: [] }), optimistic });
    expect(outcomeFor(result).keep).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });
});

/**
 * Grok pass 3, HIGH 1: settle keyed on the HTTP status and `outcomeFor` keyed on the body's, so
 * the two could disagree about the same commit. A 4xx with an empty body rolled the card back and
 * dropped the op — a refusal — and then told the sheet "Logged", which put the card straight back
 * on Today: a meal the server had refused, sitting in her log.
 */
describe("settle and the sheet reach the same verdict", () => {
  it("keeps a 4xx whose body could not be read at all, and says so", async () => {
    // An answer nobody could read is not a refusal (Grok pass 26, HIGH 1) — and settle and the
    // sheet still say the same thing about it, which is what this file is here for: nothing was
    // taken back, and she is told it has not settled rather than that it was logged.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", {
      status: 422, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const result = await commitLogEntry(REQ, { fetchImpl, optimistic });

    expect(outcomeFor(result)).toEqual({
      keep: true, message: "Still saving. It will settle on the next sync." });
    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
    await expect(getRow(h, "log_entries", ENTRY_ID)).resolves.toBeDefined();
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("refuses a 4xx with an empty JSON body", async () => {
    const result = await commitLogEntry(REQ, { fetchImpl: jsonFetch(409, {}), optimistic });
    expect(outcomeFor(result).keep).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("accepts a 2xx that names a refusal in its body", async () => {
    readsServerRow(serverRow);
    const result = await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(200, { status: "invalid", issues: [] }), optimistic });

    expect(outcomeFor(result).keep).toBe(true);
    // And settle agreed: the card stayed and the queued op went.
    expect(getDay(DATE)?.extras).toHaveLength(1);
    expect(await allOps(h)).toHaveLength(0);
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });

  it("keeps a named 4xx refusal's own words", async () => {
    const result = await commitLogEntry(REQ, {
      fetchImpl: jsonFetch(422, { status: "invalid", issues: [] }), optimistic });
    expect(result.status).toBe("invalid");
    expect(outcomeFor(result)).toEqual({
      keep: false, message: "That food could not be logged as sent." });
  });

  it("still queues a transient 4xx rather than refusing it", async () => {
    const result = await commitLogEntry(REQ, { fetchImpl: jsonFetch(429, {}), optimistic });
    expect(result).toEqual({ status: "queued" });
    expect(getDay(DATE)?.extras).toHaveLength(1);
  });
});

/**
 * Grok pass 3, MEDIUM 3 and 4. The op is queued before the POST, so the drain can settle the same
 * entry the reply already settled — and it wrote `{...local, ...op.payload, rev}`, which is the
 * request's items under the server's revision, exactly the row HIGH 2 forbids. Separately, a
 * commit whose fetch timed out after the server had applied it drained as `duplicate`, which only
 * deleted the op: the card never settled and the mirror kept `rev: null`.
 */
/** The authoritative row, as `log_entries` + `log_items` come back through RLS. */
const serverRow = {
  id: ENTRY_ID, rev: 6, eaten_at: REQ.eaten_at, tz: REQ.tz, local_date: DATE, slot: "meal-2",
  method: "search", note: null,
  items: [{ id: ITEM_ID, entry_id: ENTRY_ID, seq: 1,
    food_ref_id: "cccccccc-3333-4333-8333-333333333333", qty: 1, unit: "g", grams: 175,
    portion_id: null, food_revision_id: null, was_edited: false, confidence: null,
    snapshot: {} }],
};

describe("the drain settles a log entry from the server, never from the request", () => {
  function push(status: "applied" | "duplicate"): PushFn {
    return async (ops) => ({
      results: ops.map((op) => status === "applied"
        ? { op_id: op.op_id, status: "applied" as const, rev: 9, seq: 3 }
        : { op_id: op.op_id, status: "duplicate" as const }),
      server_time: "2026-11-02T17:00:05.000Z",
    });
  }

  it("leaves the reply's own row alone when a drain lands on an entry already settled", async () => {
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    // Put an op back, as a stale drain would find one.
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, {}), optimistic });

    await drainOutbox(h, push("applied"));
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(6);
    expect((row.items as { grams: number }[])[0].grams).toBe(175);
  });

  it("settles a timed-out commit when the drain finds the server already had it", async () => {
    const timedOut = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: timedOut, optimistic });
    expect((await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>).rev).toBeNull();

    readsServerRow(serverRow);
    await drainOutbox(h, push("duplicate"));
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(6);
    expect(await pendingEntryIds()).not.toContain(ENTRY_ID);
  });

  it("leaves the row without a revision when the server cannot be read", async () => {
    const timedOut = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: timedOut, optimistic });
    readsServerRow(null);
    await drainOutbox(h, push("duplicate"));
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown> | undefined;
    expect(row?.rev ?? null).toBeNull();
  });

  it("leaves the card pending when it cannot read the entry back", async () => {
    // The op is gone — the server has the entry — but the mirror is still the local row with no
    // revision, which the note path and the coach's undo both refuse. A card that says "logged,
    // and settled" over a row nothing can edit is the lie this mark exists to prevent
    // (Grok pass 4, HIGH 2).
    const timedOut = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: timedOut, optimistic });
    readsServerRow(null);
    await drainOutbox(h, push("duplicate"));
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("brings the card up to the row it did read, not just the mirror", async () => {
    const timedOut = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: timedOut,
      optimistic: { date: DATE, entry: { ...ENTRY, items: [{ id: ITEM_ID, name: "Rice",
        grams: 100, macros: ENTRY.macros }] as LoggedFood["items"] } } });
    readsServerRow(serverRow);
    await drainOutbox(h, push("duplicate"));
    const card = getDay(DATE)?.extras?.[0];
    expect(card?.items?.[0].grams).toBe(175);
    expect(card?.rev).toBe(6);
  });
});

/**
 * Grok pass 4, HIGH 2: the pending mark is a claim about the MIRROR, not about the POST. Clearing
 * it over a row with no revision tells Today the entry is settled while the note path and the
 * coach's undo both still refuse it.
 */
describe("the pending mark follows the mirror", () => {
  it("stays on a 2xx whose entry could not be read back", async () => {
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("clears once the entry is in the mirror whole, with its revision", async () => {
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
  });

  it("reads the entry back even when the 2xx body was not contract-shaped", async () => {
    // `{status:"accepted"}` says the server has it and nothing else. The row is the only way to
    // learn what it has, so the read must still happen.
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { hello: "world" }), optimistic });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(6);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
  });

  it("takes no revision from a read-back row whose items came back thin", async () => {
    // `log_items` can hand back a null `snapshot` — `ok()` coalesces it on the wire, the raw
    // PostgREST row does not — and a revision over items like those is a row the note path
    // refuses, which is the refusal that rolls back a meal the server still holds. The predicate
    // is therefore asked of the authoritative row too (Grok pass 4, MEDIUM 3).
    readsServerRow({ ...serverRow, items: [{ ...serverRow.items[0], unit: null }] });
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBeNull();
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("still takes a row whose snapshot came back null, coalesced as the wire coalesces it", async () => {
    readsServerRow({ ...serverRow, items: [{ ...serverRow.items[0], snapshot: null }] });
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(6);
    expect((row.items as { snapshot: unknown }[])[0].snapshot).toEqual({});
  });

  it("promotes a record no live commit owns, rather than marking it for ever", async () => {
    // The page died between the write and the answer — or after the 2xx dropped the queued change
    // and before the record was cleared. Nothing is posting it and nothing will: the retry took
    // only `needs_reconcile`, so Today drew the pending dot for good and she logged the meal
    // again (Grok pass 7, HIGH 1).
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });

    // The kill: fresh modules over the same database, so no live commit holds the entry. A real
    // reload also rebinds the account, which is what the fresh helper import below does.
    vi.resetModules();
    const { resetTestAccount: freshReset } = await import("@/tests/helpers/account");
    const freshH = await freshReset();
    const fresh = await import("@/lib/log/reconcile");
    readsServerRow(serverRow);
    const before = reads;
    await fresh.retryPendingReconciles(freshH);
    expect(reads).toBeGreaterThan(before);
    const today = await import("@/lib/log/today-state");
    expect(await today.pendingIds(freshH)).not.toContain(ENTRY_ID);
  });

  it("does not read the row this commit was meant to replace as proof it landed", async () => {
    // An edit: the mirror holds the entry at rev 3 and this commit was to make rev 4. The page
    // died mid-post and the mirror write never happened, so the complete row still sitting there
    // is the OLD one — evidence of the previous commit, not of this one (Grok pass 8, MEDIUM 1).
    await putRow(h, "log_entries", ENTRY_ID, { ...serverRow, rev: 3 });
    // The record goes down first, and the page dies before the mirror write replaces that row.
    await markInFlight(h, ENTRY_ID, h.userId, { request: { ...REQ, base_rev: 3 }, baseRev: 3 });

    readsServerRow(null);
    await retryPendingReconciles(h);
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
    expect((await readPending(h))[0].state).toBe("needs_reconcile");
  });

  it("takes the base revision from the request, not from a mirror read that can fail", async () => {
    // The mirror read is best effort — a blocked database answers nothing — and reading `null`
    // there turned an edit into "any complete row is mine". The request already says what this
    // commit is based on (Grok pass 9, HIGH 3).
    await putRow(h, "log_entries", ENTRY_ID, { ...serverRow, rev: 3 });
    const idb = await import("@/lib/sync/idb");
    const blocked = vi.spyOn(idb, "getRow").mockRejectedValue(new Error("blocked"));
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry({ ...REQ, base_rev: 3 }, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });
    blocked.mockRestore();
    resetLiveCommits();
    for (const op of await allOps(h)) await deleteOp(h, op.op_id);

    readsServerRow(null);
    await retryPendingReconciles(h);
    expect((await readPending(h))[0].state).toBe("needs_reconcile");
  });

  it("clears an orphaned record outright when the mirror already holds the entry", async () => {
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    // Settled, then marked again as if the process had died before the record was cleared.
    await markInFlight(h, ENTRY_ID, "user-a");
    resetLiveCommits();

    const before = reads;
    await retryPendingReconciles(h);
    expect(reads).toBe(before);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
  });

  it("survives the page being killed: the record is on disk, not in the heap", async () => {
    // The whole point of the record. A 2xx whose read-back failed, then the app is closed — the
    // module state goes with it, and the entry must still be reconciled on the next sync
    // (Grok pass 5, HIGH 1). `resetModules` is that kill: the same IndexedDB, fresh modules.
    const post = vi.fn(async () => new Response(JSON.stringify({ status: "ok", rev: 7 }),
      { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: post, optimistic });

    vi.resetModules();
    const { resetTestAccount: freshReset } = await import("@/tests/helpers/account");
    const freshH = await freshReset();
    const fresh = await import("@/lib/log-commit-client");
    expect([...await fresh.pendingEntryIds(freshH)]).toContain(ENTRY_ID);

    readsServerRow(serverRow);
    await fresh.retryPendingReconciles(freshH);
    expect([...await fresh.pendingEntryIds(freshH)]).not.toContain(ENTRY_ID);
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(6);
  });

  it("holds the drain off an entry whose commit is still posting", async () => {
    // The op is queued BEFORE the post, and `enqueue` wakes the sync. A drain landing in that
    // window settled the same entry from the other side: it read the row back and cleared the
    // record while the POST was still open, so a 4xx on the live POST then rolled back a row the
    // drain had just confirmed (Grok pass 6, HIGH 1). The live POST owns the entry until it
    // settles; until then the op stays due and untouched.
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    for (let i = 0; i < 50 && (await allOps(h)).length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const before = reads;
    const push = vi.fn(async () => ({ results: [], server_time: "2026-11-02T17:00:05.000Z" }));
    await drainOutbox(h, push as unknown as PushFn);
    expect(push).not.toHaveBeenCalled();
    expect(reads).toBe(before);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
  });

  it("hands the drain the write a killed page left behind, on the next launch", async () => {
    // The page was killed mid-POST. Nothing is posting that entry any more — no process holds it
    // — so the next launch must send the queued change at once. Standing off a durable record
    // would wait on a request that no longer exists anywhere (panel round 15).
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect((await allOps(h)).length).toBe(1); });

    // The kill: fresh modules over the same IndexedDB, so the record survives and the live map
    // does not. A real reload also rebinds the account.
    vi.resetModules();
    const { resetTestAccount: freshReset } = await import("@/tests/helpers/account");
    const freshH = await freshReset();
    const outbox = await import("@/lib/sync/outbox");
    readsServerRow(serverRow);
    const push = vi.fn(async (ops: { op_id: string }[]) => ({
      results: ops.map((op) => ({ op_id: op.op_id, status: "applied" as const, rev: 9, seq: 3 })),
      server_time: "2026-11-02T17:00:05.000Z",
    }));
    await outbox.drainOutbox(freshH, push as unknown as PushFn);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toHaveLength(1);
    const { allOps: freshAllOps } = await import("@/lib/sync/idb");
    expect(await freshAllOps(freshH)).toHaveLength(0);
  });

  it("lets the drain have the op once the commit has settled", async () => {
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }), optimistic });
    readsServerRow(serverRow);
    const push = vi.fn(async (ops: { op_id: string }[]) => ({
      results: ops.map((op) => ({ op_id: op.op_id, status: "applied" as const, rev: 9, seq: 3 })),
      server_time: "2026-11-02T17:00:05.000Z",
    }));
    await drainOutbox(h, push as unknown as PushFn);
    expect(push).toHaveBeenCalledTimes(1);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
  });

  it("never touches an entry whose commit is still posting", async () => {
    // A sync landing in the middle of a commit must not read a half-written entry back over the
    // optimistic row the commit is about to settle itself (Grok pass 5, HIGH 3).
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    // The record is written before the POST; wait for it rather than for a fixed number of turns.
    for (let i = 0; i < 50 && !(await pendingEntryIds()).has(ENTRY_ID); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);

    readsServerRow(serverRow);
    const before = reads;
    await retryPendingReconciles(h);
    expect(reads).toBe(before);
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBeNull();
  });

  it("reads nothing for a record another account left behind", async () => {
    // Ownership now comes from the bound account handle, not the session claim, so a foreign
    // owner can only be the shape legacy adoption leaves in THIS account's own database (spec
    // §0.6) — set up directly, since a commit under this account can never mint one.
    await markNeedsReconcile(h, ENTRY_ID, "user-b");
    readsServerRow(serverRow);
    const before = reads;
    await retryPendingReconciles(h);
    expect(reads).toBe(before);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
  });

  it("keeps trying after a read that found no row — lag is not an answer", async () => {
    // `maybeSingle()` answering null is replica lag and a JWT blip as often as it is a deletion.
    // Clearing the record over two of those left her with a 0 kcal meal the server holds, marked
    // final and never read again (Grok pass 6, HIGH 2).
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    await retryPendingReconciles(h);
    await retryPendingReconciles(h);
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);

    readsServerRow(serverRow);
    await retryPendingReconciles(h);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
    expect((await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>).rev).toBe(6);
  });

  it("keeps a write the server never took apart from one it did", async () => {
    // The page died mid-post and the queued change never made it either, so nothing ever saw the
    // server take this entry. Every read misses, the record caps — and a card that says "logged"
    // over it means she never retries (Grok pass 8, HIGH 2).
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });
    for (const op of await allOps(h)) await deleteOp(h, op.op_id);
    resetLiveCommits();

    readsServerRow(null);
    for (let i = 0; i < MAX_ATTEMPTS * 2; i += 1) {
      await retryPendingReconciles(h, () => Date.now() + i * DAY_MS);
    }
    const states = await logEntryStates();
    expect([...states.unsaved]).toContain(ENTRY_ID);
    expect([...states.stale]).not.toContain(ENTRY_ID);
  });

  it("forgets the record when she takes the card off the day herself", async () => {
    // Her delete is the last word on an entry she can see: nothing should keep asking about it,
    // and the request kept for a retry she will never tap is dead weight (Grok pass 9, MEDIUM 5).
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);

    // The server says it has a tombstone for this entry: the one answer that ends the matter.
    readsServerRow({ ...serverRow, deleted_at: "2026-11-02T18:00:00.000Z" });
    await forgetLoggedEntry(DATE, ENTRY_ID);
    expect(await readPending(h)).toHaveLength(0);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("keeps nothing to re-send for a delete the server has not answered about", async () => {
    // The same delete when the read comes back empty: the record stays, because an empty read is
    // not proof — but it is a `deleted` record, which draws nothing and offers no retry.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });

    await forgetLoggedEntry(DATE, ENTRY_ID);
    const record = (await readPending(h))[0];
    expect(record.state).toBe("deleted");
    expect(record.request).toBeUndefined();
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("keeps a conflicted commit whose body never arrived", async () => {
    // A 409 says the row exists. If its body times out, the answer is unknown, not a refusal —
    // and taking the card back, dropping the queued write and rolling the mirror back erases a
    // meal the server holds, which the next pull then restores (Grok pass 26, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await commitLogEntry(REQ, { fetchImpl: unreadable(409), optimistic });

    expect(outcomeFor(result).keep).toBe(true);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
    const record = (await readPending(h))[0];
    expect(record.confirmed).toBe(true);
    expect(record.state).toBe("needs_reconcile");
  });

  it("leaves no queued write behind a conflict nobody could read", async () => {
    // The write queued before the POST is this commit's retry, and the server has answered it.
    // Leaving it in the outbox had the drain send the very request the route refused — and the
    // wake in the commit's own `finally` set it going (Grok pass 27, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await commitLogEntry(REQ, { fetchImpl: unreadable(409), optimistic });

    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    const record = (await readPending(h))[0];
    expect(record.confirmed).toBe(true);
    expect(record.state).toBe("needs_reconcile");
  });

  it("honours a tombstone nobody could read, and does not send the write again", async () => {
    // Another device deleted the entry while this commit was posting, so the route answers 410 —
    // and with a body this phone could not read. Keeping the queued write meant the drain sent it,
    // the generic rule rewrote the refused update as a create, and the meal she no longer has came
    // back (Grok pass 27, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await commitLogEntry(REQ, { fetchImpl: unreadable(410), optimistic });

    expect(outcomeFor(result).keep).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect(await getRow(h, "log_entries", ENTRY_ID)).toBeUndefined();
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);

    // And nothing brings it back: the drain has nothing to send, and the catch-up nothing to ask.
    const push = vi.fn(async () => ({ results: [], server_time: "2026-11-02T17:00:05.000Z" }));
    await drainOutbox(h, push as unknown as PushFn);
    expect(push).not.toHaveBeenCalled();
    readsServerRow(serverRow);
    await retryPendingReconciles(h);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("keeps a refused commit whose body never arrived", async () => {
    // Any other 4xx with a body nobody could read is the same unknown: nothing local is taken
    // back, and the catch-up asks the server (Grok pass 26, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await commitLogEntry(REQ, { fetchImpl: unreadable(422), optimistic });

    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
    expect(await getRow(h, "log_entries", ENTRY_ID)).toBeDefined();
    const record = (await readPending(h))[0];
    expect(record.confirmed).toBe(false);
    expect(record.request).toBeTruthy();
    expect(outcomeFor(result).keep).toBe(true);
  });

  it("asks the server nothing about a food that was never on it", async () => {
    // A bundled pick or one of her own foods goes straight onto the day: no commit, no record, no
    // queued write, no mirrored row. Making a tombstone for one asked the server about an entry it
    // has never heard of, twenty times over, and kept a record that draws nothing (pass 25, LOW 5).
    const LOCAL_ID = "eeeeeeee-5555-4555-8555-555555555555";
    upsertExtra(DATE, { ...ENTRY, id: LOCAL_ID });
    const before = reads;

    await forgetLoggedEntry(DATE, LOCAL_ID);

    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect(await readPending(h)).toHaveLength(0);
    expect(reads).toBe(before);
  });

  it("takes the queued write with the card when she deletes it", async () => {
    // Her delete is the last word. The write queued before the POST was left in the outbox, so the
    // drain created the meal anyway and the next pull put it back on Today (Grok pass 11, HIGH 2).
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(503, { error: "down" }), optimistic });
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);

    await forgetLoggedEntry(DATE, ENTRY_ID);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    expect(await getRow(h, "log_entries", ENTRY_ID)).toBeUndefined();
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("asks the server to delete an entry it has already taken", async () => {
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    expect(await allOps(h)).toHaveLength(0);

    await forgetLoggedEntry(DATE, ENTRY_ID);
    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("delete");
    expect(ops[0].base_rev).toBe(6);
  });

  it("applies a delete she made while the commit was still posting", async () => {
    let answer!: (res: Response) => void;
    const held = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;
    const commit = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    await forgetLoggedEntry(DATE, ENTRY_ID);
    readsServerRow(serverRow);
    answer(new Response(JSON.stringify(OK), { status: 200,
      headers: { "content-type": "application/json" } }));
    await commit;

    // The card does not come back, and the server is told to drop the entry it just took.
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(await getRow(h, "log_entries", ENTRY_ID)).toBeUndefined();
  });

  it("never re-queues the create for an entry she deleted mid-post", async () => {
    // A timeout or a 5xx goes to the outbox, and the outbox write happens AFTER her delete: the
    // drain then recreated the meal she had just removed (Grok pass 12, HIGH 1).
    let fail!: (e: unknown) => void;
    const held = vi.fn(() => new Promise<Response>((_res, reject) => { fail = reject; })) as unknown as typeof fetch;
    const commit = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    await forgetLoggedEntry(DATE, ENTRY_ID);
    fail(new TypeError("Failed to fetch"));
    await commit;

    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("puts no card back through the sheet after honouring her delete", async () => {
    // Settling a delete and then answering `queued` told the sheet the meal was on its way, so it
    // ran its own `onAdd` and `upsertExtra` put the deleted meal straight back on the day — with
    // no queued write behind it and maybe no server row either (Grok pass 15, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let refuse!: (res: Response) => void;
    const held = vi.fn(() => new Promise<Response>((resolve) => { refuse = resolve; })) as unknown as typeof fetch;
    const commit = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    await forgetLoggedEntry(DATE, ENTRY_ID);
    refuse(new Response(JSON.stringify({ error: "down" }), { status: 503,
      headers: { "content-type": "application/json" } }));
    const result = await commit;

    // Exactly what Log a food and Log a meal do with the answer.
    const outcome = outcomeFor(result);
    if (outcome.keep) upsertExtra(DATE, committedEntry(DATE, ENTRY));
    expect(outcome.keep).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
  });

  it("honours a delete that lands while the settle is reading the row back", async () => {
    // The read-back after a 2xx is a network hop, and her delete in another tab lands inside it:
    // `finishDelete` sees this commit still holding the entry and leaves the server delete to it.
    // The settle then patched the card back on, cleared the record and answered `ok`, so the
    // sheet added the meal again and the server kept it (Grok pass 19, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let deletedAlready = false;
    reader(async () => {
      if (!deletedAlready) {
        deletedAlready = true;
        await forgetLoggedEntry(DATE, ENTRY_ID);
      }
      return serverRow;
    });

    const result = await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });

    expect(result).toEqual({ status: "discarded" });
    expect(outcomeFor(result).keep).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect(await getRow(h, "log_entries", ENTRY_ID)).toBeUndefined();
    // And the server is still told: the delete is queued at the revision it answered with.
    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
  });

  it("asks the server to drop an entry a conflict proved it has", async () => {
    let refuse!: (res: Response) => void;
    const held = vi.fn(() => new Promise<Response>((resolve) => { refuse = resolve; })) as unknown as typeof fetch;
    const commit = commitLogEntry({ ...REQ, base_rev: 1 }, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    await forgetLoggedEntry(DATE, ENTRY_ID);
    readsServerRow(serverRow);
    refuse(new Response(JSON.stringify({ status: "conflict", current_rev: 6,
      entity: { ...serverRow } }), { status: 409, headers: { "content-type": "application/json" } }));
    await commit;

    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("honours a delete another tab recorded while this one was posting", async () => {
    let answer!: (res: Response) => void;
    const held = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;
    const commit = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    // The other tab writes the record; this heap knows nothing but what IndexedDB says.
    await markDeleted(h, ENTRY_ID);
    readsServerRow(serverRow);
    answer(new Response(JSON.stringify(OK), { status: 200,
      headers: { "content-type": "application/json" } }));
    await commit;

    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    expect((await allOps(h)).map((o) => o.kind)).toEqual(["delete"]);
  });

  it("finishes a delete it could not aim the first time", async () => {
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });

    // She deletes while the phone cannot reach the server, so the revision to aim the delete at
    // cannot be read. The record waits rather than queuing a delete at no revision.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reader(async () => { throw new Error("offline"); });
    await forgetLoggedEntry(DATE, ENTRY_ID);
    expect(await allOps(h)).toHaveLength(0);
    expect((await readPending(h))[0].state).toBe("deleted");

    readsServerRow(serverRow);
    await retryPendingReconciles(h);
    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(ops[0].base_rev).toBe(6);
    expect(await readPending(h)).toHaveLength(0);
  });

  it("keeps a delete the server answered nothing about", async () => {
    // A read that comes back with no row is replica lag, or the window after a POST the client
    // never heard about, as often as it is a deletion. Treating it as "the server has nothing"
    // cleared the durable tombstone AND queued no delete, so the next pull put the meal she had
    // removed straight back on Today (Grok pass 14, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });

    readsServerRow(null);
    await forgetLoggedEntry(DATE, ENTRY_ID);
    expect(await allOps(h)).toHaveLength(0);
    expect((await readPending(h))[0].state).toBe("deleted");

    // The row is visible on the next pass, and the delete goes out then.
    readsServerRow(serverRow);
    await retryPendingReconciles(h);
    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(ops[0].base_rev).toBe(6);
    expect(await readPending(h)).toHaveLength(0);
  });

  it("draws nothing at all for an entry she has deleted", async () => {
    // The tombstone now outlives her delete until the server is told, and every record was
    // reported to Today as a save in progress — so the meal she took off the day came back as a
    // pending card (panel round 13).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });

    reader(async () => { throw new Error("offline"); });
    await forgetLoggedEntry(DATE, ENTRY_ID);
    expect((await readPending(h))[0].state).toBe("deleted");

    const states = await logEntryStates();
    expect([...states.pending, ...states.stale, ...states.unsaved, ...states.lost]).toEqual([]);
    expect([...await pendingEntryIds()]).toEqual([]);

    // And still nothing once the reads run out: giving up on telling the server is not a state
    // the card has ever had a word for.
    for (let i = 0; i < MAX_ATTEMPTS * 2; i += 1) {
      await retryPendingReconciles(h, () => Date.now() + i * DAY_MS);
    }
    const capped = await logEntryStates();
    expect([...capped.pending, ...capped.stale, ...capped.unsaved, ...capped.lost]).toEqual([]);
    expect(await isDeleted(h, ENTRY_ID)).toBe(true);
  });

  it("retires a delete the server already holds a tombstone for", async () => {
    // The one answer that IS proof: a `deleted_at` row. Nothing left to tell the server.
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });

    readsServerRow({ ...serverRow, deleted_at: "2026-11-02T18:00:00.000Z" });
    await forgetLoggedEntry(DATE, ENTRY_ID);
    expect(await readPending(h)).toHaveLength(0);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
  });

  it("asks the server about a delete nothing ever confirmed", async () => {
    // `confirmed` is false for an in-flight create — the mirror has no revision yet — so a delete
    // during an open POST that then times out cleared the tombstone and never asked. The server
    // kept the meal and the next pull put it back (Grok pass 13, HIGH 1).
    let fail!: (e: unknown) => void;
    const held = vi.fn(() => new Promise<Response>((_res, reject) => { fail = reject; })) as unknown as typeof fetch;
    const commit = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    await forgetLoggedEntry(DATE, ENTRY_ID);
    // The server did take it, whatever this phone managed to hear.
    readsServerRow(serverRow);
    fail(new TypeError("Failed to fetch"));
    await commit;

    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(ops[0].base_rev).toBe(6);
    expect(await readPending(h)).toHaveLength(0);
  });

  it("re-aims a delete the server refused, and never turns it back into the meal", async () => {
    // A delete op that conflicts used to be merged with the server's row: the mirror got the
    // entry back and the op was re-queued carrying it. Her delete must survive a stale revision
    // (Grok pass 12, HIGH 2).
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    await forgetLoggedEntry(DATE, ENTRY_ID);
    expect((await allOps(h)).map((o) => o.kind)).toEqual(["delete"]);

    const push: PushFn = async (ops) => ({
      results: ops.map((op) => ({ op_id: op.op_id, status: "conflict" as const,
        entity: "log_entries" as const, current_rev: 9, current: { ...serverRow, rev: 9 } })),
      server_time: "2026-11-02T17:00:05.000Z",
    });
    await drainOutbox(h, push);

    const ops = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID);
    expect(ops.map((o) => o.kind)).toEqual(["delete"]);
    expect(ops[0].base_rev).toBe(9);
    expect(await getRow(h, "log_entries", ENTRY_ID)).toBeUndefined();
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("backs a re-aimed delete off rather than looping on a busy row", async () => {
    // A rebase that starts over with no attempts and a due time of now is a tight
    // conflict → rebase → drain loop against a row another device keeps changing
    // (Grok pass 13, MEDIUM 4).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    await forgetLoggedEntry(DATE, ENTRY_ID);

    const refuse = (rev: number): PushFn => async (ops) => ({
      results: ops.map((op) => ({ op_id: op.op_id, status: "conflict" as const,
        entity: "log_entries" as const, current_rev: rev, current: { ...serverRow, rev } })),
      server_time: "2026-11-02T17:00:05.000Z",
    });

    await drainOutbox(h, refuse(9));
    const first = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)[0];
    expect(first.kind).toBe("delete");

    await drainOutbox(h, refuse(10), () => Date.now() + 60_000);
    const second = (await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)[0];
    expect(second.kind).toBe("delete");
    expect(second.base_rev).toBe(10);
    // It carries what it has already cost, and it is not due again this instant.
    expect(second.error_attempts ?? 0).toBeGreaterThan(first.error_attempts ?? 0);
    expect(second.next_attempt_at).toBeGreaterThan(Date.now());
  });

  it("stops asking the server about a delete it can never aim", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    readsServerRow(serverRow);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    reader(async () => { throw new Error("offline"); });
    await forgetLoggedEntry(DATE, ENTRY_ID);

    const before = reads;
    for (let i = 0; i < MAX_ATTEMPTS * 2; i += 1) {
      await retryPendingReconciles(h, () => Date.now() + i * DAY_MS);
    }
    const spent = reads - before;
    expect(spent).toBeLessThanOrEqual(MAX_ATTEMPTS);
    const after = reads;
    await retryPendingReconciles(h, () => Date.now() + 999 * DAY_MS);
    expect(reads).toBe(after);
    // The record stays her delete rather than becoming a state the card has words for: nothing
    // may draw this entry again, whatever the server was never told (panel round 13).
    expect((await readPending(h))[0].state).toBe("deleted");
    expect(await isDeleted(h, ENTRY_ID)).toBe(true);
  });

  it("refuses to retry an entry the server says is deleted", async () => {
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });
    // `isInFlight` only proves `recordFirst`'s mark landed. The commit's own `writeLocalFirst`
    // keeps going after that — queuing the op, then mirroring its own (not-deleted) optimistic
    // row — and it is still in flight here because `hangs` only blocks the POST, which comes
    // after it. Racing that write with the deleted_at put below let the commit's later write win
    // and put the row back without `deleted_at`, so the retry went on to post (flaky under load).
    await vi.waitFor(async () => { expect(await getRow(h, "log_entries", ENTRY_ID)).toBeDefined(); });
    resetLiveCommits();
    await putRow(h, "log_entries", ENTRY_ID, { ...serverRow, deleted_at: "2026-11-02T18:00:00.000Z" });

    const posts = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await retryUnsavedCommit(ENTRY_ID, { fetchImpl: posts })).toBeNull();
    expect(posts).not.toHaveBeenCalled();
  });

  it("posts her retry instead of joining a commit that has stopped posting", async () => {
    // One definition of "still posting", for the drain and for the card's own retry. `isCommitting`
    // stops believing a hold past the budget, but `joinCommit` went on handing out its promise, so
    // the tap joined a commit that would never post again and simply hung (pass 25, MEDIUM 3).
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });

    const later = Date.now() + HOLD_BUDGET_MS + 1_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      expect(await isCommitting(ENTRY_ID)).toBe(false);
      const posts = vi.fn(async () => new Response(JSON.stringify(OK),
        { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

      await retryUnsavedCommit(ENTRY_ID, { fetchImpl: posts });

      expect(posts).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("calls a record lost the moment its request is dropped", async () => {
    // `bounded` stripped the request and left the state alone, so the card drew the pending mark
    // for ever and `lost` was only reachable after twenty misses (Grok pass 11, MEDIUM 3).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids: string[] = [];
    for (let i = 0; i < MAX_UNCONFIRMED + 1; i += 1) {
      const id = `ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`;
      ids.push(id);
      await markInFlight(h, id, "user-a", { request: { ...REQ, entry_id: id }, baseRev: 0 });
      await markNeedsReconcile(h, id, "user-a");
    }
    const states = await logEntryStates();
    expect([...states.lost]).toEqual([ids[0]]);
    expect([...states.pending]).not.toContain(ids[0]);
  });

  it("does not offer a retry it cannot honour", async () => {
    // Past the cap the oldest requests are dropped, and the card went on saying "tap to try
    // again" over a record with nothing left to send: the tap did nothing at all
    // (Grok pass 10, HIGH 1).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids: string[] = [];
    for (let i = 0; i < MAX_UNCONFIRMED + 1; i += 1) {
      const id = `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`;
      ids.push(id);
      await markInFlight(h, id, "user-a", { request: { ...REQ, entry_id: id }, baseRev: 0 });
      await markNeedsReconcile(h, id, "user-a");
      await capRecord(id);
    }

    const states = await logEntryStates();
    expect([...states.lost]).toEqual([ids[0]]);
    expect([...states.unsaved]).not.toContain(ids[0]);
    expect([...states.unsaved]).toContain(ids[ids.length - 1]);

    const posts = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await retryUnsavedCommit(ids[0], { fetchImpl: posts })).toBeNull();
    expect(posts).not.toHaveBeenCalled();
    // MAX_UNCONFIRMED + 1 ids, each capped (MAX_ATTEMPTS reads apiece): over a thousand awaited
    // fake-indexeddb round trips. ~360ms alone, but under the full suite's default parallelism —
    // many worker processes contending for CPU — that stretched past 5s (observed flake).
  }, 15_000);

  it("keeps only so many unsaved requests, and says when it drops one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < MAX_UNCONFIRMED + 3; i += 1) {
      const id = `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await markInFlight(h, id, "user-a", { request: { ...REQ, entry_id: id }, baseRev: 0 });
    }
    const kept = (await readPending(h)).filter((r) => r.request !== undefined);
    expect(kept.length).toBeLessThanOrEqual(MAX_UNCONFIRMED);
    expect(warn.mock.calls.some(([m]) => /unsaved/i.test(String(m)))).toBe(true);
  });

  it("refuses to retry an entry a commit is already posting", async () => {
    // The card's retry control and a live commit are two ways to send the same entry. While one
    // is in the air the other must do nothing (Grok pass 9, HIGH 2).
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });

    const posts = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await retryUnsavedCommit(ENTRY_ID, { fetchImpl: posts })).toBeNull();
    expect(posts).not.toHaveBeenCalled();
  });

  it("can post an unsaved entry again from what the record kept", async () => {
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });
    for (const op of await allOps(h)) await deleteOp(h, op.op_id);
    resetLiveCommits();

    readsServerRow(serverRow);
    const posts = vi.fn(async () => new Response(JSON.stringify(OK), { status: 200,
      headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await retryUnsavedCommit(ENTRY_ID, { fetchImpl: posts });
    expect(posts).toHaveBeenCalledTimes(1);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
  });

  it("hands the retry's caller the server's nutrition_unchecked", async () => {
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await isInFlight(h, ENTRY_ID)).toBe(true); });
    for (const op of await allOps(h)) await deleteOp(h, op.op_id);
    resetLiveCommits();

    readsServerRow(serverRow);
    const posts = vi.fn(async () => new Response(JSON.stringify({ ...OK, nutrition_unchecked: true }),
      { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const result = await retryUnsavedCommit(ENTRY_ID, { fetchImpl: posts });
    expect(commitNutritionUnchecked(result)).toBe(true);
  });

  it("tells Today a capped entry is logged, not that it is still saving", async () => {
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    for (let i = 0; i < MAX_ATTEMPTS * 2; i += 1) {
      await retryPendingReconciles(h, () => Date.now() + i * DAY_MS);
    }
    const states = await logEntryStates();
    expect([...states.stale]).toContain(ENTRY_ID);
    expect([...states.pending]).not.toContain(ENTRY_ID);
  });

  it("stops reading after the cap, and still says the entry is not settled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    // Far more syncs than the cap, each a day later so the spacing never masks the cap.
    for (let i = 0; i < MAX_ATTEMPTS * 2; i += 1) {
      await retryPendingReconciles(h, () => Date.now() + i * DAY_MS);
    }
    const after = reads;
    expect(after).toBeLessThanOrEqual(MAX_ATTEMPTS + 1);
    await retryPendingReconciles(h, () => Date.now() + 999 * DAY_MS);
    expect(reads).toBe(after);
    // The card is still hers and still pending: nothing here may quietly call it final.
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
    expect(getDay(DATE)?.extras).toHaveLength(1);
    expect(warn.mock.calls.some(([m]) => /gave up|stopped/i.test(String(m)))).toBe(true);
  });

  it("spaces its reads out rather than reading on every sync", async () => {
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    const before = reads;
    // Twenty syncs in the same instant — a busy morning of opens, focuses and `online` events.
    for (let i = 0; i < 20; i += 1) await retryPendingReconciles(h);
    // The first few are every sync; after that the gaps double, so the rest cost nothing.
    expect(reads - before).toBeLessThanOrEqual(FREE_ATTEMPTS + 1);
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("clears the record and the card when the server says the entry is deleted", async () => {
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    readsServerRow({ ...serverRow, deleted_at: "2026-11-02T18:00:00.000Z" });
    await retryPendingReconciles(h);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
    // A tombstone is the server's last word on this entry: no later sync asks about it again.
    const after = reads;
    await retryPendingReconciles(h);
    await retryPendingReconciles(h);
    expect(reads).toBe(after);
  });

  it("does not re-mark an entry the commit's own read found tombstoned", async () => {
    // The read-back answered a deleted row, so the record was retired and the mirror row deleted —
    // and then the settle asked the mirror whether it was complete, found nothing there, and made
    // the record again. The entry was off Today and marked pending at the same time, and the next
    // sync read it once more (panel round 13).
    readsServerRow({ ...serverRow, deleted_at: "2026-11-02T18:00:00.000Z" });
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);

    const after = reads;
    await retryPendingReconciles(h);
    await retryPendingReconciles(h);
    expect(reads).toBe(after);
  });

  it("tells the sheet nothing was kept when the read-back finds a tombstone", async () => {
    // The commit still answered with the server's `ok`, so the sheet added the card back through
    // its own `onAdd` — over an entry the server has already deleted, which no pull will ever
    // take off Today again (Grok pass 20, HIGH 2).
    readsServerRow({ ...serverRow, deleted_at: "2026-11-02T18:00:00.000Z" });

    const result = await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, OK), optimistic });

    expect(result).toEqual({ status: "discarded" });
    // Exactly what Log a food and Log a meal do with the answer.
    const outcome = outcomeFor(result);
    if (outcome.keep) upsertExtra(DATE, committedEntry(DATE, ENTRY));
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });

  it("is retried by the catch-up a successful sync licenses, without posting again", async () => {
    const post = vi.fn(async () => new Response(JSON.stringify({ status: "ok", rev: 7 }),
      { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: post, optimistic });
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);

    readsServerRow(serverRow);
    await retryPendingReconciles(h);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
    expect((post as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

/**
 * Grok pass 6, MEDIUM 4: the claim is a snapshot, and the world moves while a pass is running.
 */
describe("a retry pass that overlaps a commit", () => {
  it("does not read an entry a commit claimed after the pass had started", async () => {
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });

    // A second entry, also waiting, and a tap that lands while the pass is reading the first one.
    const other = "eeeeeeee-7777-4777-8777-777777777777";
    await commitLogEntry({ ...REQ, entry_id: other },
      { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }) });
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    let tapped = false;
    reader(async () => {
      if (!tapped) {
        tapped = true;
        void commitLogEntry({ ...REQ, entry_id: other }, { fetchImpl: hangs });
        await vi.waitFor(async () => { expect(await isInFlight(h, other)).toBe(true); });
      }
      return null;
    });

    const before = reads;
    await retryPendingReconciles(h);
    // The first record is read; the second is not, because a commit owns it by then.
    expect(reads - before).toBe(1);
  });

  it("lets go of an entry whose own local write hung, so the next tap can post", async () => {
    // The hold is meant to last as long as the request. A commit that never reaches its POST —
    // a blocked IndexedDB, a write that never settles — held the entry for the life of the page
    // and every later commit joined a promise that would never answer (Grok pass 8, LOW 1).
    vi.useFakeTimers();
    try {
      const idb = await import("@/lib/sync/idb");
      const stuck = vi.spyOn(idb, "putRow").mockImplementation(() => new Promise<void>(() => {}));
      const never = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
      void commitLogEntry(REQ, { fetchImpl: never, optimistic });
      await vi.advanceTimersByTimeAsync(HOLD_BUDGET_MS + 1000);
      stuck.mockRestore();

      expect(await isCommitting(ENTRY_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not roll back a row another attempt has already settled", async () => {
    // Two attempts at one entry — the second from another tab, or from the retry control. The
    // second landed and its row is in the mirror; this one's refusal must not put the old row
    // back and take her meal off Today (Grok pass 9, HIGH 2).
    let refuse!: (res: Response) => void;
    const held = vi.fn(() => new Promise<Response>((resolve) => { refuse = resolve; })) as unknown as typeof fetch;
    const first = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });

    // The other attempt settles from the server while this one is still in the air.
    readsServerRow(serverRow);
    await reconcileFromServer(h, ENTRY_ID);
    expect((await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>).rev).toBe(6);

    refuse(new Response(JSON.stringify({ status: "invalid", issues: [] }), { status: 422,
      headers: { "content-type": "application/json" } }));
    await first;

    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(6);
    expect(getDay(DATE)?.extras).toHaveLength(1);
  });

  it("sends one POST when two commits for one entry overlap", async () => {
    // A double tap, or a retry fired while the first is still in the air. Two POSTs meant two
    // settle paths racing on one entry — and a second queued change for a commit that already had
    // one (panel round 15). The second call joins the first and gets its answer.
    let release!: (res: Response) => void;
    const held = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
    const first = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });
    const second = commitLogEntry(REQ, { fetchImpl: held, optimistic });

    readsServerRow(serverRow);
    release(new Response(JSON.stringify(OK), { status: 200,
      headers: { "content-type": "application/json" } }));
    const [a, b] = await Promise.all([first, second]);

    expect(held).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
  });

  it("queues one change for two overlapping commits, even when the post fails", async () => {
    let release!: (e: unknown) => void;
    const held = vi.fn(() => new Promise<Response>((_resolve, reject) => { release = reject; })) as unknown as typeof fetch;
    const first = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    await vi.waitFor(() => { expect(held).toHaveBeenCalledTimes(1); });
    const second = commitLogEntry(REQ, { fetchImpl: held, optimistic });
    release(new TypeError("Failed to fetch"));
    await Promise.all([first, second]);
    expect(held).toHaveBeenCalledTimes(1);
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
  });

  it("gives a capped entry a fresh budget when she commits it again", async () => {
    // A stale record keeping its attempts meant the next commit's read was spent on the first
    // miss and the record re-staled at once. A new commit is new evidence — the entry exists on
    // the server now — and earns a fresh look (Grok pass 7, MEDIUM 3).
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    for (let i = 0; i < MAX_ATTEMPTS * 2; i += 1) {
      await retryPendingReconciles(h, () => Date.now() + i * DAY_MS);
    }
    expect((await readPending(h)).find((r) => r.entryId === ENTRY_ID)?.state).toBe("stale");

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 8 }), optimistic });
    readsServerRow(serverRow);
    await retryPendingReconciles(h);
    expect([...await pendingEntryIds()]).not.toContain(ENTRY_ID);
    expect((await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>).rev).toBe(6);
  });

  it("keeps the owner a record already had when the session cannot be read", async () => {
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    signIn(null);
    await markInFlight(h, ENTRY_ID, null);
    expect((await readPending(h)).find((r) => r.entryId === ENTRY_ID)?.userId).toBe(h.userId);
  });

  it("joins a record that is still trying instead of resetting its bookkeeping", async () => {
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    for (let i = 0; i < 3; i += 1) await retryPendingReconciles(h, () => Date.now() + i * DAY_MS);
    const tried = (await readPending(h)).find((r) => r.entryId === ENTRY_ID);
    expect(tried?.attempts).toBeGreaterThan(0);

    // She taps Save on the same entry again while it is still being read back. The record's
    // bookkeeping is the record's; only a CAPPED one earns a fresh budget (Grok pass 7, MEDIUM 3).
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }), optimistic });
    const after = (await readPending(h)).filter((r) => r.entryId === ENTRY_ID);
    expect(after).toHaveLength(1);
    expect(after[0].attempts).toBe(tried?.attempts);
  });
});

/**
 * Grok pass 6, HIGH 3. Forward-only is about the revision, and an equal revision is not a step
 * back: the row that carries it may simply describe the entry more fully than the card does.
 */
describe("what may move a card or a mirror row", () => {
  const twoItems = {
    ...serverRow, rev: 5,
    items: [
      { ...serverRow.items[0], snapshot: { energy_kcal: { amount: 200, unit: "kcal" } } },
      { ...serverRow.items[0], id: "dddddddd-4444-4444-8444-444444444444", seq: 2, grams: 40,
        snapshot: { energy_kcal: { amount: 90, unit: "kcal" } } },
    ],
  };
  const card: LoggedFood = { ...ENTRY, rev: 5, items: [{ id: ITEM_ID, seq: 1,
    food_ref_id: REQ.items[0].food_ref_id, grams: 100, qty: 1, unit: "g", snapshot: {},
    foodId: "rice", name: "Rice", portionLabel: "100 g", macros: ENTRY.macros }] };

  it("takes a fuller row at the same revision", async () => {
    readsServerRow(twoItems);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 5 }),
      optimistic: { date: DATE, entry: card } });
    expect(getDay(DATE)?.extras?.[0].items?.[0].grams).toBe(175);
  });

  it("takes the server's food when the same line now points at a different one", async () => {
    // Another device replaced the food under this item id. Keeping the card's own ref meant Today
    // showed one food while the server held another, and everything the card's ref feeds — her
    // note's base, the off-plan marks, the next edit — spoke for the wrong one (pass 21, MEDIUM 3).
    const swapped = { ...serverRow, rev: 5, items: [{ ...serverRow.items[0],
      food_ref_id: "eeeeeeee-5555-4555-8555-555555555555", qty: 2, unit: "portion" }] };
    readsServerRow(swapped);

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 5 }),
      optimistic: { date: DATE, entry: card } });

    const item = getDay(DATE)?.extras?.[0].items?.[0];
    expect(item?.food_ref_id).toBe("eeeeeeee-5555-4555-8555-555555555555");
    expect(item?.name).not.toBe("Rice");
  });

  it("adds an item the row has and the card does not", async () => {
    // Another device added a food to this entry. The join by id could only ever update items the
    // card already had, so the card stayed at one item and Today's rings stayed a meal short
    // (panel round 15). At the same revision or newer, the row's items ARE the card's items.
    readsServerRow(twoItems);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 5 }),
      optimistic: { date: DATE, entry: card } });
    const logged = getDay(DATE)?.extras?.[0];
    expect(logged?.items).toHaveLength(2);
    expect(logged?.items?.map((i) => i.id)).toContain("dddddddd-4444-4444-8444-444444444444");
    expect(entryMacros(logged as LoggedFood).kcal)
      .toBe(snapshotMacros(logged?.items)?.kcal);
  });

  it("keeps a food the wire never carried when the row comes back", async () => {
    // A meal can mix catalog foods, which are sent, with her own or a bundled one, which are kept
    // on the card and never put on the wire. Replacing the card's items with the row's dropped
    // those from the card and from the day's rings (Grok pass 20, HIGH 1).
    const mixed: LoggedFood = {
      ...ENTRY, rev: 5,
      macros: { kcal: 260, protein: 12, carbs: 30, fat: 6 },
      items: [
        { id: ITEM_ID, seq: 1, food_ref_id: REQ.items[0].food_ref_id, grams: 100, qty: 1,
          unit: "g", snapshot: {}, foodId: "catalog:41", name: "Rice", portionLabel: "100 g",
          macros: { kcal: 160, protein: 3, carbs: 30, fat: 1 } },
        { id: "dddddddd-4444-4444-8444-444444444444", seq: 2, food_ref_id: "local:chicken",
          grams: 90, qty: 1, unit: "portion", snapshot: {}, foodId: "chicken", name: "Chicken",
          portionLabel: "1 portion", macros: { kcal: 100, protein: 9, carbs: 0, fat: 5 } },
      ],
    };
    // The server knows one of the two, and its read-back says so.
    readsServerRow({ ...serverRow, rev: 5 });

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 5 }),
      optimistic: { date: DATE, entry: mixed } });

    const logged = getDay(DATE)?.extras?.[0] as LoggedFood;
    expect(logged.items?.map((i) => i.name)).toEqual(["Rice", "Chicken"]);
    expect(entryMacros(logged).kcal).toBe(260);
  });

  it("leaves a bundled line alone when a row arrives beside it, and says so", async () => {
    // The known limitation of merging on identity alone (Grok pass 22, HIGH 2). If the server
    // ever stores a bundled pick under an id of its own, the card keeps its local line and the
    // row lands beside it. Guessing which one it is — by seq, by grams — cost another food its
    // line, which is worse; the answer belongs to a pull-time reconcile, not to this merge.
    const mixed: LoggedFood = {
      ...ENTRY, rev: 5,
      macros: { kcal: 260, protein: 12, carbs: 30, fat: 6 },
      items: [
        { id: ITEM_ID, seq: 1, food_ref_id: REQ.items[0].food_ref_id, grams: 100, qty: 1,
          unit: "g", snapshot: {}, foodId: "catalog:41", name: "Rice", portionLabel: "100 g",
          macros: { kcal: 160, protein: 3, carbs: 30, fat: 1 } },
        { id: "dddddddd-4444-4444-8444-444444444444", seq: 2, food_ref_id: "local:chicken",
          grams: 90, qty: 1, unit: "portion", snapshot: {}, foodId: "chicken", name: "Chicken",
          portionLabel: "1 portion", macros: { kcal: 100, protein: 9, carbs: 0, fat: 5 } },
      ],
    };
    // The server kept both, and gave the second one an id of its own at the same seq.
    readsServerRow({
      ...serverRow, rev: 5,
      items: [
        serverRow.items[0],
        { ...serverRow.items[0], id: "ffffffff-6666-4666-8666-666666666666", seq: 2, grams: 90,
          qty: 1, unit: "portion",
          snapshot: { energy_kcal: { amount: 100, unit: "kcal" } } },
      ],
    });

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 5 }),
      optimistic: { date: DATE, entry: mixed } });

    const logged = getDay(DATE)?.extras?.[0] as LoggedFood;
    expect(logged.items).toHaveLength(3);
    expect(logged.items?.map((i) => i.name)).toContain("Chicken");
  });

  it("never lets a bundled line stand in for another food's row", async () => {
    // Card seq and server seq are different lists — the card numbers every line, the request only
    // the catalog ones — so matching on seq let a bundled line claim the row of the food after it,
    // and that food's own line went. Only a real identity may collapse two lines (pass 22, HIGH 2).
    const RICE_ITEM = "99999999-9999-4999-8999-999999999999";
    const RICE_REF = "88888888-8888-4888-8888-888888888888";
    const mixed: LoggedFood = {
      ...ENTRY, rev: 5,
      items: [
        { id: ITEM_ID, seq: 1, food_ref_id: REQ.items[0].food_ref_id, grams: 100, qty: 1,
          unit: "g", snapshot: {}, foodId: "catalog:41", name: "Chicken", portionLabel: "100 g",
          macros: { kcal: 160, protein: 30, carbs: 0, fat: 4 } },
        { id: "dddddddd-4444-4444-8444-444444444444", seq: 2, food_ref_id: "local:banana",
          grams: 120, qty: 1, unit: "portion", snapshot: {}, foodId: "banana", name: "Banana",
          portionLabel: "1 banana", macros: { kcal: 105, protein: 1, carbs: 27, fat: 0 } },
        { id: RICE_ITEM, seq: 3, food_ref_id: RICE_REF, grams: 150, qty: 1, unit: "g",
          snapshot: {}, foodId: "catalog:42", name: "Rice", portionLabel: "150 g",
          macros: { kcal: 200, protein: 4, carbs: 44, fat: 1 } },
      ],
    };
    // The server's own list is the two catalog foods, and it minted its own id for the rice.
    readsServerRow({
      ...serverRow, rev: 5,
      items: [
        serverRow.items[0],
        { ...serverRow.items[0], id: "77777777-7777-4777-8777-777777777777", seq: 2, grams: 150,
          food_ref_id: RICE_REF, snapshot: { energy_kcal: { amount: 200, unit: "kcal" } } },
      ],
    });

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 5 }),
      optimistic: { date: DATE, entry: mixed } });

    const items = (getDay(DATE)?.extras?.[0] as LoggedFood).items ?? [];
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.name)).toContain("Banana");
    expect(items.find((i) => i.food_ref_id === RICE_REF)?.grams).toBe(150);
  });

  it("does not let a lagging replica confirm a write that has not landed", async () => {
    // An edit based on rev 3. A read-back that answers rev 3 is the write BEFORE this one: it says
    // nothing about whether this commit landed, so it may not confirm it, overwrite the local
    // items, or throw away the request she may still have to retry (Grok pass 9, HIGH 4).
    await putRow(h, "log_entries", ENTRY_ID, { ...serverRow, rev: 3 });
    await markInFlight(h, ENTRY_ID, h.userId, { request: { ...REQ, base_rev: 3 }, baseRev: 3 });
    await markNeedsReconcile(h, ENTRY_ID, h.userId);

    readsServerRow({ ...serverRow, rev: 3 });
    await retryPendingReconciles(h);
    const held = (await readPending(h))[0];
    expect(held.confirmed).toBe(false);
    expect(held.request).toBeTruthy();
    expect(held.state).toBe("needs_reconcile");

    readsServerRow({ ...serverRow, rev: 4 });
    await retryPendingReconciles(h);
    expect(await readPending(h)).toHaveLength(0);
    expect((await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>).rev).toBe(4);
  });

  it("never writes a mirror row older than the one it holds", async () => {
    readsServerRow({ ...serverRow, rev: 5 });
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 5 }), optimistic });
    expect((await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>).rev).toBe(5);

    // A lagging replica answers the NEXT read with the revision before it — the drain settles the
    // same entry this way too. A note takes its base_rev from this row, so writing that back would
    // send an edit against a revision the server has already moved past.
    readsServerRow({ ...serverRow, rev: 4, items: [{ ...serverRow.items[0], grams: 10 }] });
    await reconcileFromServer(h, ENTRY_ID);
    const row = await getRow(h, "log_entries", ENTRY_ID) as Record<string, unknown>;
    expect(row.rev).toBe(5);
    expect((row.items as { grams: number }[])[0].grams).toBe(175);
  });

  it("does not let a late 2xx undo a fuller patch the drain already made", async () => {
    // The commit's own reply lands after another pass has brought the card up to a newer row.
    // `updateExtra` replaces by id, so patching from the older reply would put the older numbers
    // back on a card that has already moved on.
    readsServerRow(null);
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { status: "ok", rev: 7 }),
      optimistic: { date: DATE, entry: card } });
    readsServerRow({ ...serverRow, rev: 9 });
    await reconcileFromServer(h, ENTRY_ID);
    expect(getDay(DATE)?.extras?.[0].rev).toBe(9);

    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 5 }),
      optimistic: { date: DATE, entry: card } });
    expect(getDay(DATE)?.extras?.[0].rev).toBe(9);
    expect(getDay(DATE)?.extras?.[0].items?.[0].grams).toBe(175);
  });

  it("leaves a card with no revision alone when the row is older than the mirror", async () => {
    readsServerRow({ ...serverRow, rev: 5 });
    await commitLogEntry(REQ, { fetchImpl: jsonFetch(200, { ...OK, rev: 5 }),
      optimistic: { date: DATE, entry: { ...card, rev: undefined } } });
    readsServerRow({ ...serverRow, rev: 4, items: [{ ...serverRow.items[0], grams: 10 }] });
    await reconcileFromServer(h, ENTRY_ID);
    expect(getDay(DATE)?.extras?.[0].items?.[0].grams).not.toBe(10);
  });
});

describe("reconcileEntry", () => {
  it("takes the server's grams and snapshot for each item it knows", () => {
    const withItems: LoggedFood = { ...ENTRY, items: [{
      id: ITEM_ID, name: "Rice", grams: 90, macros: ENTRY.macros,
    }] as LoggedFood["items"] };
    const patch = reconcileEntry(withItems, {
      ...OK, items: [{ ...serverItem(ITEM_ID, 100),
        snapshot: { energy_kcal: { amount: 130 } } as never }],
    });
    expect(patch.items?.[0]).toMatchObject({ grams: 100 });
    expect(patch.items?.[0].snapshot).toEqual({ energy_kcal: { amount: 130 } });
  });

  it("leaves an entry with nothing flagged exactly as it was", () => {
    expect(reconcileEntry(ENTRY, OK).flags).toBeUndefined();
  });

  it("carries the acknowledged revision onto the card, as the conflict path already does", () => {
    // A card with no revision reads as an entry the server has not answered for. The clean 2xx IS
    // the answer, and it names the revision (Grok pass 3, LOW 8).
    expect(reconcileEntry(ENTRY, { ...OK, rev: 4 }).rev).toBe(4);
  });
});
