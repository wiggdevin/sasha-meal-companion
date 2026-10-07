import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, requireUser } from "@/lib/server/auth";
import { resolveBarcode } from "@/lib/server/barcode";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { POST } from "@/app/api/foods/barcode/route";

vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn(),
}));
vi.mock("@/lib/server/barcode", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/barcode")>()), resolveBarcode: vi.fn(),
}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

const mockedUser = vi.mocked(requireUser);
const mockedResolve = vi.mocked(resolveBarcode);
const GTIN = "04006381333931";
const NOT_FOUND = { status: "not_found" as const, gtin14: GTIN, searchHint: {} };

function req(body: unknown, ip = "3.3.3.3"): Request {
  return new Request("https://app.test/api/foods/barcode", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimits();
  process.env.NEXT_PUBLIC_FEATURE_SCAN = "1";
  mockedUser.mockReset();
  mockedResolve.mockReset();
  mockedUser.mockResolvedValue({ userId: "user-a", client: {} as never });
  mockedResolve.mockResolvedValue(NOT_FOUND);
});

afterEach(() => { delete process.env.NEXT_PUBLIC_FEATURE_SCAN; });

describe("POST /api/foods/barcode", () => {
  it("404s with the flag unset, without touching identity", async () => {
    delete process.env.NEXT_PUBLIC_FEATURE_SCAN;
    const res = await POST(req({ gtin: GTIN }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(mockedUser).not.toHaveBeenCalled();
  });

  it("resolves for an authenticated caller and passes the hint through", async () => {
    const res = await POST(req({ gtin: "4006381333931", hint: { brand: "Ella's" } }));
    expect(res.status).toBe(200);
    // A barcode answer is catalog data: it says no AI produced it (C8).
    expect(await res.json()).toEqual({ ...NOT_FOUND, provenance: { ai: false, source: "app" } });
    expect(mockedResolve).toHaveBeenCalledWith({}, {}, "user-a",
      { gtin: "4006381333931", hint: { brand: "Ella's" } }, expect.any(Object));
  });

  it("hands the resolver a scheduleRefresh so the 90-day refresh has somewhere to run", async () => {
    await POST(req({ gtin: GTIN }));
    const deps = mockedResolve.mock.calls[0][4];
    expect(typeof deps?.scheduleRefresh).toBe("function");
  });

  it("400s on an invalid GTIN raised by the resolver", async () => {
    mockedResolve.mockRejectedValue(new HttpError(400, "invalid_gtin", "That is not a barcode we can read."));
    const res = await POST(req({ gtin: "4006381333932" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_gtin");
  });

  it("400s on a body that is not a BarcodeRequest", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ gtin: 42 }))).status).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("401s with no session", async () => {
    mockedUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
    expect((await POST(req({ gtin: GTIN }))).status).toBe(401);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("429s past 120 a minute with Retry-After", async () => {
    for (let i = 0; i < 120; i += 1) expect((await POST(req({ gtin: GTIN }))).status).toBe(200);
    const res = await POST(req({ gtin: GTIN }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("429s the outbound budget after 20 provider calls in a minute", async () => {
    mockedResolve.mockImplementation(async (_c, _a, _u, _r, deps) => {
      await deps?.onOutbound?.();
      return NOT_FOUND;
    });
    for (let i = 0; i < 20; i += 1) expect((await POST(req({ gtin: GTIN }))).status).toBe(200);
    expect((await POST(req({ gtin: GTIN }))).status).toBe(429);
  });

  it("503s when the resolver reports both providers down", async () => {
    mockedResolve.mockRejectedValue(
      new HttpError(503, "upstream_unavailable", "The food databases are not answering. Try again in a minute."));
    const res = await POST(req({ gtin: GTIN }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("upstream_unavailable");
  });

  it("413s on a body over 8 KB", async () => {
    expect((await POST(req({ gtin: GTIN, hint: { name: "x".repeat(9000) } }))).status).toBe(413);
  });

  it("never echoes an internal message on a 500", async () => {
    mockedResolve.mockRejectedValue(new Error("relation catalog_barcodes does not exist"));
    const res = await POST(req({ gtin: GTIN }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal", message: "Something went wrong." });
  });
});
