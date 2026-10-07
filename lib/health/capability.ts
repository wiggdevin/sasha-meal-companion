"use client";

import { accountFetch, onAccountReady, type AccountHandle } from "@/lib/device/account";

/**
 * Is body data on? The tab bar sits outside `AuthGate` (`app/layout.tsx`), so it can only learn the
 * answer from one authoritative response. Tri-state on purpose (Sol audit, T11a): `unknown` means
 * "has not decided yet" and is never rendered as on or off. Only a 200 or a 503 on
 * `/api/health/daily` decides — never a cached row, a 401, or a network error — and the answer is
 * remembered for the session so a tab switch does not probe again.
 */

export type BodyCapability = "unknown" | "enabled" | "disabled";

/** The bound account once it is ready — at once if it already is. */
function readyAccount(): Promise<AccountHandle> {
  return new Promise((resolve) => {
    let stop: (() => void) | null = null;
    let done = false;
    stop = onAccountReady((h) => {
      done = true;
      stop?.();
      resolve(h);
    });
    if (done) stop();
  });
}

export const BODY_CAPABILITY_KEY = "smc:body_capability";

let sessionValue: BodyCapability | null = null;
let inFlight: Promise<BodyCapability> | null = null;

/** Phase 9 §0.3: the capability answer belongs to the account that asked. */
export function resetCapabilityCache(): void {
  sessionValue = null;
  inFlight = null;
}

export function readBodyCapability(): BodyCapability {
  if (sessionValue !== null) return sessionValue;
  if (typeof window === "undefined") return "unknown";
  try {
    const raw = globalThis.sessionStorage.getItem(BODY_CAPABILITY_KEY);
    if (raw === "enabled" || raw === "disabled") sessionValue = raw;
  } catch {
    // A blocked session store is not a reason to decide anything.
  }
  return sessionValue ?? "unknown";
}

function remember(value: BodyCapability): BodyCapability {
  if (value === "unknown") return value;
  sessionValue = value;
  try {
    globalThis.sessionStorage.setItem(BODY_CAPABILITY_KEY, value);
  } catch {
    // See readBodyCapability.
  }
  return value;
}

/**
 * One probe, one request: concurrent callers share the in-flight promise. Only a 200 or a 503 is a
 * decision (Sol audit, T11a); any other answer — a 401 from a signed-out load, a network error —
 * clears the in-flight promise so the next mount can try again instead of freezing on `unknown`
 * for the rest of the session.
 */
export async function probeBodyCapability(fetchFn: typeof fetch = fetch): Promise<BodyCapability> {
  if (inFlight) return inFlight;
  const probe = (async () => {
    try {
      // The route refuses a request with no account header (PR #248 review r3 #1), and the tab bar
      // can mount before an account is bound: wait for a ready one, then ask as that account.
      const h = await readyAccount();
      const q = new Date().toISOString().slice(0, 10);
      const res = await accountFetch(h, `/api/health/daily?from=${q}&to=${q}`, { cache: "no-store" },
        { fetchImpl: fetchFn });
      if (res.status === 200) return remember("enabled");
      if (res.status === 503) return remember("disabled");
      return "unknown";
    } catch {
      return "unknown";
    }
  })();
  inFlight = probe;
  const result = await probe;
  if (result === "unknown") inFlight = null;
  return result;
}

/** Test-only: the session cache and the in-flight promise are module singletons. */
export function resetBodyCapabilityForTests(): void {
  sessionValue = null;
  inFlight = null;
}
