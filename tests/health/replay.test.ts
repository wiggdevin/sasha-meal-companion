import { describe, expect, it } from "vitest";
import { REPLAY_WINDOW_MS, withinReplayWindow } from "@/lib/health/replay";

const now = new Date("2026-09-15T14:00:00Z");

describe("withinReplayWindow", () => {
  it("defaults to the ten-minute window", () => {
    expect(REPLAY_WINDOW_MS).toBe(600_000);
  });

  it("accepts a timestamp inside ten minutes, in either direction", () => {
    expect(withinReplayWindow("2026-09-15T13:55:00Z", now)).toBe(true);
    expect(withinReplayWindow("2026-09-15T14:05:00Z", now)).toBe(true);
  });

  it("accepts the boundary exactly", () => {
    expect(withinReplayWindow("2026-09-15T13:50:00Z", now)).toBe(true);
  });

  it("rejects thirty minutes old — spec acceptance criterion 3", () => {
    expect(withinReplayWindow("2026-09-15T13:30:00Z", now)).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(withinReplayWindow("soon", now)).toBe(false);
  });

  it("honours an explicit window", () => {
    expect(withinReplayWindow("2026-09-15T13:30:00Z", now, 3_600_000)).toBe(true);
  });
});
