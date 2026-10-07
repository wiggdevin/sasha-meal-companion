import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { allOps, appendOp } from "./idb";
import { applyFoodMembershipResult } from "./outbox-membership";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

describe("food-membership outbox settlement", () => {
  beforeEach(async () => {
    h = await resetTestAccount();
    globalThis.indexedDB = new IDBFactory();
  });

  it("removes an applied membership operation without creating a mirror row", async () => {
    const queued = await appendOp(h, {
      op_id: "11111111-1111-4111-8111-111111111111",
      entity: "food_membership",
      entity_id: "watermelon",
      kind: "update",
      base_rev: null,
      payload: { name_norm: "watermelon", status: "eats", rev: 100 },
      client_ts: "2026-09-19T12:00:00.000Z",
    }, 100);
    const handled = await applyFoodMembershipResult(h, {
      op_id: queued.op_id, status: "applied", rev: 100, seq: 1,
    }, queued, async () => { throw new Error("applied membership was treated as rejected"); });

    expect(handled).toBe(true);
    expect(await allOps(h)).toEqual([]);
  });
});
