import { describe, expect, it } from "vitest";
import { CLEAR_AT, DELETE_AT, swipeStage, swipeTravel, trayStrength } from "@/lib/today/swipe-detents";

describe("the meal card's left swipe", () => {
  it("follows the finger until Clear is fully shown, then catches", () => {
    expect(swipeTravel(50, 360)).toBe(50);
    expect(swipeTravel(CLEAR_AT, 360)).toBe(CLEAR_AT);
    // 30 px more finger travel barely moves the card: the sticky catch.
    expect(swipeTravel(CLEAR_AT + 30, 360) - CLEAR_AT).toBeLessThan(8);
  });

  it("catches again where Delete is fully shown, and never passes the card's width", () => {
    const atDelete = [...Array(400).keys()].find((d) => swipeTravel(d, 360) >= DELETE_AT)!;
    expect(swipeTravel(atDelete + 40, 360) - DELETE_AT).toBeLessThan(12);
    expect(swipeTravel(2000, 360)).toBe(360);
  });

  it("rises one stage at each catch and when a release would delete", () => {
    expect([0, 79, 80, 188, 189, 260, 261].map((d) => swipeStage(d, 300))).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });

  it("deepens Clear first, then Delete, from faint to full", () => {
    expect(trayStrength(0)).toEqual({ clear: 0, del: 0 });
    expect(trayStrength(40)).toEqual({ clear: 0.5, del: 0 });
    expect(trayStrength(120)).toEqual({ clear: 1, del: 0.5 });
    expect(trayStrength(400)).toEqual({ clear: 1, del: 1 });
  });
});
