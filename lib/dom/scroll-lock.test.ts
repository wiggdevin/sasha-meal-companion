/**
 * Finding #88 — Bottom sheets never lock background scroll.
 *
 * lockBodyScroll takes a body-like target (instead of reading `document`
 * directly) so this is unit-testable without a DOM — this repo has no
 * jsdom. Sheet.tsx calls it with the real document.body at runtime.
 *
 * The lock is ref-counted at module scope (review blocker on
 * fix/fix-sheet-modal-focus-and-scroll): three places in this app hand
 * off from one Sheet straight to another under AnimatePresence's default
 * 'sync' mode, which keeps the outgoing sheet mounted through its ~200ms
 * exit animation while the new one is already open. The outgoing sheet's
 * delayed cleanup must not un-hide scroll behind a sheet that has since
 * taken over.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { __resetScrollLockForTests, lockBodyScroll } from "@/lib/dom/scroll-lock";

beforeEach(() => {
  __resetScrollLockForTests();
});

describe("lockBodyScroll", () => {
  it("sets overflow to hidden while locked", () => {
    const body = { style: { overflow: "" } };
    lockBodyScroll(body);
    expect(body.style.overflow).toBe("hidden");
  });

  it("restores whatever overflow value was there before, on unlock", () => {
    const body = { style: { overflow: "auto" } };
    const unlock = lockBodyScroll(body);
    expect(body.style.overflow).toBe("hidden");
    unlock();
    expect(body.style.overflow).toBe("auto");
  });

  it("restores an empty overflow, not the literal string 'hidden'", () => {
    const body = { style: { overflow: "" } };
    const unlock = lockBodyScroll(body);
    unlock();
    expect(body.style.overflow).toBe("");
  });

  it("stays locked while a second, later sheet is still open (stacked hand-off)", () => {
    const body = { style: { overflow: "" } };
    const unlockFirstSheet = lockBodyScroll(body); // sheet 1 opens
    const unlockSecondSheet = lockBodyScroll(body); // sheet 2 opens on top, before sheet 1 unmounts
    expect(body.style.overflow).toBe("hidden");

    unlockFirstSheet(); // sheet 1's delayed exit-animation cleanup fires
    expect(body.style.overflow).toBe("hidden"); // must stay locked: sheet 2 is still open

    unlockSecondSheet(); // sheet 2 finally closes
    expect(body.style.overflow).toBe("");
  });

  it("restores the value from before the FIRST lock, not an intermediate one", () => {
    const body = { style: { overflow: "auto" } };
    const unlockFirstSheet = lockBodyScroll(body);
    const unlockSecondSheet = lockBodyScroll(body);
    unlockFirstSheet();
    unlockSecondSheet();
    expect(body.style.overflow).toBe("auto");
  });

  it("is idempotent if the same unlock somehow runs twice", () => {
    const body = { style: { overflow: "auto" } };
    const unlock = lockBodyScroll(body);
    unlock();
    unlock();
    expect(body.style.overflow).toBe("auto");
  });
});
