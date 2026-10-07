"use client";

import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { clampTilt } from "@/lib/today/water-liquid";

/**
 * The phone's roll for the water tile's surface (2026-10-03: "maybe it moves a little when the user
 * moves their phone"). `DeviceOrientationEvent.gamma`, clamped to ±15°; the liquid smooths it.
 *
 * iOS gates the sensor behind `DeviceOrientationEvent.requestPermission()`, which needs a user
 * gesture: `requestTiltPermission` is called from the tile's tap, once per page load, and never on
 * load. A denial or an error is silent: the water simply stays level. Browsers without the gate
 * (Android) deliver events with no prompt; browsers without the sensor deliver none.
 */
type Permission = "unavailable" | "prompt" | "granted" | "denied";
type OrientationGate = { requestPermission?: () => Promise<string> };

let permission: Permission | null = null;
let asked = false;
const listeners = new Set<() => void>();

function gate(): OrientationGate | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { DeviceOrientationEvent?: OrientationGate }).DeviceOrientationEvent ?? null;
}

function snapshot(): Permission {
  if (permission === null) {
    const g = gate();
    permission = !g ? "unavailable" : typeof g.requestPermission === "function" ? "prompt" : "granted";
  }
  return permission;
}

function settle(next: Permission): void {
  permission = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Call from a tap handler. Asks iOS once; every later call, and every other browser, is a no-op. */
export function requestTiltPermission(): void {
  if (asked || snapshot() !== "prompt") return;
  asked = true;
  try {
    gate()?.requestPermission?.().then(
      (answer) => settle(answer === "granted" ? "granted" : "denied"),
      () => settle("denied"),
    );
  } catch {
    settle("denied");
  }
}

/** Tests only: forget the page's answer so the next render reads the stubbed sensor afresh. */
export function resetWaterTiltForTests(): void {
  permission = null;
  asked = false;
}

/** The latest clamped roll in degrees, as a ref the liquid's frame loop reads. 0 while disabled. */
export function useWaterTilt(enabled: boolean): RefObject<number> {
  const state = useSyncExternalStore(subscribe, snapshot, () => "unavailable" as Permission);
  const tilt = useRef(0);
  useEffect(() => {
    tilt.current = 0;
    if (!enabled || state !== "granted") return;
    const onOrientation = (event: DeviceOrientationEvent) => { tilt.current = clampTilt(event.gamma); };
    window.addEventListener("deviceorientation", onOrientation);
    return () => window.removeEventListener("deviceorientation", onOrientation);
  }, [enabled, state]);
  return tilt;
}
