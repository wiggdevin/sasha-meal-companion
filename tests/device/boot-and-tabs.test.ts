// @vitest-environment jsdom
/**
 * Phase 9 slice 1, reload boundary: cold-start binding, legacy adoption at cold start only, one
 * writer tab per account (PR #248 review r7 BLOCK 2: same-account tabs overwrote each other's
 * store), and other tabs closing their gates on "leaving" signals.
 *
 * Each tab is a separate set of fresh modules (`vi.resetModules()`); they share localStorage,
 * IndexedDB, BroadcastChannel and one Web Locks manager, as tabs of one origin do.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "2026-09-22";
const STORE_A = `smc:u:${A}:store`;

const adoption = vi.hoisted(() => ({ calls: [] as string[], fail: 0 }));
vi.mock("@/lib/device/legacy-adoption", () => ({
  adoptLegacyDevice: async (h: { userId: string }) => {
    adoption.calls.push(h.userId);
    if (adoption.fail > 0) { adoption.fail -= 1; throw new Error("QuotaExceededError"); }
    return { copied: 0, heldOps: 0 };
  },
}));

/** Exclusive Web Locks with a FIFO queue and `ifAvailable`, shared by every "tab". */
class FakeLocks {
  private held = new Set<string>();
  private queue = new Map<string, (() => void)[]>();
  request(name: string, opts: { ifAvailable?: boolean },
    cb: (lock: unknown) => unknown): Promise<unknown> {
    const busy = this.held.has(name) || (this.queue.get(name)?.length ?? 0) > 0;
    if (busy && opts.ifAvailable) return Promise.resolve(cb(null));
    return new Promise((resolve) => {
      // Held until the callback's promise settles, then the next queued ask is granted.
      const grant = (): void => {
        this.held.add(name);
        void Promise.resolve(cb({ name })).finally(() => {
          this.held.delete(name);
          this.queue.get(name)?.shift()?.();
        }).then(resolve, resolve);
      };
      if (!busy) grant();
      else this.queue.set(name, [...(this.queue.get(name) ?? []), grant]);
    });
  }
}

type Tab = {
  account: typeof import("@/lib/device/account");
  boot: typeof import("@/lib/device/boot");
  departure: typeof import("@/lib/device/departure");
  writer: typeof import("@/lib/device/writer-lock");
  store: typeof import("@/lib/store");
  signOut: typeof import("@/lib/device/sign-out");
  reload: ReturnType<typeof vi.fn<() => void>>;
  stopSignals: () => void;
};

const tabs: Tab[] = [];

/** A new tab (or a reloaded one): fresh modules, listening to other tabs' signals. */
async function openTab(): Promise<Tab> {
  vi.resetModules();
  const tab: Tab = {
    account: await import("@/lib/device/account"),
    boot: await import("@/lib/device/boot"),
    departure: await import("@/lib/device/departure"),
    writer: await import("@/lib/device/writer-lock"),
    store: await import("@/lib/store"),
    signOut: await import("@/lib/device/sign-out"),
    reload: vi.fn<() => void>(),
    stopSignals: () => {},
  };
  tab.departure.__setDepartureDeps({ reload: tab.reload });
  tab.boot.__setBootDeps({ reload: tab.reload });
  tab.stopSignals = tab.boot.watchTabSignals();
  tabs.push(tab);
  return tab;
}

/** What a reload does to the tab it leaves: its lock goes, its listeners go. */
function unload(tab: Tab): void {
  tab.writer.__releaseWriter();
  tab.stopSignals();
}

const extra = (id: string) => ({ id, name: id, kcal: 100 }) as never;
const storedExtras = (): string[] =>
  (JSON.parse(localStorage.getItem(STORE_A) ?? "{\"days\":{}}") as {
    days: Record<string, { extras?: { id: string }[] }>;
  }).days[DATE]?.extras?.map((e) => e.id) ?? [];

beforeEach(() => {
  localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
  adoption.calls = [];
  adoption.fail = 0;
  Object.defineProperty(navigator, "locks", { value: new FakeLocks(), configurable: true });
});

afterEach(() => {
  for (const tab of tabs.splice(0)) unload(tab);
  vi.restoreAllMocks();
});

describe("cold-start binding", () => {
  it("binds once, runs legacy adoption before ready, and never again in the same page", async () => {
    const tab = await openTab();
    expect(tab.boot.applySessionAccount(A)).toBe("bound");
    await vi.waitFor(() => expect(tab.boot.bootPhase()).toBe("ready"));
    expect(adoption.calls).toEqual([A]);
    expect(tab.account.isAccountReady()).toBe(true);
    expect(tab.boot.applySessionAccount(A)).toBe("bound"); // a token refresh
    expect(tab.boot.applySessionAccount(B)).toBe("departing");
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
    expect(adoption.calls).toEqual([A]); // B is adopted only by its own new page
  });

  it("a failed adoption blocks, and Retry is a new page that adopts at its own cold start", async () => {
    adoption.fail = 2;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tab = await openTab();
    tab.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(tab.boot.bootPhase()).toBe("failed"));
    expect(tab.account.isAccountReady()).toBe(false);
    expect(adoption.calls).toEqual([A, A]);
    tab.boot.retryBoot();
    expect(tab.reload).toHaveBeenCalledTimes(1);
    expect(adoption.calls).toEqual([A, A]); // not re-run in this page
    unload(tab);
    const fresh = await openTab();
    fresh.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(fresh.boot.bootPhase()).toBe("ready"));
    expect(adoption.calls).toEqual([A, A, A]);
  });
});

describe("two tabs of the same account (review r7 BLOCK 2)", () => {
  it("only the writer tab is ready; the other cannot clobber it, and Use here hands over", async () => {
    const one = await openTab();
    one.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(one.boot.bootPhase()).toBe("ready"));
    one.store.addExtra(DATE, extra("from-tab-1"));

    const two = await openTab();
    two.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(two.boot.bootPhase()).toBe("elsewhere"));
    expect(two.account.isAccountReady()).toBe(false);
    expect(adoption.calls).toEqual([A]); // the second tab does not adopt either

    // Tab 1 keeps editing; nothing of tab 2 overwrites it.
    one.store.addExtra(DATE, extra("from-tab-1-again"));
    expect(storedExtras()).toEqual(["from-tab-1", "from-tab-1-again"]);

    // Use here: tab 1 saves and reloads (its unload frees the lock); tab 2 becomes the writer.
    one.reload.mockImplementation(() => unload(one));
    two.boot.useHere();
    await vi.waitFor(() => expect(one.reload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(two.boot.bootPhase()).toBe("ready"));
    expect(two.store.loadStore().days[DATE]?.extras?.map((e) => e.id))
      .toEqual(["from-tab-1", "from-tab-1-again"]);
    two.store.addExtra(DATE, extra("from-tab-2"));

    // A late save in the frozen tab 1 is refused and reaches no storage.
    expect(() => one.store.addExtra(DATE, extra("late-tab-1"))).toThrow();
    expect(storedExtras()).toEqual(["from-tab-1", "from-tab-1-again", "from-tab-2"]);

    // Tab 1's new page finds the lock taken and waits as "elsewhere".
    const oneAgain = await openTab();
    oneAgain.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(oneAgain.boot.bootPhase()).toBe("elsewhere"));
  });

  it("without Web Locks a lease keeps one writer; Use here hands it over (reload r2 #2)", async () => {
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    const one = await openTab();
    one.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(one.boot.bootPhase()).toBe("ready"));
    one.store.addExtra(DATE, extra("from-tab-1"));

    const two = await openTab();
    two.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(two.boot.bootPhase()).toBe("elsewhere"));
    expect(two.account.isAccountReady()).toBe(false);

    one.reload.mockImplementation(() => unload(one));
    two.boot.useHere();
    await vi.waitFor(() => expect(one.reload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(two.boot.bootPhase()).toBe("ready"), { timeout: 3000 });
    two.store.addExtra(DATE, extra("from-tab-2"));
    expect(storedExtras()).toEqual(["from-tab-1", "from-tab-2"]);

    // Tab 1's new page does not take the lease back while tab 2 holds it.
    const oneAgain = await openTab();
    oneAgain.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(oneAgain.boot.bootPhase()).toBe("elsewhere"));
  });
});

describe("the lease is a fence, not only a heartbeat (reload r3 #1)", () => {
  it("a tab whose lease expired while suspended writes nothing more and leaves", async () => {
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    const one = await openTab();
    one.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(one.boot.bootPhase()).toBe("ready"));
    one.store.addExtra(DATE, extra("from-tab-1"));
    // Tab 1 is suspended long enough for its lease to expire; tab 2 opens and takes it.
    const key = `smc:device:writer:${A}`;
    const lease = JSON.parse(localStorage.getItem(key)!) as { owner: string; until: number };
    localStorage.setItem(key, JSON.stringify({ ...lease, until: Date.now() - 1 }));
    const two = await openTab();
    two.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(two.boot.bootPhase()).toBe("ready"));
    two.store.addExtra(DATE, extra("from-tab-2"));
    // Tab 1 resumes: its save is refused before it touches the blob, and it leaves.
    expect(() => one.store.addExtra(DATE, extra("stale-tab-1"))).toThrow();
    expect(storedExtras()).toEqual(["from-tab-1", "from-tab-2"]);
    await vi.waitFor(() => expect(one.reload).toHaveBeenCalledTimes(1));
    expect(storedExtras()).toEqual(["from-tab-1", "from-tab-2"]);
  });

  it("a page restored from the back-forward cache leaves at once", async () => {
    const tab = await openTab();
    tab.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(tab.boot.bootPhase()).toBe("ready"));
    const shown = new Event("pageshow");
    Object.defineProperty(shown, "persisted", { value: true });
    window.dispatchEvent(shown);
    expect(tab.departure.departurePhase()).not.toBe("none");
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
  });
});

describe("a sign-out tapped as A (reload r1 #9)", () => {
  it("never removes B's session when the page left A for B before the tap resolved", async () => {
    const tab = await openTab();
    tab.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(tab.boot.bootPhase()).toBe("ready"));
    const session: unknown = { user: { id: B } }; // another tab signed in as B meanwhile
    const auth = {
      signOut: vi.fn(async () => ({ error: null })),
      getSession: async () => ({ data: { session } }),
    };
    tab.boot.applySessionAccount(B); // the page starts leaving A
    await tab.signOut.signOutHere(auth, A); // the notice resolved late; the tap was for A
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("does not remove the session when it already belongs to another account", async () => {
    const tab = await openTab();
    tab.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(tab.boot.bootPhase()).toBe("ready"));
    const auth = {
      signOut: vi.fn(async () => ({ error: null })),
      getSession: async () => ({ data: { session: { user: { id: B } } as unknown } }),
    };
    await tab.signOut.signOutHere(auth, A);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });
});

describe("other tabs close their gates on account-change signals", () => {
  it("a sign-out in one tab makes the account's other tab leave too, on the BroadcastChannel", async () => {
    const one = await openTab();
    one.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(one.boot.bootPhase()).toBe("ready"));
    const two = await openTab();
    two.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(two.boot.bootPhase()).toBe("elsewhere"));
    const other = await openTab();
    other.boot.applySessionAccount(B);
    await vi.waitFor(() => expect(other.boot.bootPhase()).toBe("ready"));

    let session: unknown = { user: { id: A } };
    const auth = {
      signOut: vi.fn(async () => { session = null; return { error: null }; }),
      getSession: async () => ({ data: { session } }),
    };
    await one.signOut.signOutHere(auth, A);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(one.reload).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(two.departure.departurePhase()).not.toBe("none"));
    await vi.waitFor(() => expect(two.reload).toHaveBeenCalledTimes(1));
    expect(two.account.currentAccountOrNull()).toBeNull();
    expect(other.departure.departurePhase()).toBe("none"); // B's tab is not A's
  });

  it("the storage event carries the same signal where BroadcastChannel is missing", async () => {
    const tab = await openTab();
    tab.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(tab.boot.bootPhase()).toBe("ready"));
    const { TAB_SIGNAL_KEY } = await import("@/lib/device/tab-signal");
    window.dispatchEvent(new StorageEvent("storage", {
      key: TAB_SIGNAL_KEY,
      newValue: JSON.stringify({ type: "leaving", userId: A, nonce: "n-1", from: "other-tab" }),
    }));
    expect(tab.departure.departurePhase()).not.toBe("none");
    expect(tab.account.isAccountReady()).toBe(false);
    await vi.waitFor(() => expect(tab.account.currentAccountOrNull()).toBeNull());
  });

  it("a tab that detects the session change itself tells the account's other tabs (reload r1 #8)", async () => {
    const one = await openTab();
    one.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(one.boot.bootPhase()).toBe("ready"));
    const two = await openTab();
    two.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(two.boot.bootPhase()).toBe("elsewhere"));
    // Only tab 2 sees the new session (e.g. its request answered 409 account_mismatch).
    expect(two.boot.applySessionAccount(B)).toBe("departing");
    await vi.waitFor(() => expect(one.departure.departurePhase()).not.toBe("none"));
    await vi.waitFor(() => expect(one.reload).toHaveBeenCalledTimes(1));
  });
});

describe("a server account mismatch (reload review r4 #2)", () => {
  it("closes the gate and leaves at once, without waiting for a session read", async () => {
    const tab = await openTab();
    tab.boot.applySessionAccount(A);
    await vi.waitFor(() => expect(tab.boot.bootPhase()).toBe("ready"));
    tab.boot.onAccountMismatch();
    expect(tab.departure.departurePhase()).toBe("leaving");
    expect(tab.account.isAccountReady()).toBe(false);
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
  });
});
