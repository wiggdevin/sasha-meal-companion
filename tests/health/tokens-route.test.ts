import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));

const insert = vi.fn();
const update = vi.fn();
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({
  from: () => ({
    insert: (row: unknown) => { insert(row); return { select: () => ({ single: async () =>
      ({ data: { id: "src-9", kind: "health_auto_export", device_label: "HAE" }, error: null }) }) }; },
    update: (patch: unknown) => { update(patch); return { eq: () => ({ eq: () => ({ select: () =>
      ({ maybeSingle: async () => ({ data: { id: "src-9" }, error: null }) }) }) }) }; },
  }) }) }));

const { POST } = await import("@/app/api/health/tokens/route");
const { DELETE } = await import("@/app/api/health/tokens/[id]/route");
const user = vi.mocked(requireUser);

describe("the source-token routes", () => {
  beforeEach(() => {
    resetRateLimits();
    insert.mockClear();
    update.mockClear();
    user.mockReset().mockResolvedValue({ userId: "user-1", client: {} as never });
  });

  it("returns the plaintext token once and stores only its hash", async () => {
    const res = await POST(new Request("https://app.test/api/health/tokens", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "health_auto_export", device_label: "HAE",
        time_zone: "America/Denver" }) }));
    const json = await res.json() as { token: string; source: { id: string } };
    expect(res.status).toBe(200);
    expect(json.token.startsWith("smh_")).toBe(true);
    expect(json.source.id).toBe("src-9");
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.user_id).toBe("user-1");
    expect(row.time_zone).toBe("America/Denver");
    expect(String(row.token_hash).startsWith("\\x")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(json.token);
  });

  it("422s an unknown source kind", async () => {
    const res = await POST(new Request("https://app.test/api/health/tokens", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "fitbit" }) }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-IANA source timezone", async () => {
    const res = await POST(new Request("https://app.test/api/health/tokens", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        kind: "health_auto_export", time_zone: "Mountain Time-ish",
      }) }));
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it("revokes by setting revoked_at, scoped to the caller", async () => {
    const res = await DELETE(new Request("https://app.test/api/health/tokens/src-9",
      { method: "DELETE" }), { params: Promise.resolve({ id: "src-9" }) });
    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0]).toMatchObject({ revoked_at: expect.any(String) });
  });
});
