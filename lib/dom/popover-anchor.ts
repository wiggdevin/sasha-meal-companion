/**
 * The element a pop-up card grows out of (components/Sheet ModalSheet, components/TimeWheelSheet).
 * Callers open a Sheet by state, not by passing the button, so the card works out its trigger at
 * mount: the last element pressed (tracked with one passive capture listener, installed once) when
 * the press is recent, else the focused element. A recent press wins because iOS Safari does not
 * focus a tapped button, and a field elsewhere can keep focus while the user taps a card.
 */

const RECENT_PRESS_MS = 1000;
const INTERACTIVE = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], input, select, textarea, label, [tabindex]';

let lastPress: { target: Element; at: number } | null = null;
let installed = false;

function onPointerDown(event: PointerEvent): void {
  if (event.target instanceof Element) lastPress = { target: event.target, at: performance.now() };
}

/** Installs the press tracker once per page. Safe to call on every Sheet mount. */
export function installTriggerTracking(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
}

/** The trigger to anchor to right now, or null when nothing sensible opened the card. */
export function captureTrigger(): Element | null {
  if (typeof document === "undefined") return null;
  const press = lastPress;
  if (press && press.target.isConnected && performance.now() - press.at <= RECENT_PRESS_MS) {
    return press.target.closest(INTERACTIVE) ?? press.target;
  }
  const active = document.activeElement;
  return active && active !== document.body && active !== document.documentElement ? active : null;
}

/** Test-only: forgets the last press. */
export function __resetTriggerTrackingForTests(): void {
  lastPress = null;
}
