import { describe, expect, it } from "vitest";
import { capState, hardCap, softCap } from "@/lib/ai/spend";

describe("capState", () => {
  it("is ok below the soft cap", () => expect(capState(29, 30, 100)).toBe("ok"));
  it("warns at the soft cap and above", () => {
    expect(capState(30, 30, 100)).toBe("warn");
    expect(capState(99, 30, 100)).toBe("warn");
  });
  it("blocks at the hard cap and above", () => {
    expect(capState(100, 30, 100)).toBe("blocked");
    expect(capState(101, 30, 100)).toBe("blocked");
  });
  it("blocks everything when the hard cap is 0", () => {
    expect(capState(0, 30, 0)).toBe("blocked");
  });
  it("never warns when the soft cap is 0 or below", () => {
    expect(capState(50, 0, 100)).toBe("ok");
  });
});

describe("cap readers", () => {
  it("default to 30 and 100", () => {
    expect(softCap({})).toBe(30);
    expect(hardCap({})).toBe(100);
  });
  it("read the env names from contracts §6", () => {
    expect(softCap({ CAPTURE_DAILY_SOFT_CAP: "5" })).toBe(5);
    expect(hardCap({ CAPTURE_DAILY_HARD_CAP: "0" })).toBe(0);
  });
  it("fall back to the default on an unparseable value rather than reading NaN", () => {
    expect(hardCap({ CAPTURE_DAILY_HARD_CAP: "lots" })).toBe(100);
  });
});
