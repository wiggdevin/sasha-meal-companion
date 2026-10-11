import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { resolveSourceByToken } from "@/lib/server/health-tokens";
import { applyIngest } from "@/lib/server/health-ingest";

vi.mock("@/lib/server/health-tokens", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/health-tokens")>()),
  resolveSourceByToken: vi.fn(),
}));
vi.mock("@/lib/server/health-ingest", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/health-ingest")>()),
  applyIngest: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

const { POST } = await import("@/app/api/health/ingest/route");
const resolve = vi.mocked(resolveSourceByToken);
const apply = vi.mocked(applyIngest);

const BODY = { source_kind: "apple_health_shortcut", sent_at: new Date().toISOString(),
  tz: "America/New_York", samples: [] };

function post(body: unknown, token = "smh_live", extra: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/health/ingest", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
    body: JSON.stringify(body) });
}

describe("POST /api/health/ingest", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    resolve.mockReset().mockResolvedValue({ id: "src-1", userId: "user-1",
      kind: "apple_health_shortcut" });
    apply.mockReset().mockResolvedValue({ event_id: "ev-1", status: "applied", accepted: 1,
      updated: 0, skipped: 0, rejected: [] });
  });

  it("503s when the flag is unset, before any token lookup", async () => {
    vi.stubEnv("HEALTH_INGEST_ENABLED", "");
    expect((await POST(post(BODY))).status).toBe(503);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("401s a revoked or unknown token before reading user data", async () => {
    resolve.mockResolvedValue(null);
    expect((await POST(post(BODY))).status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("413s a body over 2 MB without calling applyIngest", async () => {
    const big = { ...BODY, samples: [{ type: "step_count", value: 1, unit: "count",
      start_time: BODY.sent_at, end_time: BODY.sent_at, device_label: "x".repeat(3_000_000) }] };
    expect((await POST(post(big))).status).toBe(413);
    expect(apply).not.toHaveBeenCalled();
  });

  it("429s the 31st request in an hour for the same token", async () => {
    for (let i = 0; i < 30; i += 1) await POST(post(BODY));
    expect((await POST(post(BODY))).status).toBe(429);
  });

  // gap-privileged-boundary-6: the pre-identity key is a hash of the raw, unverified bearer
  // token, so a caller who sends a fresh fabricated token on every request gets a brand-new
  // rate-limit key each time and the 30/hour ceiling never engages, letting every request reach
  // resolveSourceByToken's DB lookup. The limiter must also key on something the caller cannot
  // freely choose, so a flood of distinct fabricated tokens from the same source is still throttled.
  it("429s the 31st request in an hour when each uses a different fabricated token from the same source", async () => {
    for (let i = 0; i < 30; i += 1) await POST(post(BODY, `fake-token-${i}`));
    const res = await POST(post(BODY, "fake-token-30"));
    expect(res.status).toBe(429);
    expect(resolve.mock.calls.length).toBeLessThan(31);
  });

  it("passes the parsed body through and returns applyIngest's response", async () => {
    const res = await POST(post(BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ event_id: "ev-1", status: "applied" });
    expect(apply.mock.calls[0][1]).toEqual({ id: "src-1", userId: "user-1",
      kind: "apple_health_shortcut" });
  });
});

describe("applyIngest", async () => {
  const { applyIngest: real } = await vi.importActual<typeof import("@/lib/server/health-ingest")>(
    "@/lib/server/health-ingest");
  const source = { id: "src-1", userId: "user-1", kind: "apple_health_shortcut" };
  const now = new Date("2026-09-15T14:00:00Z");

  function stubAdmin(eventId: string, status: string,
      counts = { accepted: 1, updated: 0, skipped: 0 }) {
    const rpc = vi.fn(async (name: string) => {
      if (name === "set_health_source_time_zone") return { data: null, error: null };
      if (name !== "health_ingest_record") throw new Error(`unexpected rpc ${name}`);
      const isNew = status !== "duplicate";
      return { data: [{ event_id: eventId, is_new: isNew,
        ...(isNew ? counts : { accepted: 0, updated: 0, skipped: 0 }) }], error: null };
    });
    return { rpc } as never;
  }

  /**
   * The database as one transaction per call (migration 20261230091000): a payload hash is
   * remembered only when its apply committed, and a failed apply leaves nothing behind.
   */
  function transactionalAdmin(failures: number) {
    const committed = new Map<string, string>();
    let left = failures;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "set_health_source_time_zone") return { data: null, error: null };
      if (name !== "health_ingest_record") throw new Error(`unexpected rpc ${name}`);
      const hash = String(args.p_payload_hash);
      const prior = committed.get(hash);
      if (prior) {
        return { data: [{ event_id: prior, is_new: false, accepted: 0, updated: 0, skipped: 0 }],
          error: null };
      }
      if (left > 0) {
        left -= 1;
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      const id = `ev-${committed.size + 1}`;
      committed.set(hash, id);
      return { data: [{ event_id: id, is_new: true,
        accepted: (args.p_samples as unknown[]).length, updated: 0, skipped: 0 }], error: null };
    });
    return { value: { rpc } as never, rpc };
  }

  const body = (over: Record<string, unknown> = {}) => ({ source_kind: "apple_health_shortcut",
    sent_at: "2026-09-15T14:00:30Z", tz: "America/New_York", samples: [
      { type: "step_count", value: 812, unit: "count", start_time: "2026-09-15T12:00:00Z",
        end_time: "2026-09-15T13:00:00Z" }], ...over });

  it("409s a payload outside the replay window", async () => {
    await expect(real(stubAdmin("ev-1", "applied"), source, body({ sent_at: "2026-09-15T13:30:00Z" }), now))
      .rejects.toMatchObject({ status: 409, code: "replayed" });
  });

  it("403s when the payload's source_kind is not the source row's kind", async () => {
    await expect(real(stubAdmin("ev-1", "applied"), source, body({ source_kind: "health_auto_export" }), now))
      .rejects.toMatchObject({ status: 403, code: "wrong_source_kind" });
  });

  it("422s an envelope zod failure", async () => {
    await expect(real(stubAdmin("ev-1", "applied"), source, { hello: "world" }, now))
      .rejects.toMatchObject({ status: 422, code: "unprocessable" });
  });

  it("returns duplicate and applies nothing on a repeated payload", async () => {
    const admin = stubAdmin("ev-1", "duplicate");
    const out = await real(admin, source, body(), now);
    expect(out).toEqual({ event_id: "ev-1", status: "duplicate", accepted: 0, updated: 0,
      skipped: 0, rejected: [] });
    const rpc = (admin as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("health_ingest_apply");
  });

  it("records the event and applies the samples in one RPC, never two (A009, A081)", async () => {
    const db = transactionalAdmin(0);
    await real(db.value, source, body(), now);
    expect(db.rpc.mock.calls.filter(([name]) => name !== "set_health_source_time_zone"))
      .toHaveLength(1);
    expect(db.rpc).toHaveBeenCalledWith("health_ingest_record", expect.objectContaining({
      p_user_id: "user-1", p_source_id: "src-1",
      p_samples: [expect.objectContaining({ type: "step_count", value: 812 })] }));
    expect(db.rpc).not.toHaveBeenCalledWith("health_ingest_event", expect.anything());
    expect(db.rpc).not.toHaveBeenCalledWith("health_ingest_apply", expect.anything());
  });

  it("500s a failed apply, and the identical retry applies instead of answering duplicate", async () => {
    const db = transactionalAdmin(1);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(real(db.value, source, body(), now))
        .rejects.toMatchObject({ status: 500, code: "internal" });
    } finally {
      logged.mockRestore();
    }
    const retry = await real(db.value, source, body(), now);
    expect(retry).toMatchObject({ event_id: "ev-1", status: "applied", accepted: 1 });
    const resend = await real(db.value, source, body(), now);
    expect(resend).toMatchObject({ event_id: "ev-1", status: "duplicate", accepted: 0 });
  });

  it("lists a malformed sample in rejected and still applies the rest", async () => {
    const admin = stubAdmin("ev-2", "applied");
    const out = await real(admin, source, body({ samples: [
      { type: "step_count", value: 812, unit: "count", start_time: "2026-09-15T12:00:00Z",
        end_time: "2026-09-15T13:00:00Z" },
      { type: "step_count", value: 1, unit: "furlong", start_time: "2026-09-15T12:00:00Z",
        end_time: "2026-09-15T13:00:00Z" }] }), now);
    expect(out.rejected).toEqual([{ index: 1, reason: "schema: unit" }]);
    expect(out.accepted).toBe(1);
  });
});
