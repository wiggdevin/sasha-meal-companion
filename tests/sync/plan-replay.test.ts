/**
 * W096 (backlog B092): plan_days feed rows this phone pulled before its pull projected them are
 * replayed once, so another device's older edit to a day reaches Today.
 *
 * The phone below has a stored cursor past two plan-day changes whose plan never reached its
 * legacy store (what an older build left behind). A normal pass replays the feed up to that
 * cursor, projects the newest change of each day, and then never replays again.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetStoreCache, getDay } from "@/lib/store";
import { appendOp, getMeta, putRow, setCursor } from "@/lib/sync/idb";
import { pullChanges } from "@/lib/sync/client";
import { PLAN_REPLAY_KEY, PLAN_REPLAY_VERSION } from "@/lib/sync/plan-replay";
import type { ChangeRow, ChangesResponse } from "@/lib/sync/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let h: AccountHandle;
const dayA = "2026-10-01";
const dayB = "2026-10-02";

function planChange(seq: number, date: string, rev: number, note: string): ChangeRow {
  return { seq, rev, entity: "plan_days", entity_key: date, op: "update", at: "2026-10-01T12:00:00Z",
    current: { local_date: date, rev, day_type_override: null, floor_day: false, swaps: {},
      slot_notes: { "meal-1": note }, item_overrides: {}, eaten_slots: {},
      updated_at: "2026-10-01T12:00:00Z" } };
}

/** A feed server: answers `since` and `limit` from one change log, and counts its reads. */
function feed(log: ChangeRow[], limit = 500) {
  const reads: number[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const since = Number(url.searchParams.get("since") ?? 0);
    reads.push(since);
    const page = log.filter((c) => c.seq > since).slice(0, limit);
    const body: ChangesResponse = { changes: page,
      next_cursor: page.at(-1)?.seq ?? since, has_more: page.length === limit };
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { fetchFn, reads };
}

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  __resetStoreCache();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("plan day replay (W096)", () => {
  const log = [
    planChange(1, dayA, 1, "first"),
    planChange(2, dayA, 2, "second"),
    planChange(3, dayB, 1, "other day"),
  ];

  it("projects the newest consumed change of each day once, then stops replaying", async () => {
    await setCursor(h, 3);
    const server = feed(log);
    await pullChanges(h, undefined, { fetchFn: server.fetchFn });

    expect(getDay(dayA)?.notes).toEqual({ "meal-1": "second" });
    expect(getDay(dayB)?.notes).toEqual({ "meal-1": "other day" });
    expect(server.reads).toEqual([3, 0]);
    expect(await getMeta(h, PLAN_REPLAY_KEY)).toEqual({ version: PLAN_REPLAY_VERSION, done: true });

    await pullChanges(h, undefined, { fetchFn: server.fetchFn });
    expect(server.reads).toEqual([3, 0, 3]);
  });

  it("resumes from its own watermark when one pass's pages run out", async () => {
    await setCursor(h, 3);
    const server = feed(log, 1);
    // The main read takes one page, the replay the one left; the next pass resumes after seq 1.
    await pullChanges(h, undefined, { fetchFn: server.fetchFn, maxPages: 2 });
    expect(await getMeta(h, PLAN_REPLAY_KEY)).toMatchObject({ done: false, cursor: 1, through: 3 });
    await pullChanges(h, undefined, { fetchFn: server.fetchFn, maxPages: 10 });
    expect(server.reads).toEqual([3, 0, 3, 1, 2]);
    expect(getDay(dayA)?.notes).toEqual({ "meal-1": "second" });
    expect(getDay(dayB)?.notes).toEqual({ "meal-1": "other day" });
    expect(await getMeta(h, PLAN_REPLAY_KEY)).toMatchObject({ done: true });
  });

  it("never rolls back a later mirrored revision or a day with a queued op", async () => {
    await setCursor(h, 3);
    await putRow(h, "plan_days", dayA, { ...planChange(9, dayA, 5, "newer").current });
    await appendOp(h, { op_id: "op-b", entity: "plan_days", entity_id: dayB, kind: "update",
      base_rev: 1, payload: { slot_notes: { "meal-1": "mine" } }, client_ts: "2026-10-02T08:00:00Z" });
    await pullChanges(h, undefined, { fetchFn: feed(log).fetchFn });

    expect(getDay(dayA)?.notes).toBeUndefined();
    expect(getDay(dayB)?.notes).toBeUndefined();
    // The skipped day records no hold, so the next pass does not rewind the main pull to seq 3.
    expect(await getMeta(h, "pull_holds")).toBeUndefined();
  });

  it("has nothing to replay on a phone that had pulled nothing", async () => {
    const server = feed(log);
    await pullChanges(h, undefined, { fetchFn: server.fetchFn });
    expect(server.reads).toEqual([0]);
    expect(await getMeta(h, PLAN_REPLAY_KEY)).toEqual({ version: PLAN_REPLAY_VERSION, done: true });
  });
});
