/**
 * T11b: the shared body-profile read, and two writes that must both survive.
 *
 * Sol audit finding 3 — every consumer of the profile (Settings' fields, the estimator card, Today's
 * line) reads through `useBodyProfile()`, which reloads on the existing `SYNCED_EVENT` and on the
 * `BODY_PROFILE_CHANGED_EVENT` a save fires; a save must therefore reach a SECOND consumer, not only
 * the form that made it. Finding 7 — mirror row and outbox op commit together, and a rejected
 * enqueue must leave the stored row untouched and let the form show its retry.
 *
 * Fourth round: finding 1 — every writer of the `user_settings` row (this save, water's `setGoal`,
 * a sync pull) goes through ONE atomic read-modify-write, so a whole-row payload can never carry a
 * column value another writer has already replaced. Third round: finding 6 — a rejected read is a
 * retryable error state, never a profile that reads as "not set" forever.
 *
 * The compare-and-swap server and the settlement cases it drives live in
 * `tests/body/settings-settlement.test.ts` — this file was 424 lines, over the 400-line limit.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { SYNCED_EVENT } from "@/lib/sync/client";
import type { BodyProfile } from "@/lib/tdee";
import {
  listenForSyncStatusRefresh, loadSyncStatus, SyncCard, type SyncStatusState,
} from "@/components/SyncStatus";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

/** Flipped per test; read by the mocked idb read below. */
const flags = vi.hoisted(() => ({ failRead: false }));

/** The read half of the same idea: a rejected IndexedDB read must reach the consumer as an error. */
vi.mock("@/lib/sync/idb", async (orig) => {
  const actual = await orig<typeof import("@/lib/sync/idb")>();
  return { ...actual,
    getRow: vi.fn(async (...args: Parameters<typeof actual.getRow>) => {
      if (flags.failRead) throw new Error("read failed");
      return actual.getRow(...args);
    }) };
});

const { pendingCount } = await import("@/lib/sync/outbox");
const { BODY_PROFILE_CHANGED_EVENT, loadBodyProfile, saveBodyProfile, subscribeBodyProfile } =
  await import("@/lib/body-profile-client");
const { EMPTY_BODY_PROFILE } = await import("@/lib/tdee");

/** A consumer of the shared read: what a hook's `setProfile` and error flag would receive. */
function consumer(): { seen: BodyProfile[]; errors: unknown[]; stop: () => void; retry: () => void } {
  const seen: BodyProfile[] = [];
  const errors: unknown[] = [];
  const sub = subscribeBodyProfile((profile) => seen.push(profile),
    (error) => errors.push(error));
  return { seen, errors, stop: sub.stop, retry: sub.retry };
}

describe("the shared body-profile read", () => {
  beforeEach(async () => {
    flags.failRead = false;
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("updates a second consumer after a save — no reload, no re-read by the saver", async () => {
    const a = consumer();
    const b = consumer();
    await vi.waitFor(() => expect(a.seen).toHaveLength(1));
    await vi.waitFor(() => expect(b.seen).toHaveLength(1));

    await saveBodyProfile({ height_cm: 165, birth_year: 1996, sex: "female", body_fat_pct: 25 });
    await vi.waitFor(() => expect(b.seen.at(-1)?.heightCm).toBe(165));
    expect(a.seen.at(-1)?.heightCm).toBe(165);
    a.stop();
    b.stop();
  });

  it("re-reads the row when a sync pull settles on the existing event", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const { seen, stop } = consumer();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen.at(-1)).toEqual(EMPTY_BODY_PROFILE);

    // A pull writes the row into IndexedDB and then announces itself. The consumer must notice.
    await putRow(h, "user_settings", "settings", { height_cm: 170, birth_year: 1996, sex: "female",
      body_fat_pct: 25 });
    page.dispatchEvent(new Event(SYNCED_EVENT));
    await vi.waitFor(() => expect(seen.at(-1)?.heightCm).toBe(170));
    stop();
    vi.unstubAllGlobals();
  });

  // Finding 6: the hook starts at `{ profile: null, error: null }`, which renders exactly like
  // "nothing stored yet". A rejected read must therefore be an error the surface can retry.
  it("reports a rejected read and recovers on retry, instead of reading as an empty profile", async () => {
    flags.failRead = true;
    const { seen, errors, retry, stop } = consumer();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(seen).toHaveLength(0);                  // a failed read never invents a profile
    expect(errors[0]).toBeInstanceOf(Error);

    flags.failRead = false;
    await putRow(h, "user_settings", "settings", { height_cm: 170, birth_year: 1996, sex: "female",
      body_fat_pct: 25 });
    retry();
    await vi.waitFor(() => expect(seen.at(-1)?.heightCm).toBe(170));
    expect(errors.at(-1)).toBeNull();              // the retry clears the error state
    stop();
  });

  it("fires the named body-profile-changed event after a successful save", async () => {
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    const heard: string[] = [];
    page.addEventListener(BODY_PROFILE_CHANGED_EVENT, () => heard.push("changed"));

    await saveBodyProfile({ height_cm: 165 });
    expect(heard).toEqual(["changed"]);
    expect((await loadBodyProfile()).heightCm).toBe(165);
    vi.unstubAllGlobals();
  });
});

describe("two saves at once", () => {
  beforeEach(async () => {
    flags.failRead = false;
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  // Finding 1: a save reads the whole row, merges its patch and writes the whole row back. Two
  // fields edited in quick succession (height, then birth year) used to read the same rev and the
  // later write erased the earlier field. Both writes now commit through one atomic path, so both
  // survive.
  it("keeps both fields when two distinct-field saves are in flight together", async () => {
    await Promise.all([
      saveBodyProfile({ height_cm: 165 }),
      saveBodyProfile({ birth_year: 1996 }),
    ]);

    const row = await getRow(h, "user_settings", "settings");
    expect(row?.height_cm).toBe(165);
    expect(row?.birth_year).toBe(1996);
    // One op, not two: `user_settings` is a single whole-row entity, so the outbox holds at most
    // one pending op for it and the second save's intent merges into the first's payload (T11b
    // seventh round). The mirror is what proves both fields survived the race.
    expect(await pendingCount(h)).toBe(1);
    expect((await allOps(h))[0].payload).toMatchObject({ height_cm: 165, birth_year: 1996 });
    expect((await loadBodyProfile()).heightCm).toBe(165);
  });
});

describe("honest offline sync status", () => {
  beforeEach(async () => {
    flags.failRead = false;
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
  });

  it("reads the cached session and local queue without requiring the network", async () => {
    await saveBodyProfile({ height_cm: 165 });
    const offlineClient = {
      auth: {
        getUser: async () => { throw new TypeError("offline"); },
        getSession: async () => ({ data: { session: {
          user: { email: "synthetic@example.test" },
        } } }),
      },
    };

    await expect(loadSyncStatus(offlineClient)).resolves.toMatchObject({
      email: "synthetic@example.test",
      pending: 1,
    });
  });

  it("keeps the mirror and exact pending generation across an offline reload", async () => {
    await saveBodyProfile({ height_cm: 165, birth_year: 1996 });
    const before = (await allOps(h))[0];
    expect(before).toBeDefined();
    h = await resetTestAccount();

    expect(await getRow(h, "user_settings", "settings")).toMatchObject({
      height_cm: 165, birth_year: 1996,
    });
    const after = (await allOps(h))[0];
    expect(after).toMatchObject({
      op_id: before.op_id,
      generation: before.generation,
      base_rev: before.base_rev,
      payload: before.payload,
    });
  });

  it("refreshes as soon as a local profile save makes the displayed queue stale", () => {
    const target = new EventTarget();
    const refresh = vi.fn();
    const stop = listenForSyncStatusRefresh(target, refresh);
    target.dispatchEvent(new Event(BODY_PROFILE_CHANGED_EVENT));
    expect(refresh).toHaveBeenCalledOnce();
    stop();
  });

  it("labels a manual recovery attempt as retrying after a failed sync", () => {
    const state: SyncStatusState = {
      email: "synthetic@example.test", pending: 1, lastSync: null,
      error: "some changes could not be sent", syncing: true, loaded: true,
    };
    const markup = renderToStaticMarkup(createElement(SyncCard, { state, onSync: () => {} }));
    expect(markup).toContain("Retrying…");
    expect(markup).not.toContain("height_cm");
  });

  it("still exposes a queued local change when no session is available", () => {
    const state: SyncStatusState = {
      email: null, pending: 1, lastSync: null, error: null, syncing: false, loaded: true,
    };
    const markup = renderToStaticMarkup(createElement(SyncCard, { state, onSync: () => {} }));
    expect(markup).toContain("1 change waiting to send");
  });
});
