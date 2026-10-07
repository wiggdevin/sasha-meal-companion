// @vitest-environment jsdom
/**
 * Choose your companion (owner, 2026-10-07): four companions, each with the same eight poses, a
 * stored value that falls back to Sprout, and a picker that says what it chose.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { useState } from "react";
import MascotPicker from "./MascotPicker";
import { MASCOTS, MASCOT_KEYS, mascotOf, type MascotKey } from "@/components/today/island/mascots";
import { SproutFigure } from "@/components/today/island/SproutFigure";

afterEach(cleanup);
// Vitest runs from the repository root.
const ROOT = process.cwd();

describe("the companions", () => {
  it("each have all eight poses, and every image is in public/", () => {
    expect(MASCOT_KEYS).toEqual(["sprout", "blueberry", "mushroom", "peapod"]);
    for (const key of MASCOT_KEYS) {
      const art = MASCOTS[key].art;
      expect(Object.keys(art).sort()).toEqual(["content", "droopy", "joyful", "listening", "pointing", "sleepy", "thinking", "wave"]);
      for (const src of Object.values(art)) expect(existsSync(join(ROOT, "public", src))).toBe(true);
    }
  });

  it("falls back to Sprout for a stored value it does not know (the column is free text)", () => {
    expect(mascotOf("blueberry").name).toBe("Blu");
    expect(mascotOf("dragon").key).toBe("sprout");
    expect(mascotOf(null).key).toBe("sprout");
  });

  it("describe themselves without a word about food, weight or what to do", () => {
    for (const key of MASCOT_KEYS) expect(MASCOTS[key].line).not.toMatch(/\b(eat|weight|calorie|should|must|diet)\b/i);
  });

  it("draw in SproutFigure by key", () => {
    const { container } = render(<SproutFigure mascot="mushroom" mood="wave" label="Button" />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("mascots%2Fmushroom%2Fwave");
  });
});

function Harness() {
  const [value, setValue] = useState<MascotKey>("sprout");
  return <MascotPicker value={value} onChange={setValue} />;
}

describe("MascotPicker", () => {
  it("chooses a companion, shows it large and says so", () => {
    render(<MotionConfig reducedMotion="always"><Harness /></MotionConfig>);
    expect(screen.getByRole("button", { name: "Sprout" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Blu" }));
    expect(screen.getByRole("button", { name: "Blu" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: "Blu" })).toBeTruthy();
    expect(screen.getByText("A round blueberry with rosy cheeks.")).toBeTruthy();
    expect(document.querySelector("[aria-live]")?.textContent).toBe("Blu is your companion now.");
  });
});
