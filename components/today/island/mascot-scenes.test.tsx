// @vitest-environment jsdom
/**
 * Each companion in every scene (owner, 2026-10-07: "I picked blue to see its unique UI interactions but
 * all interactions are still with sprout"): the pond, swim, bucket, massage and award art are the chosen
 * companion's own, and what is said uses its name.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { MASCOT_KEYS, SCENE_POSES, named, sceneArt } from "./mascots";

const chosen = vi.hoisted(() => ({ mascot: "blueberry" }));
vi.mock("@/components/today/island/well-pet", () => ({ useMascot: () => chosen.mascot, MASCOT_EVENT: "companion-changed" }));
vi.mock("@/components/today/care/sound", () => ({
  play: vi.fn(), unlockAudio: vi.fn(), readMuted: () => true, silence: vi.fn(), writeMuted: vi.fn(),
}));
afterEach(cleanup);

describe("scene art for each companion", () => {
  it("keeps Sprout's first paths", () => {
    expect(sceneArt("sprout", "fishing")).toBe("/pet/scene/sprout-fishing.webp");
    expect(sceneArt("sprout", "massage-1")).toBe("/pet/care/massage-1.webp");
    expect(sceneArt("sprout", "bucket-pour")).toBe("/pet/water/sprout-bucket-pour.webp");
    expect(sceneArt("sprout", "award-workout-flex")).toBe("/pet/awards/sprout-workout-flex.webp");
  });

  it("has every pose drawn for every companion, so no scene falls back to Sprout", () => {
    const missing = MASCOT_KEYS.flatMap((mascot) => SCENE_POSES.map((pose) => sceneArt(mascot, pose)))
      .filter((src) => !existsSync(join(process.cwd(), "public", src)));
    expect(missing).toEqual([]);
  });

  it("says Sprout's lines with the chosen companion's name", () => {
    expect(named("Sprout's pond", "blueberry")).toBe("Blu's pond");
    expect(named("Sprout skips a pebble.", "mushroom")).toBe("Button skips a pebble.");
    expect(named("A sprout of moss. Sprout waves.", "peapod")).toBe("A sprout of moss. Pod waves.");
    expect(named("Sprout waves.", "sprout")).toBe("Sprout waves.");
  });
});

describe("the chosen companion in a care scene and the shop", () => {
  it("plays the massage with the companion's own art and words", async () => {
    const { default: CareScenePlayer } = await import("@/components/today/care/CareScenePlayer");
    const { container } = render(<MotionConfig reducedMotion="always"><CareScenePlayer scene="massage" onClose={() => {}} /></MotionConfig>);
    const srcs = [...container.querySelectorAll("img")].map((img) => decodeURIComponent(img.getAttribute("src") ?? ""));
    expect(srcs.some((src) => src.includes("/pet/mascots/blueberry/scene/massage-2.webp"))).toBe(true);
    expect(srcs.some((src) => src.includes("/pet/care/"))).toBe(false);
    expect(screen.getAllByText("Blu feels brand new.").length).toBeGreaterThan(0);
  });

  it("dresses only Sprout: another companion is drawn without Sprout's wearables", async () => {
    const { default: DressedSprout } = await import("@/components/today/care/shop/DressedSprout");
    const { container } = render(<MotionConfig reducedMotion="always">
      <DressedSprout wearing={{ head: "knitted-hat" }} mascot="blueberry" label="Blu" /></MotionConfig>);
    const srcs = [...container.querySelectorAll("img")].map((img) => decodeURIComponent(img.getAttribute("src") ?? ""));
    expect(srcs.some((src) => src.includes("/pet/mascots/blueberry/content.webp"))).toBe(true);
    expect(srcs.some((src) => src.includes("/pet/shop/"))).toBe(false);
  });
});
