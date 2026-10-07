/**
 * The outbox write that fails AFTER the POST has gone out (Grok pass 16, HIGH 1).
 *
 * By then the server may already hold the entry, and the op written before the POST may still be
 * in the outbox — `enqueue` replaces by op id, so a second failed write does not remove the first.
 * Rolling the local write back there took the card off Today over a meal that was on its way, and
 * told her to try again: she logs it a second time while the drain sends the first one.
 *
 * So nothing local is taken back after the POST. The record stays `in_flight` for the next
 * catch-up to read the server about, the card stays, and the sheet is told the truth.
 *
 * Its own file because the seam is a module mock: `lib/log-commit-client.ts` imports `enqueue`
 * directly, so the only way to make that write fail is to replace the module for this file alone.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitLogEntry, forgetLoggedEntry, logEntryStates, outcomeFor, pendingEntryIds,
} from "@/lib/log-commit-client";
import {
  confirmEntry, markDurable, markInFlight, markNeedsReconcile, MAX_ATTEMPTS, readPending,
} from "@/lib/log/pending";
import { retryPendingReconciles } from "@/lib/log/reconcile";
import { resetLiveCommits } from "@/lib/log/live-commits";
import { getDay, loadStore, saveStore, upsertExtra } from "@/lib/store";
import { allOps } from "@/lib/sync/idb";
import type { LogCommitRequest } from "@/lib/log/contract";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

const DATE = "2026-11-02";
const ENTRY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ITEM_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const FOOD_REF = "cccccccc-3333-4333-8333-333333333333";

/** How many outbox writes still have to work before the database "blocks". */
let goodWrites = 0;

vi.mock("@/lib/sync/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/outbox")>();
  return {
    ...actual,
    enqueue: async (...args: Parameters<typeof actual.enqueue>) => {
      if (goodWrites <= 0) throw new Error("the database is blocked");
      goodWrites -= 1;
      return actual.enqueue(...args);
    },
  };
});

/** When false the outbox cannot be read at all — a blocked database, mid-catch-up. */
let outboxReadable = true;
/** How many of the next record writes the database refuses. */
let refuseWrites = 0;
/** When true every READ of the database fails: the record list, the outbox and the mirror. */
let readsBlocked = false;

vi.mock("@/lib/sync/idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/idb")>();
  return {
    ...actual,
    allOps: async (...args: Parameters<typeof actual.allOps>) => {
      if (!outboxReadable || readsBlocked) throw new Error("the database is blocked");
      return actual.allOps(...args);
    },
    getRow: async (...args: Parameters<typeof actual.getRow>) => {
      if (readsBlocked) throw new Error("the database is blocked");
      return actual.getRow(...args);
    },
    openAccountDb: async (...args: Parameters<typeof actual.openAccountDb>) => {
      const db = await actual.openAccountDb(...args);
      return new Proxy(db as object, {
        get(target, prop, receiver) {
          if (prop === "get" && readsBlocked) {
            return async () => { throw new Error("the database is blocked"); };
          }
          if (prop === "put") {
            return async (...args: unknown[]) => {
              if (refuseWrites > 0) { refuseWrites -= 1; throw new Error("the database is blocked"); }
              return (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown)
                .apply(target, args);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof db;
    },
  };
});

/** How many times the catch-up has asked the server about an entry, and what it answers. */
let reads = 0;
let serverAnswer: () => Promise<Record<string, unknown> | null> = async () => null;

vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-a" } } }) },
    from: () => ({ select: () => ({ eq: () => ({
      maybeSingle: async () => { reads += 1; return { data: await serverAnswer(), error: null }; },
    }) }) }),
  }),
}));

const REQ: LogCommitRequest = {
  entry_id: ENTRY_ID, eaten_at: "2026-11-02T17:00:00.000Z", tz: "UTC", local_date: DATE,
  slot: "meal-2", method: "search",
  items: [{ id: ITEM_ID, seq: 1, food_ref_id: FOOD_REF, qty: 1, unit: "g", grams: 100 }],
};

const ENTRY: LoggedFood = {
  id: ENTRY_ID, foodId: FOOD_REF, name: "Greek yogurt", portionLabel: "100 g",
  qty: 1, grams: 100, macros: { kcal: 100, protein: 10, carbs: 5, fat: 2 },
  at: REQ.eaten_at,
};

const optimistic = { date: DATE, entry: ENTRY };
const DAY_MS = 24 * 60 * 60 * 1000;

/** A contract-shaped answer, so a settle has nothing left to read back. */
const OK = {
  status: "ok", entry_id: ENTRY_ID, rev: 1,
  items: [{ id: ITEM_ID, entry_id: ENTRY_ID, seq: 1, food_ref_id: FOOD_REF, qty: 1, unit: "g",
    grams: 100, portion_id: null, food_revision_id: null, was_edited: false, confidence: null,
    snapshot: {} }],
  totals: { local_date: DATE, nutrients: [], micro_coverage_pct: 0 },
};

beforeEach(async () => {
  // A re-post through the catch-up (`sendAgain`) commits through the real `commitLogEntry`, whose
  // `.finally()` fires a fire-and-forget wake (`wakeIfQueued`) nobody awaits. Give it real turns to
  // settle against the account this test bound, before the next test's `beforeEach` turns the
  // account handle over and the same read throws `AccountChanged` unhandled.
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  h = await resetTestAccount();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  saveStore({ ...loadStore(), days: {} });
  resetLiveCommits();
  reads = 0;
  outboxReadable = true;
  refuseWrites = 0;
  readsBlocked = false;
  serverAnswer = async () => null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("an outbox write that fails after the POST", () => {
  it("keeps the card, the record and the op already queued", async () => {
    goodWrites = 1; // the write before the POST lands; the one after it does not.
    const down = vi.fn(async () => new Response(JSON.stringify({ error: "down" }),
      { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await commitLogEntry(REQ, { fetchImpl: down, optimistic });

    // The op from before the POST is still there, and it is the one the drain will send.
    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(1);
    expect(result).toEqual({ status: "queued" });
    expect(outcomeFor(result).keep).toBe(true);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
    expect(await readPending(h)).toHaveLength(1);
  });

  it("keeps the flag through the window before the POST", async () => {
    // `markInFlight` rebuilds the record, so a commit that starts while an earlier one has already
    // recorded that nothing could be queued used to drop the flag — and a kill in that window left
    // a record the catch-up would only ever read (Grok pass 19, note).
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    await markDurable(h, ENTRY_ID, false);
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    expect((await readPending(h))[0].durable).toBe(false);
  });

  it("still keeps them when nothing could be queued at all", async () => {
    goodWrites = 0;
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;

    const result = await commitLogEntry(REQ, { fetchImpl: down, optimistic });

    expect((await allOps(h)).filter((o) => o.entity_id === ENTRY_ID)).toHaveLength(0);
    // Never "try again": the POST went out, so the server may have it, and the record is what
    // the next catch-up reads the server about.
    const outcome = outcomeFor(result);
    expect(outcome.keep).toBe(true);
    expect(outcome.message).toBe("Logged. It will catch up when you are back online.");
    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
    const record = (await readPending(h))[0];
    expect(record.state).toBe("in_flight");
    // And the record says no op backs it, so the catch-up knows only the server can answer.
    expect(record.durable).toBe(false);
  });
});

describe("the catch-up for a write no outbox holds", () => {
  it("sends it again rather than reading the server about it", async () => {
    // Nothing was queued and the POST failed, so the server has never heard of this entry.
    // Reading it back twenty times finds nothing twenty times: it has to be SENT (Grok pass 17,
    // HIGH 2).
    goodWrites = 0;
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, optimistic });
    expect((await readPending(h))[0].durable).toBe(false);

    const posts = vi.fn(async () => new Response(JSON.stringify(OK),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", posts);
    goodWrites = 5;

    await retryPendingReconciles(h);

    expect(posts).toHaveBeenCalledTimes(1);
    // And the entry is settled by that POST, so nothing is left to say about it. (The one read
    // here is the commit's own settle reading its row back, not the catch-up asking about it.)
    expect(await readPending(h)).toHaveLength(0);
  });

  it("still reads a record that never said its queue write failed", async () => {
    // Only a record that SAYS the write before the POST could not be made is re-posted. Every
    // other unconfirmed record — a kill mid-POST, a 2xx nobody could read, a read-back that was
    // refused — is read, and keeps the request behind the card's "try again" (panel round 17).
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    // Its queue write landed, which is what every record has unless the commit says otherwise.
    await markDurable(h, ENTRY_ID, true);
    await markNeedsReconcile(h, ENTRY_ID, h.userId);

    const posts = vi.fn(async () => new Response(JSON.stringify(OK),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", posts);

    await retryPendingReconciles(h);

    expect(posts).not.toHaveBeenCalled();
    expect(reads).toBe(1);
    const held = (await readPending(h))[0];
    expect(held.state).toBe("needs_reconcile");
    expect(held.request).toBeTruthy();
  });

  it("gives up on it at the cap instead of posting it for ever", async () => {
    // `markInFlight` treats a capped record as a fresh tap and hands it twenty new reads. That is
    // right for HER tap and wrong for the catch-up's own re-POST, which counted an attempt and
    // then wiped the count it had just spent (Grok pass 18, HIGH 1).
    goodWrites = 0;
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, optimistic });
    expect(down).toHaveBeenCalledTimes(1);

    const posts = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", posts);
    // A month between passes, because the gap between attempts doubles and the last few are days
    // apart. More passes than the cap allows attempts, so a count that resets shows up as posts.
    for (let i = 0; i < MAX_ATTEMPTS + 5; i += 1) {
      await retryPendingReconciles(h, () => Date.now() + i * 30 * DAY_MS);
    }
    expect(posts.mock.calls.length).toBeLessThanOrEqual(MAX_ATTEMPTS);

    // Nothing is posted any more, and the card says what it is: never saved, nothing left to send.
    const spent = posts.mock.calls.length;
    await retryPendingReconciles(h, () => Date.now() + 9_999 * DAY_MS);
    expect(posts.mock.calls.length).toBe(spent);
    const states = await logEntryStates();
    expect([...states.unsaved, ...states.lost]).toContain(ENTRY_ID);
    expect([...states.pending]).not.toContain(ENTRY_ID);
  });

  it("calls a write it cannot send again not saved at once", async () => {
    // A record with no request left is one nothing can re-send. Spending the twenty reads first
    // means the card claims to be saving for as long as they last (Grok pass 17, HIGH 2).
    await markInFlight(h, ENTRY_ID, h.userId);
    // And it is one of the re-POST cases: this phone never managed to queue anything for it.
    await markDurable(h, ENTRY_ID, false);
    await markNeedsReconcile(h, ENTRY_ID, h.userId);

    await retryPendingReconciles(h);

    // One read first — a card is not called lost over an entry nobody asked the server about
    // (Grok pass 18, LOW 4) — and the server does not have this one.
    expect(reads).toBe(1);
    expect([...(await logEntryStates()).lost]).toContain(ENTRY_ID);
  });

  it("calls it logged instead when the server turns out to have it", async () => {
    // Same record, nothing left to send — but the row is there, so the entry is hers and settled,
    // not lost (Grok pass 18, LOW 4).
    await markInFlight(h, ENTRY_ID, h.userId);
    await markDurable(h, ENTRY_ID, false);
    await markNeedsReconcile(h, ENTRY_ID, h.userId);
    serverAnswer = async () => ({
      id: ENTRY_ID, rev: 4, eaten_at: REQ.eaten_at, tz: "UTC", local_date: DATE, slot: "meal-2",
      method: "search", note: null,
      items: [{ id: ITEM_ID, entry_id: ENTRY_ID, seq: 1, food_ref_id: FOOD_REF, qty: 1, unit: "g",
        grams: 100, portion_id: null, food_revision_id: null, was_edited: false, confidence: null,
        snapshot: {} }],
    });

    await retryPendingReconciles(h);

    const states = await logEntryStates();
    expect([...states.lost, ...states.unsaved]).not.toContain(ENTRY_ID);
    expect(await readPending(h)).toHaveLength(0);
  });
});

/**
 * The read comes first, and the decision is taken on the record as it is NOW (Grok pass 18,
 * MEDIUM 2). The claim is a snapshot: another tab's drain, or this tab's own POST landing after
 * the client gave up on it, can confirm an entry between the claim and the send — and posting
 * then is a replay of a write the server already applied.
 */
describe("before any re-POST", () => {
  const SERVER_ROW = {
    id: ENTRY_ID, rev: 4, eaten_at: REQ.eaten_at, tz: "UTC", local_date: DATE, slot: "meal-2",
    method: "search", note: null,
    items: [{ id: ITEM_ID, entry_id: ENTRY_ID, seq: 1, food_ref_id: FOOD_REF, qty: 1, unit: "g",
      grams: 100, portion_id: null, food_revision_id: null, was_edited: false, confidence: null,
      snapshot: {} }],
  };

  async function unsentRecord(): Promise<void> {
    goodWrites = 0;
    const down = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await commitLogEntry(REQ, { fetchImpl: down, optimistic });
  }

  it("does nothing about an entry the server turns out to have", async () => {
    await unsentRecord();
    serverAnswer = async () => SERVER_ROW;
    const posts = vi.fn(async () => new Response(JSON.stringify(OK),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", posts);

    await retryPendingReconciles(h);

    expect(posts).not.toHaveBeenCalled();
    expect(await readPending(h)).toHaveLength(0);
  });

  it("does not post over a write confirmed since the claim", async () => {
    await unsentRecord();
    // The entry is confirmed while this very pass is running — another tab's drain answered.
    serverAnswer = async () => { await confirmEntry(h, ENTRY_ID); return null; };
    const posts = vi.fn(async () => new Response(JSON.stringify(OK),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", posts);

    await retryPendingReconciles(h);

    expect(posts).not.toHaveBeenCalled();
  });

  it("waits rather than posting while the outbox cannot be read at all", async () => {
    // An outbox that cannot be read says nothing either way, and a POST on "nothing either way"
    // is a write that may already be queued (Grok pass 23, LOW 3). It is a pause, not a verdict:
    // the record stays and the next pass asks again, which is what panel round 18 asked for.
    await unsentRecord();
    outboxReadable = false;
    const posts = vi.fn(async () => new Response(JSON.stringify(OK),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", posts);

    await retryPendingReconciles(h);
    expect(posts).not.toHaveBeenCalled();
    expect(await readPending(h)).toHaveLength(1);

    outboxReadable = true;
    await retryPendingReconciles(h, () => Date.now() + DAY_MS);
    expect(posts).toHaveBeenCalledTimes(1);
  });

  it("keeps the record durable when the write behind it has to be tried twice", async () => {
    // The write that says "the outbox has it now" is quiet and best effort. Losing it leaves a
    // record claiming nothing was ever queued, which is a re-POST of a write the drain is already
    // sending (Grok pass 23, LOW 3).
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    refuseWrites = 1;

    await markDurable(h, ENTRY_ID, true);

    expect((await readPending(h))[0].durable).toBe(true);
  });

  it("counts a miss and posts nothing when the server cannot be read", async () => {
    await unsentRecord();
    serverAnswer = async () => { throw new Error("offline"); };
    const posts = vi.fn(async () => new Response(JSON.stringify(OK),
      { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", posts);

    await retryPendingReconciles(h);

    expect(posts).not.toHaveBeenCalled();
    expect((await readPending(h))[0].attempts).toBe(1);
  });
});

/**
 * The app is killed mid-commit, which is the case every part of the local-first write exists for
 * (Grok pass 22, HIGH 1). Whatever got written before the kill, the relaunch has to finish it:
 * send the meal, and put it back on Today while it is trying.
 */
describe("a commit the app never finished", () => {
  it("sends and draws a record left with no card and no write behind it", async () => {
    // Killed between the record and the paint: an `in_flight` record with the request, nothing
    // else. Nothing said no op was ever written, so the catch-up read the server instead of
    // sending — and drew nothing, because there was no card to patch.
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    expect((await readPending(h))[0].durable).toBe(false);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);

    goodWrites = 5;
    const posts = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", posts);

    await retryPendingReconciles(h);

    expect(posts).toHaveBeenCalledTimes(1);
    const extras = getDay(DATE)?.extras ?? [];
    expect(extras.map((e) => e.id)).toEqual([ENTRY_ID]);
    expect([...await pendingEntryIds()]).toContain(ENTRY_ID);
  });

  it("brings back the card she saw, not a stand-in for it", async () => {
    // The request is ids, grams and units. The meal's name, her note and the bundled lines were
    // never on the wire, and a 2xx keeps the card's own words — so a stand-in card built from the
    // request would have become the meal, for good (Grok pass 23, HIGH 1).
    const meal: LoggedFood = {
      id: ENTRY_ID, foodId: "meal", name: "Chicken and rice", note: "after the gym",
      portionLabel: "2 items", qty: 1, grams: 220,
      macros: { kcal: 420, protein: 40, carbs: 45, fat: 8 },
      items: [
        { id: ITEM_ID, seq: 1, food_ref_id: FOOD_REF, grams: 100, qty: 1, unit: "g", snapshot: {},
          foodId: "catalog:41", name: "Chicken", portionLabel: "100 g",
          macros: { kcal: 160, protein: 30, carbs: 0, fat: 4 } },
        { id: "dddddddd-4444-4444-8444-444444444444", seq: 2, food_ref_id: "local:banana",
          grams: 120, qty: 1, unit: "portion", snapshot: {}, foodId: "banana", name: "Banana",
          portionLabel: "1 banana", macros: { kcal: 105, protein: 1, carbs: 27, fat: 0 } },
      ],
      at: REQ.eaten_at,
    };
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0, card: meal });

    goodWrites = 5;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await retryPendingReconciles(h);

    const extra = (getDay(DATE)?.extras ?? [])[0];
    expect(extra?.name).toBe("Chicken and rice");
    expect(extra?.foodId).toBe("meal");
    expect(extra?.note).toBe("after the gym");
    expect(extra?.items?.map((i) => i.name)).toContain("Banana");
  });

  it("names a recovered meal and keeps her note when only the request is left", async () => {
    // The last resort. It still says what it is and still carries what the request DOES know.
    const req = { ...REQ, note: "after the gym",
      items: [REQ.items[0], { ...REQ.items[0], id: "dddddddd-4444-4444-8444-444444444444", seq: 2 }] };
    await markInFlight(h, ENTRY_ID, h.userId, { request: req, baseRev: 0 });

    goodWrites = 5;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await retryPendingReconciles(h);

    const extra = (getDay(DATE)?.extras ?? [])[0];
    expect(extra?.name).toBe("Meal · 2 items");
    expect(extra?.foodId).toBe("meal");
    expect(extra?.note).toBe("after the gym");
  });

  it("sends a record whose card went up but whose write never did", async () => {
    // Killed after the paint and before the outbox write: a card, a record, no op.
    await markInFlight(h, ENTRY_ID, h.userId, { request: REQ, baseRev: 0 });
    upsertExtra(DATE, ENTRY);

    goodWrites = 5;
    const posts = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    vi.stubGlobal("fetch", posts);

    await retryPendingReconciles(h);

    expect(posts).toHaveBeenCalledTimes(1);
    expect(getDay(DATE)?.extras ?? []).toHaveLength(1);
  });
});

/**
 * The shortcut for a food that was never on the server needs POSITIVE evidence (Grok pass 26,
 * HIGH 3). "No record, no queued write, no mirrored row" is also what a database that cannot be
 * read answers, and taking the shortcut on that leaves a catalog save that is still posting with
 * no tombstone at all: its own 2xx then puts the meal back.
 */
describe("deleting while the database cannot say what it knows", () => {
  it("keeps the durable tombstone rather than guessing", async () => {
    goodWrites = 5;
    const hangs = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    void commitLogEntry(REQ, { fetchImpl: hangs, optimistic });
    await vi.waitFor(async () => { expect(await readPending(h)).toHaveLength(1); });

    readsBlocked = true;
    await forgetLoggedEntry(DATE, ENTRY_ID);
    readsBlocked = false;

    expect((await readPending(h))[0]?.state).toBe("deleted");
    expect(getDay(DATE)?.extras ?? []).toHaveLength(0);
  });
});
