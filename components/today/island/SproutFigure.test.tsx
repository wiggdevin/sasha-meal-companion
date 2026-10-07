// @vitest-environment jsdom
/**
 * SproutFigure (onboarding v2's guide): Sprout alone at any size, decorative unless named, with
 * hero-size art for every pose, including the wave.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { SPROUT_HERO_ART, SproutFigure } from "./Sprout";

afterEach(cleanup);

describe("SproutFigure", () => {
  it("has hero art on disk for every pose", () => {
    // public/ is resolved from this file, not the process's working directory.
    const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../../public");
    for (const path of Object.values(SPROUT_HERO_ART)) expect(existsSync(join(publicDir, path)), path).toBe(true);
    expect(Object.keys(SPROUT_HERO_ART).sort()).toEqual(["content", "droopy", "joyful", "listening", "pointing", "sleepy", "thinking", "wave"]);
  });

  it("is decorative by default and sized by its prop", () => {
    const { container } = render(<SproutFigure mood="wave" size={320} />);
    const figure = container.firstElementChild as HTMLElement;
    expect(figure.getAttribute("aria-hidden")).toBe("true");
    expect(figure.style.width).toBe("320px");
    expect(figure.style.height).toBe("320px");
    expect(figure.querySelector("img")?.getAttribute("src")).toContain("sprout-wave");
  });

  it("is one named image when given a label, and holds still under reduced motion", () => {
    render(<MotionConfig reducedMotion="always"><SproutFigure mood="joyful" label="Sprout waves hello" /></MotionConfig>);
    const figure = screen.getByRole("img", { name: "Sprout waves hello" });
    expect(figure.querySelector("[data-still]")).not.toBeNull();
  });
});
