// @vitest-environment jsdom
/**
 * PR #248 review r4 #4: leaving an account must not remove what the returning account needs
 * offline. The saved food refs are per account (and the only way a resolved catalog food logs
 * offline), and the service worker's shell cache is account-neutral (offline navigation, also the
 * reload that ends every departure). Both are kept.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({ rpc }) }));

import { bindAccount } from "@/lib/device/account";
import { __setDepartureDeps, beginDeparture } from "@/lib/device/departure";
import { newPage } from "@/tests/helpers/new-page";
import { resolveFoodRef } from "@/lib/log-client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REF = "dddddddd-4444-4444-8444-444444444444";

beforeEach(async () => {
  await newPage(null);
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  rpc.mockReset();
});

async function leaveTo(next: string) {
  __setDepartureDeps({ reload: () => {} });
  await beginDeparture();
  return newPage(next);
}

describe("leaving an account keeps offline resources", () => {
  it("logs a previously resolved catalog food offline after A → B → A", async () => {
    rpc.mockResolvedValue({ data: REF, error: null });
    expect(await resolveFoodRef(7, undefined, bindAccount(A))).toBe(REF);

    await leaveTo(B);
    const back = await leaveTo(A);

    rpc.mockResolvedValue({ data: null, error: new Error("offline") });
    const failure = vi.fn();
    expect(await resolveFoodRef(7, failure, back!)).toBe(REF);
    expect(failure).not.toHaveBeenCalled();
  });

  it("leaves the service worker's shell cache in place", async () => {
    const del = vi.fn(async () => true);
    vi.stubGlobal("caches", { keys: async () => ["sasha-shell-v3"], delete: del });
    bindAccount(A);
    await leaveTo(B);
    expect(del).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
