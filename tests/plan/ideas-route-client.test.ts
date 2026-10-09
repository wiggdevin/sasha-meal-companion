/**
 * POST /api/plan/ideas: auth before the body, the shared limiter (pre-auth IP, then per account),
 * strict body, no-store and a Server-Timing header; and the phone's per-chip latency marks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/server/plan-ideas", () => ({ planIdeas: vi.fn(async (_c: unknown, _a: unknown, _u: unknown,
  body: { chip: string }) => ({ cards: [], chip: body.chip, provenance: { ai: false, source: "app" }, serverMs: 42 })) }));
vi.mock("@/lib/device/account", async (orig) => ({
  ...(await orig<typeof import("@/lib/device/account")>()),
  accountFetch: vi.fn(),
  accountJson: vi.fn(async (_h: unknown, res: Response) => res.json()),
}));

import { POST } from "@/app/api/plan/ideas/route";
import { HttpError, requireUser } from "@/lib/server/auth";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { planIdeas } from "@/lib/server/plan-ideas";
import { accountFetch, type AccountHandle } from "@/lib/device/account";
import { requestPlanIdeas, startChipRun } from "@/lib/plan/ideas-client";
import { buffered } from "@/lib/timing";

const body = { chip: "protein", slot: "meal-2", date: "2026-10-08", zone: "UTC" };
const post = (value: unknown) => POST(new Request("http://x/api/plan/ideas", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));

afterEach(() => vi.clearAllMocks());

describe("route", () => {
  it("answers 401 with no session, after the IP limiter and before the body", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new HttpError(401, "unauthorized", "Sign in."));
    const res = await post(body);
    expect(res.status).toBe(401);
    expect(vi.mocked(enforceRateLimit).mock.calls[0][0]).toMatch(/^plan:ideas:pre:ip:/);
    expect(planIdeas).not.toHaveBeenCalled();
  });

  it("limits per account, answers no-store with Server-Timing", async () => {
    vi.mocked(requireUser).mockResolvedValueOnce({ userId: "u1", client: {} } as never);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(vi.mocked(enforceRateLimit).mock.calls.map((call) => call[0])).toContain("plan:ideas:user:u1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("server-timing")).toBe("ideas;dur=42");
    expect((await res.json()).chip).toBe("protein");
  });

  it("refuses an unknown chip or field", async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} } as never);
    expect((await post({ ...body, chip: "pizza" })).status).toBe(400);
    expect((await post({ ...body, text: "Suggest three meals" })).status).toBe(400);
  });
});

describe("phone latency marks", () => {
  it("records sent, server and card-visible under plan-chip:<chip>", async () => {
    vi.mocked(accountFetch).mockResolvedValueOnce(Response.json({ cards: [], chip: "protein",
      provenance: { ai: false, source: "app" }, serverMs: 120 }));
    const timing = startChipRun("protein");
    const answer = await requestPlanIdeas({} as AccountHandle, body as never, timing);
    timing.done(answer.serverMs);
    const rows = buffered().filter((row) => row.path === "plan-chip:protein");
    expect(rows.map((row) => row.step).sort()).toEqual(["card-visible", "sent", "server"]);
    expect(rows.find((row) => row.step === "server")?.ms).toBe(120);
  });
});
