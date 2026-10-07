import { describe, expect, it } from "vitest";
import { appleHealthConnectionState } from "@/lib/health-client";
import type { DailyHealthResponse } from "@/lib/health/contract";

type Source = DailyHealthResponse["sources"][number];
const source = (kind: Source["kind"], overrides: Partial<Source> = {}): Source => ({
  id: "apple-1", kind, device_label: "Apple source",
  last_received_at: null, revoked: false, ...overrides,
});
const NOW = new Date("2026-09-20T12:00:00Z");

describe("Apple Health connection row", () => {
  for (const kind of ["apple_health_shortcut", "health_auto_export"] as const) {
    it(`shows all four states at the 36-hour boundary for ${kind}`, () => {
      expect(appleHealthConnectionState([], false, NOW)).toEqual({
        status: "Not set up", detail: null, action: "Connect", hasActiveSource: false,
      });
      expect(appleHealthConnectionState([source(kind)], false, NOW)).toEqual({
        status: "Setup started · waiting for first sync", detail: null, action: "Manage",
        hasActiveSource: true,
      });
      expect(appleHealthConnectionState([
        source(kind, { last_received_at: "2026-09-19T00:00:00Z" }),
      ], false, NOW)).toEqual({
        status: "Syncing · last received 36 h ago", detail: null, action: "Manage",
        hasActiveSource: true,
      });
      expect(appleHealthConnectionState([
        source(kind, { last_received_at: "2026-09-18T23:59:00Z" }),
      ], false, NOW)).toEqual({
        status: "Needs attention · last received 36 h ago",
        detail: "Open your Shortcut or exporter and run it once.", action: "Manage",
        hasActiveSource: true,
      });
    });
  }

  it("excludes revoked and non-Apple sources and fails closed when ingest is disabled", () => {
    expect(appleHealthConnectionState([
      source("apple_health_shortcut", {
        revoked: true, last_received_at: "2026-09-20T11:59:00Z",
      }),
      source("oura", { id: "oura", last_received_at: "2026-09-20T11:59:00Z" }),
    ], false, NOW).status).toBe("Not set up");
    expect(appleHealthConnectionState([source("apple_health_shortcut")], true, NOW).status)
      .toBe("Not available yet");
  });
});
