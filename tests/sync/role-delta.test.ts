/**
 * Audit 2026-10-10 P15 (W029): a meal-role save is a field delta (`{ role }`), the payload the
 * server's role-only branch (migration 20261210090100) writes alone. It is queued, retried and
 * rebased as a delta, so it can never carry this device's stale status, note or no_cook back over
 * another device's Avoid, and never recreates a pref another device removed.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { drainOutbox, enqueueWithRow } from "@/lib/sync/outbox";
import { isRoleDelta } from "@/lib/sync/role-delta";
import type { OpResult, OpsResponse, SyncOp } from "@/lib/sync/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

const REF = "88888888-8888-4888-8888-888888888888";
let h: AccountHandle;

const roleOp = (baseRev: number): SyncOp => ({
  op_id: crypto.randomUUID(), entity: "user_food_prefs", entity_id: REF, kind: "update",
  base_rev: baseRev, payload: { role: "fat" }, client_ts: "2026-10-11T10:05:00.000Z",
});

const answer = (result: Record<string, unknown>) => async (ops: { op_id: string }[]): Promise<OpsResponse> =>
  ({ results: [{ op_id: ops[0].op_id, ...result } as unknown as OpResult], server_time: "2026-10-11T10:06:00.000Z" });

beforeEach(async () => {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  vi.spyOn(Math, "random").mockReturnValue(1);
  // This device's mirror still says Favored: another device marked the food Avoid at 10:00.
  await putRow(h, "user_food_prefs", REF, {
    food_ref_id: REF, status: "eats", role: null, no_cook: false, note: null, rev: 3,
  });
});

afterEach(() => { vi.restoreAllMocks(); });

describe("a meal-role save is a field delta", () => {
  it("recognises only an exact, storable role payload on a pref", () => {
    expect(isRoleDelta(roleOp(3))).toBe(true);
    expect(isRoleDelta({ ...roleOp(3), payload: { role: "fat", status: "eats" } })).toBe(false);
    expect(isRoleDelta({ ...roleOp(3), payload: { role: "dessert" } })).toBe(false);
    expect(isRoleDelta({ ...roleOp(3), entity: "user_foods" })).toBe(false);
  });

  it("queues `{ role }` alone, keyed by the op's ref", async () => {
    await enqueueWithRow(h, { food_ref_id: REF, status: "eats", role: "fat", rev: 4 }, roleOp(3), 1_000);
    expect((await allOps(h)).map((op) => op.payload)).toEqual([{ role: "fat" }]);
  });

  it("a conflict rebases the delta onto the server row and keeps the server's Avoid", async () => {
    await enqueueWithRow(h, { food_ref_id: REF, status: "eats", role: "fat", rev: 4 }, roleOp(3), 1_000);
    await drainOutbox(h, answer({ status: "conflict", entity: "user_food_prefs", current_rev: 4,
      current: { food_ref_id: REF, status: "avoid", role: null, no_cook: false, note: null, rev: 4,
        updated_at: "2026-10-11T10:00:00.000Z" } }), () => 2_000);
    const [rebased] = await allOps(h);
    expect(rebased).toMatchObject({ entity: "user_food_prefs", base_rev: 4, payload: { role: "fat" } });
    expect(Object.keys(rebased.payload)).toEqual(["role"]);
    expect(await getRow(h, "user_food_prefs", REF)).toMatchObject({ status: "avoid", role: "fat", rev: 4 });
  });

  it("a conflict with a role already stored drops the delta: a stored role wins", async () => {
    await enqueueWithRow(h, { food_ref_id: REF, status: "eats", role: "fat", rev: 4 }, roleOp(3), 1_000);
    await drainOutbox(h, answer({ status: "conflict", entity: "user_food_prefs", current_rev: 4,
      current: { food_ref_id: REF, status: "avoid", role: "protein", rev: 4,
        updated_at: "2026-10-11T10:00:00.000Z" } }), () => 2_000);
    expect(await allOps(h)).toEqual([]);
    expect(await getRow(h, "user_food_prefs", REF)).toMatchObject({ status: "avoid", role: "protein", rev: 4 });
  });

  it("a removed pref (`gone`) drops the delta instead of recreating the food", async () => {
    await enqueueWithRow(h, { food_ref_id: REF, status: "eats", role: "fat", rev: 4 }, roleOp(3), 1_000);
    await drainOutbox(h, answer({ status: "gone" }), () => 2_000);
    expect(await allOps(h)).toEqual([]);
    expect(await getRow(h, "user_food_prefs", REF)).toBeUndefined();
  });
});
