// @vitest-environment jsdom
/**
 * Sound off holds for every sound in the well (the award player, the shop's chime), even in a private
 * window where storage refuses (Sol r2 on the shop, 2026-10-07).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMuted, writeMuted } from "./sound";

afterEach(() => { vi.restoreAllMocks(); writeMuted(false); window.localStorage.clear(); });

describe("Sound off", () => {
  it("is remembered on the device", () => {
    writeMuted(true);
    expect(window.localStorage.getItem("care:sound-muted")).toBe("1");
    expect(readMuted()).toBe(true);
  });

  it("holds for this visit when storage refuses", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("private window"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("private window"); });
    expect(readMuted()).toBe(false);
    writeMuted(true);
    expect(readMuted()).toBe(true);
    writeMuted(false);
    expect(readMuted()).toBe(false);
  });
});
