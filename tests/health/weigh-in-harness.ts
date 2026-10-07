/**
 * The doubles both weigh-in client suites run on — `weigh-in-client.test.ts` (one save at a time)
 * and `weigh-in-drain.test.ts` (the drain, and everything that overlaps it).
 *
 * Two seams, and only two: `fetch`, because the route is the only network `lib/health/weigh-in-client.ts`
 * has and counting the calls is how "nothing is re-posted once the server has answered" is proved;
 * and the bound account (Phase 9 §0.1), because a pending record belongs to one, and posting one
 * under another account's handle would file her weight under someone else.
 *
 * The pending list lives in the `meta` store of the per-account IndexedDB database the outbox uses,
 * so it survives a reload and a week offline. `fake-indexeddb` supplies it; `resetWeighInWorld` gives
 * each test its own empty one, bound to `USER_A` by default.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";
import { bindAccount, unbindAccount, type AccountHandle } from "@/lib/device/account";
import { __resetWeighInDrain } from "@/lib/health/weigh-in-client";
import { loadStore, saveStore } from "@/lib/store";
import { resetTestAccount } from "@/tests/helpers/account";

let h: AccountHandle;

export const TZ = "America/Los_Angeles";
export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

/** The account `resetWeighInWorld` bound for this test (`USER_A`), or whatever `switchAccount` last
 *  bound instead. Most tests never need this directly — `saveWeighIn` defaults to the bound account —
 *  but `drainWeighIns` and `readPendingWeighIns` now take the handle first. */
export function account(): AccountHandle {
  return h;
}

/**
 * Binds a different account, mid-test: the moment a save or drain already holding an OLDER handle
 * becomes stale, exactly as a real sign-in switch would leave it. Call it from inside a `fetchImpl`
 * double to land the switch while a request is in the air, or before a call to land it earlier.
 * Updates the harness's own handle too, so a later `account()` picks up the new one.
 */
export function switchAccount(userId: string): AccountHandle {
  h = bindAccount(userId);
  return h;
}

/** The "signed out" case: nothing is bound, so a weigh-in typed now has no account to park under. */
export function signOut(): void {
  unbindAccount();
}

export function ok(body: unknown = { kg: 77.111, sampleId: "sample-1" }): Response {
  return new Response(JSON.stringify(body), { status: 200,
    headers: { "content-type": "application/json" } });
}

export function fail(status: number, message = "no"): Response {
  return new Response(JSON.stringify({ error: "invalid", message }), { status,
    headers: { "content-type": "application/json" } });
}

export const offline = () => vi.fn(async () => { throw new TypeError("Failed to fetch"); });

/** Every request a fetch double was handed, parsed — what the phone actually sent. */
export const bodies = (f: { mock: { calls: unknown[][] } }) =>
  f.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as unknown);

/** lib/store.ts is synchronous localStorage; the repo's other client suites stub it the same way. */
function stubLocalStorage(): void {
  const cells = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => cells.get(k) ?? null,
    setItem: (k: string, v: string) => void cells.set(k, String(v)),
    removeItem: (k: string) => void cells.delete(k),
    clear: () => cells.clear(),
    key: (i: number) => [...cells.keys()][i] ?? null,
    get length() { return cells.size; },
  } as Storage;
}

/** A fresh device: empty IndexedDB, empty day store, no drain in flight, bound to `USER_A`. */
export async function resetWeighInWorld(): Promise<void> {
  h = await resetTestAccount();
  globalThis.indexedDB = new IDBFactory();
  stubLocalStorage();
  // lib/store.ts memoises the store in module scope, so a fresh localStorage is not a fresh store.
  saveStore({ ...loadStore(), days: {} });
  __resetWeighInDrain();
}
