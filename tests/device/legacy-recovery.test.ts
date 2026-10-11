// @vitest-environment jsdom
/**
 * W055 (Phase 9 §0.6 "Later"): the owner-proved recovery tool for held legacy ops. Listing is
 * read-only, recovery is a dry run unless the owner types the confirmation, `smc` is never written
 * or deleted, and one op can reach at most one account.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { adoptLegacyDevice, legacyHeldCount } from "@/lib/device/legacy-adoption";
import {
  installHeldChangesConsole, listHeldLegacyOps, recoverHeldLegacyOps, RECOVER_CONFIRM,
} from "@/lib/device/legacy-recovery";
import { allOps, closeAllAccountDbs, upgradeStores } from "@/lib/sync/idb";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const water = (opId: string, date: string, cups: number, seq: number) => ({
  op_id: opId, entity: "water_log", entity_id: date, kind: "update", base_rev: 0,
  payload: { local_date: date, cups }, client_ts: `${date}T08:00:00Z`,
  seq, attempts: 2, error_attempts: 0, queued_at: `${date}T08:00:00Z`, next_attempt_at: 0,
});

async function seedLegacy(): Promise<void> {
  const db = await openDB("smc", 4, { upgrade: upgradeStores });
  await db.put("outbox", water("w1", "2026-09-03", 5, 1));
  await db.put("outbox", water("w2", "2026-09-04", 6, 2));
  await db.put("outbox", { op_id: "bad", entity: "not_a_table", entity_id: "x", kind: "update",
    payload: {}, seq: 3 });
  db.close();
}

async function legacyOutbox(): Promise<unknown[]> {
  const db = await openDB("smc");
  try { return await db.getAll("outbox"); } finally { db.close(); }
}

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("held legacy op recovery (W055)", () => {
  it("lists held ops as a summary without the payload, and writes nothing", async () => {
    await seedLegacy();
    const before = await legacyOutbox();
    const list = await listHeldLegacyOps();
    expect(list).toEqual([
      { op_id: "bad", entity: "not_a_table", entity_id: "x", kind: "update", client_ts: null,
        recoveredInto: null, valid: false },
      { op_id: "w1", entity: "water_log", entity_id: "2026-09-03", kind: "update",
        client_ts: "2026-09-03T08:00:00Z", recoveredInto: null, valid: true },
      { op_id: "w2", entity: "water_log", entity_id: "2026-09-04", kind: "update",
        client_ts: "2026-09-04T08:00:00Z", recoveredInto: null, valid: true },
    ]);
    expect(JSON.stringify(list)).not.toContain("cups");
    expect(await legacyOutbox()).toEqual(before);
  });

  it("lists nothing on a phone without smc, and never creates it", async () => {
    expect(await listHeldLegacyOps()).toEqual([]);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain("smc");
  });

  it("is a dry run by default: reports the plan and queues nothing", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    const out = await recoverHeldLegacyOps(a, ["w1"]);
    expect(out).toEqual({ dryRun: true, recovered: ["w1"], skipped: [] });
    expect(await allOps(a)).toEqual([]);
    expect(await legacyHeldCount()).toBe(3);
  });

  it("a wrong confirmation is still a dry run", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    const out = await recoverHeldLegacyOps(a, ["w1"], { confirm: "yes" });
    expect(out.dryRun).toBe(true);
    expect(await allOps(a)).toEqual([]);
  });

  it("with the confirmation, queues only the named op into the bound account, stamped and fresh", async () => {
    await seedLegacy();
    const before = await legacyOutbox();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    const out = await recoverHeldLegacyOps(a, ["w1"], { confirm: RECOVER_CONFIRM });
    expect(out).toEqual({ dryRun: false, recovered: ["w1"], skipped: [] });
    const ops = await allOps(a);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op_id: "w1", user_id: A, entity: "water_log", kind: "update",
      payload: { local_date: "2026-09-03", cups: 5 }, attempts: 0 });
    // smc is never written: the old tab's data stays as it was.
    expect(await legacyOutbox()).toEqual(before);
    // The recovered op is no longer counted as held; the other two still are.
    expect(await legacyHeldCount()).toBe(2);
    expect((await listHeldLegacyOps() as { op_id: string; recoveredInto: string | null }[])
      .find((o) => o.op_id === "w1")?.recoveredInto).toBe(A);
  });

  it("never gives one op to a second account", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    await recoverHeldLegacyOps(a, ["w1"], { confirm: RECOVER_CONFIRM });
    const b = bindAccount(B);
    const out = await recoverHeldLegacyOps(b, ["w1"], { confirm: RECOVER_CONFIRM });
    expect(out.recovered).toEqual([]);
    expect(out.skipped).toEqual([{ op_id: "w1", reason: "already_recovered" }]);
    expect(await allOps(b)).toEqual([]);
  });

  it("skips a malformed op and an id that is not held", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    const out = await recoverHeldLegacyOps(a, ["bad", "nope"], { confirm: RECOVER_CONFIRM });
    expect(out.recovered).toEqual([]);
    expect(out.skipped).toEqual([
      { op_id: "bad", reason: "malformed" }, { op_id: "nope", reason: "not_held" },
    ]);
    expect(await allOps(a)).toEqual([]);
  });

  it("the console entry point acts on the bound account and refuses with none bound", async () => {
    await seedLegacy();
    const target: Record<string, unknown> = {};
    installHeldChangesConsole(target);
    const api = target.smcHeldChanges as {
      list: () => Promise<unknown>; recover: (ids: string[], c?: string) => Promise<unknown>;
    };
    await expect(api.recover(["w1"], RECOVER_CONFIRM)).rejects.toThrow(/Sign in/);
    const a = bindAccount(A);
    await expect(api.recover(["w2"], RECOVER_CONFIRM)).resolves.toMatchObject({ recovered: ["w2"] });
    expect((await allOps(a)).map((o) => o.op_id)).toEqual(["w2"]);
  });
});
