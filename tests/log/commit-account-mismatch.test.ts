/** Phase 9 §0.5a: a commit that names another account than the session's writes nothing. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyLogEntry = vi.fn();
const getClaims = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createRequestClient: () => ({ auth: { getClaims } }) }));
vi.mock("@/lib/server/log", () => ({ applyLogEntry: (...a: unknown[]) => applyLogEntry(...a) }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => {} }));

const { POST } = await import("@/app/api/log/commit/route");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  applyLogEntry.mockReset();
  getClaims.mockResolvedValue({ data: { claims: { sub: B } }, error: null });
});

describe("POST /api/log/commit account check", () => {
  it("answers 409 account_mismatch for A's header on B's JWT and writes nothing", async () => {
    const res = await POST(new Request("https://x.test/api/log/commit", {
      method: "POST", headers: { "content-type": "application/json", "x-smc-account": A },
      body: JSON.stringify({ entry_id: crypto.randomUUID() }),
    }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "account_mismatch" });
    expect(applyLogEntry).not.toHaveBeenCalled();
  });
});
