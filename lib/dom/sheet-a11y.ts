/**
 * Pure focus/keyboard decision logic for Sheet's modal behavior (Finding
 * #61: no focus trap, no Escape-to-close). Kept out of Sheet.tsx so it is
 * unit-testable — this repo has no jsdom/React Testing Library, so the
 * DOM wiring itself (Sheet.tsx's keydown listener) stays a manual phone
 * gate, per the convention in tests/today/day-type-toggle.test.tsx.
 */

const SHEET_CLOSE_KEY = "Escape";

/** True when this keydown should close the sheet. */
export function isSheetCloseKey(key: string): boolean {
  return key === SHEET_CLOSE_KEY;
}

type Focusable = { focus: () => void };

/**
 * Where Tab (or Shift+Tab) should redirect focus to keep it trapped inside
 * the sheet. `current` is whatever element has focus right now. Returns
 * null when the browser's own Tab order already stays inside the sheet.
 */
export function nextTrapFocus<T extends Focusable>(
  focusable: readonly T[],
  current: T | null,
  shiftKey: boolean
): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  // Async sheet content can disable the focused control before the next Tab.
  if (!current || !focusable.includes(current)) return shiftKey ? last : first;
  if (shiftKey) return current === first ? last : null;
  return current === last ? first : null;
}

/**
 * Drops one element from a focusable list, by reference. Sheet.tsx uses
 * this to remove its own full-screen scrim close button from the list
 * before taking initial focus or calling `nextTrapFocus`: the scrim is a
 * sibling of the sheet's content inside the dialog wrapper, so a plain
 * `dialog.querySelectorAll(...)` puts it first in DOM order, ahead of the
 * sheet's real content — silently overriding a consumer's own autoFocus
 * (e.g. LogFoodSheet's search input) and anchoring both ends of the Tab
 * trap on an invisible button instead.
 */
export function excludeElement<T>(focusable: readonly T[], toExclude: T | null): T[] {
  if (!toExclude) return [...focusable];
  return focusable.filter((el) => el !== toExclude);
}

type DialogScoped = { closest: (selector: string) => unknown };

/**
 * True when a key that reached `root` (Escape, Tab) was meant for it: a sheet or picker opened
 * INSIDE a full-screen flow (a nested `role="dialog"`) handles the same keys itself, and the flow
 * under it must stay put.
 */
export function keyBelongsTo(target: unknown, root: unknown): boolean {
  const scoped = target as Partial<DialogScoped> | null;
  if (!scoped || typeof scoped.closest !== "function") return true;
  const owner = scoped.closest('[role="dialog"]');
  return owner === null || owner === root;
}
