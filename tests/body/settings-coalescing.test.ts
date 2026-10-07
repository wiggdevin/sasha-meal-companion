/**
 * T11b P1 (seventh round): `user_settings` is ONE whole-row entity per user, so the outbox may hold
 * at most one pending op for it, anchored at the rev the server is KNOWN to hold. Two queued
 * dependent ops (`base_rev` N and N+1) let an external revision bump in between make the second op
 * CAS-match a rev it never meant to write, silently overwriting the other device's field.
 *
 * Every case drives the compare-and-swap server in `./cas-server-fixture` and asserts the row the
 * SERVER ends up with, not the payload that was queued. `./settings-settlement.test.ts` keeps the
 * settlement/mirror cases; this file is the coalescing rule and its races.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getRow } from "@/lib/sync/idb";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { enqueue, pendingCount, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { saveBodyProfile } from "@/lib/body-profile-client";
import { addCups, setGoal } from "@/lib/water-client";
import { casServer, FRESH_SETTINGS, serverFetch } from "./cas-server-fixture";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let h: AccountHandle;

describe("one pending settings op, anchored at the baseline rev", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("coalesces two local edits into one op aimed at the rev the server holds", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });                 // baseline = the server's row, rev 4

    await setGoal(10, "training-10");
    await saveBodyProfile({ height_cm: 165 });

    const queued = await allOps(h);
    expect(queued).toHaveLength(1);                    // one op, not a speculative successor
    expect(queued[0].base_rev).toBe(4);                // the baseline rev, not the mirror's 5
    expect(queued[0].payload).toMatchObject({ water_goal_cups_training: 10, height_cm: 165,
      training_kcal: 2400, water_goal_cups_rest: 7 });

    const push = await pushOutbox(h, { fetchFn });
    expect(push).toMatchObject({ applied: 1, conflicts: 0, failed: false });
    expect(server.row()).toMatchObject({ height_cm: 165, water_goal_cups_training: 10, rev: 5 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("keeps an external change and both local edits when the server moves between them", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });

    await setGoal(10, "training-10");
    await saveBodyProfile({ height_cm: 165 });

    // Another device writes in between: the server is at rev 5 and its kcal is 2500.
    server.moveTo({ ...FRESH_SETTINGS, rev: 5, training_kcal: 2500,
      changed_at: "2026-09-12T17:00:00.000Z" });

    const first = await pushOutbox(h, { fetchFn });
    // The other device's write is still on the server: the stale successor op used to match rev 5
    // by accident and write its own 2400 back over it.
    expect(server.row()).toMatchObject({ training_kcal: 2500 });
    expect(first).toMatchObject({ applied: 0, conflicts: 1 });
    const second = await pushOutbox(h, { fetchFn });
    expect(second).toMatchObject({ applied: 1, conflicts: 0 });

    // The other device's field AND both of hers survive.
    expect(server.row()).toMatchObject({ training_kcal: 2500, height_cm: 165,
      water_goal_cups_training: 10, rev: 6 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("keeps an external change that landed before both local edits", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });

    server.moveTo({ ...FRESH_SETTINGS, rev: 5, training_kcal: 2500 });
    await pullChanges(h, 0, { fetchFn });                 // baseline = rev 5

    await setGoal(10, "training-10");
    await saveBodyProfile({ height_cm: 165 });

    const queued = await allOps(h);
    expect(queued).toHaveLength(1);
    expect(queued[0].base_rev).toBe(5);
    const push = await pushOutbox(h, { fetchFn });
    expect(push).toMatchObject({ applied: 1, conflicts: 0 });
    expect(server.row()).toMatchObject({ training_kcal: 2500, height_cm: 165,
      water_goal_cups_training: 10, rev: 6 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("rebases the same op twice during a resend without losing an intent", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await setGoal(10, "training-10");
    await saveBodyProfile({ height_cm: 165 });

    server.moveTo({ ...FRESH_SETTINGS, rev: 5, training_kcal: 2500 });
    expect((await pushOutbox(h, { fetchFn })).conflicts).toBe(1);      // conflict on the first send
    expect(((await allOps(h))[0]).base_rev).toBe(5);

    // The server moves again while the rebased op is still waiting its turn.
    server.moveTo({ ...(server.row() ?? {}), rev: 6, protein_g: 120 });
    expect((await pushOutbox(h, { fetchFn })).conflicts).toBe(1);      // conflict on the resend
    expect(((await allOps(h))[0]).base_rev).toBe(6);

    expect((await pushOutbox(h, { fetchFn })).applied).toBe(1);
    expect(server.row()).toMatchObject({ training_kcal: 2500, protein_g: 120, height_cm: 165,
      water_goal_cups_training: 10, rev: 7 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("rewrites the pending op onto the row a pull delivers mid-queue", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await setGoal(10, "training-10");

    server.moveTo({ ...FRESH_SETTINGS, rev: 5, training_kcal: 2500 });
    await pullChanges(h, 0, { fetchFn });                 // the pull lands while her op is still queued

    const queued = await allOps(h);
    expect(queued).toHaveLength(1);
    expect(queued[0].base_rev).toBe(5);                // rewritten to the pulled rev, still one op
    expect(queued[0].payload).toMatchObject({ training_kcal: 2500, water_goal_cups_training: 10 });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ training_kcal: 2500, water_goal_cups_training: 10, rev: 6 });

    expect((await pushOutbox(h, { fetchFn })).applied).toBe(1);
    expect(server.row()).toMatchObject({ training_kcal: 2500, water_goal_cups_training: 10,
      rev: 6 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("leaves every other entity's op path alone: water still queues successive ops", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await setGoal(10, "training-10");

    await addCups("2026-09-19", 1);
    await addCups("2026-09-19", 1);

    const ops = await allOps(h);
    expect(ops.filter((op) => op.entity === "user_settings")).toHaveLength(1);
    // The water path is untouched: two cups are two ops, each aimed at the rev the one before it
    // leaves behind — the coalescing rule is `user_settings`'s alone.
    const water = ops.filter((op) => op.entity === "water_log");
    expect(water).toHaveLength(2);
    expect(water.map((op) => op.base_rev)).toEqual([null, 1]);
  });

  it("collapses an upgraded device's old op chain into the one op it may hold", async () => {
    // A phone that upgrades holding the pre-fix chain: two ops, base 4 then 5, exactly what the old
    // `mutateUserSettings` queued. The next edit must collapse them into ONE op aimed at the rev the
    // server actually holds, with all three intents on it.
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "update", base_rev: 4, payload: { ...FRESH_SETTINGS, height_cm: 165 },
      client_ts: "2026-09-12T17:00:00.000Z" });
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "update", base_rev: 5, payload: { ...FRESH_SETTINGS, height_cm: 165,
        water_goal_cups_training: 10 }, client_ts: "2026-09-12T17:01:00.000Z" });

    await setGoal(9, "rest");

    const queued = await allOps(h);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ base_rev: 4,
      payload: { height_cm: 165, water_goal_cups_training: 10, water_goal_cups_rest: 9,
        training_kcal: 2400 } });
    expect((await pushOutbox(h, { fetchFn })).applied).toBe(1);
    expect(server.row()).toMatchObject({ height_cm: 165, water_goal_cups_training: 10,
      water_goal_cups_rest: 9, rev: 5 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });
});
