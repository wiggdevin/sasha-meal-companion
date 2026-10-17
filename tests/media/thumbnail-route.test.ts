/**
 * W125 (T2 D2): GET /api/media/thumbnail signs a read URL for an entry's kept plate thumbnail,
 * with the caller's own session client, and only for a path inside the caller's own folder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), requireUser: mocks.auth,
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: mocks.limit }));

const { GET } = await import("@/app/api/media/thumbnail/route");

const USER = "11111111-1111-4111-8111-111111111111";
const ENTRY = "22222222-2222-4222-8222-222222222222";
const OWN = `media/${USER}/33333333-3333-4333-8333-333333333333.jpg`;

function client(row: { data: unknown; error: unknown }, signed = { data: { signedUrl: "https://x/s?t=1" }, error: null }) {
  const filters: unknown[][] = [];
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) q[m] = (...a: unknown[]) => { filters.push([m, ...a]); return q; };
  q.maybeSingle = async () => row;
  const sign = vi.fn(async () => signed);
  return { filters, sign, c: { from: () => q, storage: { from: () => ({ createSignedUrl: sign }) } } };
}
const req = (entry: string) => new Request(`http://test/api/media/thumbnail?entry=${entry}`);

beforeEach(() => { vi.clearAllMocks(); });

describe("GET /api/media/thumbnail", () => {
  it("signs the caller's own kept thumbnail for an hour, no-store", async () => {
    const { c, sign, filters } = client({ data: { path: OWN }, error: null });
    mocks.auth.mockResolvedValue({ userId: USER, client: c });
    const res = await GET(req(ENTRY));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ url: "https://x/s?t=1", expiresInSeconds: 3600 });
    expect(sign).toHaveBeenCalledWith(`${USER}/33333333-3333-4333-8333-333333333333.jpg`, 3600);
    expect(filters).toContainEqual(["eq", "entry_id", ENTRY]);
    expect(filters).toContainEqual(["eq", "user_id", USER]);
    expect(filters).toContainEqual(["eq", "kind", "image"]);
    expect(filters).toContainEqual(["is", "deleted_at", null]);
    expect(mocks.limit).toHaveBeenCalledWith(`media:thumbnail:user:${USER}`, 120, 60);
  });

  it("answers null with no row, and never signs another account's path", async () => {
    for (const data of [null, { path: `media/44444444-4444-4444-8444-444444444444/33333333-3333-4333-8333-333333333333.jpg` }]) {
      const { c, sign } = client({ data, error: null });
      mocks.auth.mockResolvedValue({ userId: USER, client: c });
      const res = await GET(req(ENTRY));
      expect(await res.json()).toEqual({ url: null });
      expect(sign).not.toHaveBeenCalled();
    }
  });

  it("refuses a bad id with 400, a failed read with 503, and a signed-out caller before the limiter", async () => {
    const { c } = client({ data: null, error: { code: "x" } });
    mocks.auth.mockResolvedValue({ userId: USER, client: c });
    expect((await GET(req("nope"))).status).toBe(400);
    expect((await GET(req(ENTRY))).status).toBe(503);
    mocks.limit.mockClear();
    mocks.auth.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in."));
    expect((await GET(req(ENTRY))).status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it("answers null when Storage will not sign", async () => {
    const { c } = client({ data: { path: OWN }, error: null }, { data: null, error: { message: "no" } } as never);
    mocks.auth.mockResolvedValue({ userId: USER, client: c });
    expect(await (await GET(req(ENTRY))).json()).toEqual({ url: null });
  });
});
