// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The parts of the gate that are about ROUTES and SESSIONS, plus the one render case that is about
 * the ACCOUNT changing under a mounted gate. The four-state machine, the account-scoped cache and
 * the offline fail-closed shell are driven for real in `tests/onboarding/auth-gate.test.tsx`.
 */

const navigation = vi.hoisted(() => {
  const replace = vi.fn();
  // One stable router object: `useRouter` is an effect dependency of the gate, so a fresh literal
  // per render would re-run the session subscription on every state change.
  return { pathname: "/sign-in", replace, router: { replace } };
});
const supabase = vi.hoisted(() => ({
  client: null as unknown,
  signedOut: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  } as unknown,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
}));

vi.mock("@/lib/supabase/client", () => ({ browserClient: () => supabase.client }));
vi.mock("@/lib/sync/settings", () => ({ captureTimeZone: vi.fn(async () => true) }));
// Phase 9 §0.1: the device half of a session change, stubbed so this file drives the gate only.
vi.mock("@/lib/device/legacy-adoption", () => ({
  adoptLegacyDevice: vi.fn(async () => ({ copied: 0, heldOps: 0 })),
}));
vi.mock("@/lib/device/forget", () => ({
  touchAccount: vi.fn(),
  pendingWork: vi.fn(async () => ({ ops: 0 })), pendingTotal: () => 0,
}));
vi.mock("@/components/ActivityMismatchPrompt", () => ({
  ActivityPromptProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import AuthGate, {
  applyAccountOnboardingRead,
  isAuthExempt,
  sessionUserId,
  signedOutHref,
} from "./AuthGate";
import { accountDisposition } from "@/lib/profile/onboarding-state";
import { currentAccountOrNull } from "@/lib/device/account";
import { __setDepartureDeps } from "@/lib/device/departure";
import { grantAllLocks, newPage } from "@/tests/helpers/new-page";

const reload = vi.fn();

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
  await newPage(null); // every test is a fresh page (reload boundary)
  grantAllLocks();
  reload.mockReset();
  __setDepartureDeps({ reload });
  navigation.pathname = "/sign-in";
  navigation.replace.mockClear();
  supabase.client = supabase.signedOut;
  localStorage.clear();
});

describe("isAuthExempt", () => {
  it("exempts the sign-in route", () => {
    expect(isAuthExempt("/sign-in")).toBe(true);
  });

  it("exempts auth callback routes", () => {
    expect(isAuthExempt("/auth/callback")).toBe(true);
  });

  it("does not exempt the home route", () => {
    expect(isAuthExempt("/")).toBe(false);
  });

  it("does not exempt other routes", () => {
    expect(isAuthExempt("/week")).toBe(false);
  });

  it("does not exempt a null pathname", () => {
    expect(isAuthExempt(null)).toBe(false);
  });

  it("exempts the /design galleries only in development with the explicit opt-in", () => {
    try {
      expect(isAuthExempt("/design/meal-cards")).toBe(false);
      vi.stubEnv("NEXT_PUBLIC_DESIGN_GALLERY_OPEN", "1");
      expect(isAuthExempt("/design/meal-cards")).toBe(true);
      expect(isAuthExempt("/design")).toBe(true);
      expect(isAuthExempt("/designer")).toBe(false);
      vi.stubEnv("NODE_ENV", "production");
      expect(isAuthExempt("/design/meal-cards")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("AuthGate on an exempt path", () => {
  it("renders children instead of the signed-out card when the pathname is /sign-in", () => {
    const markup = renderToStaticMarkup(
      <AuthGate>
        <p>form</p>
      </AuthGate>,
    );

    expect(markup).toContain("form");
    expect(markup).not.toContain("Signed out");
  });
});

// Production smoke 2026-09-13 (feature "body"): every Body-page step lists sign-in as a
// prerequisite. A session that expires on a deep page like /body must return to /sign-in with
// `next` set to that page — the same rule middleware.ts applies to every server-side redirect —
// so signing back in lands on /body instead of on Today.
describe("signedOutHref", () => {
  it("sends the browser back to the page it was on", () => {
    expect(signedOutHref("/body")).toBe("/sign-in?next=%2Fbody");
  });

  it("omits next for the home route", () => {
    expect(signedOutHref("/")).toBe("/sign-in");
  });

  it("omits next for a null pathname", () => {
    expect(signedOutHref(null)).toBe("/sign-in");
  });
});

describe("sessionUserId", () => {
  it("names the account a session belongs to, and nothing else", () => {
    expect(sessionUserId({ user: { id: "user-a" } })).toBe("user-a");
    expect(sessionUserId(null)).toBeNull();
    expect(sessionUserId(undefined)).toBeNull();
    expect(sessionUserId({ user: null })).toBeNull();
    expect(sessionUserId({ user: { id: "" } })).toBeNull();
    expect(sessionUserId({ user: { id: 7 } })).toBeNull();
  });
});

describe("the onboarding read", () => {
  it("does not apply an aborted read, and a later read still answers", async () => {
    let resolveFirst!: (value: {
      data: { first_opened_at: string; onboarded_at: null };
    }) => void;
    const firstResult = new Promise<{
      data: { first_opened_at: string; onboarded_at: null };
    }>((resolve) => { resolveFirst = resolve; });
    const firstClient = {
      from: () => ({ select: () => ({ maybeSingle: () => firstResult }) }),
    };
    let applied: string | null = null;
    const firstController = new AbortController();
    const firstRead = applyAccountOnboardingRead(
      firstClient,
      firstController.signal,
      (serverRow) => { applied = accountDisposition(serverRow ?? null); },
    );

    firstController.abort();
    resolveFirst({
      data: { first_opened_at: "2026-09-21T12:00:00.000Z", onboarded_at: null },
    });
    await firstRead;
    expect(applied).toBeNull();

    const secondClient = {
      from: () => ({
        select: () => ({
          maybeSingle: async () => ({
            data: { first_opened_at: "2026-09-22T12:00:00.000Z", onboarded_at: null },
          }),
        }),
      }),
    };
    await applyAccountOnboardingRead(
      secondClient,
      new AbortController().signal,
      (serverRow) => { applied = accountDisposition(serverRow ?? null); },
    );

    expect(applied).toBe("force");
  });
});

/**
 * Grok pass 1 on T2, FIX 1. `forget()` cleared the cache and the refs when a DIFFERENT auth user
 * id arrived, but left the gate at the previous account's "in" — so children stayed mounted while
 * the new account's disposition was still unknown, and a forced (row-less) account could paint
 * Today on a device somebody else had already signed in on. The gate must close on the change and
 * reopen only on the new account's own read.
 */
describe("<AuthGate> when the account changes under it", () => {
  const COMPLETED = { first_opened_at: "2026-09-19T10:00:00.000Z",
    onboarded_at: "2026-09-19T10:30:00.000Z" };


  let container: HTMLDivElement;

  beforeEach(() => {
    navigation.pathname = "/";
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => { container.remove(); });

  it("a session change to B closes the gate at once, binds nothing, and reloads (reload boundary)", async () => {
    let announce!: (session: { user: { id: string } } | null) => void;
    supabase.client = {
      auth: {
        getSession: async () => ({ data: { session: { user: { id: "user-a" } } } }),
        onAuthStateChange: (handler: (event: string, session: unknown) => void) => {
          announce = (session) => handler("SIGNED_IN", session);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
      from: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: COMPLETED }) }) }),
    };

    const root = createRoot(container);
    await act(async () => {
      root.render(<AuthGate><main data-testid="today">Today</main></AuthGate>);
    });
    await flush(); // the page binds and becomes ready for A
    expect(container.querySelector("[data-testid='today']")).not.toBeNull();

    await act(async () => { announce({ user: { id: "user-b" } }); });

    expect(container.querySelector("[data-testid='today']")).toBeNull();
    expect(container.textContent).toContain("Saving changes on this phone");
    expect(currentAccountOrNull()?.userId).not.toBe("user-b"); // B binds only in the next page
    await act(async () => { await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1)); });
    expect(currentAccountOrNull()).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalledWith("/onboarding");

    await act(async () => { root.unmount(); });
  });
});
