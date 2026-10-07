import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { favorTasteKey, RulesChangedError } from "@/lib/server/taste-favor";
import { POST } from "@/app/api/foods/favor/route";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/taste-favor", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/taste-favor")>()), favorTasteKey: vi.fn() }));

const BODY = { favored: true, refs: 2, skippedAvoid: 1, rulesRevision: 7 };
const today = () => new Date().toISOString().slice(0, 10);
const post = (body: unknown, query = `?date=${today()}`) => POST(new Request(`http://x/api/foods/favor${query}`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  resetRateLimits();
  vi.mocked(favorTasteKey).mockReset();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} } as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(favorTasteKey).mockResolvedValue(BODY as Awaited<ReturnType<typeof favorTasteKey>>);
});

describe("POST /api/foods/favor", () => {
  it("favors the key for the session's own account, dated by the phone's day, never cached", async () => {
    const res = await post({ key: "u:banana" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BODY);
    expect(favorTasteKey).toHaveBeenCalledWith({}, "u1", "u:banana", today());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a signed-out caller before any read", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    const res = await post({ key: "u:banana" });
    expect(res.status).toBe(401);
    expect(favorTasteKey).not.toHaveBeenCalled();
  });

  it("takes no user id, ref or other field from the body", async () => {
    expect((await post({ key: "u:banana", userId: "someone-else" })).status).toBe(400);
    expect((await post({ refs: ["00000000-0000-4000-8000-000000000901"] })).status).toBe(400);
    expect(favorTasteKey).not.toHaveBeenCalled();
  });

  it.each([[404, "unknown_key"], [409, "rule_review_required"], [422, "nothing_to_favor"],
    [503, "admission_unavailable"]])(
    "passes %i %s through, never cached", async (status, code) => {
      vi.mocked(favorTasteKey).mockRejectedValue(new HttpError(status, code, "x"));
      const res = await post({ key: "f:bananas" });
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(code);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

  it("answers 409 rules_changed with the new rules version", async () => {
    vi.mocked(favorTasteKey).mockRejectedValue(new RulesChangedError(41));
    const res = await post({ key: "f:greek yogurt" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "rules_changed", rulesVersion: 41 });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rate-limits each account to 30 favors a minute", async () => {
    for (let i = 0; i < 30; i += 1) expect((await post({ key: "u:banana" })).status).toBe(200);
    const res = await post({ key: "u:banana" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(favorTasteKey).toHaveBeenCalledTimes(30);
  });
});
