"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/client";
import { captureTimeZone } from "@/lib/sync/settings";
import { currentAccountOrNull, onAccountReady, SESSION_CHECK_EVENT } from "@/lib/device/account";
import {
  applySessionAccount, bootPhase, documentAccountId, onBootPhase, retryBoot, useHere,
  onAccountMismatch, watchTabSignals, type BootPhase,
} from "@/lib/device/boot";
import {
  departurePhase, onDeparturePhase, retryDeparture, type DeparturePhase,
} from "@/lib/device/departure";
import { signOutHere, signOutNotice } from "@/lib/device/sign-out";
import { ActivityPromptProvider } from "@/components/ActivityMismatchPrompt";
import Button from "@/components/ui/Button";
import { designGalleryOpen } from "@/app/design/gallery-access";
import {
  GateShell, OtherTabCard, SignedOutCard, UnsavedChangesCard,
} from "@/components/GateShell";
import {
  accountDisposition,
  readAccountOnboardingRow,
  type AccountOnboardingClient,
  type OnboardingDisposition,
  type ServerOnboardingRow,
} from "@/lib/profile/onboarding-state";

/**
 * D1 §1. Four states, and only two of them ever render the app:
 *
 *   unknown     the session or the onboarding disposition is still being resolved
 *   out         no session
 *   onboarding  this account has never finished setup
 *   in          this account may use the app
 *
 * The walkthrough baseline caught Today on screen 304 ms after sign-in and before the onboarding
 * read answered (lanes/W1/baseline.md step 1): the old `applySession` set "in" from the session
 * alone, then a later effect redirected. A redirect cannot un-render a screen that already
 * fetched, so the disposition — not the session — is what opens this gate.
 */
export type Gate = "unknown" | "out" | "onboarding" | "in";

/**
 * Routes AuthGate itself never gates, kept in step with middleware.ts's
 * matcher (`/((?!api/|auth/|_next/|sign-in|.*\\.[^/]+$).*)`), which already
 * exempts /sign-in and /auth/* server-side for the same reason: a signed-out
 * visitor on /sign-in must reach the magic-link form, not the "Signed out"
 * card whose only link is /sign-in.
 */
const AUTH_EXEMPT_PATHS = ["/sign-in", "/auth/"];

export function isAuthExempt(pathname: string | null): boolean {
  if (!pathname) return false;
  // The /design fixture galleries, in local development with an explicit opt-in only.
  if (designGalleryOpen(pathname)) return true;
  return AUTH_EXEMPT_PATHS.some((path) =>
    path.endsWith("/") ? pathname.startsWith(path) : pathname === path,
  );
}

/**
 * Where the "Signed out" card's sign-in link goes — back to the page you were on, the same
 * `next` rule middleware.ts applies to every server-side redirect (production smoke 2026-09-13,
 * feature "body": a session that expires on a deep page like /body must not drop you on Today
 * after you sign back in).
 */
export function signedOutHref(pathname: string | null): string {
  if (!pathname || pathname === "/") return "/sign-in";
  return `/sign-in?next=${encodeURIComponent(pathname)}`;
}

/* ---------------------------------------------------------------------------------------- */
/* The account-scoped disposition cache (D1 §1.3)                                             */
/* ---------------------------------------------------------------------------------------- */

export const DISPOSITION_CACHE_PREFIX = "meal-companion:onboarding-disposition:";

export type CachedDisposition = {
  disposition: OnboardingDisposition;
  firstOpenedAt: string | null;
  onboardedAt: string | null;
};

const DISPOSITIONS: readonly OnboardingDisposition[] = ["force", "invite", "none"];

export function dispositionCacheKey(userId: string): string {
  return `${DISPOSITION_CACHE_PREFIX}${userId}`;
}

type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storageOr(storage: WebStorage | null | undefined): WebStorage | null {
  if (storage !== undefined) return storage;
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** `null` for "this account has no cached disposition", including a stored value we cannot trust. */
export function readCachedDisposition(
  userId: string, storage?: WebStorage | null,
): CachedDisposition | null {
  try {
    const raw = storageOr(storage)?.getItem(dispositionCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedDisposition>;
    if (!DISPOSITIONS.includes(parsed.disposition as OnboardingDisposition)) return null;
    return {
      disposition: parsed.disposition as OnboardingDisposition,
      firstOpenedAt: typeof parsed.firstOpenedAt === "string" ? parsed.firstOpenedAt : null,
      onboardedAt: typeof parsed.onboardedAt === "string" ? parsed.onboardedAt : null,
    };
  } catch {
    return null;
  }
}

export function writeCachedDisposition(
  userId: string, value: CachedDisposition, storage?: WebStorage | null,
): void {
  try {
    storageOr(storage)?.setItem(dispositionCacheKey(userId), JSON.stringify(value));
  } catch {
    // A blocked localStorage only costs this device its offline entry; it is never fatal.
  }
}

export function clearCachedDisposition(userId: string, storage?: WebStorage | null): void {
  try {
    storageOr(storage)?.removeItem(dispositionCacheKey(userId));
  } catch {
    // Same: nothing downstream depends on the removal succeeding.
  }
}

/* ---------------------------------------------------------------------------------------- */
/* The state machine, as pure functions                                                       */
/* ---------------------------------------------------------------------------------------- */

export type GateResolution =
  | { status: "resolved"; disposition: OnboardingDisposition; cache: CachedDisposition | null }
  | { status: "blocked" };

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * What one onboarding read means. `undefined` is a FAILED read (D1 §1.4): it is never turned into
 * a disposition, because a dropped connection read as "invite" is exactly how the old path let a
 * row-less account into Today. It falls back to this account's own cache, or fails closed.
 *
 * `cache` is what to persist — non-null only for a successful server read.
 */
export function resolveGate(
  serverRow: ServerOnboardingRow | null | undefined,
  cached: CachedDisposition | null,
): GateResolution {
  if (serverRow === undefined) {
    return cached === null
      ? { status: "blocked" }
      : { status: "resolved", disposition: cached.disposition, cache: null };
  }
  const disposition = accountDisposition(serverRow);
  return {
    status: "resolved",
    disposition,
    cache: {
      disposition,
      firstOpenedAt: stringOrNull(serverRow?.first_opened_at),
      onboardedAt: stringOrNull(serverRow?.onboarded_at),
    },
  };
}

export type GateView = "shell" | "blocked" | "signed-out" | "children" | "adoption-failed";

/**
 * `/onboarding` renders only in the onboarding state; nothing else renders children until "in".
 * Phase 9 §0.1: no account screen renders until this device is READY for the account (legacy
 * adoption finished), however fast the disposition answered (audit plan r2 finding 3).
 */
export function gateView(
  gate: Gate, pathname: string | null, blocked: boolean, ready: boolean, adoptionFailed = false,
): GateView {
  if (gate === "out") return "signed-out";
  if (adoptionFailed) return "adoption-failed";
  if (gate === "unknown") return blocked ? "blocked" : "shell";
  if (!ready) return "shell";
  if (gate === "onboarding") return pathname === "/onboarding" ? "children" : "shell";
  return pathname === "/onboarding" ? "shell" : "children";
}

/**
 * The one navigation the gate performs, decided only from a RESOLVED disposition — never mid-read,
 * so finishing onboarding (which replaces to "/") cannot be bounced straight back.
 */
export function gateRedirect(gate: Gate, pathname: string | null): "/onboarding" | "/" | null {
  if (!pathname) return null;
  if (gate === "onboarding") return pathname === "/onboarding" ? null : "/onboarding";
  if (gate === "in") return pathname === "/onboarding" ? "/" : null;
  return null;
}

export function gateForDisposition(disposition: OnboardingDisposition): Gate {
  return disposition === "force" ? "onboarding" : "in";
}

type SessionLike = { user?: { id?: unknown } | null } | null | undefined;

export function sessionUserId(session: SessionLike): string | null {
  const id = session?.user?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

export async function applyAccountOnboardingRead(
  client: AccountOnboardingClient,
  signal: AbortSignal,
  apply: (serverRow: ServerOnboardingRow | null | undefined) => void,
  expectedUserId?: string,
): Promise<void> {
  const serverRow = await readAccountOnboardingRow(client, expectedUserId);
  if (signal.aborted) return;
  apply(serverRow);
}

/* ---------------------------------------------------------------------------------------- */

type Account = { userId: string | null; disposition: OnboardingDisposition | null };

/** Runs `fn` once this page is ready for `userId` (at once when it already is). */
function whenReady(userId: string, fn: () => void): void {
  let done = false;
  let off: (() => void) | null = null;
  off = onAccountReady((h) => {
    if (done || h.userId !== userId) return;
    done = true;
    off?.();
    fn();
  });
  if (done) off();
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const exempt = isAuthExempt(pathname);
  const [gate, setGate] = useState<Gate>("unknown");
  const [blocked, setBlocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const boot = useSyncExternalStore<BootPhase>(onBootPhase, bootPhase, () => "idle");
  const departure = useSyncExternalStore<DeparturePhase>(
    onDeparturePhase, departurePhase, () => "none");
  const account = useRef<Account>({ userId: null, disposition: null });

  // Other tabs of this origin: "leaving" and "handover" reach this page for as long as it lives.
  useEffect(() => watchTabSignals(), []);

  useEffect(() => {
    let alive = true;
    let read: AbortController | null = null;
    const supabase = browserClient();

    const settle = (disposition: OnboardingDisposition): void => {
      if (!alive) return;
      account.current.disposition = disposition;
      const next = gateForDisposition(disposition);
      setBlocked(false);
      setGate(next);
      const destination = gateRedirect(next, pathname);
      if (destination) router.replace(destination);
    };

    /**
     * Phase 9 slice 1, reload boundary: a page binds one account, once. A session for another
     * account, or none, after that never switches in place — `applySessionAccount` starts the
     * departure (durable state, then a reload) and the gate shows only the neutral shell.
     */
    const applySession = (session: SessionLike): void => {
      if (!alive) return;
      const userId = sessionUserId(session);
      // An exempt route (/sign-in, /auth/*) binds nothing, but a page that already bound an
      // account still leaves it when the session changes.
      if (exempt) {
        if (documentAccountId() !== null) applySessionAccount(userId);
        return;
      }
      const outcome = applySessionAccount(userId);
      if (outcome === "departing") {
        read?.abort();
        read = null;
        // The departing account's disposition cache stays: it is keyed by that account and is
        // what lets it open offline when it comes back (reload review r2 #1).
        account.current = { userId: null, disposition: null };
        return;
      }
      if (outcome === "signed-out" || userId === null) {
        read?.abort();
        read = null;
        account.current = { userId: null, disposition: null };
        setGate("out");
        return;
      }
      const known = account.current.userId === userId ? account.current.disposition : null;
      account.current.userId = userId;
      // "none" and "invite" never turn back into "force", so they are answered from memory.
      // "force" is re-read on every navigation: that is how a just-finished onboarding releases
      // the gate instead of redirecting to /onboarding forever.
      if (known !== null && known !== "force") {
        settle(known);
        return;
      }
      const controller = new AbortController();
      read?.abort();
      read = controller;
      // The narrow read port; the full client type is too deep for the structural check.
      const onboardingClient = supabase as unknown as AccountOnboardingClient;
      void applyAccountOnboardingRead(onboardingClient, controller.signal, (serverRow) => {
        if (read === controller) read = null;
        // A read answered for an account the gate has since left is nobody's to cache or apply.
        if (!alive || account.current.userId !== userId) return;
        const resolution = resolveGate(serverRow, readCachedDisposition(userId));
        if (resolution.status === "blocked") {
          account.current.disposition = null;
          setGate("unknown");
          setBlocked(true);
          return;
        }
        const cache = resolution.cache;
        if (cache !== null) {
          // Only the writer tab, once ready, writes for the account (reload review r1 #10): the
          // disposition cache, and on the first authenticated online open this browser's zone
          // (D1 §6.4; idempotent and never fatal).
          whenReady(userId, () => {
            writeCachedDisposition(userId, cache);
            const h = currentAccountOrNull();
            if (h?.userId === userId) void captureTimeZone(h).catch(() => {});
          });
        }
        settle(resolution.disposition);
      }, userId);
    };

    // PR #248 review r1 #3: the initial read can answer after an auth event has already applied a
    // newer session; that stale answer must not bind the page.
    let authEventSeen = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (!authEventSeen) applySession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventSeen = true;
      applySession(session);
    });
    // The server answered `account_mismatch`: the cookie belongs to another account now. Leave at
    // once; the next page reads the session (reload review r4 #2).
    const recheck = (): void => onAccountMismatch();
    window.addEventListener(SESSION_CHECK_EVENT, recheck);
    return () => {
      alive = false;
      read?.abort();
      data.subscription.unsubscribe();
      window.removeEventListener(SESSION_CHECK_EVENT, recheck);
    };
  }, [exempt, pathname, router, attempt]);

  // Leaving an account: nothing of it (or of the next one) renders until the page reloads.
  if (departure === "blocked") return <UnsavedChangesCard onRetry={() => { void retryDeparture(); }} />;
  if (departure === "leaving") return <GateShell body="Saving changes on this phone…" />;
  if (exempt) return <>{children}</>;
  if (boot === "elsewhere" || boot === "waiting") {
    return <OtherTabCard waiting={boot === "waiting"} onUseHere={useHere} />;
  }

  const view = gateView(gate, pathname, blocked, boot === "ready", boot === "failed");
  if (view === "children") return <ActivityPromptProvider>{children}</ActivityPromptProvider>;
  if (view === "signed-out") return <SignedOutCard href={signedOutHref(pathname)} />;
  if (view === "blocked" || view === "adoption-failed") {
    const retry = (): void => {
      // Adoption runs only at a cold start: Retry is a fresh page.
      if (view === "adoption-failed") { retryBoot(); return; }
      setBlocked(false);
      setAttempt((value) => value + 1);
    };
    // Sign out says first what is still waiting on this phone; a second tap signs out.
    const signOut = async (): Promise<void> => {
      // The account the tap is for: a later session change never turns it into another's sign-out.
      const h = currentAccountOrNull();
      if (h === null) return;
      if (notice === null) {
        const text = await signOutNotice(h.userId);
        if (text !== null) { setNotice(text); return; }
      }
      void signOutHere(browserClient().auth, h.userId);
    };
    return (
      <GateShell body={view === "adoption-failed"
        ? "This phone could not finish the update."
        : "Connect once to finish setting up this device"}>
        {notice ? <p className="m-0 text-caption font-normal text-graphite">{notice}</p> : null}
        <div className="mt-2 flex flex-col gap-2">
          <Button variant="primary" size="lg" block onClick={retry}>Retry</Button>
          <Button variant="tertiary" block onClick={() => { void signOut(); }}>Sign out</Button>
        </div>
      </GateShell>
    );
  }
  return <GateShell body="Setting up this device…" />;
}
