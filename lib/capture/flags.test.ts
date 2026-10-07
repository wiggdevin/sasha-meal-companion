import { afterEach, describe, expect, it, vi } from "vitest";
import { enabledMethods, isMethodEnabled } from "./flags";

afterEach(() => vi.unstubAllEnvs());

describe("enabledMethods", () => {
  it("returns [] for an empty value — unset and empty are the same absence", () => {
    expect(enabledMethods("")).toEqual([]);
  });

  it("trims, lowercases, and keeps the canonical order", () => {
    expect(enabledMethods("text, Photo")).toEqual(["text", "photo"]);
  });

  it("drops unknown values", () => {
    expect(enabledMethods("text,barcode,voice")).toEqual(["text", "voice"]);
  });

  it("dedupes repeated values", () => {
    expect(enabledMethods("text,text,voice")).toEqual(["text", "voice"]);
  });

  it("falls back to the public twin only when given no raw value of its own", () => {
    vi.stubEnv("NEXT_PUBLIC_CAPTURE_METHODS", "label,voice");
    expect(enabledMethods()).toEqual(["voice", "label"]);
  });

  it("prefers the server's CAPTURE_METHODS over the public twin when both are set", () => {
    vi.stubEnv("CAPTURE_METHODS", "text");
    vi.stubEnv("NEXT_PUBLIC_CAPTURE_METHODS", "photo");
    expect(enabledMethods()).toEqual(["text"]);
  });

  it("defaults to process.env when no env argument is given", () => {
    expect(Array.isArray(enabledMethods())).toBe(true);
  });
});

describe("isMethodEnabled", () => {
  it("is true when the method is in the enabled list", () => {
    expect(isMethodEnabled("text", "text,voice")).toBe(true);
  });

  it("is false when the method is absent", () => {
    expect(isMethodEnabled("photo", "text,voice")).toBe(false);
  });

  it("is false when nothing is enabled", () => {
    expect(isMethodEnabled("text", "")).toBe(false);
  });
});
