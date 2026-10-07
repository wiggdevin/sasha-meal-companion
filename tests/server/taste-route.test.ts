import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { accountTaste } from "@/lib/server/taste-admission";
import { GET } from "@/app/api/foods/taste/route";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/taste-admission", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/taste-admission")>()), accountTaste: vi.fn() }));

const BODY = { version: "taste-1", asOf: "2026-10-06", windowDays: 180, m: 0, episodes: 0, rulesRevision: 1,
  items: [] };

beforeEach(() => {
  resetRateLimits();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} } as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(accountTaste).mockResolvedValue(BODY as Awaited<ReturnType<typeof accountTaste>>);
});

describe("GET /api/foods/taste", () => {
  it("answers the caller's own account, dated by the phone's day, never cached", async () => {
    const res = await GET(new Request(`http://x/api/foods/taste?date=${new Date().toISOString().slice(0, 10)}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BODY);
    expect(accountTaste).toHaveBeenCalledWith({}, "u1", new Date().toISOString().slice(0, 10),
      expect.objectContaining({ evidence: expect.any(Function) }), expect.any(Date), expect.any(Function));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses an unauthenticated caller before any read", async () => {
    const { HttpError } = await import("@/lib/server/auth");
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    const res = await GET(new Request("http://x/api/foods/taste"));
    expect(res.status).toBe(401);
    expect(accountTaste).not.toHaveBeenCalled();
  });
});
