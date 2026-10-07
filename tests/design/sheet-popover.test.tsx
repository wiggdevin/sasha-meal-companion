/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sheet from "@/components/Sheet";
import { __resetScrollLockForTests } from "@/lib/dom/scroll-lock";

afterEach(() => {
  cleanup();
  __resetScrollLockForTests();
});

function Opener() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open picker</button>
    {open && <Sheet title="Pick" onClose={() => setOpen(false)}><button type="button">Choice</button></Sheet>}
  </>;
}

describe("Sheet modal pop-up (2026-10-03: no bottom sheets)", () => {
  it("renders a card with no drag handle and no bottom placement", () => {
    render(<Sheet title="Edit meal" subtitle="Lunch" onClose={() => {}}><p>Body</p></Sheet>);
    const dialog = screen.getByRole("dialog", { name: "Edit meal" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector(".sheet-handle")).toBeNull();
    expect(dialog.querySelector(".bottom-0")).toBeNull();
    const card = dialog.querySelector<HTMLElement>(".sheet-surface");
    expect(card).not.toBeNull();
    expect(card?.style.top).toMatch(/px$/);
    expect(card?.style.transformOrigin).toMatch(/px/);
    expect(screen.getByText("Lunch")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(2);
  });

  it("sets its title in the display face, like every screen title (Kimi K1, 2026-10-04)", () => {
    render(<Sheet title="Conversations" onClose={() => {}}><p>Body</p></Sheet>);
    expect(screen.getByRole("heading", { name: "Conversations", level: 2 }).className).toMatch(/\bfont-display\b/);
  });

  it("centres the card when nothing opened it", () => {
    render(<Sheet title="Pick" onClose={() => {}}><p>Body</p></Sheet>);
    expect(screen.getByRole("dialog").querySelector("[data-popover-side]")?.getAttribute("data-popover-side"))
      .toBe("center");
  });

  it("anchors to the button that opened it and returns focus there on close", () => {
    render(<Opener />);
    const trigger = screen.getByRole("button", { name: "Open picker" });
    trigger.getBoundingClientRect = () => ({ top: 100, bottom: 144, left: 40, right: 200, width: 160,
      height: 44, x: 40, y: 100, toJSON: () => ({}) });
    trigger.focus();
    fireEvent.click(trigger);
    const card = screen.getByRole("dialog").querySelector<HTMLElement>(".sheet-surface");
    expect(card?.getAttribute("data-popover-side")).toBe("below");
    // The card's first focusable control takes focus; Escape closes and focus goes back.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a tap outside and locks background scroll while open", () => {
    const onClose = vi.fn();
    const view = render(<Sheet title="Pick" onClose={onClose}><p>Body</p></Sheet>);
    expect(document.body.style.overflow).toBe("hidden");
    const scrim = screen.getByRole("dialog").querySelector<HTMLElement>(".sheet-popover-scrim");
    fireEvent.click(scrim!);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps Tab inside the card", () => {
    render(<Sheet title="Pick" onClose={() => {}}><button type="button">Only choice</button></Sheet>);
    const last = screen.getByRole("button", { name: "Only choice" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
  });

  it("styles the surface as a rounded card on every corner, with no handle rule left", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const surface = /\.sheet-surface\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(surface).toMatch(/border-radius:\s*28px;/);
    expect(surface).not.toMatch(/border-bottom:\s*0/);
    expect(css).not.toMatch(/\.sheet-handle\s*\{/);
    expect(css).not.toMatch(/translateY\(100%\)/);
  });
});
