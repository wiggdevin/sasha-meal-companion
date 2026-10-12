/**
 * T11b P1 (eighth round): SEND GENERATIONS for the `user_settings` row.
 *
 * The seventh round made the outbox hold one pending op anchored at the baseline rev, and then let a
 * local edit REPLACE that op while its request was still in flight. Two things followed, and both are
 * reproduced here against the compare-and-swap fake:
 *
 *  1. A delayed `applied` reclassified the fields the server had just acknowledged as pending intents
 *     (the acknowledgement was folded against the OLD baseline row), so a remote change to a field
 *     her own op had already written was silently overwritten on the retry.
 *  2. A LOST answer left the replaced op's row to be resurrected by the retry backoff, and the next
 *     `duplicate` then settled against that stale generation — dropping the newer edits with it.
 *
 * The fix: when an op is SENT its `{ op_id, base_rev, intents, generation }` is frozen (the op row is
 * the record; `markSentSettings` writes the snapshot and stops rewriting it). Intents recorded after
 * the send go into the NEXT generation with a fresh op_id, and a response settles only the generation
 * whose op_id it carries. `applied` (and `duplicate`) make that generation's payload the new baseline
 * and rewrite the next generation onto it; `conflict` rebases the pending generation(s) onto the row
 * the server returned.
 *
 * The last case is the other half of the same finding: a phone upgrading from the T6 era with a
 * queued whole-row op but NO baseline. Promoting every column of that stale payload to an intent is
 * how it overwrote newer remote settings on its first sync, so it fails closed instead — the op is
 * held back, the feed is re-read from the start, and only the fields that actually differ from the
 * pulled row become intents (best-effort recovery: the row the payload was built on was never
 * recorded, so a field she really did change is indistinguishable from a stale copy).
 *
 * Ninth round (finding 1): the FREEZE is part of the SELECTION now. The drain reads the outbox to
 * build its batch, and an edit landing after that read replaces the op it named — the normal
 * coalescing path. Freezing the name afterwards put the retired op back beside its successor, and
 * the answer to the retired op then deleted the newer edit with it. Ninth round (finding 2): a
 * baseline-less `create` is parked like an `update`, and the feed the recovery re-reads is also what
 * says whether the server holds a row at all — if it holds none, her payload IS the row to create.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allOps, getRow, setCursor } from "@/lib/sync/idb";
import { pullChanges, pushOutbox } from "@/lib/sync/client";
import { enqueue, pendingCount, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { saveBodyProfile } from "@/lib/body-profile-client";
import { setGoal } from "@/lib/water-client";
import {
  applyThenDropFetch, casServer, FRESH_SETTINGS, gatedServerFetch, serverFetch,
} from "./cas-server-fixture";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

vi.mock("@/lib/sync/food-refs", () => ({
  loadAccountFoodSnapshot: async () => ({ foods: [], prefs: [], refs: [] }),
}));

let h: AccountHandle;

/**
 * The window the drain's freeze must own: it fires from `allOps`, the outbox read the drain takes
 * first, and runs the edit the README above describes. Registered (and consumed) once per test.
 */
const seam = vi.hoisted(() => ({ between: null as null | (() => Promise<void>) }));

vi.mock("@/lib/sync/idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/idb")>();
  return { ...actual, allOps: async (h: AccountHandle) => {
    const ops = await actual.allOps(h);
    const once = seam.between;
    seam.between = null;
    if (once) await once();
    return ops;
  } };
});

describe("a settings generation in flight", () => {
  beforeEach(async () => {
    seam.between = null;
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("settles a delayed applied for its own generation, never re-asserting its fields", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });                     // baseline = the server's row, rev 4
    await saveBodyProfile({ height_cm: 165 });             // generation 1, aimed at rev 4

    const gate = gatedServerFetch(server);
    const inFlight = pushOutbox(h, { fetchFn: gate.fetchFn });
    await gate.reached;                                    // the server applied it: rev 5
    // She edits again while the answer is still in the air.
    await setGoal(10, "training-10");                      // generation 2
    // …and another device moves the field generation 1 already wrote.
    server.moveTo({ ...(server.row() ?? {}), rev: 6, height_cm: 170 });

    gate.release();
    const settled = await inFlight;
    expect(settled).toMatchObject({ applied: 1, failed: false });

    // Only generation 1 settled. Generation 2 is still queued, carrying the goal alone, aimed at
    // the rev the acknowledged generation landed on — the acknowledged height is NOT an intent.
    const pending = await allOps(h);
    expect(pending).toHaveLength(1);
    expect(pending[0].base_rev).toBe(5);
    expect(pending[0].payload).toMatchObject({ height_cm: 165, water_goal_cups_training: 10 });
    expect(await pendingCount(h)).toBe(1);

    // The retry is a conflict (the server moved to 6) and rebases onto the row the server holds:
    // the other device's 170 survives, and her goal is the only thing written.
    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ conflicts: 1, applied: 0 });
    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ applied: 1, conflicts: 0 });
    expect(server.row()).toMatchObject({ height_cm: 170, water_goal_cups_training: 10, rev: 7 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("reads a duplicate as 'this generation's payload is on the server' and keeps the next one", async () => {
    const clock = vi.useFakeTimers({ toFake: ["Date"] });
    try {
    const server = casServer(FRESH_SETTINGS);
    await pullChanges(h, 0, { fetchFn: serverFetch(server) });
    await saveBodyProfile({ height_cm: 165 });             // generation 1, aimed at rev 4

    // The push applied it and the answer died on the way back, so the op is still queued.
    const lost = await pushOutbox(h, { fetchFn: applyThenDropFetch(server) });
    expect(lost).toMatchObject({ applied: 0, failed: true });
    expect(server.row()).toMatchObject({ height_cm: 165, rev: 5 });
    expect((await allOps(h))[0]).toMatchObject({ attempts: 1 });

    // Her next edit lands while that generation is unconfirmed, and another device moves the row.
    await setGoal(10, "training-10");                      // generation 2
    server.moveTo({ ...(server.row() ?? {}), rev: 6, protein_g: 120 });
    await pullChanges(h, 0, { fetchFn: serverFetch(server) });  // the real sync order: pull, then push

    // The retry waits out the transport backoff the lost answer left behind.
    vi.setSystemTime(new Date(Date.now() + 5_000));
    // The retry answers duplicate (the op_id is in the change log), which settles generation 1 only:
    // the pulled row stands and generation 2 is re-aimed at it, her goal intact.
    const duplicate = await pushOutbox(h, { fetchFn: serverFetch(server) });
    expect(duplicate).toMatchObject({ dropped: 1, applied: 0 });
    const pending = await allOps(h);
    expect(pending).toHaveLength(1);
    expect(pending[0].base_rev).toBe(6);
    expect(pending[0].payload).toMatchObject({ water_goal_cups_training: 10, protein_g: 120 });

    expect(await pushOutbox(h, { fetchFn: serverFetch(server) })).toMatchObject({ applied: 1 });
    expect(server.row()).toMatchObject({ height_cm: 165, water_goal_cups_training: 10,
      protein_g: 120, rev: 7 });
    await expect(pendingCount(h)).resolves.toBe(0);
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY)).toMatchObject({ ...server.row() });
    } finally { clock.useRealTimers(); }
  });

  it("keeps a transport-failed generation queued until its retry is due", async () => {
    const clock = vi.useFakeTimers({ toFake: ["Date"] });
    // The top of the outbox's jitter band (lib/jitter.ts) is the planned one-second delay.
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      clock.setSystemTime(new Date("2026-09-12T18:00:00.000Z"));
      const server = casServer(FRESH_SETTINGS);
      const fetchFn = serverFetch(server);
      await pullChanges(h, 0, { fetchFn });
      await saveBodyProfile({ height_cm: 165 });

      expect(await pushOutbox(h, { fetchFn: applyThenDropFetch(server) }))
        .toMatchObject({ pushed: 0, failed: true, retryAfterMs: 1_000 });
      expect((await allOps(h))[0]).toMatchObject({ attempts: 1,
        next_attempt_at: Date.now() + 1_000 });

      // The server has the immutable generation, but its answer was lost. Before the retry time,
      // the drain must leave it queued instead of bypassing backoff and settling a duplicate.
      expect(await pushOutbox(h, { fetchFn }))
        .toMatchObject({ pushed: 0, dropped: 0, failed: false });
      await expect(pendingCount(h)).resolves.toBe(1);

      clock.advanceTimersByTime(1_000);
      expect(await pushOutbox(h, { fetchFn })).toMatchObject({ pushed: 1, dropped: 1 });
      await expect(pendingCount(h)).resolves.toBe(0);
    } finally { clock.useRealTimers(); random.mockRestore(); }
  });

  it("coalesces every edit made in flight into at most one immutable successor", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await pullChanges(h, 0, { fetchFn });
    await saveBodyProfile({ height_cm: 165 });

    const gate = gatedServerFetch(server);
    const inFlight = pushOutbox(h, { fetchFn: gate.fetchFn });
    await gate.reached;
    await setGoal(10, "training-10");
    await saveBodyProfile({ body_fat_pct: 25 });
    await setGoal(9, "rest");

    const [sent, successor] = await allOps(h);
    expect(await allOps(h)).toHaveLength(2);
    expect(sent.payload).toMatchObject({ height_cm: 165, water_goal_cups_training: 8,
      water_goal_cups_rest: 7 });
    expect(sent.payload).not.toHaveProperty("body_fat_pct");
    expect(successor.payload).toMatchObject({ height_cm: 165, body_fat_pct: 25,
      water_goal_cups_training: 10, water_goal_cups_rest: 9 });
    expect(successor.op_id).not.toBe(sent.op_id);

    gate.release();
    expect(await inFlight).toMatchObject({ applied: 1, failed: false });
    const remaining = await allOps(h);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].op_id).toBe(successor.op_id);
    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ applied: 1, conflicts: 0 });
    expect(server.row()).toMatchObject({ height_cm: 165, body_fat_pct: 25,
      water_goal_cups_training: 10, water_goal_cups_rest: 9, rev: 6 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });
});

describe("a T6-era phone upgrading with a queued settings op", () => {
  beforeEach(async () => {
    seam.between = null;
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("parks the op, pulls the row, then sends only the fields that differ", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await setCursor(h, 1);                                    // the phone's earlier sync got this far
    // The op the T6-era build queued: the whole row it knew, no baseline recorded anywhere.
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "update", base_rev: 4, client_ts: "2026-09-12T17:00:00.000Z",
      payload: { water_goal_cups: 8, water_goal_cups_training: 10, water_goal_cups_rest: 7,
        training_kcal: 2400, protein_g: 110 } });
    // Another device (on this build) set her height while the phone was away.
    server.moveTo({ ...FRESH_SETTINGS, rev: 5, height_cm: 170 });

    // Fail closed: nothing goes on the wire before the server's row is known.
    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ pushed: 0, failed: true });
    expect(server.row()).toMatchObject({ height_cm: 170, training_kcal: 2400, rev: 5 });

    // The cursor has already passed the settings row, so the recovery re-reads the feed from 0.
    expect(await pullChanges(h, undefined, { fetchFn })).toMatchObject({ applied: 1 });

    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ applied: 1, failed: false });
    // The unrelated remote bump survives, and her queued goal reaches the server.
    expect(server.row()).toMatchObject({ height_cm: 170, water_goal_cups_training: 10,
      training_kcal: 2400, rev: 6 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("keeps a baseline-less op parked until the recovery pull reaches its final page", async () => {
    const server = casServer(FRESH_SETTINGS);
    await setCursor(h, 1);
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "update", base_rev: 4, client_ts: "2026-09-12T17:00:00.000Z",
      payload: { ...FRESH_SETTINGS, water_goal_cups_training: 10 } });
    const pagedFetch = (async (url: string) => {
      const since = Number(new URL(String(url), "https://app.test").searchParams.get("since") ?? 0);
      if (since === 0) {
        return new Response(JSON.stringify({ changes: [{ seq: 1, entity: "user_settings",
          entity_key: "settings", rev: 4, op: "update", at: "2026-09-12T18:00:00.000Z",
          current: FRESH_SETTINGS }], next_cursor: 1, has_more: true }), { status: 200,
          headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ changes: [], next_cursor: 2, has_more: false }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    expect(await pullChanges(h, undefined, { fetchFn: pagedFetch, maxPages: 1 }))
      .toMatchObject({ pages: 1, hasMore: true });
    expect(await pushOutbox(h, { fetchFn: serverFetch(server) }))
      .toMatchObject({ pushed: 0, failed: true });
    await expect(pendingCount(h)).resolves.toBe(1);

    // The replay resumes at its own watermark (W026, A082): one page, not a restart from 0.
    expect(await pullChanges(h, undefined, { fetchFn: pagedFetch, maxPages: 2 }))
      .toMatchObject({ pages: 1, hasMore: false });
    expect(await pushOutbox(h, { fetchFn: serverFetch(server) }))
      .toMatchObject({ applied: 1, failed: false });
    expect(server.row()).toMatchObject({ water_goal_cups_training: 10, rev: 5 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  it("collapses a baseline-less legacy chain without reviving an edit the newest op reverted",
    async () => {
      const authoritative = { ...FRESH_SETTINGS, height_cm: 160 };
      const server = casServer(authoritative);
      const fetchFn = serverFetch(server);
      await setCursor(h, 1);
      await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
        kind: "update", base_rev: 4, client_ts: "2026-09-12T17:00:00.000Z",
        payload: { ...authoritative, height_cm: 165 } });
      await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
        kind: "update", base_rev: 5, client_ts: "2026-09-12T17:01:00.000Z",
        payload: { ...authoritative, height_cm: 160, water_goal_cups_training: 10 } });

      expect(await pushOutbox(h, { fetchFn })).toMatchObject({ pushed: 0, failed: true });
      expect(await pullChanges(h, undefined, { fetchFn })).toMatchObject({ applied: 1 });
      await expect(pendingCount(h)).resolves.toBe(1);

      // The latest legacy payload put height back to the authoritative 160, so height is no longer
      // an outstanding intent. A later remote height change must survive the conflict/rebase.
      server.moveTo({ ...authoritative, rev: 5, height_cm: 170 });
      expect(await pushOutbox(h, { fetchFn })).toMatchObject({ conflicts: 1, applied: 0 });
      expect(await pushOutbox(h, { fetchFn })).toMatchObject({ conflicts: 0, applied: 1 });
      expect(server.row()).toMatchObject({ height_cm: 170, water_goal_cups_training: 10, rev: 6 });
      await expect(pendingCount(h)).resolves.toBe(0);
    });

  // Finding 2, the CREATE half: the same phone, but the op its old build queued is a `create` (no
  // baseline, `base_rev: null`). `apply_sync_op` answers a create against an existing row with
  // `conflict` and the server's own row, so sending it dropped every column of her payload — the
  // park has to cover a create exactly like an update, and the diff then re-aims it as an update.
  it("parks a baseline-less create and sends only the fields the server's row lacks", async () => {
    const server = casServer(FRESH_SETTINGS);
    const fetchFn = serverFetch(server);
    await setCursor(h, 1);
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "create", base_rev: null, client_ts: "2026-09-12T17:00:00.000Z",
      payload: { water_goal_cups: 8, water_goal_cups_training: 10, water_goal_cups_rest: 7,
        training_kcal: 2400, protein_g: 110 } });
    server.moveTo({ ...FRESH_SETTINGS, rev: 5, height_cm: 170 });

    // Fail closed, exactly like the update: a create against a row the server MIGHT hold is not a
    // request it can answer without throwing her payload away.
    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ pushed: 0, failed: true });
    expect(server.row()).toMatchObject({ height_cm: 170, water_goal_cups_training: 8, rev: 5 });

    // The feed, re-read from the start, has the row: her payload diffs against it, and only the
    // goal she actually changed is kept.
    expect(await pullChanges(h, undefined, { fetchFn })).toMatchObject({ applied: 1 });
    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ applied: 1, failed: false });
    expect(server.row()).toMatchObject({ height_cm: 170, water_goal_cups_training: 10,
      training_kcal: 2400, rev: 6 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });

  // Finding 2, the no-row half: the feed the recovery re-reads carries NO settings row at all, so
  // the server holds none. A parked update would be answered `gone` and stay parked for good; the
  // explicit empty baseline turns her payload into the row the create inserts.
  it("creates the row when the recovery's feed shows the server holds none", async () => {
    const server = casServer(null);
    const fetchFn = serverFetch(server);
    await setCursor(h, 1);
    await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_settings", entity_id: "settings",
      kind: "create", base_rev: null, client_ts: "2026-09-12T17:00:00.000Z",
      payload: { water_goal_cups: 8, water_goal_cups_training: 10, water_goal_cups_rest: 7,
        training_kcal: 2400, protein_g: 110 } });

    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ pushed: 0, failed: true });
    expect(server.row()).toBeNull();

    // The empty baseline is explicit (rev 0), and the mirror shows the create it is waiting to send.
    await pullChanges(h, undefined, { fetchFn });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ water_goal_cups_training: 10, rev: 1 });

    expect(await pushOutbox(h, { fetchFn })).toMatchObject({ applied: 1, failed: false });
    expect(server.row()).toMatchObject({ water_goal_cups_training: 10, training_kcal: 2400,
      rev: 1 });
    await expect(pendingCount(h)).resolves.toBe(0);
  });
});

/**
 * Finding 1 (ninth round): the selection and the freeze are ONE transaction. The drain's own outbox
 * read is a snapshot, and an edit landing after it replaces the op that snapshot named; a freeze
 * written against the name afterwards resurrects the retired op beside the successor, and the
 * retired op's answer then retires the newer edit with it.
 */
describe("the drain's selection and freeze", () => {
  beforeEach(async () => {
    seam.between = null;
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("sends the generation it froze, not the op an edit replaced while the batch was built",
    async () => {
      const server = casServer(FRESH_SETTINGS);
      const fetchFn = serverFetch(server);
      await pullChanges(h, 0, { fetchFn });                   // baseline = the server's row, rev 4
      await saveBodyProfile({ height_cm: 165 });           // the op the drain's snapshot names

      // The edit lands in the window between that snapshot and the freeze.
      seam.between = async () => { await setGoal(10, "training-10"); };

      expect(await pushOutbox(h, { fetchFn }))
        .toMatchObject({ pushed: 1, applied: 1, failed: false });
      // Both edits reached the server in one op, and no stale generation was resurrected.
      expect(server.row()).toMatchObject({ height_cm: 165, water_goal_cups_training: 10,
        training_kcal: 2400, rev: 5 });
      await expect(pendingCount(h)).resolves.toBe(0);
      expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
        .toMatchObject({ ...(server.row() ?? {}) });
    });
});
