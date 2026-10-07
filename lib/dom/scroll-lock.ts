/**
 * Locks background scroll while a Sheet is open (Finding #88: bottom
 * sheets never lock background scroll). Takes a body-like target instead
 * of reading `document` directly so the lock/restore logic is
 * unit-testable without a DOM — this repo has no jsdom.
 *
 * Ref-counted at module scope (review blocker on
 * fix/fix-sheet-modal-focus-and-scroll): three flows in this app hand off
 * from one Sheet straight to another (LogFoodSheet -> AddFoodSheet,
 * CaptureSheet -> LogFoodSheet, BarcodeScanSheet -> ScanConfirmSheet), and
 * AnimatePresence's default 'sync' mode keeps the outgoing sheet mounted
 * through its ~200ms exit animation while the new one is already open. A
 * per-call lock would have the outgoing sheet's delayed cleanup restore
 * scroll while the new sheet is still fully open. Only the first lock
 * (0 -> 1) captures the value to restore, and only the last unlock
 * (count back to 0) restores it.
 */
type ScrollTarget = { style: { overflow: string } };

let lockCount = 0;
let restoreValue = "";

/** Sets overflow to "hidden" (if not already locked) and returns a
 *  function that releases this caller's lock, restoring the pre-lock
 *  overflow value once every caller has released. */
export function lockBodyScroll(body: ScrollTarget): () => void {
  if (lockCount === 0) {
    restoreValue = body.style.overflow;
    body.style.overflow = "hidden";
  }
  lockCount += 1;

  let released = false;
  return function unlockBodyScroll() {
    if (released) return; // idempotent: a cleanup must only ever release once
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      body.style.overflow = restoreValue;
    }
  };
}

/** Test-only: resets the shared lock counter between cases. Never called
 *  from app code — each Sheet mount/unmount pairs its own lock/unlock. */
export function __resetScrollLockForTests(): void {
  lockCount = 0;
  restoreValue = "";
}
