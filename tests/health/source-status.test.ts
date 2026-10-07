import { describe, expect, it, vi } from "vitest";
import { listSources } from "@/lib/server/health-daily";

function client(rows: unknown[]) {
  const eq = vi.fn().mockResolvedValue({ data: rows, error: null });
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { value: { from } as never, from, select, eq };
}

describe("health source status read", () => {
  it("reads one status row per source so a noisy source cannot hide an older source", async () => {
    const db = client([
      { id: "noisy", kind: "health_auto_export", device_label: "Phone", revoked_at: null,
        last_received_at: "2026-09-20T12:00:00Z" },
      { id: "older", kind: "apple_health_shortcut", device_label: "Shortcut", revoked_at: null,
        last_received_at: "2026-09-10T12:00:00Z" },
    ]);
    await expect(listSources(db.value, "user-1")).resolves.toEqual([
      { id: "noisy", kind: "health_auto_export", device_label: "Phone", revoked: false,
        last_received_at: "2026-09-20T12:00:00Z" },
      { id: "older", kind: "apple_health_shortcut", device_label: "Shortcut", revoked: false,
        last_received_at: "2026-09-10T12:00:00Z" },
    ]);
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(db.from).toHaveBeenCalledWith("health_source_status");
  });
});
