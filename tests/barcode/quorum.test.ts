import { describe, expect, it } from "vitest";
import {
  acceptReading, isPersistentScanFailure, pruneHistory, SCAN_ERROR_THRESHOLD, type Reading,
} from "@/lib/barcode/quorum";

const read = (text: string, at: number): Reading => ({ text, format: "EAN-13", at });

describe("acceptReading", () => {
  it("refuses a single lucky read", () => {
    expect(acceptReading([], read("4006381333931", 1000))).toBeNull();
  });

  it("accepts the second identical read inside the window", () => {
    const history = [read("4006381333931", 1000)];
    expect(acceptReading(history, read("4006381333931", 1400))).toBe("4006381333931");
  });

  it("refuses when the earlier read is older than 1500 ms", () => {
    const history = [read("4006381333931", 1000)];
    expect(acceptReading(history, read("4006381333931", 2600))).toBeNull();
  });

  it("resets when a different text lands between two matches", () => {
    const history = [read("4006381333931", 1000), read("0036000291452", 1100)];
    expect(acceptReading(history, read("4006381333931", 1200))).toBeNull();
  });

  it("honours a higher quorum", () => {
    const history = [read("9", 1000), read("9", 1100)];
    expect(acceptReading(history, read("9", 1200), 3)).toBe("9");
    expect(acceptReading([read("9", 1000)], read("9", 1100), 3)).toBeNull();
  });
});

describe("isPersistentScanFailure", () => {
  it("stays false under the threshold and flips once it is reached", () => {
    expect(isPersistentScanFailure(SCAN_ERROR_THRESHOLD - 1)).toBe(false);
    expect(isPersistentScanFailure(SCAN_ERROR_THRESHOLD)).toBe(true);
    expect(isPersistentScanFailure(0)).toBe(false);
  });
});

describe("pruneHistory", () => {
  it("drops readings outside the window and caps the tail", () => {
    const history = [read("a", 100), read("b", 1900), read("c", 1950)];
    expect(pruneHistory(history, 2000)).toEqual([read("b", 1900), read("c", 1950)]);
    expect(pruneHistory([read("a", 1), read("b", 2), read("c", 3)], 3, 2))
      .toEqual([read("b", 2), read("c", 3)]);
  });
});
