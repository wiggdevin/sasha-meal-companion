// @vitest-environment jsdom
/**
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

const navigation = vi.hoisted(() => ({ pathname: "/", replace: vi.fn() }));
const supabase = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
}));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => supabase.client }));
vi.mock("@/lib/sync/settings", () => ({ captureTimeZone: vi.fn(async () => true) }));
vi.mock("@/components/ActivityMismatchPrompt", () => ({
  ActivityPromptProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
/** Phase 9 §0.1 seams: adoption and the sign-out notice's count are driven per test. */
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

import AuthGate, {
  DISPOSITION_CACHE_PREFIX,
  clearCachedDisposition,
  dispositionCacheKey,
  gateRedirect,
  gateView,
  readCachedDisposition,
  resolveGate,
  writeCachedDisposition,
} from "@/components/AuthGate";
import { captureTimeZone } from "@/lib/sync/settings";
import { grantAllLocks, newPage } from "@/tests/helpers/new-page";
import { __setBootDeps } from "@/lib/device/boot";
import { __setDepartureDeps } from "@/lib/device/departure";

const AFTER_CUTOVER = "2026-09-21T12:00:00.000Z";
const BEFORE_CUTOVER = "2026-09-19T10:00:00.000Z";

type Row = { first_opened_at?: unknown; onboarded_at?: unknown } | null;

type Session = { user: { id: string } } | null;
const auth = vi.hoisted(() => ({
  listener: null as ((event: string, session: unknown) => void) | null,
  signOut: vi.fn(async () => ({ error: null })),
}));

function client(session: Session, row: Row | "fail") {
  return {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (fn: (event: string, session: unknown) => void) => {
        auth.listener = fn;
        return { data: { subscription: { unsubscribe: () => { auth.listener = null; } } } };
      },
      signOut: auth.signOut,
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

describe("gateView", () => {
  it("never renders children while the disposition is unknown", () => {
    expect(gateView("unknown", "/", false, true)).toBe("shell");
    expect(gateView("unknown", "/onboarding", false, true)).toBe("shell");
    expect(gateView("unknown", "/", true, true)).toBe("blocked");
  });

  it("renders the onboarding route only in the onboarding state", () => {
    expect(gateView("onboarding", "/onboarding", false, true)).toBe("children");
    expect(gateView("onboarding", "/", false, true)).toBe("shell");
    expect(gateView("in", "/onboarding", false, true)).toBe("shell");
    expect(gateView("in", "/", false, true)).toBe("children");
    expect(gateView("out", "/", false, true)).toBe("signed-out");
  });

  it("renders no account screen before this device is ready (audit plan r2 finding 3)", () => {
    expect(gateView("in", "/", false, false)).toBe("shell");
    expect(gateView("onboarding", "/onboarding", false, false)).toBe("shell");
    expect(gateView("in", "/", false, false, true)).toBe("adoption-failed");
    expect(gateView("out", "/", false, false)).toBe("signed-out");
  });
});

describe("gateRedirect", () => {
  it("sends a forced account to onboarding from any other protected path", () => {
    expect(gateRedirect("onboarding", "/")).toBe("/onboarding");
    expect(gateRedirect("onboarding", "/week")).toBe("/onboarding");
    expect(gateRedirect("onboarding", "/onboarding")).toBeNull();
  });

  it("releases a finished account off the onboarding route", () => {
    expect(gateRedirect("in", "/onboarding")).toBe("/");
    expect(gateRedirect("in", "/")).toBeNull();
    expect(gateRedirect("unknown", "/")).toBeNull();
    expect(gateRedirect("out", "/onboarding")).toBeNull();
  });
});

describe("the account-scoped disposition cache", () => {
  it("keys every entry by the authenticated user id", () => {
    expect(dispositionCacheKey("user-a")).toBe(`${DISPOSITION_CACHE_PREFIX}user-a`);
    writeCachedDisposition("user-a", {
      disposition: "none", firstOpenedAt: BEFORE_CUTOVER, onboardedAt: AFTER_CUTOVER,
    });
    expect(readCachedDisposition("user-a")?.disposition).toBe("none");
    expect(readCachedDisposition("user-b")).toBeNull();
  });

  it("clears only the account it is given", () => {
    writeCachedDisposition("user-a", {
      disposition: "force", firstOpenedAt: AFTER_CUTOVER, onboardedAt: null,
    });
    writeCachedDisposition("user-b", {
      disposition: "none", firstOpenedAt: BEFORE_CUTOVER, onboardedAt: AFTER_CUTOVER,
    });
    clearCachedDisposition("user-a");
    expect(readCachedDisposition("user-a")).toBeNull();
    expect(readCachedDisposition("user-b")?.disposition).toBe("none");
  });

  it("refuses a stored value that is not a disposition", () => {
    localStorage.setItem(dispositionCacheKey("user-a"), JSON.stringify({ disposition: "maybe" }));
    expect(readCachedDisposition("user-a")).toBeNull();
  });
});

describe("resolveGate", () => {
  it("caches only a successful server read", () => {
    const absent = resolveGate(null, null);
    expect(absent).toEqual({
      status: "resolved", disposition: "force",
      cache: { disposition: "force", firstOpenedAt: null, onboardedAt: null },
    });
    const finished = resolveGate(
      { first_opened_at: AFTER_CUTOVER, onboarded_at: AFTER_CUTOVER }, null,
    );
    expect(finished).toEqual({
      status: "resolved", disposition: "none",
      cache: { disposition: "none", firstOpenedAt: AFTER_CUTOVER, onboardedAt: AFTER_CUTOVER },
    });
  });

  it("falls back to this account's cache when the read failed, and writes nothing", () => {
    expect(resolveGate(undefined, {
      disposition: "none", firstOpenedAt: BEFORE_CUTOVER, onboardedAt: AFTER_CUTOVER,
    })).toEqual({ status: "resolved", disposition: "none", cache: null });
    expect(resolveGate(undefined, {
      disposition: "force", firstOpenedAt: AFTER_CUTOVER, onboardedAt: null,
    })).toEqual({ status: "resolved", disposition: "force", cache: null });
  });

  it("stays fail-closed when the read failed and this account has no cache", () => {
    expect(resolveGate(undefined, null)).toEqual({ status: "blocked" });
  });
});

describe("<AuthGate> for a row-less account", () => {
  it("shows the neutral shell and no Today DOM, before and after the read", async () => {
    supabase.client = client({ user: { id: "user-a" } }, null);
    const { markupBeforeRead, root } = await mount();

    expect(markupBeforeRead).not.toContain("data-testid=\"today\"");
    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(container.textContent).toContain("Setting up this device");
    expect(navigation.replace).toHaveBeenCalledWith("/onboarding");
    expect(readCachedDisposition("user-a")?.disposition).toBe("force");
    expect(captureTimeZone).toHaveBeenCalled();

    await act(async () => { root.unmount(); });
  });

  it("renders the onboarding route itself once the gate is in onboarding", async () => {
    navigation.pathname = "/onboarding";
    supabase.client = client({ user: { id: "user-a" } }, null);
    const { root } = await mount();

    expect(container.querySelector("[data-testid='today']")).not.toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
  });
});

describe("<AuthGate> offline", () => {
  it("fails closed with Retry and Sign out when nothing is cached", async () => {
    supabase.client = client({ user: { id: "user-a" } }, "fail");
    const { root } = await mount();

    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(container.textContent).toContain("Connect once to finish setting up this device");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).toContain("Sign out");
    expect(captureTimeZone).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
  });

  it("lets the same account in on a cached completed disposition", async () => {
    writeCachedDisposition("user-a", {
      disposition: "none", firstOpenedAt: BEFORE_CUTOVER, onboardedAt: AFTER_CUTOVER,
    });
    supabase.client = client({ user: { id: "user-a" } }, "fail");
    const { root } = await mount();

    expect(container.querySelector("[data-testid='today']")).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("never reads another account's cache", async () => {
    writeCachedDisposition("user-b", {
      disposition: "none", firstOpenedAt: BEFORE_CUTOVER, onboardedAt: AFTER_CUTOVER,
    });
    supabase.client = client({ user: { id: "user-a" } }, "fail");
    const { root } = await mount();

    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(container.textContent).toContain("Connect once to finish setting up this device");
    await act(async () => { root.unmount(); });
  });
});

describe("<AuthGate> signed out", () => {
  it("shows the signed-out card and clears this device's account cache", async () => {
    writeCachedDisposition("user-a", {
      disposition: "none", firstOpenedAt: BEFORE_CUTOVER, onboardedAt: AFTER_CUTOVER,
    });
    supabase.client = client(null, null);
    const { root } = await mount();

    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(container.textContent).toContain("Signed out");
    await act(async () => { root.unmount(); });
  });
});

describe("<AuthGate> for a grandfathered account", () => {
  it("enters directly with no onboarding redirect", async () => {
    supabase.client = client({ user: { id: "user-a" } }, {
      first_opened_at: BEFORE_CUTOVER, onboarded_at: null,
    });
    const { root } = await mount();

    expect(container.querySelector("[data-testid='today']")).not.toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(readCachedDisposition("user-a")?.disposition).toBe("invite");
    await act(async () => { root.unmount(); });
  });
});
