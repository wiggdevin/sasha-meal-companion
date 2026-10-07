// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import PhosphorOrb from "@/components/PhosphorOrb";
import { fragmentSource, MAX_ORB_DPR, orbQuality, REFERENCE_WORK } from "@/lib/today/phosphor-orb";

afterEach(cleanup);

describe("phosphor orb quality", () => {
  it("draws every screen pixel up to 3x, but caps per-pixel work and frame rate on a phone", () => {
    const phone = orbQuality({ coarse: true, dpr: 3, cores: 6 });
    expect(phone.dpr).toBe(3);
    expect(orbQuality({ coarse: true, dpr: 4, cores: 6 }).dpr).toBe(MAX_ORB_DPR);
    expect(phone.fps).toBeLessThanOrEqual(30);
    expect(phone.steps * phone.twist).toBeLessThan(REFERENCE_WORK / 4);
    const desk = orbQuality({ coarse: false, dpr: 2, cores: 12 });
    expect(desk.dpr).toBe(2);
    expect(desk.steps * desk.twist).toBeLessThan(REFERENCE_WORK / 2);
  });

  it("builds a WebGL2 shader whose loop bounds come from the quality", () => {
    const source = fragmentSource(orbQuality({ coarse: true, dpr: 2, cores: 4 }));
    expect(source.startsWith("#version 300 es")).toBe(true);
    expect(source).toContain("#define STEPS 30");
    expect(source).not.toContain("8e1");
    expect(source).toMatch(/uniform vec3 uCore/);
    expect(source).toMatch(/uniform vec3 uFire/);
  });
});

describe("PhosphorOrb", () => {
  it("falls back to a static glow when WebGL2 is missing, and never draws more than one canvas", () => {
    const { container } = render(<PhosphorOrb active />);
    expect(container.querySelectorAll("canvas").length).toBeLessThanOrEqual(1);
    expect(container.querySelector("[data-orb-mode]")?.getAttribute("data-orb-mode")).toBe("fallback");
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});
