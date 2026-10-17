"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Registers /sw.js so the app shell is cache-first and works offline (PRD acceptance criterion 4),
 * and offers a waiting update without ever forcing it (FluidVoice "Update availability").
 *
 * The worker never takes over an open tab by itself (public/sw.js): a forced reload can lose an
 * unsent coach draft. So a waiting worker only raises a persistent "Update available" notice. Its
 * Reload is the one path that messages the waiting worker; the page reloads on the controller change
 * that follows, and only because it asked — a change another tab asked for leaves this one alone.
 * Registration and update-check failures are silent: there is no one to report them to, and the
 * app works without the worker.
 */

/** Per page load: set once this page chose Reload, and once it has reloaded for it. */
let reloadRequested = false;
let controllerReloaded = false;
/** Per page session: the waiting worker the user dismissed; a newer one is offered again. */
let dismissedWorker: ServiceWorker | null = null;
const reloadPage = () => window.location.reload();

/** The one reload this page may do, and only after its own Reload. */
function reloadOnce(reload: () => void): void {
  if (!reloadRequested || controllerReloaded) return;
  controllerReloaded = true;
  reload();
}

/** A worker that is no longer waiting: another tab activated it, or a newer build replaced it. */
const settled = (worker: ServiceWorker) => worker.state === "activated" || worker.state === "redundant";

export default function ServiceWorkerRegistrar({ reload = reloadPage }: {
  /** How the page reloads after its own Reload; injectable so the one-reload rule is testable. */
  reload?: () => void;
} = {}) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [requested, setRequested] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    let live = true;
    let installing: ServiceWorker | null = null;
    let watched: ServiceWorker | null = null;

    // The offered worker's own state: activated by this page's Reload → reload once; activated by
    // another tab or made redundant → the offer is stale and goes, and this tab is left alone.
    const onWaitingState = () => {
      if (!watched || !settled(watched)) return;
      if (watched.state === "activated") {
        watch(null);
        if (reloadRequested) reloadOnce(reload);
        return;
      }
      // Redundant: a newer build replaced the offered one. Any Reload asked of the old worker is
      // abandoned (it never takes over), so the newer one is offered afresh, Reload enabled.
      reloadRequested = false;
      if (live) setRequested(false);
      const successor = registrationRef.current?.waiting ?? null;
      watch(container.controller && successor && !settled(successor) ? successor : null);
    };
    const watch = (next: ServiceWorker | null) => {
      if (watched === next) return;
      watched?.removeEventListener("statechange", onWaitingState);
      watched = next;
      watched?.addEventListener("statechange", onWaitingState);
      if (live) setWaiting(next);
    };
    // A first install has no controller to replace: it activates by itself, so nothing is offered.
    const offer = () => {
      const candidate = registrationRef.current?.waiting ?? null;
      if (live && container.controller && candidate && !settled(candidate)) watch(candidate);
    };
    const onStateChange = () => { if (installing?.state === "installed") offer(); };
    // Waiting-worker race: a worker can finish installing before this page listens (it was already
    // installing when register() resolved, or installed between updatefound and the listener), so
    // the state is read once after attaching and the registration is re-read on every look.
    const trackInstalling = () => {
      installing?.removeEventListener("statechange", onStateChange);
      installing = registrationRef.current?.installing ?? null;
      installing?.addEventListener("statechange", onStateChange);
      // A worker that already finished is no longer `installing`: it is the registration's waiting one.
      offer();
    };
    const onUpdateFound = trackInstalling;
    const onControllerChange = () => {
      if (reloadRequested) reloadOnce(reload);
      else if (watched && settled(watched)) watch(null);
    };
    // An installed app can stay open for days; it looks for a new build when it comes back.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // A worker that installed while the app was hidden is waiting without an event this page saw.
      registrationRef.current?.update().catch(() => {}).finally(() => { if (live) { trackInstalling(); offer(); } });
    };

    container.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisible);
    container.register("/sw.js").then((found) => {
      if (!live) return;
      registrationRef.current = found;
      found.addEventListener("updatefound", onUpdateFound);
      trackInstalling();
      offer();
    }).catch(() => {
      // No backend, no telemetry, no one to report this to: the app runs without the worker.
    });

    return () => {
      live = false;
      container.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisible);
      registrationRef.current?.removeEventListener("updatefound", onUpdateFound);
      installing?.removeEventListener("statechange", onStateChange);
      watched?.removeEventListener("statechange", onWaitingState);
    };
  }, [reload]);

  /**
   * The user's Reload. A worker still waiting is asked to take over and the change event reloads;
   * one another tab already activated (its change event came before this page asked) reloads now;
   * one a newer build replaced hands the request to the newer waiting worker, if there is one.
   */
  function requestReload(offered: ServiceWorker): void {
    reloadRequested = true;
    setRequested(true);
    const current = registrationRef.current?.waiting ?? null;
    const target = offered.state === "redundant" ? current : offered;
    if (!target || target.state === "activated") reloadOnce(reload);
    else target.postMessage({ type: "SKIP_WAITING" });
  }

  if (!waiting || waiting === dismissedWorker) return null;

  return (
    <div role="status" aria-live="polite"
      className="update-notice pill-in toast min-h-11 text-caption text-charcoal">
      <span className="min-w-0 flex-1">Update available</span>
      <button type="button" disabled={requested} className="tap update-notice-reload"
        onClick={() => requestReload(waiting)}>
        {requested ? "Reloading…" : "Reload"}
      </button>
      <button type="button" aria-label="Dismiss update notice" className="tap update-notice-dismiss"
        onClick={() => { dismissedWorker = waiting; setWaiting(null); }}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"
          stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
