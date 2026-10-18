// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCK_BOTTOM_OFFSET, TRAY_OPEN } from "@/components/dock/dock-motion";
import { CoachFrame } from "@/components/coach/CoachShell";
import { KEYBOARD_CLEARANCE, RESTING_CLEARANCE } from "@/components/coach/CoachFrame";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "visualViewport");
});

describe("coach shell layout", () => {
  it("keeps the same composer node through restore, typing, and an in-flight turn", () => {
    // The page composer is gone (the dock is the one ask field); the slot now just holds the
    // history chip and the send toast, but CoachFrame itself still owes it one stable node.
    const composer = (busy: boolean) => <div data-testid="coach-composer" aria-busy={busy} />;
    const view = render(<CoachFrame transcript={<p>Restoring</p>} composer={composer(true)} />);
    const original = view.getByTestId("coach-composer");

    view.rerender(<CoachFrame transcript={<p>Typing</p>} composer={composer(true)} />);
    expect(view.getByTestId("coach-composer")).toBe(original);
    view.rerender(<CoachFrame transcript={<p>Waiting for reply</p>} composer={composer(true)} />);
    expect(view.getByTestId("coach-composer")).toBe(original);
    view.rerender(<CoachFrame transcript={<p>Ready</p>} composer={composer(false)} />);
    expect(view.getByTestId("coach-composer")).toBe(original);
  });

  it("clears the dock's folded height plus its full attach-tray growth, not just the bubble", () => {
    // The page's own composer used to sit between the transcript and the dock, absorbing most of
    // the tray's upward growth; with it gone, the transcript's last message is the thing the tray
    // would cover, so the clearance has to account for TRAY_OPEN itself (Scan and Weigh-in now
    // live there), not just the dock's folded bubble height.
    const view = render(<CoachFrame transcript={<div />} composer={<div />} />);
    const shell = view.getByTestId("coach-shell");
    expect(RESTING_CLEARANCE).toContain(`max(${TRAY_OPEN}px, var(--dock-height, 0px)) + ${DOCK_BOTTOM_OFFSET + 12}px`);
    expect(shell.style.paddingBottom).toBe(RESTING_CLEARANCE);
  });

  it("is fixed to the screen, so the body's dock padding never scrolls the page under it", () => {
    const view = render(<CoachFrame transcript={<div />} composer={<div />} />);
    expect(view.getByTestId("coach-shell").style.position).toBe("fixed");
    view.rerender(<CoachFrame fill="parent" transcript={<div />} composer={<div />} />);
    expect(view.getByTestId("coach-shell").style.position).toBe("");
  });

  it("updates the visual viewport height on resize", () => {
    const listeners = new Map<string, EventListener>();
    const viewport = {
      height: 700,
      offsetTop: 4,
      addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    const view = render(<CoachFrame transcript={<div />} composer={<div />} />);
    const shell = view.getByTestId("coach-shell");
    expect(shell.style.getPropertyValue("--visual-viewport-height")).toBe("700px");
    expect(shell.style.getPropertyValue("--visual-viewport-offset-top")).toBe("4px");

    viewport.height = 612;
    act(() => listeners.get("resize")?.(new Event("resize")));
    expect(shell.style.getPropertyValue("--visual-viewport-height")).toBe("612px");
    // The raised dock still sits over the frame's foot, so its live height stays clear.
    expect(shell.style.paddingBottom).toBe(KEYBOARD_CLEARANCE);
  });

  it("uses chronological column layout and never column-reverse", () => {
    const { container, getByTestId } = render(<CoachFrame transcript={<div />} composer={<div />} />);
    const shell = getByTestId("coach-shell");

    expect(shell.style.flexDirection).toBe("column");
    expect(container.innerHTML).not.toContain("column-reverse");
  });

  it("only mounts shell header chrome when the header slot is populated", () => {
    const view = render(<CoachFrame transcript={<div />} composer={<div />} />);
    expect(view.container.querySelector("header")).toBeNull();

    view.rerender(<CoachFrame header={<span>Back</span>} transcript={<div />} composer={<div />} />);
    expect(view.getByText("Back").closest("header")).not.toBeNull();
  });
});
