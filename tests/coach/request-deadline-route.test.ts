/**
 * The route answers by COACH_RESPONSE_DEADLINE_MS after the request ARRIVED, whatever is still
 * running (Sol r4: the turn's clock used to start inside runTurn, after auth and body parsing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/coach-turn", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/coach-turn")>()),
  runTurn: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

const { requireUser } = await import("@/lib/server/auth");
const { runTurn } = await import("@/lib/server/coach-turn");
const { POST } = await import("@/app/api/coach/route");
const { COACH_RESPONSE_DEADLINE_MS } = await import("@/lib/coach/turn");
const { DEADLINES } = await import("@/lib/fetch-with-deadline");

const body = { threadId: null, messageId: "3f1b1a2c-0000-4000-8000-000000000031", text: "hi" };
const post = () => new Request("https://app.test/api/coach",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const never = () => new Promise<never>(() => {});

describe("POST /api/coach deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRateLimits();
    vi.stubEnv("COACH_ENABLED", "1");
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} as never });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.mocked(runTurn).mockReset();
    vi.mocked(requireUser).mockReset();
  });

  it("answers well before the phone's own deadline", () => {
    expect(COACH_RESPONSE_DEADLINE_MS).toBeLessThanOrEqual(DEADLINES.coach - 2_000);
  });

  it("hands runTurn the moment the request arrived", async () => {
    vi.mocked(runTurn).mockResolvedValue({} as never);
    const arrived = Date.now();
    await POST(post());
    expect(vi.mocked(runTurn).mock.calls[0][4]).toMatchObject({ startedAt: arrived });
  });

  it("answers a retryable 503 when the turn is still running at the deadline", async () => {
    vi.mocked(runTurn).mockImplementation(never);
    let settled: Response | null = null;
    void POST(post()).then((res) => { settled = res; });
    await vi.advanceTimersByTimeAsync(COACH_RESPONSE_DEADLINE_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const res = settled as unknown as Response;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "timeout" });
  });

  it("counts sign-in time against the same deadline", async () => {
    vi.mocked(requireUser).mockImplementation(never);
    let settled: Response | null = null;
    void POST(post()).then((res) => { settled = res; });
    await vi.advanceTimersByTimeAsync(COACH_RESPONSE_DEADLINE_MS);
    expect((settled as unknown as Response | null)?.status).toBe(503);
  });
});
