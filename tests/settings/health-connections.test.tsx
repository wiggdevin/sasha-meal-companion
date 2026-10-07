import { describe, expect, it } from "vitest";
import { healthConnectionStatus } from "@/components/settings/HealthConnectionsSection";
import type { DailyHealthResponse } from "@/lib/health/contract";

type Source = DailyHealthResponse["sources"][number];

const source = (overrides: Partial<Source> = {}): Source => ({
  id: "oura-1",
  kind: "oura",
  device_label: "Oura Ring",
  last_received_at: null,
  revoked: false,
  ...overrides,
});

describe("healthConnectionStatus", () => {
  it("shows Not available yet when health ingest is disabled", () => {
    expect(healthConnectionStatus("oura", [source()], true)).toBe("Not available yet");
  });

  it("shows Not linked when no active source exists", () => {
    expect(healthConnectionStatus("oura", [source({ revoked: true })], false)).toBe("Not linked");
  });

  it("shows Linked and waits for the first sync when the active source has no receipt", () => {
    expect(healthConnectionStatus("oura", [source()], false)).toBe(
      "Linked · waiting for first sync",
    );
  });

  it("shows the latest active source receipt as a relative sync time", () => {
    const sources = [
      source({ id: "old", last_received_at: "2026-09-20T10:00:00.000Z" }),
      source({ id: "new", last_received_at: "2026-09-20T11:30:00.000Z" }),
    ];
    expect(healthConnectionStatus("oura", sources, false, new Date("2026-09-20T12:00:00.000Z")))
      .toBe("Linked · last sync 30 min ago");
  });
});
