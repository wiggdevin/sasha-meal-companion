// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { adoptLegacyDevice, legacyHeldCount, HELD_LINE } from "@/lib/device/legacy-adoption";
import { allOps, closeAllAccountDbs, getMeta, getRow, upgradeStores } from "@/lib/sync/idb";
import { loadStore } from "@/lib/store";
import { resetAccountMemory } from "@/tests/helpers/new-page";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const dbNames = async () => (await indexedDB.databases()).map((d) => d.name);

/** The pre-Phase-9 shared database as an old build left it: version 4, one store per entity. */
async function seedLegacy(): Promise<void> {
  const db = await openDB("smc", 4, { upgrade: upgradeStores });
  await db.put("plan_days", { local_date: "2026-09-01", user_id: A, rev: 3 }, "2026-09-01");
  await db.put("plan_days", { local_date: "2026-09-02", user_id: B, rev: 1 }, "2026-09-02");
  await db.put("water_log", { local_date: "2026-09-03", cups: 5, rev: 1 }, "2026-09-03"); // no owner
  await db.put("outbox", { op_id: "w1", entity: "water_log", entity_id: "2026-09-03", kind: "update",
    base_rev: 0, payload: { local_date: "2026-09-03", cups: 5 }, client_ts: "2026-09-03T08:00:00Z",
    seq: 1, attempts: 0, error_attempts: 0, queued_at: "2026-09-03T08:00:00Z", next_attempt_at: 0 });
  await db.put("meta", 41, "cursor");
  await db.put("meta", true, `grandfathered_eaten:${A}`);
  db.close();
}

async function clearLegacyOutbox(): Promise<void> {
  const db = await openDB("smc");
  await db.clear("outbox");
  db.close();
}

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("legacy adoption (Phase 9 §0.6)", () => {
  it("copies only the current account's owner-stamped rows and its eaten marker", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect(await getRow(a, "plan_days", "2026-09-01")).toMatchObject({ user_id: A });
    expect(await getRow(a, "plan_days", "2026-09-02")).toBeUndefined();
    expect(await getRow(a, "water_log", "2026-09-03")).toBeUndefined();
    expect(await getMeta(a, `grandfathered_eaten:${A}`)).toBe(true);
    expect(await getMeta(a, "cursor")).toBeUndefined();
  });

  it("never overwrites a row the account database already holds", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    const { putRow } = await import("@/lib/sync/idb");
    await putRow(a, "plan_days", "2026-09-01", { local_date: "2026-09-01", user_id: A, rev: 9 });
    await adoptLegacyDevice(a);
    expect(await getRow(a, "plan_days", "2026-09-01")).toMatchObject({ rev: 9 });
  });

  it("holds an unowned water op under A and under B: not copied, not sent, counted", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect(await allOps(a)).toEqual([]);
    const b = bindAccount(B);
    await adoptLegacyDevice(b);
    expect(await allOps(b)).toEqual([]);
    expect(await legacyHeldCount()).toBe(1);
    expect(HELD_LINE(1)).toBe("1 changes from before the update are held on this phone.");
  });

  // PR #248 review r5 #2: an old tab can still write into smc after any count, so this slice never
  // deletes it — not even when it looks empty. Deletion is a later, separately reviewed step.
  it("never deletes smc, even when it holds no ops", async () => {
    await seedLegacy();
    await adoptLegacyDevice(bindAccount(A));
    expect(await dbNames()).toContain("smc");
    await clearLegacyOutbox();
    await adoptLegacyDevice(bindAccount(B));
    expect(await dbNames()).toContain("smc");
    expect(await legacyHeldCount()).toBe(0);
  });

  it("keeps an op an old tab writes into smc after adoption found it empty", async () => {
    await seedLegacy();
    await clearLegacyOutbox();
    await adoptLegacyDevice(bindAccount(A));
    const oldTab = await openDB("smc");
    await oldTab.put("outbox", { op_id: "late", entity: "water_log", entity_id: "2026-09-04",
      kind: "update", base_rev: 0, payload: { local_date: "2026-09-04", cups: 1 },
      client_ts: "2026-09-04T08:00:00Z", seq: 2, attempts: 0, error_attempts: 0,
      queued_at: "2026-09-04T08:00:00Z", next_attempt_at: 0 });
    oldTab.close();
    await adoptLegacyDevice(bindAccount(B));
    expect(await dbNames()).toContain("smc");
    expect(await legacyHeldCount()).toBe(1);
  });

  it.each(["pending_log_entries", "pending_weigh_ins", "pending_target_revisions", "pending_future_queue"])(
    "keeps smc when the outbox is empty but meta %s holds a record", async (key) => {
      await seedLegacy();
      await clearLegacyOutbox();
      const db = await openDB("smc");
      await db.put("meta", [{ userId: null, ownerId: null, entryId: "e1", requestId: "r1" }], key);
      db.close();
      await adoptLegacyDevice(bindAccount(A));
      expect(await dbNames()).toContain("smc");
      expect(await legacyHeldCount()).toBeGreaterThan(0);
    });

  it("adopts owner-stamped pending records of the current account only", async () => {
    await seedLegacy();
    const db = await openDB("smc");
    await db.put("meta", [
      { entryId: "eA", userId: A, confirmed: false, state: "in_flight" },
      { entryId: "eB", userId: B, confirmed: false, state: "in_flight" },
      { entryId: "eN", userId: null, confirmed: false, state: "in_flight" },
    ], "pending_log_entries");
    await db.put("meta", [{ userId: A, request: { localDate: "2026-09-20", lb: 150, tz: "UTC" } }],
      "pending_weigh_ins");
    await db.put("meta", [{ ownerId: B, requestId: "rB", body: {} }], "pending_target_revisions");
    db.close();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect((await getMeta<{ entryId: string }[]>(a, "pending_log_entries"))!.map((r) => r.entryId))
      .toEqual(["eA"]);
    expect(await getMeta(a, "pending_weigh_ins")).toHaveLength(1);
    expect(await getMeta(a, "pending_target_revisions")).toBeUndefined();
    expect(await dbNames()).toContain("smc"); // B's and the ownerless records stay held
  });

  it("an existing record in the account database wins over the legacy copy", async () => {
    await seedLegacy();
    const legacy = await openDB("smc");
    await legacy.put("meta", [{ entryId: "eA", userId: A, state: "in_flight", attempts: 0 }],
      "pending_log_entries");
    legacy.close();
    const a = bindAccount(A);
    const { putMeta } = await import("@/lib/sync/idb");
    await putMeta(a, "pending_log_entries", [{ entryId: "eA", userId: A, state: "stale", attempts: 20 }]);
    await adoptLegacyDevice(a);
    expect(await getMeta(a, "pending_log_entries")).toEqual([
      { entryId: "eA", userId: A, state: "stale", attempts: 20 },
    ]);
  });

  it("does not create smc on a phone that never had it", async () => {
    await adoptLegacyDevice(bindAccount(A));
    expect(await dbNames()).not.toContain("smc");
    expect(await legacyHeldCount()).toBe(0);
  });

  it("deletes legacy caches and holds drafts, scans and the store blob", async () => {
    localStorage.setItem("smc:coach:current:someone", "t1");
    localStorage.setItem("smc:health_daily", "{}");
    localStorage.setItem("smc:draft:d1", "{}");
    localStorage.setItem("smc:pending_scans", "[]");
    localStorage.setItem("meal-companion:store:v1", "{}");
    await adoptLegacyDevice(bindAccount(A));
    expect(localStorage.getItem("smc:health_daily")).toBeNull();
    expect(localStorage.getItem("smc:coach:current:someone")).toBe("t1");
    expect(localStorage.getItem("smc:draft:d1")).toBeNull();
    expect(localStorage.getItem("smc:legacy:smc:draft:d1")).toBe("{}");
    expect(localStorage.getItem("smc:legacy:smc:pending_scans")).toBe("[]");
    expect(localStorage.getItem("smc:legacy:meal-companion:store:v1")).toBe("{}");
  });

  // PR #248 review r2 #3: old coach transcripts and action marks carry no owner and hold applied
  // results the server cannot rebuild. They are held byte for byte, never deleted, never adopted.
  it("holds old coach transcripts and coach-action marks, byte for byte", async () => {
    const transcript = JSON.stringify({ messages: [{ id: "m1" }], actions: [{ status: "applied" }] });
    const mark = JSON.stringify({ status: "applied", token: { kind: "log", entryId: "e1" } });
    localStorage.setItem("smc:coach:t1", transcript);
    localStorage.setItem("smc:coach-action:x1", mark);
    await adoptLegacyDevice(bindAccount(A));
    expect(localStorage.getItem("smc:coach:t1")).toBeNull();
    expect(localStorage.getItem("smc:coach-action:x1")).toBeNull();
    expect(localStorage.getItem("smc:legacy:smc:coach:t1")).toBe(transcript);
    expect(localStorage.getItem("smc:legacy:smc:coach-action:x1")).toBe(mark);
    expect(localStorage.getItem(`smc:u:${A}:coach:t1`)).toBeNull();
  });

  it("never gives held legacy ticks to any account, B signing in first (audit plan r3 finding 2)", async () => {
    localStorage.setItem("meal-companion:store:v1", JSON.stringify({ version: 1,
      days: { "2026-09-01": { eaten: { "meal-1": "2026-09-01T12:00:00Z" } } } }));
    const b = bindAccount(B);
    await adoptLegacyDevice(b);
    expect(await allOps(b)).toEqual([]);
    expect(loadStore().days["2026-09-01"]).toBeUndefined();
    unbindAccount(); resetAccountMemory();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect(await allOps(a)).toEqual([]);
    expect(loadStore().days["2026-09-01"]).toBeUndefined();
    expect(localStorage.getItem("smc:legacy:meal-companion:store:v1")).not.toBeNull();
  });

  /**
   * PR #248 review r1 #1: the store blob, drafts and the scan queue carry no owner. A phone whose
   * only RECORDED owner is A can still hold B's local-only data, so nothing ownerless is ever
   * given to an account — not even on a single-account phone. It stays held.
   */
  it("gives the store blob to nobody, even when A is the only owner the phone has recorded", async () => {
    await seedLegacy(); // owner-stamped rows of A and B
    const db = await openDB("smc");
    await db.delete("plan_days", "2026-09-02"); // B's row: now only A is on record
    db.close();
    localStorage.setItem("meal-companion:onboarding-disposition:" + A, "{}");
    localStorage.setItem("meal-companion:store:v1", JSON.stringify({ version: 1,
      days: { "2026-09-01": { extras: [{ id: "x1", name: "Label meal" }] } } }));
    await adoptLegacyDevice(bindAccount(A));
    expect(loadStore().days["2026-09-01"]).toBeUndefined();
    expect(localStorage.getItem(`smc:u:${A}:store`)).toBeNull();
    expect(localStorage.getItem("smc:legacy:meal-companion:store:v1")).not.toBeNull(); // still held
  });

  it("B's local-only drafts and scans stay held when A, the only recorded owner, signs in", async () => {
    // B used this phone but left no owner-stamped record; A is the only owner on record.
    localStorage.setItem("meal-companion:onboarding-disposition:" + A, "{}");
    localStorage.setItem("smc:draft:d1", "{\"draft\":1}");
    localStorage.setItem("smc:pending_scans", "[{\"gtin14\":\"1\"}]");
    await adoptLegacyDevice(bindAccount(A));
    expect(localStorage.getItem(`smc:u:${A}:draft:d1`)).toBeNull();
    expect(localStorage.getItem(`smc:u:${A}:pending_scans`)).toBeNull();
    expect(localStorage.getItem("smc:legacy:smc:draft:d1")).toBe("{\"draft\":1}");
    expect(localStorage.getItem("smc:legacy:smc:pending_scans")).toBe("[{\"gtin14\":\"1\"}]");
  });

  it("gives the store blob to nobody when the phone has recorded another account too", async () => {
    await seedLegacy(); // A's and B's plan rows
    localStorage.setItem("meal-companion:store:v1", JSON.stringify({ version: 1,
      days: { "2026-09-01": { extras: [{ id: "x1", name: "Label meal" }] } } }));
    await adoptLegacyDevice(bindAccount(A));
    expect(loadStore().days["2026-09-01"]).toBeUndefined();
    unbindAccount(); resetAccountMemory();
    await adoptLegacyDevice(bindAccount(B));
    expect(loadStore().days["2026-09-01"]).toBeUndefined();
  });

  it("never touches a store the account already has", async () => {
    localStorage.setItem("meal-companion:onboarding-disposition:" + A, "{}");
    localStorage.setItem(`smc:u:${A}:store`, JSON.stringify({ version: 1,
      days: { "2026-09-05": { extras: [{ id: "new", name: "New" }] } } }));
    localStorage.setItem("meal-companion:store:v1", JSON.stringify({ version: 1,
      days: { "2026-09-01": { extras: [{ id: "old", name: "Old" }] } } }));
    await adoptLegacyDevice(bindAccount(A));
    expect(Object.keys(loadStore().days)).toEqual(["2026-09-05"]);
  });

  it("is idempotent: a second run copies nothing again and keeps what it held", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    const second = await adoptLegacyDevice(a);
    expect(second.copied).toBe(0);
    expect(second.heldOps).toBe(1);
  });

  it("stops quietly when the account changes mid-adoption and writes nothing more", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    const run = adoptLegacyDevice(a);
    bindAccount(B);
    await expect(run).resolves.toMatchObject({ copied: 0 });
    unbindAccount();
    const a2 = bindAccount(A);
    expect(localStorage.getItem(`smc:device:legacy-adopted:${A}`)).toBeNull();
    // the next bind runs it again
    await adoptLegacyDevice(a2);
    expect(await getRow(a2, "plan_days", "2026-09-01")).toMatchObject({ user_id: A });
  });
});
