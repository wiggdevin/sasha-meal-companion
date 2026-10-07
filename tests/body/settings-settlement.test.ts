/**
 * T11b: the `user_settings` row against a compare-and-swap server — the rev chain, and the mirror
 * after every settlement.
 *
 * Split out of `tests/body/profile-sync.test.ts` (fifth-audit finding 3): that file was 424 lines.
 * The shared read and the two-save case stay there; everything that needs the CAS fake lives here.
 *
 * The auditor's reproduction: set the water goal to 10 while a profile save is in flight, and the
 * goal came back as 8 — the save had read the pre-10 row and queued the whole row it read. Same
 * shape for a pull: the server's row lands while the save is between its read and its write.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { mutateUserSettings, pendingCount, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { readSettingsBaseline } from "@/lib/sync/settings";
import { saveBodyProfile } from "@/lib/body-profile-client";
import { setGoal } from "@/lib/water-client";
import {
  applyThenDropFetch, casServer, FRESH_SETTINGS, serverFetch, settingsPage,
} from "./cas-server-fixture";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let h: AccountHandle;

describe("one atomic settings row", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
    await putRow(h, "user_settings", USER_SETTINGS_KEY, { rev: 4, water_goal_cups: 8,
      water_goal_cups_training: 8, water_goal_cups_rest: 7, training_kcal: 2400 });
  });

  it("keeps the water goal and the body profile when a save races setGoal", async () => {
    // The auditor's reproduction, taken all the way to a server that compare-and-swaps: both
    // writes must reach it, in whichever order they won the race locally.
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await Promise.all([
      saveBodyProfile({ height_cm: 165 }),
      setGoal(10, "training-10"),
    ]);

    const row = await getRow(h, "user_settings", "settings");
    expect(row?.height_cm).toBe(165);
    expect(row?.water_goal_cups_training).toBe(10);
    // Both writers rewrite the WHOLE row, and the row is one entity: the second writer's intent
    // merges into the ONE pending op, which stays aimed at the rev the server actually holds.
    // Queueing [4, 4] is what the audit found; [4, 5] is the speculative successor the seventh
    // round's P1 fixed.
    const queued = await allOps(h);
    expect(queued.map((op) => op.base_rev)).toEqual([4]);
    expect(queued[0].payload).toMatchObject({ height_cm: 165, water_goal_cups_training: 10 });

    const push = await pushOutbox(h, { fetchFn });
    expect(push).toMatchObject({ applied: 1, conflicts: 0, failed: false });
    expect(server.row()).toMatchObject({ height_cm: 165, water_goal_cups_training: 10,
      training_kcal: 2400, rev: 5 });
  });

  it("keeps the goal she just set and the field a save is writing when a pull lands", async () => {
    // She set the goal to 10 offline; the op is still in the outbox. The next pull brings the
    // server's row, which still says 8 — writing it straight over the mirror IS the revert.
    await putRow(h, "user_settings", USER_SETTINGS_KEY, { rev: 4, height_cm: 160,
      water_goal_cups: 8, water_goal_cups_training: 8, water_goal_cups_rest: 7,
      training_kcal: 2400 });
    await setGoal(10, "training-10");

    await Promise.all([
      saveBodyProfile({ body_fat_pct: 25 }),
      pullChanges(h, 0, { fetchFn: settingsPage({ rev: 4, height_cm: 160, water_goal_cups: 8,
        water_goal_cups_training: 8, water_goal_cups_rest: 7, training_kcal: 2400 }) }),
    ]);

    const row = ((await getRow(h, "user_settings", "settings")) ?? {}) as Record<string, number>;
    expect(row.water_goal_cups_training).toBe(10);  // the pull did not put the goal back to 8
    expect(row.body_fat_pct).toBe(25);
    expect(row.height_cm).toBe(160);                // and the pull kept what nothing changed
    // The last whole-row payload is what the server will end up with: both values, once.
    const last = (await allOps(h)).at(-1);
    expect(last?.payload).toMatchObject({ water_goal_cups_training: 10, body_fat_pct: 25,
      height_cm: 160, training_kcal: 2400 });
  });

  it("rolls back the mirror, pending op, baseline, intents and generation on a late write failure",
      async () => {
    await pullChanges(h, 0, { fetchFn: settingsPage({ rev: 4, water_goal_cups: 8,
      water_goal_cups_training: 8, water_goal_cups_rest: 7, training_kcal: 2400 }) });
    await setGoal(10, "training-10");
    const beforeRow = await getRow(h, "user_settings", USER_SETTINGS_KEY);
    const beforeOps = await allOps(h);
    const beforeBaseline = await readSettingsBaseline(h);

    // An uncloneable op-only field fails on the final OUTBOX put, after the old op was retired and
    // the baseline and mirror writes were issued. The transaction must roll every store back.
    await expect(mutateUserSettings(h, (current) => ({
      row: { ...current, height_cm: 165, rev: 5 },
      op: { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: USER_SETTINGS_KEY,
        kind: "update", base_rev: 4,
        client_ts: (() => undefined) as unknown as string,
        payload: { ...current, height_cm: 165 } },
      result: null,
    }))).rejects.toThrow();

    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY)).toEqual(beforeRow);
    expect(await allOps(h)).toEqual(beforeOps);
    expect(await readSettingsBaseline(h)).toEqual(beforeBaseline);
    // A goal set by hand also records the manual water mode in diet_prefs (lib/water-prefs.ts).
    expect(beforeBaseline).toMatchObject({ rev: 4, generation: 2,
      intents: [{ key: "water_goal_cups_training", value: 10 },
        { key: "diet_prefs", value: { flags: [], water: { goal: "manual" } } }] });
    await expect(pendingCount(h)).resolves.toBe(1);
  });
});

/**
 * The rev chain (finding 1) and the mirror after each settlement (finding 2). Every case is driven
 * against the compare-and-swap server in `./cas-server-fixture`, so the assertion is the row the
 * server would end up with and the row she would see — not a payload in the outbox. The
 * one-pending-op rule (seventh-round P1) lives in `./settings-coalescing.test.ts`.
 */
describe("a compare-and-swap server and the mirror it implies", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("coalesces the goal and then a profile save into one op", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });                 // the server's row becomes the baseline

    await setGoal(10, "training-10");
    await saveBodyProfile({ height_cm: 165 });

    expect((await allOps(h)).map((op) => op.base_rev)).toEqual([4]);
    const push = await pushOutbox(h, { fetchFn });
    expect(push).toMatchObject({ applied: 1, conflicts: 0, failed: false });
    expect(server.row()).toMatchObject({ height_cm: 165, water_goal_cups_training: 10,
      water_goal_cups_rest: 7, training_kcal: 2400, rev: 5 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("coalesces in the other order too: a profile save, then the goal", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });

    await saveBodyProfile({ height_cm: 165 });
    await setGoal(10, "training-10");

    expect((await allOps(h)).map((op) => op.base_rev)).toEqual([4]);
    const push = await pushOutbox(h, { fetchFn });
    expect(push).toMatchObject({ applied: 1, conflicts: 0, failed: false });
    expect(server.row()).toMatchObject({ height_cm: 165, water_goal_cups_training: 10,
      training_kcal: 2400, rev: 5 });
  });

  it("keeps her edit in the mirror when the response answers for nothing at all", async () => {
    const server = casServer(FRESH_SETTINGS);
    await pullChanges(h, 0, { fetchFn: serverFetch(server) });
    await setGoal(10, "training-10");
    await saveBodyProfile({ height_cm: 165 });         // both intents, one op, base 4

    // The push applied the op and died before answering. The op stays queued and the mirror keeps
    // BOTH her edits over the server's row — a mirror rebuilt from the baseline alone would show
    // the pre-edit row until the next pull.
    const push = await pushOutbox(h, { fetchFn: serverFetch(server, { results: () => [] }) });
    expect(push).toMatchObject({ applied: 0, failed: true, retryAfterMs: expect.any(Number) });
    await expect(pendingCount(h)).resolves.toBe(1);

    const pending = (await allOps(h))[0];
    const mirror = await getRow(h, "user_settings", USER_SETTINGS_KEY);
    // What the server would show, plus what is still queued: the invariant, then the values.
    expect(mirror).toEqual({ ...server.row(), ...pending.payload, rev: 5 });
    expect(mirror).toMatchObject({ height_cm: 165, water_goal_cups_training: 10, rev: 5 });
  });

  it("keeps a pending goal when a pull lands while it is queued", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await setGoal(10, "training-10");

    // The pull arrives while the goal op is still queued, and the server still says 8.
    await pullChanges(h, 0, { fetchFn });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ water_goal_cups_training: 10, rev: 5 });

    await saveBodyProfile({ height_cm: 165 });
    // Still the ONE op, still aimed at the baseline rev the server holds: the second writer merged.
    expect((await allOps(h)).map((op) => op.base_rev)).toEqual([4]);
    await pushOutbox(h, { fetchFn });
    expect(server.row()).toMatchObject({ water_goal_cups_training: 10, height_cm: 165, rev: 5 });
  });

  it("queues a rebased op and the rev it will land on in one step", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await setGoal(10, "training-10");                 // op 1, base 4

    // Another device bumps the row before her op arrives, so the push comes back a conflict.
    server.moveTo({ ...FRESH_SETTINGS, rev: 5, training_kcal: 2500,
      changed_at: "2026-09-12T17:00:00.000Z" });
    const push = await pushOutbox(h, { fetchFn });
    expect(push).toMatchObject({ applied: 0, conflicts: 1 });

    const rebased = (await allOps(h))[0];
    expect(rebased.base_rev).toBe(5);                 // aimed at the rev the server actually holds
    expect(rebased.payload.water_goal_cups_training).toBe(10);   // her change survived the merge
    // The mirror is the server's row plus the rebased op, at the rev that op will land on. If the
    // re-queue and the rebuild were not one transaction, the next writer would read 5 as well — the
    // same [N, N] the audit found.
    expect((await getRow(h, "user_settings", USER_SETTINGS_KEY))?.rev).toBe(6);
    await saveBodyProfile({ height_cm: 165 });
    // The save merges into the rebased op rather than queueing a successor aimed at 6.
    const merged = await allOps(h);
    expect(merged.map((op) => op.base_rev)).toEqual([5]);
    expect(merged[0].payload).toMatchObject({ water_goal_cups_training: 10, height_cm: 165 });

    const push2 = await pushOutbox(h, { fetchFn });
    expect(push2).toMatchObject({ applied: 1, conflicts: 0 });
    expect(server.row()).toMatchObject({ water_goal_cups_training: 10, height_cm: 165, rev: 6 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("drops a duplicate's stale value instead of keeping it in the mirror", async () => {
    // Eighth round: a `duplicate` only ever answers an op that was really SENT, so the generation is
    // frozen at rev 4 first and the pull that follows it can no longer re-aim it — which is exactly
    // the state the old single-op model could not represent.
    const clock = vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const server = casServer(FRESH_SETTINGS);
      const fetchFn = serverFetch(server);
      await pullChanges(h, 0, { fetchFn });
      await setGoal(10, "training-10");                // op 1, base 4 — queued while she is offline

      // The op had already reached the server once and its answer was lost.
      expect(await pushOutbox(h, { fetchFn: applyThenDropFetch(server) })).toMatchObject({ failed: true });
      // Another device has moved the goal since: the newest pulled row is 12 at rev 6.
      server.moveTo({ ...FRESH_SETTINGS, water_goal_cups_training: 12, rev: 6 });
      await pullChanges(h, 0, { fetchFn });
      expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
        .toMatchObject({ water_goal_cups_training: 10 });        // her intent, still queued

      // The retry waits out the backoff the lost answer left behind, and answers duplicate.
      vi.setSystemTime(new Date(Date.now() + 5_000));
      const push = await pushOutbox(h, { fetchFn: serverFetch(server,
        { results: (ops) => ops.map((op) => ({ op_id: op.op_id, status: "duplicate" as const })) }) });
      expect(push.dropped).toBe(1);
      await expect(pendingCount(h)).resolves.toBe(0);
      // The op left the queue, so its payload leaves the mirror with it: the server's row is the row.
      expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
        .toMatchObject({ water_goal_cups_training: 12, rev: 6 });
    } finally { clock.useRealTimers(); }
  });
});
