// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import MealCardActions, { SWIPE_SETTLE } from "./MealCardActions";
import { CLEAR_AT, DELETE_AT } from "@/lib/today/swipe-detents";

afterEach(cleanup);

describe("MealCardActions rail", () => {
  it("fills only the exposed width while keeping Clear and Delete keyboard thresholds", () => {
    const props = { label: "Meal 1", onClear: () => {}, onDelete: () => {} };
    const { rerender } = render(<MealCardActions {...props} revealed={0}><div>Meal</div></MealCardActions>);
    const clear = screen.getByRole("button", { name: "Clear Meal 1", hidden: true });
    const remove = screen.getByRole("button", { name: "Delete Meal 1", hidden: true });
    const rail = clear.parentElement as HTMLElement;
    expect(rail.style.width).toBe("0px");
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    expect(clear.tabIndex).toBe(-1);
    expect(remove.tabIndex).toBe(-1);

    // A peek short of the Clear detent is not reachable yet (audit b4b #8).
    rerender(<MealCardActions {...props} revealed={CLEAR_AT - 1}><div>Meal</div></MealCardActions>);
    expect(rail.style.width).toBe(`${CLEAR_AT - 1}px`);
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    expect(clear.tabIndex).toBe(-1);

    rerender(<MealCardActions {...props} revealed={CLEAR_AT}><div>Meal</div></MealCardActions>);
    expect(rail.getAttribute("aria-hidden")).toBe("false");
    expect(clear.tabIndex).toBe(0);
    expect(remove.tabIndex).toBe(-1);
    expect(remove.getAttribute("aria-hidden")).toBe("true");

    rerender(<MealCardActions {...props} revealed={DELETE_AT}><div>Meal</div></MealCardActions>);
    expect(rail.style.width).toBe(`${DELETE_AT}px`);
    expect(remove.tabIndex).toBe(0);
    expect(remove.hasAttribute("aria-hidden")).toBe(false);
  });

  it("settles without overshoot under reduced motion: the global rule beats the inline settle", () => {
    expect(SWIPE_SETTLE).toMatch(/cubic-bezier/);
    const css = readFileSync(`${process.cwd()}/app/globals.css`, "utf8");
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduce).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-duration:\s*0\.01ms\s*!important/);
  });

  it("puts Clear before Delete in tab order", () => {
    const props = { label: "Meal 1", onClear: () => {}, onDelete: () => {}, onToggle: () => {} };
    render(<MealCardActions {...props} revealed={DELETE_AT}><div>Meal</div></MealCardActions>);
    const clear = screen.getByRole("button", { name: "Clear Meal 1" });
    const remove = screen.getByRole("button", { name: "Delete Meal 1" });
    // Clear becomes actionable at a lower swipe threshold than Delete (R12); a keyboard user
    // tabbing forward from Clear must reach Delete next, not skip past it.
    expect(clear.compareDocumentPosition(remove) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([["Clear"], ["Delete"]])(
    "moves focus back to More once %s closes the tray", (name) => {
      const props = { label: "Meal 1", onClear: () => {}, onDelete: () => {}, onToggle: () => {} };
      const { rerender } = render(
        <MealCardActions {...props} revealed={DELETE_AT}><div>Meal</div></MealCardActions>);
      const action = screen.getByRole("button", { name: `${name} Meal 1` });
      act(() => action.focus());
      expect(document.activeElement).toBe(action);

      // The parent closes the tray in response to Clear/Delete (gesture.closeActions());
      // the action button is now aria-hidden / tabIndex=-1 but would otherwise keep focus.
      rerender(<MealCardActions {...props} revealed={0}><div>Meal</div></MealCardActions>);
      const more = screen.getByRole("button", { name: "More for Meal 1" });
      expect(document.activeElement).toBe(more);
    });

  it("still focuses Clear on the next open after a close reset the pending flag", () => {
    const props = { label: "Meal 1", onClear: () => {}, onDelete: () => {}, onToggle: () => {} };
    const { rerender } = render(
      <MealCardActions {...props} revealed={DELETE_AT}><div>Meal</div></MealCardActions>);
    const clear = screen.getByRole("button", { name: "Clear Meal 1" });
    act(() => clear.focus());
    rerender(<MealCardActions {...props} revealed={0}><div>Meal</div></MealCardActions>);
    const more = screen.getByRole("button", { name: "More for Meal 1" });
    expect(document.activeElement).toBe(more);

    fireEvent.click(more);
    rerender(<MealCardActions {...props} revealed={DELETE_AT}><div>Meal</div></MealCardActions>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear Meal 1" }));
  });

  it("keeps every focused More utility from losing its specificity tie with not-sr-only", () => {
    const props = { label: "Meal 1", onClear: () => {}, onDelete: () => {}, onToggle: () => {} };
    render(<MealCardActions {...props} revealed={0}><div>Meal</div></MealCardActions>);
    const more = screen.getByRole("button", { name: "More for Meal 1" });
    // Tailwind's `not-sr-only` resets position, margin, overflow, clip and padding, all at once
    // (not just padding) — any `focus:` utility sharing one of those properties ties on
    // specificity with it, and Tailwind's own utility order decides the winner. `!` pins every
    // one of them so the More label is reliably positioned and padded once focused, round-2
    // audit (Grok MINOR), not just un-clipped.
    for (const utility of ["absolute", "left-3", "top-3", "z-20", "rounded-full", "bg-primary",
      "px-4", "py-2", "text-caption", "text-on-primary"]) {
      expect(more.className).toMatch(new RegExp(`focus-visible:!${utility}(?:\\s|$)`));
    }
  });

  it("reports the tray expanded once Clear is actually reachable, not only at full reveal", () => {
    const props = { label: "Meal 1", onClear: () => {}, onDelete: () => {}, onToggle: () => {} };
    const { rerender } = render(
      <MealCardActions {...props} revealed={0}><div>Meal</div></MealCardActions>);
    const more = screen.getByRole("button", { name: "More for Meal 1" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    // Clear becomes tabbable at its detent; a screen-reader user who has reached it should not be
    // told the control is still "collapsed" (round-2 audit, DeepSeek MINOR #6).
    rerender(<MealCardActions {...props} revealed={CLEAR_AT}><div>Meal</div></MealCardActions>);
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });
});
