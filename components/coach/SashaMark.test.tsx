// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (original) => ({
  ...await original<typeof import("motion/react")>(),
  useReducedMotion: () => motion.reduce,
}));
import SashaMark from "@/components/coach/SashaMark";

afterEach(() => { cleanup(); motion.reduce = false; });

/** U21 (2026-10-04): the living mark breathes at rest, speeds up while Sasha works, and is a still
 *  emblem under reduced motion. It is decoration: the transcript's thinking line announces. */
describe("the living mark", () => {
  it("is decorative and says when Sasha is working", () => {
    const { container, rerender } = render(<SashaMark />);
    const mark = container.firstElementChild!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.getAttribute("data-thinking")).toBeNull();
    expect(mark.querySelectorAll("circle")).toHaveLength(3);
    rerender(<SashaMark thinking />);
    expect(mark.getAttribute("data-thinking")).toBe("true");
  });

  it("holds still under reduced motion", () => {
    motion.reduce = true;
    const { container } = render(<SashaMark thinking />);
    expect(container.firstElementChild!.getAttribute("data-motion")).toBe("reduced");
  });
});
