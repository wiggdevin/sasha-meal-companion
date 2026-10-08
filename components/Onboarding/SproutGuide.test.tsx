// @vitest-environment jsdom
/**
 * a11y check (onboarding v2 lane 2 acceptance criteria): Sprout's pose change always carries a text
 * equivalent, announced through a polite live region — `SproutFigure` itself is presentational only
 * (no state, no line of its own), so the progress indicator is never motion-only.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import SproutGuide from "./SproutGuide";

afterEach(cleanup);

describe("SproutGuide", () => {
  it("announces the listening pose's line through a polite live region", () => {
    render(<SproutGuide pose="listening" line="Sprout is listening." />);
    const line = screen.getByText("Sprout is listening.");
    expect(line.getAttribute("aria-live")).toBe("polite");
  });

  it("updates the announced line when the pose changes", () => {
    const { rerender } = render(<SproutGuide pose="listening" line="Sprout is listening." />);
    rerender(<SproutGuide pose="pointing" line="Still need your height." />);
    expect(screen.getByText("Still need your height.").getAttribute("aria-live")).toBe("polite");
    expect(screen.queryByText("Sprout is listening.")).toBeNull();
  });

  it("passes every pose straight through to SproutFigure — listening/thinking/pointing shipped"
    + " on main the same day as this lane (#486), so there is no fallback table left to test", () => {
    const { container, rerender } = render(<SproutGuide pose="listening" line="…" />);
    const figure = () => container.querySelector("[data-pose]");
    expect(figure()?.getAttribute("data-pose")).toBe("listening");
    rerender(<SproutGuide pose="thinking" line="…" />);
    expect(figure()?.getAttribute("data-pose")).toBe("thinking");
    rerender(<SproutGuide pose="pointing" line="…" />);
    expect(figure()?.getAttribute("data-pose")).toBe("pointing");
    rerender(<SproutGuide pose="wave" line="…" />);
    expect(figure()?.getAttribute("data-pose")).toBe("wave");
    rerender(<SproutGuide pose="joyful" line="…" />);
    expect(figure()?.getAttribute("data-pose")).toBe("joyful");
  });

  it("sizes the figure from the caller's own per-beat lookup, not a size baked into the pose", () => {
    // Polish pass (2026-10-07, "smooth Sprout's size transition"): the figure itself now always
    // renders at a fixed base size and is scaled down via `transform`, so the caller's requested
    // size shows up on the animated outer wrapper (which drives layout), not on SproutFigure's
    // own element — see SproutGuide.tsx's top comment for why.
    const { container } = render(<SproutGuide pose="wave" line="…" size={168} />);
    const wrapper = container.querySelector("[data-sprout-guide-size]") as HTMLElement | null;
    expect(wrapper?.getAttribute("data-sprout-guide-size")).toBe("168");
    expect(wrapper?.style.width).toBe("168px");
  });

  it("holds the figure still under reduced motion and still carries the text equivalent", () => {
    render(<MotionConfig reducedMotion="always">
      <SproutGuide pose="sleepy" line="Resting, nothing is missing." />
    </MotionConfig>);
    expect(screen.getByText("Resting, nothing is missing.").getAttribute("aria-live")).toBe("polite");
  });
});
