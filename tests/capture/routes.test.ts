import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { HttpError, requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { signUpload } from "@/lib/server/media";
import { signAndUpload } from "@/lib/capture-client";
import { DuplicateRequest, proposeDraft } from "@/lib/server/capture";
import { POST as sign } from "@/app/api/media/sign/route";
import { POST as propose } from "@/app/api/log/propose/route";
import { TEST_USER } from "@/tests/helpers/account";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/media", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/media")>()), signUpload: vi.fn() }));
vi.mock("@/lib/server/capture", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/capture")>()), proposeDraft: vi.fn() }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

const user = vi.mocked(requireUser);
const mockedSign = vi.mocked(signUpload);
const mockedPropose = vi.mocked(proposeDraft);

function post(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" } });
}

const BODY = { method: "text", localDate: "2026-09-11", tz: "America/New_York",
  slot: "meal-1", text: "two eggs" };

beforeEach(() => {
  resetRateLimits();
  user.mockReset(); mockedSign.mockReset(); mockedPropose.mockReset();
  user.mockResolvedValue({ userId: "u1", client: {} as never });
  // Phase 9 §0.1: signAndUpload reads the bound account (merged in from origin/main after this
  // test was written); bind one so the client-side call under test has a handle to act as.
  unbindAccount(); bindAccount(TEST_USER);
});

describe("POST /api/media/sign", () => {
  it("the client uploads nothing when the sign route refuses", async () => {
    const h = bindAccount("u1");
    try {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ error: "nous_unconfirmed",
        message: "off" }), { status: 503, headers: { "content-type": "application/json" } }));
      const out = await signAndUpload("audio", new Blob([new Uint8Array(4)], { type: "audio/wav" }),
        fetchFn as never, { account: h });
      expect(out.kind).toBe("failed");
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      unbindAccount();
    }
  });

  it("issues no upload URL without the Gemini attestation (Phase 13 §9 R3)", async () => {
    vi.stubEnv("GEMINI_BILLING_ATTESTED", "");
    const res = await sign(post("https://a.test/api/media/sign",
      { kind: "audio", contentType: "audio/wav", bytes: 10 }));
    vi.unstubAllEnvs();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "nous_unconfirmed" });
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("signs for the caller and never reads a user id from the body", async () => {
    mockedSign.mockResolvedValue({ path: "media/u1/a.jpg", uploadUrl: "https://s.test/u",
      expiresInSeconds: 60 });
    const res = await sign(post("https://a.test/api/media/sign",
      { kind: "image", contentType: "image/jpeg", bytes: 10, userId: "u2" }));
    expect(res.status).toBe(200);
    expect(mockedSign).toHaveBeenCalledWith({}, "u1",
      { kind: "image", contentType: "image/jpeg", bytes: 10 });
  });

  it("401s with no session", async () => {
    user.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    expect((await sign(post("https://a.test/api/media/sign",
      { kind: "image", contentType: "image/jpeg", bytes: 10 }))).status).toBe(401);
  });

  it("400s a body the schema refuses", async () => {
    expect((await sign(post("https://a.test/api/media/sign", { kind: "video" }))).status).toBe(400);
  });
});

describe("POST /api/log/propose", () => {
  it("returns the draft", async () => {
    mockedPropose.mockResolvedValue({ draftId: "d1", method: "text", items: [], notes: [],
      spend: { usedToday: 1, softCap: 30 } });
    const res = await propose(post("https://a.test/api/log/propose", BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).draftId).toBe("d1");
  });

  it.each([
    [404, new HttpError(404, "method_disabled", "off")],
    [403, new HttpError(403, "media_not_owned", "not yours")],
    [415, new HttpError(415, "unsupported_media", "bad bytes")],
    [422, new HttpError(422, "schema_invalid", "bad shape")],
    [429, new HttpError(429, "spend_cap", "enough for today")],
    [503, new HttpError(503, "provider_unavailable", "try later")],
  ])("maps a %s onto the spec error table", async (status, error) => {
    mockedPropose.mockRejectedValue(error);
    const res = await propose(post("https://a.test/api/log/propose", BODY));
    expect(res.status).toBe(status);
    expect(Object.keys(await res.json()).sort()).toEqual(["error", "message"]);
  });

  it("409s a duplicate and carries the original ai_calls id", async () => {
    mockedPropose.mockRejectedValue(new DuplicateRequest("call-1"));
    const res = await propose(post("https://a.test/api/log/propose", BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "duplicate_request", aiCallId: "call-1" });
  });

  it("413s a body over 8 KB", async () => {
    const res = await propose(post("https://a.test/api/log/propose",
      { ...BODY, text: "a".repeat(9000) }));
    expect(res.status).toBe(413);
  });
});
