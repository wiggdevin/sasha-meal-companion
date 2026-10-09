// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TipTile, { TipFace } from "./TipTile";
import { APP_TIPS, boardTips, type BoardTip } from "@/lib/today/board";

afterEach(cleanup);

function mount(tips: BoardTip[] = APP_TIPS, onOpen?: (tip: BoardTip, from: HTMLElement) => void) {
  return render(<TipTile tips={tips} onOpen={onOpen} />);
}

/** Board redesign v4 (brief §5 Tier 3): the tip is a plain 44 px row that opens its full view. */
describe("TipTile", () => {
  it("shows one line, the headline, with a glyph and a chevron, never the steps", () => {
    const { container } = mount(APP_TIPS, () => {});
    const [first] = APP_TIPS;
    const row = screen.getByRole("button", { name: `Open tip: ${first.title}` });
    expect(row.textContent).toBe(first.title);
    expect(row.querySelectorAll("svg")).toHaveLength(2);
    for (const step of first.steps) expect(container.textContent).not.toContain(step);
    expect(container.textContent).not.toContain(first.text);
  });

  it("uses the summary as its line for a tip without a headline", () => {
    mount([{ id: "plain", source: "app", text: "Just a line." }], () => {});
    expect(screen.getByRole("button", { name: "Open tip: Just a line." })).toBeTruthy();
  });

  it("opens the tip on show from the whole row", () => {
    const onOpen = vi.fn();
    mount(APP_TIPS, onOpen);
    const open = screen.getByRole("button", { name: `Open tip: ${APP_TIPS[0].title}` });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(APP_TIPS[0], open);
  });

  it("has no open control when nothing can open it, and still says the tip", () => {
    const { container } = mount();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toContain(`Tip: ${APP_TIPS[0].title}`);
  });

  it("has no paging: no Next button and no dots", () => {
    const { container } = mount(APP_TIPS, () => {});
    expect(screen.queryByRole("button", { name: "Next tip" })).toBeNull();
    expect(container.querySelector("[data-current]")).toBeNull();
  });

  it("keeps the tip it shows when the tips reorder (UI audit 2026-10-07)", () => {
    const [a, b, c] = APP_TIPS;
    const { rerender } = mount([a, b, c], () => {});
    rerender(<TipTile tips={[b, c, a]} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: `Open tip: ${a.title}` })).toBeTruthy();
    // A shown tip that leaves the list falls back to the first.
    rerender(<TipTile tips={[c, b]} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: `Open tip: ${c.title}` })).toBeTruthy();
  });

  it("names a coach tip as the coach's", () => {
    mount(boardTips([{ id: "coach-1", source: "coach", text: "A note from your coach." }]), () => {});
    const row = screen.getByRole("button", { name: "Open tip: A note from your coach." });
    expect(row.textContent).toContain("Coach");
  });

  it("draws nothing for no tips", () => {
    const { container } = mount([]);
    expect(container.firstChild).toBeNull();
  });

  it("draws the full view's face as the same row, with no control in it", () => {
    const { container } = render(<div><TipFace tips={APP_TIPS} index={1} /></div>);
    expect(container.textContent).toBe(APP_TIPS[1].title);
    expect(container.querySelector("button")).toBeNull();
  });
});
