import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));

const insert = vi.fn();
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({
  from: () => ({ insert: (row: unknown) => { insert(row); return Promise.resolve({ error: null }); } }) }) }));

const route = await import("@/app/api/health/oura/start/route");
const POST = route.POST;
const user = vi.mocked(requireUser);

function post(): Request {
  return new Request("https://app.test/api/health/oura/start", { method: "POST" });
}

describe("POST /api/health/oura/start", () => {
  beforeEach(() => {
    resetRateLimits();
    insert.mockClear();
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    vi.stubEnv("OURA_CLIENT_ID", "cid");
    vi.stubEnv("OURA_CLIENT_SECRET", "secret");
    vi.stubEnv("OURA_REDIRECT_URI", "https://app.test/api/health/oura/callback");
    user.mockReset().mockResolvedValue({ userId: "user-1", client: {} as never });
  });

  // PR #248 review r1 #2: the navigation GET sent no account header, so an old tab could start
  // Oura for whichever account the shared cookie held. It is gone; only the checked POST remains.
  it("has no GET handler: a headerless navigation cannot start a connection", () => {
    expect((route as Record<string, unknown>).GET).toBeUndefined();
  });

  it("answers Oura's URL with state and no code_challenge, per architecture §5.2's closed PKCE canary", async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://cloud.ouraring.com/oauth/authorize");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("fails closed with no redirect to Oura when OURA_CLIENT_ID is unset", async () => {
    vi.stubEnv("OURA_CLIENT_ID", "");
    const res = await POST(post());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { url?: string }).url).toBeUndefined();
  });

  it("fails closed with no redirect to Oura when OURA_REDIRECT_URI is unset", async () => {
    vi.stubEnv("OURA_REDIRECT_URI", "");
    const res = await POST(post());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { url?: string }).url).toBeUndefined();
  });

  it("binds a safe return path into the hashed OAuth state", async () => {
    const res = await POST(new Request("https://app.test/api/health/oura/start", {
      method: "POST", body: JSON.stringify({ returnTo: "/body?tab=sleep" }),
    }));
    expect(res.status).toBe(200);
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state");
    expect(state).toBeTruthy();
    expect(Buffer.from(state!.split(".")[1], "base64url").toString()).toBe("/body?tab=sleep");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ state_hash: expect.any(String) }));
  });

  it("refuses an external return URL before storing OAuth state", async () => {
    const res = await POST(new Request("https://app.test/api/health/oura/start", {
      method: "POST", body: JSON.stringify({ returnTo: "https://evil.test/" }),
    }));
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });
});
