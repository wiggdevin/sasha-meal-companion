/** [needs local Docker] — real HTTP route, token lookup, RPCs, correction, and source-zone update. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminClient, createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import { issueSourceToken } from "@/lib/server/health-tokens";
import { applyIngest } from "@/lib/server/health-ingest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { toBytea } from "@/lib/server/tokens";
import { POST } from "@/app/api/health/ingest/route";

describe.skipIf(!HAS_BRANCH)("local POST /api/health/ingest", () => {
  const admin = HAS_BRANCH ? adminClient() : null;
  let userId = "";
  let sourceId = "";
  let connectionCode = "";
  let haeSourceId = "";

  beforeAll(async () => {
    const users = await createTestUsers();
    userId = users.a.userId;
    await resetUser(userId);
    const issued = issueSourceToken();
    connectionCode = issued.raw;
    const { data, error } = await admin!.from("health_sources").insert({
      user_id: userId, kind: "apple_health_shortcut", device_label: "Shortcut",
      token_hash: toBytea(issued.hash), time_zone: "America/Chicago",
    }).select("id").single();
    if (error) throw error;
    sourceId = data.id;
    const hae = await admin!.from("health_sources").insert({
      user_id: userId, kind: "health_auto_export", device_label: "Health Auto Export",
      time_zone: "UTC",
    }).select("id").single();
    if (hae.error) throw hae.error;
    haeSourceId = hae.data.id;
  });

  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
  });

  const request = (value: number, vendorUpdatedAt: string) => {
    const sentAt = new Date().toISOString();
    return new Request("http://localhost/api/health/ingest", { method: "POST", headers: {
      authorization: `Bearer ${connectionCode}`, "content-type": "application/json",
      "x-real-ip": "127.0.0.1",
    }, body: JSON.stringify({
      source_kind: "apple_health_shortcut", sent_at: sentAt, tz: "America/Denver",
      samples: [{ type: "step_count", value, unit: "count",
        start_time: "2026-09-19T00:00:00-06:00", end_time: "2026-09-20T00:00:00-06:00",
        vendor_sample_id: "shortcut:step_count:2026-09-19",
        vendor_updated_at: vendorUpdatedAt, device_label: "Apple Watch" }],
    }) });
  };

  it("applies the exact Shortcut shape, then lets the newer daily correction win", async () => {
    const first = await POST(request(6241, "2026-09-20T08:15:00-06:00"));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: "applied", accepted: 1 });

    const correction = await POST(request(6300, "2026-09-20T08:16:00-06:00"));
    expect(correction.status).toBe(200);
    await expect(correction.json()).resolves.toMatchObject({ status: "applied", updated: 1 });

    const sample = await admin!.from("health_samples").select("value, tz")
      .eq("source_id", sourceId).eq("vendor_sample_id", "shortcut:step_count:2026-09-19")
      .single();
    expect(sample.error).toBeNull();
    expect(Number(sample.data!.value)).toBe(6300);
    expect(sample.data!.tz).toBe("America/Denver");
    const source = await admin!.from("health_sources").select("time_zone").eq("id", sourceId).single();
    expect(source.data?.time_zone).toBe("America/Denver");
  });

  it("keeps one HAE row per source/type/local-day and lets the newer receipt win", async () => {
    const firstAt = new Date();
    const localDay = new Date(firstAt.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    const body = (value: number) => ({ data: { metrics: [{ name: "step_count", units: "count",
      data: [{ date: `${localDay} 00:00:00 +0000`, qty: value, source: "Apple Watch" }],
    }] } });
    const source = { id: haeSourceId, userId, kind: "health_auto_export" };
    await expect(applyIngest(admin!, source, body(6100), firstAt)).resolves
      .toMatchObject({ accepted: 1, updated: 0 });
    await expect(applyIngest(admin!, source, body(6300),
      new Date(firstAt.getTime() + 1_000))).resolves.toMatchObject({ accepted: 0, updated: 1 });
    const rows = await admin!.from("health_samples").select("value, vendor_sample_id")
      .eq("source_id", haeSourceId).eq("vendor_sample_id", `hae:step_count:${localDay}`);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(1);
    expect(Number(rows.data![0].value)).toBe(6300);
  });
});
