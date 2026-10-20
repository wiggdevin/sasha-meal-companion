import { describe, expect, it } from "vitest";
import { sectionFor } from "./section";

describe("sectionFor", () => {
  it("maps each tab root to its section hue", () => {
    expect(sectionFor("/")).toBe("today");
    expect(sectionFor("/body")).toBe("body");
    expect(sectionFor("/foods")).toBe("foods");
    expect(sectionFor("/coach")).toBe("coach");
    expect(sectionFor("/settings")).toBe("settings");
  });

  it("keeps a sub-route in its section", () => {
    expect(sectionFor("/foods/123")).toBe("foods");
    expect(sectionFor("/settings/targets")).toBe("settings");
  });

  it("folds recipes and scan into foods, onboarding into settings and week into today", () => {
    expect(sectionFor("/recipes")).toBe("foods");
    expect(sectionFor("/scan")).toBe("foods");
    expect(sectionFor("/week")).toBe("today");
    expect(sectionFor("/onboarding")).toBe("settings");
  });

  it("falls back to today for anything else", () => {
    expect(sectionFor("/sign-in")).toBe("today");
    expect(sectionFor("/foodsy")).toBe("today");
  });
});
