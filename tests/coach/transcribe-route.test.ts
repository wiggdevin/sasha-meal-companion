/**
 * T7 §2 — POST /api/coach/transcribe. JWT, 8 KB body, rate-limited like the other coach routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/coach-transcribe", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/coach-transcribe")>()),
  transcribeAudio: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

const { requireUser } = await import("@/lib/server/auth");
const { transcribeAudio } = await import("@/lib/server/coach-transcribe");
const { POST } = await import("@/app/api/coach/transcribe/route");

const body = { path: "media/u1/3f1b1a2c-0000-4000-8000-000000000030.m4a" };
const post = (b: unknown) => new Request("https://app.test/api/coach/transcribe",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

describe("POST /api/coach/transcribe", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: {} as never });
    vi.mocked(transcribeAudio).mockResolvedValue({ text: "Add watermelon to my avoid list.", ms: 1200 });
  });

  it("answers the transcript and the model's ms", async () => {
    const res = await POST(post(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Add watermelon to my avoid list.", ms: 1200 });
  });

  it("401s without a JWT", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    const res = await POST(post(body));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it("413s a body over 8 KB", async () => {
    const res = await POST(post({ path: "x".repeat(9_000) }));
    expect(res.status).toBe(413);
  });

  it("400s a body with no path", async () => {
    expect((await POST(post({}))).status).toBe(400);
  });

  it("passes the 415, 422 and 503 the server module raises straight through", async () => {
    for (const [status, code] of [[415, "unsupported_media"], [422, "too_long"], [503, "provider"]] as const) {
      vi.mocked(transcribeAudio).mockRejectedValueOnce(new HttpError(status, code, "no"));
      const res = await POST(post(body));
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: code });
    }
  });

  it("brakes a flood before it reaches identity", async () => {
    for (let i = 0; i < 120; i += 1) await POST(post(body));
    const res = await POST(post(body));
    expect(res.status).toBe(429);
  });
});
