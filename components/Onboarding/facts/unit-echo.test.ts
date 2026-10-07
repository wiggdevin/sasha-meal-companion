import { describe, expect, it } from "vitest";
import { birthYearEcho, heightEchoCm, weightEchoKg } from "@/components/Onboarding/facts/unit-echo";

describe("unit-echo", () => {
  it("echoes height as imperial then the stored metric value", () => {
    expect(heightEchoCm(178)).toBe("5'10\" → 178 cm");
  });

  it("echoes weight as imperial then the stored metric value", () => {
    expect(weightEchoKg(75)).toBe("165 lb → 75 kg");
  });

  it("always shows the heard age next to the mapped birth year, never the year alone", () => {
    expect(birthYearEcho(1992, new Date("2026-10-07T00:00:00.000Z"))).toBe("34 → born 1992");
  });
});
