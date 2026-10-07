// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import {
  DEVICE_ACCOUNTS_KEY, hasPendingWork, pendingWork, touchAccount,
} from "@/lib/device/forget";
import { __setDepartureDeps, beginDeparture } from "@/lib/device/departure";
import { writeAccountItem } from "@/lib/device/account-storage";
import { addExtra, loadStore } from "@/lib/store";
import { readCache, writeCache } from "@/lib/coach-client";
import {
  accountDbName, allOps, appendOp, closeAllAccountDbs, deleteOp, putMeta,
} from "@/lib/sync/idb";
import { PENDING_LOG_KEY } from "@/lib/log/pending";
import { PENDING_WEIGH_INS_KEY } from "@/lib/health/weigh-in-client";
import { PENDING_TARGET_REVISIONS_KEY } from "@/lib/targets/client";
import { newPage } from "@/tests/helpers/new-page";

const ids = ["1", "2", "3", "4", "5"].map((n) => `${n.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
const dbNames = async () => (await indexedDB.databases()).map((d) => d.name);
const op = (id: string) => ({ op_id: id, entity: "water_log" as const, entity_id: "2026-09-22",
  kind: "update" as const, base_rev: 1, payload: { local_date: "2026-09-22", cups: 1 },
  client_ts: "2026-09-22T08:00:00Z" });
// Reload boundary: leaving an account deletes nothing of it. The re-fetchable caches stay too:
// they are keyed by the account, and a new page binds only one account.
const KEPT = ["expenditure", "health_daily", "proposals", "draft:d1", "pending_scans",
  "coach-action:x1", "coach:t1", "food-refs", "store"];

/** Leave the bound account as the app does (durable, then "reload"), then open a new page. */
async function leaveTo(next: string | null) {
  __setDepartureDeps({ reload: () => {} });
  await beginDeparture();
  return newPage(next);
}

beforeEach(async () => {
  await newPage(null);
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("leaving an account keeps everything of it (plan decision P9)", () => {
  it("keeps the DB, store, drafts, scans, caches and coach-action marks", async () => {
    const a = bindAccount(ids[0]); touchAccount(ids[0], 1);
    for (const k of KEPT) writeAccountItem(a, k, "keep");
    await appendOp(a, op("o1"));
    await leaveTo(null);
    for (const k of KEPT) expect(localStorage.getItem(`smc:u:${ids[0]}:${k}`)).toBe("keep");
    expect(await dbNames()).toContain(accountDbName(ids[0]));
  });

  it("keeps A's applied coach action and its Undo token across A → B → A (review r2 #2)", async () => {
    const a = bindAccount(ids[0]);
    const thread = { messages: [], actions: [{ action: { kind: "log" } as never, status: "applied" as const,
      token: { kind: "log", entryId: "e1" } as never, messageId: null }] };
    writeCache(a, "t1", thread);
    await leaveTo(ids[1]);
    const back = await leaveTo(ids[0]);
    expect(readCache(back!, "t1").actions).toEqual(thread.actions);
  });

  it("keeps a label-typed meal that lives only in the store, with an empty outbox (audit plan r3 finding 1)", async () => {
    const a = bindAccount(ids[0]); touchAccount(ids[0], 1);
    addExtra("2026-09-22", { id: "x1", name: "Label meal", kcal: 400 } as never);
    expect(await allOps(a)).toEqual([]);
    await leaveTo(ids[1]);
    expect(loadStore().days["2026-09-22"]).toBeUndefined();
    await leaveTo(ids[0]);
    expect(loadStore().days["2026-09-22"]?.extras?.map((e) => e.id)).toEqual(["x1"]);
  });

  it("deletes no account database, even with five accounts on the phone", async () => {
    for (let i = 0; i < 5; i += 1) {
      const h = bindAccount(ids[i]); touchAccount(ids[i], i);
      await appendOp(h, op(`o${i}`));
      await deleteOp(h, `o${i}`);
      await leaveTo(null);
    }
    const names = await dbNames();
    for (const id of ids) expect(names).toContain(accountDbName(id));
    expect(JSON.parse(localStorage.getItem(DEVICE_ACCOUNTS_KEY)!)).toHaveLength(5);
  });

  it("pendingWork counts each kind for the sign-out notice, and answers unknown when unreadable", async () => {
    const a = bindAccount(ids[0]); touchAccount(ids[0], 1);
    await appendOp(a, op("o1"));
    await putMeta(a, PENDING_LOG_KEY, [{ entryId: "e1" }]);
    await putMeta(a, PENDING_WEIGH_INS_KEY, [{ userId: ids[0] }]);
    await putMeta(a, PENDING_TARGET_REVISIONS_KEY, [{ ownerId: ids[0] }]);
    writeAccountItem(a, "draft:d1", "x");
    writeAccountItem(a, "pending_scans", JSON.stringify([{ gtin: "1" }, { gtin: "2" }]));
    await closeAllAccountDbs(); unbindAccount();
    const work = await pendingWork(ids[0]);
    expect(work).toMatchObject({ ops: 1, logRecords: 1, weighIns: 1, targetRevisions: 1, drafts: 1, scans: 2 });
    expect(hasPendingWork(work)).toBe(true);
    const real = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, "open").mockImplementation((name, v) => {
      if (name === accountDbName(ids[0])) throw new Error("blocked");
      return real(name, v);
    });
    expect(await pendingWork(ids[0])).toBe("unknown");
    expect(hasPendingWork("unknown")).toBe(true);
    vi.restoreAllMocks();
  });

  it("pendingWork of an account with no database counts zero and creates none", async () => {
    expect(await pendingWork(ids[3])).toMatchObject({ ops: 0, logRecords: 0, drafts: 0 });
    expect(hasPendingWork(await pendingWork(ids[3]))).toBe(false);
    expect(await dbNames()).not.toContain(accountDbName(ids[3]));
  });
});
