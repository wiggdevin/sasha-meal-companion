/**
 * T8 §2: POST /api/health/weigh-in. The route owns three things — the shape, the pound-to-kilogram
 * conversion, and turning the RPC's raise into a 422 with a line she can read. Everything else is
 * the RPC's, so the Supabase client is the seam and the call it receives is what is asserted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));

const rpc = vi.fn();
const db = vi.hoisted(() => ({
  adminClient: vi.fn(),
  delete: vi.fn(),
  eq: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: db.adminClient }));

const { DELETE, POST } = await import("@/app/api/health/weigh-in/route");
const user = vi.mocked(requireUser);

function post(body: unknown): Promise<Response> {
  return POST(new Request("https://app.test/api/health/weigh-in", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

function remove(date = "2026-09-17"): Promise<Response> {
  return DELETE(new Request(`https://app.test/api/health/weigh-in?date=${date}`, {
    method: "DELETE",
  }));
}

describe("POST /api/health/weigh-in", () => {
  beforeEach(() => {
    resetRateLimits();
    const deletion = { eq: db.eq, select: db.select };
    db.delete.mockReset().mockReturnValue(deletion);
    db.eq.mockReset().mockReturnValue(deletion);
    db.from.mockReset().mockReturnValue({ delete: db.delete });
    db.adminClient.mockReset().mockReturnValue({ from: db.from });
    db.select.mockReset().mockResolvedValue({ data: [{ id: "sample-1" }], error: null });
    rpc.mockReset().mockResolvedValue({
      data: [{ sample_id: "sample-1", kg: 77.111 }], error: null });
    user.mockReset().mockResolvedValue({ userId: "user-1", client: { rpc } as never });
  });

  it("converts her pounds to kilograms and calls the RPC as her, not as the admin", async () => {
    const res = await post({ localDate: "2026-09-17", tz: "America/Los_Angeles", lb: 170 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kg: 77.111, sampleId: "sample-1" });
    expect(rpc.mock.calls[0][0]).toBe("health_weigh_in");
    expect(rpc.mock.calls[0][1]).toEqual({
      p_local_date: "2026-09-17", p_tz: "America/Los_Angeles", p_kg: 77.111 });
  });

  it("never sends a user id — the RPC reads auth.uid()", async () => {
    await post({ localDate: "2026-09-17", tz: "America/Los_Angeles", lb: 170 });
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toContain("user");
  });

  it("422s a weight the RPC refuses, in words she can read", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "weight_out_of_range" } });
    const res = await post({ localDate: "2026-09-17", tz: "America/Los_Angeles", lb: 10 });
    expect(res.status).toBe(422);
    const body = await res.json() as { message: string };
    expect(body.message).toBe("That weight looks wrong. Check it and try again.");
    expect(body.message).not.toContain("_");
  });

  it("422s a day that has not happened", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "future_date" } });
    const res = await post({ localDate: "2099-01-01", tz: "America/Los_Angeles", lb: 170 });
    expect(res.status).toBe(422);
    expect((await res.json() as { message: string }).message)
      .toBe("That day has not happened yet.");
  });

  /**
   * The RPC's own raises are the only permanent refusals. Everything else it can answer — the
   * function missing because the migration has not landed, a PostgREST 500, a timeout — is the
   * server failing, and a 422 for one of those tells the phone to throw the weigh-in away.
   */
  it("500s a transient RPC failure rather than calling it a refusal", async () => {
    for (const message of ["connection timeout",
      "Could not find the function public.health_weigh_in", "canceling statement due to timeout"]) {
      rpc.mockResolvedValue({ data: null, error: { message } });
      const res = await post({ localDate: "2026-09-17", tz: "America/Los_Angeles", lb: 170 });
      expect(res.status).toBe(500);
      expect((await res.json() as { message: string }).message).toBe("Something went wrong.");
    }
  });

  it("500s an empty payload — a row that is not there is not a refusal either", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const res = await post({ localDate: "2026-09-17", tz: "America/Los_Angeles", lb: 170 });
    expect(res.status).toBe(500);
  });

  it("422s each of the RPC's four named refusals, and nothing else", async () => {
    for (const [raise, message] of [
      ["weight_out_of_range", "That weight looks wrong. Check it and try again."],
      ["future_date", "That day has not happened yet."],
      ["bad_tz", "Could not read your time zone."],
      ["bad_weigh_in", "Could not save that weight."],
    ]) {
      rpc.mockResolvedValue({ data: null, error: { message: raise } });
      const res = await post({ localDate: "2026-09-17", tz: "America/Los_Angeles", lb: 170 });
      expect(res.status).toBe(422);
      expect((await res.json() as { message: string }).message).toBe(message);
    }
  });

  it("400s a body that is not a date, a zone and a number", async () => {
    for (const body of [
      { localDate: "17/09/2026", tz: "America/Los_Angeles", lb: 170 },
      { localDate: "2026-09-17", tz: "", lb: 170 },
      { localDate: "2026-09-17", tz: "America/Los_Angeles", lb: "170" },
      { localDate: "2026-09-17", tz: "America/Los_Angeles" },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a body over 8 KB before it reaches the RPC", async () => {
    const res = await post({ localDate: "2026-09-17", lb: 170,
      tz: `America/${"x".repeat(9000)}` });
    expect(res.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/health/weigh-in", () => {
  beforeEach(() => {
    resetRateLimits();
    const deletion = { eq: db.eq, select: db.select };
    db.delete.mockReset().mockReturnValue(deletion);
    db.eq.mockReset().mockReturnValue(deletion);
    db.from.mockReset().mockReturnValue({ delete: db.delete });
    db.adminClient.mockReset().mockReturnValue({ from: db.from });
    db.select.mockReset().mockResolvedValue({ data: [{ id: "sample-1" }], error: null });
    user.mockReset().mockResolvedValue({ userId: "user-1", client: { rpc } as never });
  });

  it("401s before touching health data when there is no signed-in caller", async () => {
    user.mockRejectedValueOnce(new HttpError(401, "unauthorized", "Sign in to continue."));
    const res = await remove();
    expect(res.status).toBe(401);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("400s an invalid date before constructing the admin client", async () => {
    const res = await remove("17/09/2026");
    expect(res.status).toBe(400);
    expect(db.adminClient).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it("shares the POST route's 60-per-minute weigh-in limit", async () => {
    for (let i = 0; i < 60; i += 1) expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(429);
  });

  it("deletes only the caller's manual row for that date", async () => {
    const res = await remove();
    expect(res.status).toBe(204);
    expect(db.from).toHaveBeenCalledWith("health_samples");
    expect(db.eq.mock.calls).toEqual([
      ["user_id", "user-1"],
      ["type", "body_mass"],
      ["device_label", "manual"],
      ["vendor_sample_id", "manual:2026-09-17"],
    ]);
  });

  it("404s when the caller has no manual row for that date", async () => {
    db.select.mockResolvedValueOnce({ data: [], error: null });
    const res = await remove();
    expect(res.status).toBe(404);
  });
});
