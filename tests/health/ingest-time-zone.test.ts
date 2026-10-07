import { describe, expect, it, vi } from "vitest";
import { applyIngest } from "@/lib/server/health-ingest";

const now = new Date("2026-09-20T14:00:00Z");

function admin(context: { source_time_zone: string | null; user_time_zone: string | null }) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "health_ingest_time_zone_context") return { data: [context], error: null };
    if (name === "set_health_source_time_zone") return { data: null, error: null };
    if (name === "health_ingest_event") return { data: [{ id: "event-1", is_new: true }], error: null };
    if (name === "health_ingest_apply") {
      return { data: [{ accepted: (args.p_samples as unknown[]).length, updated: 0, skipped: 0 }],
        error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
  return { value: { rpc } as never, rpc };
}

describe("ingest timezone boundary", () => {
  it("applies a valid Shortcut envelope when updating the source time zone fails", async () => {
    const failure = { code: "XX000", message: "database unavailable" };
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "set_health_source_time_zone") return { data: null, error: failure };
      if (name === "health_ingest_event") {
        return { data: [{ id: "event-1", is_new: true }], error: null };
      }
      if (name === "health_ingest_apply") {
        return { data: [{ accepted: (args.p_samples as unknown[]).length, updated: 0, skipped: 0 }],
          error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const db = { value: { rpc } as never, rpc };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = { source_kind: "apple_health_shortcut", sent_at: "2026-09-20T08:00:00-06:00",
      tz: "America/Denver", samples: [{ type: "step_count", value: 1000, unit: "count",
        start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00" }] };

    try {
      await expect(applyIngest(db.value, { id: "source-1", userId: "user-1",
        kind: "apple_health_shortcut" }, body, now)).resolves.toMatchObject({
        status: "applied", accepted: 1,
      });
      const apply = db.rpc.mock.calls.find(([name]) => name === "health_ingest_apply")![1];
      expect((apply.p_samples as Array<{ tz: string }>)[0].tz).toBe("America/Denver");
      expect(logged).toHaveBeenCalledWith("health source time zone update failed", {
        sourceId: "source-1", error: failure,
      });
    } finally {
      logged.mockRestore();
    }
  });

  it("rejects an invalid Shortcut time zone with 422", async () => {
    const db = admin({ source_time_zone: null, user_time_zone: null });
    const body = { source_kind: "apple_health_shortcut", sent_at: "2026-09-20T08:00:00-06:00",
      tz: "Mars/Olympus_Mons", samples: [] };

    await expect(applyIngest(db.value, { id: "source-1", userId: "user-1",
      kind: "apple_health_shortcut" }, body, now))
      .rejects.toMatchObject({ status: 422, code: "invalid_time_zone" });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("treats Shortcut tz as authoritative and stores it as the source's last-seen zone", async () => {
    const db = admin({ source_time_zone: "America/New_York", user_time_zone: "America/Chicago" });
    const body = { source_kind: "apple_health_shortcut", sent_at: "2026-09-20T08:00:00-06:00",
      tz: "America/Denver", samples: [{ type: "step_count", value: 1000, unit: "count",
        start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00",
        vendor_sample_id: "shortcut:step_count:2026-09-19",
        vendor_updated_at: "2026-09-20T08:00:00-06:00" }] };
    await applyIngest(db.value, { id: "source-1", userId: "user-1",
      kind: "apple_health_shortcut" }, body, now);
    expect(db.rpc).toHaveBeenCalledWith("set_health_source_time_zone", {
      p_user_id: "user-1", p_source_id: "source-1", p_time_zone: "America/Denver",
    });
    const apply = db.rpc.mock.calls.find(([name]) => name === "health_ingest_apply")![1];
    expect((apply.p_samples as Array<{ tz: string }>)[0].tz).toBe("America/Denver");
  });

  it("uses the user zone for HAE when its source has no zone", async () => {
    const db = admin({ source_time_zone: null, user_time_zone: "America/Denver" });
    const body = { data: { metrics: [{ name: "step_count", units: "count", data: [
      { date: "2026-09-19 00:00:00 -0600", qty: 6200, source: "Apple Watch" },
    ] }] } };
    await applyIngest(db.value, { id: "source-1", userId: "user-1",
      kind: "health_auto_export" }, body, now);
    expect(db.rpc).toHaveBeenCalledWith("health_ingest_time_zone_context", {
      p_user_id: "user-1", p_source_id: "source-1",
    });
    const apply = db.rpc.mock.calls.find(([name]) => name === "health_ingest_apply")![1];
    expect((apply.p_samples as Array<{ tz: string }>)[0].tz).toBe("America/Denver");
  });

  it("accepts a seven-day HAE correction window and rejects a nine-day sample", async () => {
    const db = admin({ source_time_zone: "UTC", user_time_zone: null });
    const rows = [
      { date: "2026-09-13 14:00:00 +0000", qty: 6200, source: "Apple Watch" },
      { date: "2026-09-11 13:59:59 +0000", qty: 6100, source: "Apple Watch" },
    ];
    const out = await applyIngest(db.value, { id: "source-1", userId: "user-1",
      kind: "health_auto_export" }, { data: { metrics: [
      { name: "step_count", units: "count", data: rows },
    ] } }, now);
    expect(out.accepted).toBe(1);
    expect(out.rejected).toEqual([{ index: 1, reason: "sample outside the 8-day freshness window" }]);
  });
});
