/**
 * T8 §2 "Local first, then server, never lost" — ONE save at a time.
 *
 * `updateDay(viewedDate, { weightLb })` happens in lib/today/water-and-weight.ts and is instant.
 * This file is the other half of a single tap: the post, what the server's answer does to the
 * pending list, and what is parked when there is no answer at all. The drain, and everything that
 * can overlap it, is tests/health/weigh-in-drain.test.ts; the doubles both files run on are
 * tests/health/weigh-in-harness.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, AccountNotBound } from "@/lib/device/account";
import {
  __resetWeighInDrain, drainWeighIns, readPendingWeighIns, saveWeighIn,
} from "@/lib/health/weigh-in-client";
import {
  account, bodies, fail, offline, ok, resetWeighInWorld, signOut, switchAccount, TZ, USER_A, USER_B,
} from "./weigh-in-harness";

beforeEach(resetWeighInWorld);

describe("a weigh-in the server answers", () => {
  it("posts the day, the zone and the pounds, and queues nothing", async () => {
    const fetchImpl = vi.fn(async () => ok());
    expect(await saveWeighIn("2026-09-17", 170, { fetchImpl, tz: TZ })).toBeNull();

    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe("/api/health/weigh-in");
    expect(bodies(fetchImpl)).toEqual([{ localDate: "2026-09-17", lb: 170, tz: TZ }]);
    expect(await readPendingWeighIns(account())).toEqual([]);
  });

  it("hands a refusal's own words back for the FAB to show, and does not retry it", async () => {
    const fetchImpl = vi.fn(async () => fail(422, "That weight looks wrong. Check it and try again."));
    expect(await saveWeighIn("2026-09-17", 10, { fetchImpl, tz: TZ }))
      .toBe("That weight looks wrong. Check it and try again.");
    expect(await readPendingWeighIns(account())).toEqual([]);
  });

  /**
   * The correction is the whole point of the day key, and a stale pending record undoes it: the RPC
   * upserts on `manual:<local_date>`, so re-posting yesterday's 170 after today's 171 landed writes
   * 170 back over her correction. An answer — 2xx or a refusal — retires that day's pending record.
   */
  it("retires a parked weigh-in for the same day once a later one is accepted", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });
    expect(await readPendingWeighIns(account())).toHaveLength(1);

    const online = vi.fn(async () => ok());
    await saveWeighIn("2026-09-17", 171, { fetchImpl: online, tz: TZ });
    expect(await readPendingWeighIns(account())).toEqual([]);

    // The drain that follows has nothing to send, so 170 can never come back.
    __resetWeighInDrain();
    const later = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: later })).toEqual({ posted: 0, pending: 0 });
    expect(later).not.toHaveBeenCalled();
  });

  /**
   * A refusal answers for the NUMBER, not for the day. She types 170 offline, comes back into
   * signal, mistypes 10 and is told it is wrong — and the 170 she is still owed is parked in the
   * list. Retiring the day on a refusal deleted it, so the morning weight never reached the server
   * and nothing on the screen ever said so. The parked record stays and the next drain sends it.
   */
  it("leaves a parked weigh-in alone when a LATER number for that day is refused", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });
    await saveWeighIn("2026-09-17", 10, { fetchImpl: vi.fn(async () => fail(422)), tz: TZ });

    expect(await readPendingWeighIns(account())).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 170, tz: TZ } }]);

    __resetWeighInDrain();
    const later = vi.fn(async () => ok());
    expect(await drainWeighIns(account(), { fetchImpl: later })).toEqual({ posted: 1, pending: 0 });
    expect(bodies(later)).toEqual([{ localDate: "2026-09-17", lb: 170, tz: TZ }]);
  });
});

/**
 * The account has to be the same one at the moment the request goes out, and still the same when
 * its answer is acted on. Phase 9 §0.1: `post` re-checks the handle immediately after the response
 * comes back, and an account that changed underneath it throws `AccountChanged` rather than acting
 * on an answer that is not this account's to act on — so a 2xx cannot retire a day under an account
 * that is no longer bound.
 */
describe("a save whose account changes underneath it", () => {
  it("retires nothing when the account flipped while the post was in the air", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });

    // The switch lands while this save's own POST is in the air: the answer comes back to a handle
    // that is no longer current, so the save throws instead of acting on it.
    const switching = vi.fn(async () => { switchAccount(USER_B); return ok(); });
    await expect(saveWeighIn("2026-09-17", 171, { fetchImpl: switching, tz: TZ }))
      .rejects.toThrow(AccountChanged);

    // Nothing was retired on B's behalf. The 171 the server may already hold is on A's list too
    // (written before the send), after the 170 it supersedes.
    expect(await readPendingWeighIns(switchAccount(USER_A))).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 170, tz: TZ } },
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 171, tz: TZ } }]);
  });

  /**
   * PR #248 review r2 #4: the server accepted 171, the answer was lost to a switch, and A came back.
   * The drain must not post the older 170 over the accepted 171: it sends only the newest record
   * for the day and retires the older one with it.
   */
  it("never replays 170 over an accepted 171 whose answer was lost to a switch", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });
    const accepted = vi.fn(async () => { switchAccount(USER_B); return ok(); });
    await expect(saveWeighIn("2026-09-17", 171, { fetchImpl: accepted, tz: TZ }))
      .rejects.toThrow(AccountChanged);
    expect(bodies(accepted)).toEqual([{ localDate: "2026-09-17", lb: 171, tz: TZ }]);

    const back = switchAccount(USER_A);
    __resetWeighInDrain();
    const drain = vi.fn(async () => ok());
    expect(await drainWeighIns(back, { fetchImpl: drain })).toEqual({ posted: 1, pending: 0 });
    expect(bodies(drain)).toEqual([{ localDate: "2026-09-17", lb: 171, tz: TZ }]);
  });

  it("posts the older parked value only after the newer one is refused", async () => {
    await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ });
    const lost = vi.fn(async () => { switchAccount(USER_B); return fail(422); });
    await expect(saveWeighIn("2026-09-17", 10, { fetchImpl: lost, tz: TZ }))
      .rejects.toThrow(AccountChanged);

    const back = switchAccount(USER_A);
    __resetWeighInDrain();
    const drain = vi.fn(async (_url: unknown, init?: RequestInit) =>
      (JSON.parse(String(init?.body)) as { lb: number }).lb === 10 ? fail(422) : ok());
    await drainWeighIns(back, { fetchImpl: drain as never });
    __resetWeighInDrain();
    await drainWeighIns(back, { fetchImpl: drain as never });
    expect(bodies(drain)).toEqual([
      { localDate: "2026-09-17", lb: 10, tz: TZ }, { localDate: "2026-09-17", lb: 170, tz: TZ }]);
    expect(await readPendingWeighIns(back)).toEqual([]);
  });
});

describe("a weigh-in the server never hears", () => {
  it("leaves the day in the pending list when the route fails", async () => {
    // Nothing is said to her: the weight IS saved, on this phone, and the sync will carry it.
    expect(await saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ })).toBeNull();
    expect(await readPendingWeighIns(account())).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 170, tz: TZ } }]);
  });

  /**
   * A 500 is the server failing, not refusing. Treating it as a refusal would drop the weigh-in on
   * the floor — including the whole window between this code deploying and the migration landing,
   * when `health_weigh_in` does not exist yet.
   */
  it("queues a 5xx, and keeps only the last number for a day", async () => {
    const down = vi.fn(async () => fail(503));
    await saveWeighIn("2026-09-17", 170, { fetchImpl: down, tz: TZ });
    await saveWeighIn("2026-09-17", 171, { fetchImpl: down, tz: TZ });
    expect(await readPendingWeighIns(account())).toEqual([
      { userId: USER_A, request: { localDate: "2026-09-17", lb: 171, tz: TZ } }]);
  });
});

/**
 * Phase 9 §0.1: every device primitive needs a bound account, so a weigh-in typed with none bound
 * has nowhere to park. The pre-Phase-9 premise this replaces — "a weigh-in typed with no session" —
 * used to park the record unowned; that record can no longer exist, so the nearest equivalent is
 * `saveWeighIn` refusing outright rather than silently parking an unowned row.
 */
describe("a weigh-in typed with no account bound", () => {
  it("throws instead of parking an unowned record", async () => {
    signOut();
    await expect(saveWeighIn("2026-09-17", 170, { fetchImpl: offline(), tz: TZ }))
      .rejects.toThrow(AccountNotBound);
    expect(await readPendingWeighIns(switchAccount(USER_A))).toEqual([]);
  });
});
