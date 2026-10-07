/** Optional tactile detent; unsupported browsers retain the same visual snapping. */
export function selectionHaptic(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try { navigator.vibrate(8); } catch { /* Device policy may disable vibration. */ }
}

/**
 * Pulse, rest, pulse… (ms). It rises to its strongest pulse by the third, then each pulse shortens
 * while the rests lengthen: a two-second confirmation that swells quickly and trails away.
 */
export const COMMIT_SUCCESS_PATTERN = [25, 70, 50, 80, 80, 160, 60, 220, 45, 290, 30, 380, 20, 478, 12];

/**
 * Best-effort confirmation for an action that reached its durable success state. Browsers without
 * the Vibration API keep the same visual confirmation and return false.
 */
export function commitSuccessHaptic(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return false;
  try { return navigator.vibrate(COMMIT_SUCCESS_PATTERN); }
  catch { return false; /* Device policy may disable vibration. */ }
}

/** A short double tap for a confirmation the control shows itself (a Button's tick): felt, not
 *  heard over. iOS Safari has no Vibration API; the tick stays the confirmation there. */
export const CONFIRM_PATTERN = [14, 60, 22];

export function confirmHaptic(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return false;
  try { return navigator.vibrate(CONFIRM_PATTERN); }
  catch { return false; /* Device policy may disable vibration. */ }
}
