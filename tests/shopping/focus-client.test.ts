// @vitest-environment jsdom
/**
 * Phase 18 W11 (D7), Sol r2 BLOCK fix: a failed refresh must never resurrect a focus state a
 * later write already changed, and reads/writes must apply in ticket order, never call order
 * (lib/shopping/focus-client.ts). Covers the three required regressions: a failed refresh right
 * after a successful "off" write, two GETs that resolve out of order, and a write that resolves
 * while an older GET is still in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import {
  forgetShoppingFocus, heldShoppingFocus, holdShoppingFocus, refreshShoppingFocus, writeShoppingFocus,
} from "@/lib/shopping/focus-client";

let handle: AccountHandle;

beforeEach(() => {
  unbindAccount();
  handle = bindAccount(TEST_USER);
  forgetShoppingFocus();
});
afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); forgetShoppingFocus(); });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch response the test resolves or rejects itself, later. */
function deferredResponse(): { promise: Promise<Response>; resolve: (body: unknown, status?: number) => void;
  reject: (error: unknown) => void } {
  let settle!: (value: Response) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<Response>((res, rej) => { settle = res; fail = rej; });
  return {
    promise,
    resolve: (body, status = 200) => settle(json(body, status)),
    reject: (error) => fail(error),
  };
}

/** Stubs `fetch` to answer each call in order with the given response or deferred promise. */
function queueFetch(...answers: Array<Response | Promise<Response>>): ReturnType<typeof vi.fn> {
  const queue = [...answers];
  const fn = vi.fn(() => {
    const next = queue.shift();
    if (!next) throw new Error("no more mock fetch responses queued");
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ON = { until: "2099-01-01T00:00:00.000Z", keys: [] };

describe("focus-client: a failed refresh after a successful off-write", () => {
  it("never resurrects the old focus", async () => {
    holdShoppingFocus(TEST_USER, ON);
    const getFailure = deferredResponse();
    queueFetch(json({ actionId: "a1", until: null, previous: ON.until }), getFailure.promise);

    const answer = await writeShoppingFocus(handle, false);
    expect(answer.until).toBeNull();
    // The write's own answer already cleared the cache — before the forced refresh even settles.
    expect(heldShoppingFocus(TEST_USER)).toBeNull();

    getFailure.reject(new Error("network down"));
    await flush();
    // The failed refresh is fail-safe (no focus), and in any case cannot resurrect the old "on".
    expect(heldShoppingFocus(TEST_USER)).toBeNull();
  });
});

describe("focus-client: out-of-order GETs", () => {
  it("keeps the newer read even when the older one resolves later", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    queueFetch(first.promise, second.promise);

    const run1 = refreshShoppingFocus(handle, true);
    const run2 = refreshShoppingFocus(handle, true);

    second.resolve({ until: "2026-11-01T00:00:00.000Z", keys: [{ key: "rice", from: "2026-10-07", to: "2026-10-07" }] });
    await run2;
    expect(heldShoppingFocus(TEST_USER)?.until).toBe("2026-11-01T00:00:00.000Z");

    first.resolve(ON);
    await run1;
    // The older ticket's answer must not overwrite the newer one that already landed.
    expect(heldShoppingFocus(TEST_USER)?.until).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("focus-client: write-then-stale-GET", () => {
  it("keeps the write's answer when an older in-flight GET resolves afterward", async () => {
    const staleGet = deferredResponse();
    const writeRefresh = deferredResponse();
    queueFetch(staleGet.promise, json({ actionId: "a2", until: null, previous: ON.until }), writeRefresh.promise);

    // A GET that started before the write (lower ticket), left unresolved for now.
    const inFlightGet = refreshShoppingFocus(handle, true);

    const answer = await writeShoppingFocus(handle, false);
    expect(answer.until).toBeNull();
    expect(heldShoppingFocus(TEST_USER)).toBeNull();

    // The stale GET, started before the write, now resolves with an old "on" state.
    staleGet.resolve(ON);
    await inFlightGet;
    expect(heldShoppingFocus(TEST_USER)).toBeNull();

    writeRefresh.resolve({ until: null, keys: [] });
    await flush();
    // The write's own forced refresh may now land for real; it still reports focus off.
    expect(heldShoppingFocus(TEST_USER)?.until ?? null).toBeNull();
  });
});
