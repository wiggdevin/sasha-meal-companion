import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { CoachRateLimited } from "@/lib/server/coach";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/coach-turn", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/coach-turn")>()),
  runTurn: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({
  adminClient: () => ({
    from: () => ({
      select: () => ({ gte: async () => ({ data: [], error: null }) }),
    }),
  }),
}));

const { requireUser } = await import("@/lib/server/auth");
const { runTurn } = await import("@/lib/server/coach-turn");
const { systemOne } = await import("@/lib/ai/typesafe");
const { verifyPayload } = await import("@/lib/ai/payloads");
const { POST } = await import("@/app/api/coach/route");

const body = {
  threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000030", text: "what should I eat",
};
const post = (b: unknown) => new Request("https://app.test/api/coach",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

describe("POST /api/coach", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("COACH_ENABLED", "1");
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} as never });
    vi.mocked(runTurn).mockResolvedValue({
      threadId: "t1", suggestions: [], actions: [], messages: [], draft: null, deflected: false,
      toolsUsed: [], model: { provider: "gemini", modelId: "gemini-3.8-flash" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("404s when the flag is unset, before identity is resolved", async () => {
    vi.stubEnv("COACH_ENABLED", "");
    const res = await POST(post(body));
    expect(res.status).toBe(404);
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("rate-limits before identity, then parses the body", async () => {
    const res = await POST(post(body));
    expect(res.status).toBe(200);
    expect(requireUser).toHaveBeenCalledTimes(1);
  });

  it("413s a body over 16 KB", async () => {
    const res = await POST(post({ ...body, text: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it("400s a body that fails the schema", async () => {
    expect((await POST(post({ threadId: null, messageId: "nope", text: "hi" }))).status).toBe(400);
  });

  it("renders CoachRateLimited as 429 with retryAfterSeconds and a Retry-After header", async () => {
    vi.mocked(runTurn).mockRejectedValue(new CoachRateLimited(1800));
    const res = await POST(post(body));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1800");
    expect(await res.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 1800 });
  });

  it("shares three logical Jev calls inside one POST and resets them for the next POST", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
    // OD12: coach-verify payloads are health-bearing; this case counts the request budget.
    vi.stubEnv("JEV_HEALTH_ATTESTED", "1");
    const providerAnswer = {
      model: "jev-test",
      answers: { claims_unlisted_action: { type: "noul", noul: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(providerAnswer), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const resultsByRequest: unknown[][] = [];
    vi.mocked(runTurn).mockImplementation(async () => {
      const results = [];
      for (let call = 1; call <= 4; call++) {
        results.push(await systemOne(verifyPayload({ reply: `call ${call}`, actions: [],
          toolNames: [] })));
      }
      resultsByRequest.push(results);
      return {
        threadId: "t1", suggestions: [], actions: [], messages: [], draft: null, deflected: false,
        toolsUsed: [], model: { provider: "gemini", modelId: "gemini-3.8-flash" },
      };
    });

    expect((await POST(post(body))).status).toBe(200);
    expect((await POST(post(body))).status).toBe(200);

    expect(resultsByRequest).toHaveLength(2);
    expect(resultsByRequest[0].slice(0, 3).every((result) => result !== null)).toBe(true);
    expect(resultsByRequest[0][3]).toBeNull();
    expect(resultsByRequest[1][0]).not.toBeNull();
    expect(resultsByRequest[1][3]).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
