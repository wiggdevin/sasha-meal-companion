/**
 * Phase 9 slice 1, audit plan r3 finding 4: Oura connect binds the OAuth state to the account that
 * tapped, not to whichever account the shared cookie now holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import { connectOura } from "@/lib/health-client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const getClaims = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createRequestClient: () => ({ auth: { getClaims } }) }));
const startOura = vi.fn(async () => ({ url: "https://cloud.ouraring.com/oauth/authorize?state=s" }));
vi.mock("@/lib/server/oura", () => ({ startOura: (...a: unknown[]) => startOura(...(a as [])) }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

const { POST } = await import("@/app/api/health/oura/start/route");

function post(account?: string): Request {
  return new Request("https://app.test/api/health/oura/start", {
    method: "POST", headers: account ? { "x-smc-account": account } : {},
  });
}

beforeEach(() => {
  resetRateLimits();
  startOura.mockClear();
  unbindAccount();
  vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
  getClaims.mockResolvedValue({ data: { claims: { sub: B } }, error: null });
});

describe("POST /api/health/oura/start", () => {
  it("answers 409 for another account's header and starts nothing", async () => {
    const res = await POST(post(A));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "account_mismatch" });
    expect(startOura).not.toHaveBeenCalled();
  });

  it("answers { url } for the session's own account", async () => {
    const res = await POST(post(B));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ url: "https://cloud.ouraring.com/oauth/authorize?state=s" });
    expect(startOura).toHaveBeenCalledWith(expect.anything(), B);
  });
});

describe("connectOura (client)", () => {
  it("sends nothing and leaves for nowhere with a stale handle", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    const fetchImpl = vi.fn();
    const assign = vi.fn();
    await expect(connectOura(a, { fetchImpl: fetchImpl as never, assign })).rejects.toBeInstanceOf(AccountChanged);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not navigate when the answer arrives after a switch", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const assign = vi.fn();
    const a = bindAccount(A);
    const pending = connectOura(a, { fetchImpl: fetchImpl as never, assign });
    bindAccount(B);
    answer(Response.json({ url: "https://cloud.ouraring.com/x" }));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    expect(assign).not.toHaveBeenCalled();
  });

  it("posts with the account header and goes to Oura's absolute URL", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ url: "https://cloud.ouraring.com/x" }));
    const assign = vi.fn();
    await connectOura(bindAccount(A), { fetchImpl: fetchImpl as never, assign });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-smc-account")).toBe(A);
    expect(assign).toHaveBeenCalledWith("https://cloud.ouraring.com/x");
  });
});
