import { describe, expect, it } from "vitest";
import { menuShift } from "@/components/DayTypeMenu";

/** UI audit 2026-10-18 §5: the day-type menu hung from the chip ran off the left of small phones. */
describe("menuShift", () => {
  it("moves the menu right so it keeps a 16 px gutter on a 320-390 px phone", () => {
    // The chip's right edge sits about 118 px in from the content edge.
    for (const width of [320, 375, 390]) {
      const anchorRight = width - 16 - 118;
      const menu = Math.min(256, width - 32);
      const shift = menuShift(anchorRight, menu, width);
      expect(anchorRight + shift - menu).toBeGreaterThanOrEqual(16);
      expect(anchorRight + shift).toBeLessThanOrEqual(width - 16);
    }
  });

  it("leaves a menu that already fits where it is", () => {
    expect(menuShift(400, 256, 430)).toBe(0);
  });

  it("pulls a menu back inside the right gutter", () => {
    expect(menuShift(425, 256, 430)).toBe(-11);
  });
});
