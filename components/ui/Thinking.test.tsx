// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduce,
}));

import Thinking, { THINKING_HINT, THINKING_HINT_MS } from "@/components/ui/Thinking";

beforeEach(() => { vi.useFakeTimers(); motion.reduce = false; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Thinking", () => {
  it("shows its label in a polite live region", () => {
    render(<Thinking label="Finding meal ideas…" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Finding meal ideas…");
    expect(status.getAttribute("data-thinking")).toBe("inline");
  });

  it("draws three orbs under a goo filter, hidden from assistive tech", () => {
    const { container } = render(<Thinking label="Reading your photo…" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("circle")).toHaveLength(3);
    const filter = svg.querySelector("filter")!;
    expect(svg.querySelector("g[filter]")!.getAttribute("filter")).toBe(`url(#${filter.id})`);
  });

  it("adds the still-working hint only once the wait runs long", () => {
    render(<Thinking label="Reading that recipe…" />);
    expect(THINKING_HINT_MS).toBe(6000);
    act(() => { vi.advanceTimersByTime(THINKING_HINT_MS - 1); });
    expect(screen.queryByText(THINKING_HINT)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText(THINKING_HINT)).toBeTruthy();
    // Inline keeps the label and adds the hint under it, inside the same live region.
    expect(screen.getByRole("status").textContent).toBe(`Reading that recipe…${THINKING_HINT}`);
  });

  it("swaps the label for the hint in the compact size, so the line never grows", () => {
    render(<Thinking size="compact" label="Applying…" hint="Still working…" />);
    act(() => { vi.advanceTimersByTime(THINKING_HINT_MS); });
    expect(screen.getByRole("status").textContent).toBe("Still working…");
  });

  it("keeps the label alone when the hint is switched off", () => {
    render(<Thinking label="Thinking…" hint={false} />);
    act(() => { vi.advanceTimersByTime(THINKING_HINT_MS * 2); });
    expect(screen.getByRole("status").textContent).toBe("Thinking…");
  });

  it("leaves the announcing to a parent live region when asked", () => {
    render(<span role="status"><Thinking size="compact" label="Applying…" announce={false} /></span>);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Applying…");
  });

  it("becomes one calm dot and still words under reduced motion", () => {
    motion.reduce = true;
    const { container } = render(<Thinking label="Finding meal ideas…" />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-motion")).toBe("reduced");
    expect(container.querySelector("svg")).toBeNull();
    expect(status.textContent).toBe("Finding meal ideas…");
  });
});
