// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import TipDemo from "./TipDemo";
import { APP_TIPS, type TipDemoKey } from "@/lib/today/board";

afterEach(cleanup);

const KINDS = APP_TIPS.map((tip) => tip.demo) as TipDemoKey[];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(kind: TipDemoKey, reduced: boolean) {
  const demo = <TipDemo kind={kind} />;
  return render(reduced ? <MotionConfig reducedMotion="always">{demo}</MotionConfig> : demo);
}

describe("TipDemo", () => {
  it.each(KINDS)("draws the %s demonstration with a fingertip, hidden from assistive tech", (kind) => {
    const { container } = mount(kind, false);
    const svg = container.querySelector<SVGElement>(`svg[data-demo="${kind}"]`)!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.hasAttribute("data-still")).toBe(false);
    expect(svg.querySelector("[data-finger]")).not.toBeNull();
  });

  it.each(KINDS)("holds the %s demonstration on one still frame under reduced motion", async (kind) => {
    const { container } = mount(kind, true);
    const svg = container.querySelector<SVGElement>(`svg[data-demo="${kind}"]`)!;
    expect(svg.getAttribute("data-still")).toBe("true");
    const frame = () => [...svg.querySelectorAll<SVGElement>("[style]")].map((el) => el.getAttribute("style")).join("|");
    const before = frame();
    await pause(120);
    expect(frame()).toBe(before);
  });
});
