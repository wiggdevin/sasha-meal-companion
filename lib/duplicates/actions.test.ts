import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { AccountChanged, bindAccount, type AccountHandle } from "@/lib/device/account";
import { resetTestAccount } from "@/tests/helpers/account";
import { SyncOpSchema } from "@/lib/sync/types";

const forget = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("@/lib/log/delete-entry", () => ({ forgetLoggedEntry: forget }));

import { flushHeldMerges, isMergeHeld, keepBoth, MERGE_UNDO_MS, mergeGroup, scheduleMerge, undoKeepBoth } from "./actions";
import type { OpenDuplicateGroup } from "./read";

const DATE = "2026-10-08";
const GROUP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FP = "ab".repeat(32);
const E1 = "e1111111-1111-4111-8111-111111111111";
const E2 = "e2222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-08T13:00:00Z");

const ROW = { id: GROUP_ID, user_id: "u", local_date: DATE, fingerprint: FP, slot: "meal-2",
  state: "open", merged_into_entry_id: null, decided_at: null, rev: 3,
  created_at: "2026-10-08T12:40:00Z" };

const OPEN: OpenDuplicateGroup = {
  group: { id: GROUP_ID, localDate: DATE, fingerprint: FP, slot: "meal-2", state: "open", rev: 3 },
  members: [
    { entryId: E1, at: "2026-10-08T12:31:00Z", name: "Chicken", itemNames: ["Chicken"], kcal: 300 },
    { entryId: E2, at: "2026-10-08T12:33:00Z", name: "Chicken", itemNames: ["Chicken"], kcal: 300 },
  ],
};

let h: AccountHandle;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  h = await resetTestAccount();
  forget.mockClear();
  await putRow(h, "duplicate_groups", GROUP_ID, ROW);
});
afterEach(() => { vi.restoreAllMocks(); });

const groupOps = async (account: AccountHandle) =>
  (await allOps(account)).filter((op) => op.entity === "duplicate_groups");

describe("keepBoth", () => {
  it("queues one dismissed update the server accepts, with the whole row and the mirror's rev", async () => {
    expect(await keepBoth(h, GROUP_ID, NOW)).toBe("queued");
    const [op] = await groupOps(h);
    expect(op).toMatchObject({ entity: "duplicate_groups", entity_id: GROUP_ID, kind: "update",
      base_rev: 3, user_id: h.userId,
      payload: { id: GROUP_ID, local_date: DATE, fingerprint: FP, slot: "meal-2", state: "dismissed",
        merged_into_entry_id: null, decided_at: "2026-10-08T13:00:00.000Z" } });
    // The wire shape the route validates (app/api/sync/ops).
    expect(SyncOpSchema.safeParse(op).success).toBe(true);
    expect(await getRow(h, "duplicate_groups", GROUP_ID)).toMatchObject({ state: "dismissed", rev: 3 });
  });

  it("is idempotent: a second tap writes nothing", async () => {
    await keepBoth(h, GROUP_ID, NOW);
    expect(await keepBoth(h, GROUP_ID, NOW)).toBe("already_decided");
    expect(await groupOps(h)).toHaveLength(1);
  });

  it("answers missing for a group this phone never mirrored", async () => {
    expect(await keepBoth(h, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", NOW)).toBe("missing");
    expect(await groupOps(h)).toHaveLength(0);
  });

  it("is account-switch safe: an old handle writes nothing to either account", async () => {
    const other = bindAccount("22222222-2222-4222-8222-222222222222");
    await expect(keepBoth(h, GROUP_ID, NOW)).rejects.toBeInstanceOf(AccountChanged);
    expect(await groupOps(other)).toHaveLength(0);
    const back = bindAccount(h.userId);
    expect(await groupOps(back)).toHaveLength(0);
    expect(await getRow(back, "duplicate_groups", GROUP_ID)).toMatchObject({ state: "open" });
  });
});

describe("undoKeepBoth", () => {
  it("reopens the group, aimed at the rev the queued dismiss will leave", async () => {
    await keepBoth(h, GROUP_ID, NOW);
    expect(await undoKeepBoth(h, GROUP_ID, NOW + 1_000)).toBe("queued");
    const ops = (await groupOps(h)).sort((a, b) => a.seq - b.seq);
    expect(ops.map((op) => [op.payload.state, op.base_rev])).toEqual([["dismissed", 3], ["open", 4]]);
    expect(ops[1].payload).toMatchObject({ decided_at: null, merged_into_entry_id: null });
    expect(await getRow(h, "duplicate_groups", GROUP_ID)).toMatchObject({ state: "open" });
  });

  it("does nothing to a group that is not dismissed", async () => {
    expect(await undoKeepBoth(h, GROUP_ID, NOW)).toBe("already_decided");
    expect(await groupOps(h)).toHaveLength(0);
  });
});

describe("mergeGroup", () => {
  it("deletes the newer entry through the normal delete path and merges into the oldest", async () => {
    expect(await mergeGroup(h, OPEN, NOW)).toBe("queued");
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith(DATE, E2, h);
    const [op] = await groupOps(h);
    expect(op).toMatchObject({ kind: "update", base_rev: 3,
      payload: { state: "merged", merged_into_entry_id: E1 } });
    expect(SyncOpSchema.safeParse(op).success).toBe(true);
  });

  it("is idempotent: a repeat merges and deletes nothing more", async () => {
    await mergeGroup(h, OPEN, NOW);
    expect(await mergeGroup(h, OPEN, NOW)).toBe("already_decided");
    const together = await Promise.all([mergeGroup(h, OPEN, NOW), mergeGroup(h, OPEN, NOW)]);
    expect(together.every((outcome) => outcome === "already_decided")).toBe(true);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(await groupOps(h)).toHaveLength(1);
  });

  it("never runs twice at once for the same group", async () => {
    const [first, second] = await Promise.all([mergeGroup(h, OPEN, NOW), mergeGroup(h, OPEN, NOW)]);
    expect([first, second].sort()).toEqual(["already_decided", "queued"]);
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("is account-switch safe: an old handle deletes nothing and queues nothing", async () => {
    const other = bindAccount("22222222-2222-4222-8222-222222222222");
    await expect(mergeGroup(h, OPEN, NOW)).rejects.toBeInstanceOf(AccountChanged);
    expect(forget).not.toHaveBeenCalled();
    expect(await groupOps(other)).toHaveLength(0);
  });
});

describe("scheduleMerge (exact Undo, OD16)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("holds for the life of the Undo toast by default", () => {
    expect(MERGE_UNDO_MS).toBe(5_000);
  });

  it("writes nothing until the Undo window closes, then merges", async () => {
    scheduleMerge(h, OPEN, 80);
    expect(isMergeHeld(h, GROUP_ID)).toBe(true);
    expect(forget).not.toHaveBeenCalled();
    expect(await groupOps(h)).toHaveLength(0);
    await vi.waitFor(async () => expect(await groupOps(h)).toHaveLength(1));
    expect(forget).toHaveBeenCalledWith(DATE, E2, h);
    expect(isMergeHeld(h, GROUP_ID)).toBe(false);
  });

  it("Undo inside the window leaves both entries and the group exactly as they were", async () => {
    const held = scheduleMerge(h, OPEN, 40);
    expect(held.undo()).toBe(true);
    await sleep(120);
    expect(forget).not.toHaveBeenCalled();
    expect(await groupOps(h)).toHaveLength(0);
    expect(await getRow(h, "duplicate_groups", GROUP_ID)).toMatchObject({ state: "open", rev: 3 });
    expect(held.undo()).toBe(false);
  });

  it("a second tap holds one merge, and leaving the page runs it at once", async () => {
    scheduleMerge(h, OPEN, 60_000);
    scheduleMerge(h, OPEN, 60_000);
    await flushHeldMerges();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(await groupOps(h)).toHaveLength(1);
  });

  it("a merge held under an account that is gone writes nothing", async () => {
    scheduleMerge(h, OPEN, 60_000);
    const other = bindAccount("22222222-2222-4222-8222-222222222222");
    await flushHeldMerges();
    expect(forget).not.toHaveBeenCalled();
    expect(await groupOps(other)).toHaveLength(0);
  });
});
