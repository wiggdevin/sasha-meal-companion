// @vitest-environment jsdom
/**
 * Phase 9 §0.1: the gate binds the account, adopts legacy device data, and renders account
 * screens only once the device is READY. Phase 9 slice 1, reload boundary: a page binds one
 * account, once; a session change or sign-out makes the account durable, then reloads. Same
 * fixtures as tests/onboarding/auth-gate.test.tsx (split out to keep both files under 400 lines).
 *
 * D1 §1: the gate is a four-state machine and `unknown` never renders children.
 *
 * The baseline walkthrough caught Today on screen 304 ms after sign-in, before the onboarding
 * read had answered (lanes/W1/baseline.md step 1), because `applySession` set "in" from the
 * session alone. So the render case here is not "does it redirect" — it is "does any Today DOM
 * exist at any point before the disposition is known", which is what the fixture child asserts.
 */
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => {
  const replace = vi.fn();
  // One stable router, as Next gives: the gate's effect must not re-run on every render here.
  return { pathname: "/", replace, router: { replace } };
});
const supabase = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
}));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => supabase.client }));
vi.mock("@/lib/sync/settings", () => ({ captureTimeZone: vi.fn(async () => true) }));
vi.mock("@/components/ActivityMismatchPrompt", () => ({
  ActivityPromptProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
/** Phase 9 §0.1 seams: adoption, the sign-out notice's count and the reload are driven per test. */
const device = vi.hoisted(() => ({
  adopt: vi.fn(async (_h: unknown) => ({ copied: 0, heldOps: 0 })),
  pending: vi.fn(async (_id: string): Promise<unknown> => ({ ops: 0 })),
  reload: vi.fn(),
}));
vi.mock("@/lib/device/legacy-adoption", () => ({ adoptLegacyDevice: (h: unknown) => device.adopt(h) }));
vi.mock("@/lib/device/forget", () => ({
  touchAccount: vi.fn(),
  pendingWork: (id: string) => device.pending(id),
  pendingTotal: (w: unknown) => (w === "unknown" ? null
    : Object.values(w as Record<string, number>).reduce((a, b) => a + b, 0)),
}));

import AuthGate from "@/components/AuthGate";
import { captureTimeZone } from "@/lib/sync/settings";
import {
  currentAccountOrNull, isAccountReady, isCurrent, onAccountReady, type AccountHandle,
} from "@/lib/device/account";
import { __setBootDeps } from "@/lib/device/boot";
import { __setDepartureDeps } from "@/lib/device/departure";
import { addExtra, loadStore } from "@/lib/store";
import { grantAllLocks, newPage } from "@/tests/helpers/new-page";

const AFTER_CUTOVER = "2026-09-21T12:00:00.000Z";
const BEFORE_CUTOVER = "2026-09-19T10:00:00.000Z";

type Row = { first_opened_at?: unknown; onboarded_at?: unknown } | null;

type Session = { user: { id: string } } | null;
const auth = vi.hoisted(() => ({
  listener: null as ((event: string, session: unknown) => void) | null,
  signOut: vi.fn(async () => ({ error: null })),
}));

function client(initial: Session, row: Row | "fail") {
  let session = initial;
  return {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (fn: (event: string, session: unknown) => void) => {
        auth.listener = fn;
        return { data: { subscription: { unsubscribe: () => { auth.listener = null; } } } };
      },
      // Like supabase-js: the local session is gone after a sign-out, even offline.
      signOut: async () => { session = null; return auth.signOut(); },
    },
    from: () => ({
      select: () => ({
        maybeSingle: async () =>
          row === "fail" ? { data: null, error: new Error("offline") } : { data: row },
      }),
    }),
  };
}

let container: HTMLDivElement;

beforeEach(async () => {
  navigation.pathname = "/";
  navigation.replace.mockClear();
  vi.mocked(captureTimeZone).mockClear();
  await newPage(null); // every test is a fresh page (reload boundary)
  grantAllLocks();
  device.reload.mockReset();
  __setBootDeps({ reload: device.reload });
  __setDepartureDeps({ reload: device.reload });
  device.adopt.mockReset().mockResolvedValue({ copied: 0, heldOps: 0 });
  device.pending.mockReset().mockResolvedValue({ ops: 0 });
  auth.signOut.mockClear();
  auth.listener = null;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

async function mount(): Promise<{ markupBeforeRead: string; root: ReturnType<typeof createRoot> }> {
  const root = createRoot(container);
  let markupBeforeRead = "";
  await act(async () => {
    root.render(<AuthGate><main data-testid="today">Today</main></AuthGate>);
    markupBeforeRead = container.innerHTML;
  });
  return { markupBeforeRead, root };
}

/** A promise a test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** Long enough for a departure's quiet wait (lib/device/departure.ts) to finish. */
const quiet = () => act(async () => { await new Promise((r) => setTimeout(r, 150)); });

const DONE = { first_opened_at: BEFORE_CUTOVER, onboarded_at: AFTER_CUTOVER };

describe("<AuthGate> binds, adopts and readies the account (Phase 9 §0.1)", () => {
  it("marks the account ready only after adoption, and renders no child before that", async () => {
    const adoption = deferred<{ copied: number; heldOps: number }>();
    device.adopt.mockReturnValue(adoption.promise);
    const ready = vi.fn();
    const stop = onAccountReady(ready);
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    const { root } = await mount();
    await flush();
    // fast disposition, slow adoption (audit plan r2 finding 3)
    expect(currentAccountOrNull()?.userId).toBe("user-a");
    expect(ready).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(container.textContent).toContain("Setting up this device");
    await act(async () => { adoption.resolve({ copied: 0, heldOps: 0 }); });
    await flush();
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-a" }));
    expect(container.querySelector("[data-testid='today']")).not.toBeNull();
    stop();
    await act(async () => { root.unmount(); });
  });

  it("on a session change to B: freezes A at once, binds nothing, reloads once A is durable", async () => {
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    const { root } = await mount();
    await flush();
    const a = currentAccountOrNull() as AccountHandle;
    expect(a.userId).toBe("user-a");
    // The cookie now holds B (another tab signed in).
    supabase.client = client({ user: { id: "user-b" } }, DONE);
    await act(async () => { auth.listener?.("SIGNED_IN", { user: { id: "user-b" } }); });
    // At once: the gate closes and A is ready no more; B is not bound.
    expect(isAccountReady()).toBe(false);
    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(currentAccountOrNull()?.userId).not.toBe("user-b");
    await quiet();
    expect(isCurrent(a)).toBe(false);
    expect(currentAccountOrNull()).toBeNull();
    expect(device.adopt).not.toHaveBeenCalledWith(expect.objectContaining({ userId: "user-b" }));
    expect(device.reload).toHaveBeenCalledTimes(1);
    expect(auth.signOut).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("a same-user token refresh keeps the handle (Review Focus 1)", async () => {
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    const { root } = await mount();
    await flush();
    const a = currentAccountOrNull() as AccountHandle;
    await act(async () => { auth.listener?.("TOKEN_REFRESHED", { user: { id: "user-a" } }); });
    await flush();
    expect(isCurrent(a)).toBe(true);
    expect(device.reload).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("blocks with Retry when adoption fails twice; Retry is a new page, not a second adoption", async () => {
    device.adopt.mockRejectedValue(new Error("QuotaExceededError"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    const { root } = await mount();
    await flush();
    expect(device.adopt).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("This phone could not finish the update.");
    expect(container.querySelector("[data-testid='today']")).toBeNull();
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => { retry.click(); });
    await flush();
    expect(device.reload).toHaveBeenCalledTimes(1);
    expect(device.adopt).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    await act(async () => { root.unmount(); });
  });

  it("sign out asks first when changes are not synced, then signs out and reloads", async () => {
    device.adopt.mockRejectedValue(new Error("blocked"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    device.pending.mockResolvedValue({ ops: 2, logRecords: 0 });
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    const { root } = await mount();
    await flush();
    const signOut = () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Sign out")!;
    await act(async () => { signOut().click(); });
    await flush();
    expect(container.textContent)
      .toContain("2 changes are not synced yet. They stay on this phone and send when you sign in again.");
    expect(auth.signOut).not.toHaveBeenCalled();
    // UI audit 2026-10-18 §9: the notice is announced and the button says a second tap is needed.
    expect(container.querySelector('p[role="status"]')?.textContent).toContain("2 changes are not synced yet.");
    const anyway = [...container.querySelectorAll("button")].find((b) => b.textContent === "Sign out anyway")!;
    expect(anyway).toBeTruthy();
    // A repeat tap while the first is running signs out once.
    await act(async () => { anyway.click(); anyway.click(); });
    await quiet();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(device.reload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    await act(async () => { root.unmount(); });
  });

  it("signs out at once when nothing is waiting", async () => {
    device.adopt.mockRejectedValue(new Error("blocked"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    const { root } = await mount();
    await flush();
    const signOut = [...container.querySelectorAll("button")].find((b) => b.textContent === "Sign out")!;
    await act(async () => { signOut.click(); });
    await quiet();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(device.reload).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    await act(async () => { root.unmount(); });
  });

  // Review r7 BLOCK 1, reload boundary: an edit only in memory that no storage takes blocks the
  // reload. Nothing of A or B shows; Retry finishes once storage takes it.
  it("says so and does not reload when A's unsaved edit cannot be stored; Retry reloads", async () => {
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    const { root } = await mount();
    await flush();
    const real = Storage.prototype.setItem;
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage, key: string, value: string,
    ) {
      if (key === "smc:u:user-a:store") throw new DOMException("full", "QuotaExceededError");
      return real.call(this, key, value);
    });
    addExtra("2026-09-22", { id: "unsaved", name: "Soup", kcal: 100 } as never);
    supabase.client = client({ user: { id: "user-b" } }, DONE);
    await act(async () => { auth.listener?.("SIGNED_IN", { user: { id: "user-b" } }); });
    await quiet();
    expect(container.textContent).toContain("Changes on this phone could not be saved yet.");
    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(currentAccountOrNull()).toBeNull();
    expect(device.reload).not.toHaveBeenCalled();
    full.mockRestore();
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => { retry.click(); });
    await quiet();
    expect(device.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("smc:u:user-a:store")!).days["2026-09-22"].extras[0].id)
      .toBe("unsaved");
    await act(async () => { root.unmount(); });
  });

  // Reload review r2 #1: leaving A keeps A's disposition cache, so A opens offline when it comes back.
  it("A → B → A across new pages: A opens offline with its meal", async () => {
    supabase.client = client({ user: { id: "user-a" } }, DONE);
    let { root } = await mount();
    await flush();
    addExtra("2026-09-22", { id: "a-meal", name: "Soup", kcal: 100 } as never);
    supabase.client = client({ user: { id: "user-b" } }, DONE);
    await act(async () => { auth.listener?.("SIGNED_IN", { user: { id: "user-b" } }); });
    await quiet();
    expect(device.reload).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });

    // The next page, back as A, with no connection: the onboarding read fails.
    await newPage(null);
    __setBootDeps({ reload: device.reload });
    __setDepartureDeps({ reload: device.reload });
    supabase.client = client({ user: { id: "user-a" } }, "fail");
    ({ root } = await mount());
    await flush();
    expect(container.querySelector("[data-testid='today']")).not.toBeNull();
    expect(loadStore().days["2026-09-22"]?.extras?.map((e) => e.id)).toEqual(["a-meal"]);
    await act(async () => { root.unmount(); });
  });

  // Reload review r1 #10: a second tab of the account (not the writer) writes nothing for it.
  it("a tab that is not the writer shows 'open in another tab' and writes no account storage", async () => {
    const held = { request: async (_n: string, _o: unknown, cb: (l: unknown) => unknown) => cb(null) };
    Object.defineProperty(navigator, "locks", { value: held, configurable: true });
    try {
      supabase.client = client({ user: { id: "user-a" } }, DONE);
      const { root } = await mount();
      await flush();
      expect(container.textContent).toContain("Sasha is open in another tab.");
      expect(container.querySelector("[data-testid='today']")).toBeNull();
      expect(localStorage.getItem("meal-companion:onboarding-disposition:user-a")).toBeNull();
      expect(Object.keys(localStorage).filter((k) => k.startsWith("smc:u:"))).toEqual([]);
      expect(captureTimeZone).not.toHaveBeenCalled();
      await act(async () => { root.unmount(); });
    } finally {
      grantAllLocks();
    }
  });

  // PR #248 review r1 #3: the initial getSession() answers late, after an auth event already
  // applied B. The stale A result must not rebind the device or cache a disposition under A.
  it("ignores a late initial session once a newer auth event has applied", async () => {
    let answer!: (v: { data: { session: Session } }) => void;
    const late = new Promise<{ data: { session: Session } }>((r) => { answer = r; });
    const base = client(null, DONE);
    // Only the FIRST read is slow; a read made after the event (the effect re-runs on render)
    // answers with the cookie's current session, as the real client does.
    let calls = 0;
    const getSession = () => (calls++ === 0 ? late
      : Promise.resolve({ data: { session: { user: { id: "user-b" } } as Session } }));
    supabase.client = { ...base, auth: { ...base.auth, getSession } };
    const { root } = await mount();
    await act(async () => { auth.listener?.("SIGNED_IN", { user: { id: "user-b" } }); });
    await flush();
    expect(currentAccountOrNull()?.userId).toBe("user-b");
    await act(async () => { answer({ data: { session: { user: { id: "user-a" } } } }); });
    await flush();
    expect(currentAccountOrNull()?.userId).toBe("user-b");
    expect(device.reload).not.toHaveBeenCalled();
    expect(localStorage.getItem("meal-companion:onboarding-disposition:user-a")).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
