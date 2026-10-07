/**
 * T11b fifth-audit finding 5: the generic read-modify-write (`mutateRowWithOp`) files the mirror
 * row and its op under the ENTITY and KEY its caller passed, so all three names for the record —
 * the caller's `entity`, the op's `entity` and `entity_id`, and the row's own encoded key — have to
 * agree before either write. A mismatch is a caller bug, and it must leave NOTHING behind: a
 * half-written mirror row is a row the server never hears about, and an op under another key is one
 * the next writer of the real row cannot find.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { countOps, getRow, mutateRowWithOp } from "@/lib/sync/idb";
import type { Entity, SyncOp } from "@/lib/sync/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/** `user_settings` is the one single-row entity, so its key is the constant "settings". */
const SETTINGS: Entity = "user_settings";
const SETTINGS_KEY = "settings";
const WATER_DATE = "2026-09-12";

function op(over: Partial<SyncOp> = {}): SyncOp {
  return { op_id: crypto.randomUUID(), entity: SETTINGS, entity_id: SETTINGS_KEY, kind: "update",
    base_rev: 4, payload: {}, client_ts: "2026-09-12T18:00:00.000Z", ...over };
}

/** The write under test: the row the mutate returns, filed under the caller's entity and key. */
function write(entity: Entity, key: string, mutation: SyncOp, row: Record<string, unknown> = {}) {
  return mutateRowWithOp(h, entity, key, (current) => ({
    row: { ...current, ...row, rev: 5 }, op: mutation, result: null,
  }));
}

describe("the mirror row and its op must name the same record", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("refuses an op that names another entity, and writes neither half", async () => {
    await expect(write(SETTINGS, SETTINGS_KEY, op({ entity: "water_log" })))
      .rejects.toThrow(/op entity water_log does not match user_settings/);

    expect(await getRow(h, SETTINGS, SETTINGS_KEY)).toBeUndefined();
    expect(await countOps(h)).toBe(0);
  });

  it("refuses an op filed under another key, and writes neither half", async () => {
    await expect(write(SETTINGS, SETTINGS_KEY, op({ entity_id: "another-row" })))
      .rejects.toThrow(/op entity_id another-row does not match settings/);

    expect(await getRow(h, SETTINGS, SETTINGS_KEY)).toBeUndefined();
    expect(await countOps(h)).toBe(0);
  });

  it("refuses a row whose own key is not the key the write files under", async () => {
    // A date-keyed entity: the op agrees with the caller, but the row it returns carries another
    // day, so the row would land under a key it does not describe.
    await expect(write("water_log", WATER_DATE,
      op({ entity: "water_log", entity_id: WATER_DATE }), { local_date: "2026-09-11" }))
      .rejects.toThrow(/row key 2026-09-11 does not match 2026-09-12/);

    expect(await getRow(h, "water_log", WATER_DATE)).toBeUndefined();
    expect(await countOps(h)).toBe(0);
  });

  it("writes both halves when all three agree", async () => {
    await write(SETTINGS, SETTINGS_KEY, op(), { height_cm: 165 });
    expect(await getRow(h, SETTINGS, SETTINGS_KEY)).toMatchObject({ height_cm: 165, rev: 5 });
    expect(await countOps(h)).toBe(1);
  });
});
