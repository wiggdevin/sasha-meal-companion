"use client";

/**
 * The phone side of crash reporting (lib/client-errors.ts). `reportClientError` sends one
 * allowlisted report (code, name, route pattern, digest, build; never the message or the path),
 * best effort: it never throws, never retries and never waits on the answer.
 * `installClientErrorHandlers` hooks `window` `error` and `unhandledrejection` once per page load.
 *
 * Bounded: the same (source, name, code, route) is sent once per page load, and at most
 * MAX_REPORTS_PER_LOAD reports leave one page load at all, so a render loop cannot flood the route.
 *
 * It calls `fetch` directly, not `accountFetch`: the report names no account (no `x-smc-account`
 * header, no session read), and a crash during sign-in or an account switch must still be heard.
 */

import {
  CLIENT_ERRORS_URL, cleanReport, describeThrown, type ClientErrorReport, type ClientErrorSource,
} from "@/lib/client-errors";

export const MAX_REPORTS_PER_LOAD = 5;

let sent = 0;
const seen = new Set<string>();
let uninstall: (() => void) | null = null;

function buildSha(): string | null {
  return process.env.NEXT_PUBLIC_BUILD_SHA || null;
}

function currentPath(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

/** Builds the report the route would log (exported for tests). */
export function buildReport(error: unknown, source: ClientErrorSource, now: Date = new Date()): ClientErrorReport {
  const { name, code, digest } = describeThrown(error);
  return cleanReport({ source, name, code, digest, route: currentPath(), build: buildSha(),
    at: now.toISOString() }, now);
}

/** Sends one report unless it repeats one already sent or the page load's cap is reached. */
export function reportClientError(error: unknown, source: ClientErrorSource = "boundary"): boolean {
  try {
    if (typeof window === "undefined" || typeof fetch !== "function") return false;
    const report = buildReport(error, source);
    const key = `${report.source}|${report.name}|${report.code}|${report.route}`;
    if (seen.has(key) || sent >= MAX_REPORTS_PER_LOAD) return false;
    seen.add(key);
    sent += 1;
    void fetch(CLIENT_ERRORS_URL, {
      method: "POST", keepalive: true, credentials: "omit", cache: "no-store",
      headers: { "content-type": "application/json" }, body: JSON.stringify(report),
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** Hooks the window's uncaught errors once per page load; a second call is a no-op. */
export function installClientErrorHandlers(): void {
  if (uninstall || typeof window === "undefined") return;
  const onError = (event: ErrorEvent) => {
    // A failed <img>/<script> load also fires `error` (no `error` value): not a crash.
    if (event.error == null && !event.message) return;
    reportClientError(event.error ?? event.message, "window-error");
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportClientError(event.reason, "unhandled-rejection");
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  uninstall = () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

/** Test seam: forgets what this page load sent and lets the handlers be installed again. */
export function resetClientErrorReporterForTests(): void {
  sent = 0;
  seen.clear();
  uninstall?.();
  uninstall = null;
}
