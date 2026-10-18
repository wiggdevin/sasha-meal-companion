"use client";

/**
 * `navigator.onLine`, kept current: re-rendered on the window's `online` and `offline` events, so a
 * control disabled while offline comes back on its own when the connection does (UI audit
 * 2026-10-18). The server render, and a runtime with no navigator, read as online.
 */
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, online, () => true);
}
