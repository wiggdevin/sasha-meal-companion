import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { listSources, mergedDays } from "@/lib/server/health-daily";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/health-daily", () => ({ mergedDays: vi.fn(), listSources: vi.fn() }));

const { GET } = await import("@/app/api/health/daily/route");
const user = vi.mocked(requireUser);

function get(query: string): Request {
  return new Request(`https://app.test/api/health/daily${query}`);
}

describe("GET /api/health/daily", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    user.mockReset().mockResolvedValue({ userId: "user-1", client: {} as never });
    vi.mocked(mergedDays).mockResolvedValue([{ local_date: "2026-09-15", steps: 1300,
      active_kcal: 96, sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47,
      hrv_sdnn: 45, readiness_score: 78, sources: ["Apple Watch"], provenance: {} }]);
    vi.mocked(listSources).mockResolvedValue([{ id: "src-1", kind: "health_auto_export",
      device_label: "HAE", last_received_at: "2026-09-15T10:30:00Z", revoked: false }]);
  });

  it("503s when the flag is unset, so /body can render its empty state", async () => {
    vi.stubEnv("HEALTH_INGEST_ENABLED", "");
    expect((await GET(get("?from=2026-09-15&to=2026-09-15"))).status).toBe(503);
  });

  it("401s without a session", async () => {
    const { HttpError } = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
    user.mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await GET(get("?from=2026-09-15&to=2026-09-15"))).status).toBe(401);
  });

  it("400s a malformed or inverted range and 400s a window over 90 days", async () => {
    expect((await GET(get("?from=nope&to=2026-09-15"))).status).toBe(400);
    expect((await GET(get("?from=2026-09-15&to=2026-09-01"))).status).toBe(400);
    expect((await GET(get("?from=2026-01-01&to=2026-09-15"))).status).toBe(400);
  });

  it("400s an impossible calendar date that has the right shape", async () => {
    expect((await GET(get("?from=2026-13-45&to=2026-09-15"))).status).toBe(400);
    expect((await GET(get("?from=2026-02-31&to=2026-03-01"))).status).toBe(400);
    expect(vi.mocked(mergedDays)).not.toHaveBeenCalled();
  });

  it("returns merged days and sources for the caller's own id", async () => {
    const res = await GET(get("?from=2026-09-15&to=2026-09-15"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      days: [{ local_date: "2026-09-15", steps: 1300, active_kcal: 96, sleep_minutes: 444,
        body_mass_kg: 57.6, resting_heart_rate: 47, hrv_sdnn: 45,
        readiness_score: 78,
        sources: ["Apple Watch"], provenance: {} }],
      sources: [{ id: "src-1", kind: "health_auto_export", device_label: "HAE",
        last_received_at: "2026-09-15T10:30:00Z", revoked: false }] });
    expect(vi.mocked(mergedDays).mock.calls[0][1]).toBe("user-1");
  });

  // Eighth round, finding 4: the route passes the roll-up's numbers through untouched — a fractional
  // reading reaches the phone as the watch reported it, and nothing here rounds it.
  it("passes a fractional RHR and HRV through unrounded", async () => {
    vi.mocked(mergedDays).mockResolvedValue([{ local_date: "2026-09-15", steps: 1300,
      active_kcal: 96, sleep_minutes: 444, body_mass_kg: 57.6, resting_heart_rate: 47.4,
      hrv_sdnn: 45.375, readiness_score: 78, sources: ["Oura"], provenance: {} }]);
    const body = await (await GET(get("?from=2026-09-15&to=2026-09-15"))).json() as {
      days: { resting_heart_rate: number; hrv_sdnn: number }[] };
    expect(body.days[0].resting_heart_rate).toBe(47.4);
    expect(body.days[0].hrv_sdnn).toBe(45.375);
  });
});
