/**
 * Finding #61 — Sheet has no focus trap or Escape-to-close.
 *
 * This repo has no jsdom/React Testing Library (see the note in
 * tests/today/day-type-toggle.test.tsx), so Sheet's actual keydown wiring
 * is a manual phone gate. What is unit-tested here is the pure decision
 * logic Sheet.tsx calls into: which key closes the sheet, and where Tab /
 * Shift+Tab should redirect focus to keep it trapped inside the dialog.
 */
import { describe, expect, it } from "vitest";
import { excludeElement, isSheetCloseKey, nextTrapFocus } from "@/lib/dom/sheet-a11y";

describe("isSheetCloseKey", () => {
  it("closes on Escape", () => {
    expect(isSheetCloseKey("Escape")).toBe(true);
  });

  it("leaves every other key alone", () => {
    expect(isSheetCloseKey("Enter")).toBe(false);
    expect(isSheetCloseKey("Tab")).toBe(false);
    expect(isSheetCloseKey("a")).toBe(false);
  });
});

describe("nextTrapFocus", () => {
  const focus = () => {};
  const first = { focus, id: "first" };
  const middle = { focus, id: "middle" };
  const last = { focus, id: "last" };
  const focusable = [first, middle, last];

  it("wraps Tab from the last item back to the first", () => {
    expect(nextTrapFocus(focusable, last, false)).toBe(first);
  });

  it("wraps Shift+Tab from the first item back to the last", () => {
    expect(nextTrapFocus(focusable, first, true)).toBe(last);
  });

  it("leaves Tab alone in the middle of the sheet", () => {
    expect(nextTrapFocus(focusable, middle, false)).toBeNull();
    expect(nextTrapFocus(focusable, middle, true)).toBeNull();
  });

  it("recovers Tab when the focused control becomes disabled and leaves the focus list", () => {
    expect(nextTrapFocus(focusable, { focus, id: "disabled" }, false)).toBe(first);
    expect(nextTrapFocus(focusable, { focus, id: "disabled" }, true)).toBe(last);
  });

  it("does nothing when the sheet has no focusable elements", () => {
    expect(nextTrapFocus([], null, false)).toBeNull();
  });
});

describe("excludeElement", () => {
  // Review blocker on fix/fix-sheet-modal-focus-and-scroll: Sheet.tsx's
  // dialogRef spans the outer wrapper, whose first child in DOM order is
  // the full-screen scrim close button. Querying it directly for
  // focusables put the scrim at index 0 — the initial-focus target, and
  // both wrap-around ends of nextTrapFocus's Tab cycle — silently
  // overriding a consumer's own autoFocus (e.g. LogFoodSheet's search
  // input). excludeElement drops the scrim, by reference, from that list
  // before it reaches initial focus or nextTrapFocus.
  const scrim = { id: "scrim" };
  const closeIcon = { id: "closeIcon" };
  const searchInput = { id: "searchInput" };

  it("drops the given element from the list, by reference", () => {
    expect(excludeElement([scrim, closeIcon, searchInput], scrim)).toEqual([closeIcon, searchInput]);
  });

  it("leaves the list unchanged when there is nothing to exclude", () => {
    expect(excludeElement([closeIcon, searchInput], null)).toEqual([closeIcon, searchInput]);
  });

  it("leaves the list unchanged when the element to exclude isn't in it", () => {
    expect(excludeElement([closeIcon, searchInput], scrim)).toEqual([closeIcon, searchInput]);
  });
});
