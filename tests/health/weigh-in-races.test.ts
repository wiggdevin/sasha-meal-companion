/**
 * T8 §2, the drain with something else happening at the same time.
 *
 * Split from tests/health/weigh-in-drain.test.ts, which covers one drain on its own. Everything
 * here has two actors: a correction typed while a POST is in the air, a refusal landing long after
 * she typed the number, an account changing under a batch, two tabs writing one `meta` key. That is
 * where every bug this module has had actually lived. The doubles are
 * tests/health/weigh-in-harness.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, AccountNotBound } from "@/lib/device/account";
import {
  __resetWeighInDrain, drainWeighIns, readPendingWeighIns, saveWeighIn,
} from "@/lib/health/weigh-in-client";
import { getDay, loadStore, saveStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import {
  account, bodies, fail, offline, ok, resetWeighInWorld, signOut, switchAccount, TZ, USER_A, USER_B,
} from "./weigh-in-harness";

beforeEach(resetWeighInWorld);

describe("a save and a drain that overlap", () => {
  /**
   * The drain works from a snapshot it took before its POST went out. She can answer for the same
   * day while that POST is in the air — type a correction, get a 200 — and the drain would then
   * retire a record that is no longer the truth, or re-send one it should have abandoned.
   */
  it("abandons a record the interactive save already answered for", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const drainFetch = vi.fn(async () => { await parked; return ok(); });

    const draining = drainWeighIns(account(), { fetchImpl: drainFetch });
    // She corrects it before the drain's turn comes, and the server takes 171.
    await saveWeighIn("2026-09-17", 171, { fetchImpl: vi.fn(async () => ok()), tz: TZ });
    release();
    await draining;

    // The stale 170 never went out at all: the re-read before the POST saw it was no longer owed.
    expect(drainFetch).not.toHaveBeenCalled();
    expect(await readPendingWeighIns(account())).toEqual([]);

    __resetWeighInDrain();
    const after = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: after })).toEqual({ posted: 0, pending: 0 });
    expect(after).not.toHaveBeenCalled();
  });

  /**
   * The same race with the POST genuinely on the wire: the save lands WHILE the drain is waiting on
   * its own request. The drain must settle only the record it sent and send nothing further — the
   * server's last word is hers, and a second drain must not reopen it.
   */
  it("sends its record once when the correction lands mid-flight, and nothing after", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    const drainFetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).lb === 170) {
        await saveWeighIn("2026-09-17", 171, { fetchImpl: vi.fn(async () => ok()), tz: TZ });
      }
      return ok();
    });
    await drainWeighIns(account(), { fetchImpl: drainFetch });

    expect(bodies(drainFetch)).toEqual([{ localDate: "2026-09-17", lb: 170, tz: TZ }]);
    expect(await readPendingWeighIns(account())).toEqual([]);

    __resetWeighInDrain();
    const after = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: after })).toEqual({ posted: 0, pending: 0 });
    expect(after).not.toHaveBeenCalled();
  });

  /**
   * The other half of the same window: the drain used to compute the list it would write BEFORE its
   * last await, so a record parked in between was overwritten out of existence — never sent, and
   * gone from the phone.
   */
  it("keeps a weigh-in parked while the drain was finishing", async () => {
    await saveWeighIn("2026-09-16", 169, { fetchImpl: offline(), tz: TZ });

    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const drainFetch = vi.fn(async () => { await parked; return ok(); });

    const draining = drainWeighIns(account(), { fetchImpl: drainFetch });
    await Promise.resolve();
    await saveWeighIn("2026-09-17", 171, { fetchImpl: offline(), tz: TZ });
    release();
    await draining;

    expect(await readPendingWeighIns(account())).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 171, tz: TZ } }]);
  });

  it("skips a record that stopped being pending before its turn came", async () => {
    await saveWeighIn("2026-09-16", 169, { fetchImpl: offline(), tz: TZ });
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    // The first POST of the batch retires the second day's record while the batch is still running.
    const sending = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).lb === 169) {
        await saveWeighIn("2026-09-17", 171, { fetchImpl: vi.fn(async () => ok()), tz: TZ });
      }
      return ok();
    });
    await drainWeighIns(account(), { fetchImpl: sending });

    expect(bodies(sending)).toEqual([{ localDate: "2026-09-16", lb: 169, tz: TZ }]);
    expect(await readPendingWeighIns(account())).toEqual([]);
  });
});

/**
 * `lib/sync/client.ts` dispatches on `globalThis` the same way, optionally — Node has no window.
 * Recording the dispatch is what proves the page was told; the page's own listener is app/page.tsx.
 */
function watchSyncedEvent(): { types: () => string[] } {
  const seen: string[] = [];
  const target = globalThis as { dispatchEvent?: (e: Event) => boolean };
  const before = target.dispatchEvent;
  target.dispatchEvent = (e: Event) => { seen.push(e.type); return true; };
  afterEach(() => { target.dispatchEvent = before; });
  return { types: () => seen };
}

describe("a weigh-in the drain gets refused", () => {
  const day = () => getDay("2026-09-17")?.weightLb;

  it("takes the refused weight back off the day", async () => {
    await saveWeighIn("2026-09-17", 10, { fetchImpl: offline(), tz: TZ });
    saveStore({ ...loadStore(), days: { "2026-09-17":
      { date: "2026-09-17", weightLb: 10, updatedAt: "2026-09-17T00:00:00.000Z" } } });

    await drainWeighIns(account(), { fetchImpl: vi.fn(async () => fail(422)) });

    expect(day()).toBeUndefined();
    expect(await readPendingWeighIns(account())).toEqual([]);
  });

  /**
   * Today reads the day from `lib/store.ts` at render time, so clearing it behind her back changes
   * nothing on screen until something else happens to re-render — the pill went on showing a weight
   * that had just been removed. The page already listens for the sync event; this is one.
   */
  it("tells Today to repaint, so the pill does not keep the weight that just went", async () => {
    await saveWeighIn("2026-09-17", 10, { fetchImpl: offline(), tz: TZ });
    saveStore({ ...loadStore(), days: { "2026-09-17":
      { date: "2026-09-17", weightLb: 10, updatedAt: "2026-09-17T00:00:00.000Z" } } });

    const repaint = watchSyncedEvent();
    await drainWeighIns(account(), { fetchImpl: vi.fn(async () => fail(422)) });
    expect(repaint.types()).toEqual([SYNCED_EVENT]);
  });

  it("says nothing when there was no local weight to take back", async () => {
    await saveWeighIn("2026-09-17", 10, { fetchImpl: offline(), tz: TZ });

    const repaint = watchSyncedEvent();
    await drainWeighIns(account(), { fetchImpl: vi.fn(async () => fail(422)) });
    expect(repaint.types()).toEqual([]);
  });

  it("leaves a weight she has typed since the refused one alone", async () => {
    await saveWeighIn("2026-09-17", 10, { fetchImpl: offline(), tz: TZ });
    saveStore({ ...loadStore(), days: { "2026-09-17":
      { date: "2026-09-17", weightLb: 171, updatedAt: "2026-09-17T00:00:00.000Z" } } });

    await drainWeighIns(account(), { fetchImpl: vi.fn(async () => fail(422)) });

    expect(day()).toBe(171);
  });
});

/**
 * The in-heap chain serializes this tab. Two tabs are two heaps writing one `meta` key, so the real
 * boundary is `navigator.locks` when the browser has it. Node has no `navigator.locks`, so what is
 * exercised here is the FALLBACK — the chain on its own must still serialize this tab's writes.
 */
describe("the pending list with no Web Locks API", () => {
  it("still lets two saves for different days both survive", async () => {
    expect((globalThis as { navigator?: { locks?: unknown } }).navigator?.locks).toBeUndefined();

    // Started together, so their read-modify-writes overlap if nothing serializes them.
    await Promise.all([
      saveWeighIn("2026-09-16", 169, { fetchImpl: offline(), tz: TZ }),
      saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ }),
    ]);

    const parked = await readPendingWeighIns(account());
    expect(parked.map((e) => e.request.localDate).sort()).toEqual(["2026-09-16", "2026-09-17"]);
  });
});

/**
 * Phase 9 §0.2: one IndexedDB database per account, so "a phone two accounts have used" is no
 * longer a shared list filtered by JWT — it is two databases, and a device primitive holding a
 * handle for the account that is no longer bound finds that out the moment it checks.
 */
describe("a phone two accounts have used", () => {
  it("posts nothing for an account that did not park it, and leaves the record alone", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    const hB = switchAccount(USER_B);
    const asB = vi.fn(async () => ok());
    expect(await drainWeighIns(hB, { fetchImpl: asB })).toEqual({ posted: 0, pending: 0 });
    expect(asB).not.toHaveBeenCalled();

    expect(await readPendingWeighIns(switchAccount(USER_A))).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 170, tz: TZ } }]);
  });

  /**
   * The switch lands while the batch's first record is genuinely in the air. `post` re-checks the
   * handle the instant its answer comes back (Phase 9 §0.2) and throws rather than settling a
   * record for an account that is no longer bound — so the drain stops having sent exactly one
   * request, and neither record it started with is retired.
   */
  it("stops a drain that the account changed under, without settling what it sent", async () => {
    await saveWeighIn("2026-09-16", 169, { fetchImpl: offline(), tz: TZ });
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    const hA = account();
    const sending = vi.fn(async () => { switchAccount(USER_B); return ok(); });
    await expect(drainWeighIns(hA, { fetchImpl: sending })).rejects.toThrow(AccountChanged);

    expect(sending).toHaveBeenCalledTimes(1);
    expect(await readPendingWeighIns(switchAccount(USER_A))).toHaveLength(2);
  });

  /**
   * The identity check used to sit AFTER the POST, which is one request too late: the request goes
   * out on whatever the device holds at that moment, so A's parked weight could land under B's
   * account and be filed as B's morning. It is now checked immediately before every send (the
   * drain's own `isCurrent` guard, and `drainWeighIns`'s own up front), so a switch already in
   * place before the drain even starts sends nothing.
   */
  it("sends nothing for the old account when the account changes before the send", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });
    const hA = account();
    switchAccount(USER_B);

    const sending = vi.fn(async () => ok());
    expect(await drainWeighIns(hA, { fetchImpl: sending })).toEqual({ posted: 0, pending: 0 });

    expect(sending).not.toHaveBeenCalled();
    expect(await readPendingWeighIns(switchAccount(USER_A))).toHaveLength(1);
  });

  /**
   * Phase 9 §0.1: every device primitive needs a bound account, so a weigh-in typed with none bound
   * has nowhere to park. The pre-Phase-9 premise this replaces — "a weigh-in typed with no
   * session" — used to park the record unowned; that record can no longer exist, so the nearest
   * equivalent is `saveWeighIn` refusing outright.
   */
  it("throws for a weigh-in typed with no account bound, rather than parking it unowned", async () => {
    signOut();
    await expect(saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ }))
      .rejects.toThrow(AccountNotBound);
    expect(await readPendingWeighIns(switchAccount(USER_A))).toEqual([]);
  });
});
