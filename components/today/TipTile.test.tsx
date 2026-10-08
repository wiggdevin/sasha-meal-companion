// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import TipTile, { MAX_DOTS } from "./TipTile";
import { APP_TIPS, boardTips, type BoardTip } from "@/lib/today/board";

afterEach(cleanup);

function mount(tips: BoardTip[] = APP_TIPS, reduced = false, onOpen?: (tip: BoardTip, from: HTMLElement) => void) {
  const tile = <TipTile tips={tips} onOpen={onOpen} />;
  return render(reduced ? <MotionConfig reducedMotion="always">{tile}</MotionConfig> : tile);
}

const live = (container: HTMLElement) => container.querySelector<HTMLElement>('[aria-live="polite"]')!;
const slides = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('div[aria-hidden="true"] > div')];
const current = (container: HTMLElement) => container.querySelector<HTMLElement>("div[data-current]")!;
const dots = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("span[aria-hidden] > span")];

describe("TipTile", () => {
  it("shows the short form: a glyph, a headline and its one line, never the full steps", () => {
    const { container } = mount();
    const [first] = APP_TIPS;
    expect(current(container).textContent).toContain(first.title);
    expect(current(container).textContent).toContain(first.text);
    expect(current(container).querySelector("svg")).not.toBeNull();
    for (const step of first.steps) expect(container.textContent).not.toContain(step);
    const region = live(container);
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe(`Tip 1 of ${APP_TIPS.length}. ${first.title}. ${first.text}`);
    // The drawn stack is for the eye; the live region is what assistive tech reads.
    expect(current(container).closest("[aria-hidden]")).not.toBeNull();
  });

  it("opens the tip on show from anywhere on the tile, and Next only moves on", () => {
    const onOpen = vi.fn();
    mount(APP_TIPS, false, onOpen);
    fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
    expect(onOpen).not.toHaveBeenCalled();
    const open = screen.getByRole("button", { name: `Open tip: ${APP_TIPS[1].title}` });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(APP_TIPS[1], open);
  });

  it("has no open control when nothing can open it", () => {
    mount();
    expect(screen.queryByRole("button", { name: /^Open tip/ })).toBeNull();
  });

  it("moves on with a real, labelled Next button, its dot and its live region following", () => {
    const { container } = mount();
    const next = screen.getByRole("button", { name: "Next tip" });
    expect(next.getAttribute("aria-controls")).toBe(live(container).id);
    expect(dots(container)).toHaveLength(APP_TIPS.length);
    expect(dots(container).findIndex((dot) => dot.hasAttribute("data-current"))).toBe(0);
    fireEvent.click(next);
    const second = APP_TIPS[1];
    expect(live(container).textContent).toBe(`Tip 2 of ${APP_TIPS.length}. ${second.title}. ${second.text}`);
    expect(current(container).textContent).toContain(second.title);
    expect(dots(container).findIndex((dot) => dot.hasAttribute("data-current"))).toBe(1);
  });

  it("starts at the first tip it is given and wraps from the last back to it", () => {
    const { container } = mount();
    const next = screen.getByRole("button", { name: "Next tip" });
    for (let i = 1; i < APP_TIPS.length; i++) fireEvent.click(next);
    expect(live(container).textContent).toContain(`Tip ${APP_TIPS.length} of`);
    fireEvent.click(next);
    expect(live(container).textContent).toContain(`Tip 1 of ${APP_TIPS.length}.`);
  });

  it("keeps the tip it shows when the tips reorder, and moves on from there (UI audit 2026-10-07)", () => {
    const [a, b, c] = APP_TIPS;
    const { container, rerender } = mount([a, b, c]);
    expect(current(container).textContent).toContain(a.title);
    // A first cup drops the water tip's relevance: the board hands over a new order.
    rerender(<TipTile tips={[b, c, a]} />);
    expect(current(container).textContent).toContain(a.title);
    expect(live(container).textContent).toContain("Tip 3 of 3.");
    fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
    expect(current(container).textContent).toContain(b.title);
    // A shown tip that leaves the list falls back to the first.
    rerender(<TipTile tips={[c, a]} />);
    expect(current(container).textContent).toContain(c.title);
  });

  it("draws every tip in one place, so the tile never changes height between them", () => {
    const { container } = mount();
    expect(slides(container)).toHaveLength(APP_TIPS.length);
    expect(container.querySelectorAll("div[data-current]")).toHaveLength(1);
  });

  it("has neither dots nor a Next button for a single tip", () => {
    const { container } = mount([APP_TIPS[0]]);
    expect(screen.queryByRole("button", { name: "Next tip" })).toBeNull();
    expect(dots(container)).toHaveLength(0);
  });

  it("counts instead of drawing dots once there are too many to read", () => {
    const many = Array.from({ length: MAX_DOTS + 2 }, (_, i): BoardTip => ({ id: `t${i}`, source: "app", text: `Tip ${i}.` }));
    const { container } = mount(many);
    expect(dots(container)).toHaveLength(0);
    expect(container.textContent).toContain(`1/${many.length}`);
  });

  it("names a coach tip as the coach's", () => {
    const { container } = mount(boardTips([{ id: "coach-1", source: "coach", text: "A note from your coach." }]));
    expect(current(container).textContent).toContain("Coach");
    expect(live(container).textContent).toBe(`From your coach 1 of ${APP_TIPS.length + 1}. A note from your coach.`);
  });

  it("changes tip at once under reduced motion", async () => {
    const { container } = mount(APP_TIPS, true);
    const before = current(container);
    fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
    const after = current(container);
    expect(after).not.toBe(before);
    await waitFor(() => {
      expect(after.style.opacity).toBe("1");
      expect(before.style.opacity).toBe("0");
    }, { timeout: 200 });
  });
});
