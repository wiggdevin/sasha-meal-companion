import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestClient } from "@/lib/supabase/server";
import { HttpError, requireUser } from "./auth";

vi.mock("@/lib/supabase/server", () => ({ createRequestClient: vi.fn() }));

const mockedCreate = vi.mocked(createRequestClient);
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function clientWith(result: unknown) {
  const getClaims = vi.fn().mockResolvedValue(result);
  return { auth: { getClaims } } as never;
}

describe("HttpError", () => {
  it("carries a status and a code, and defaults the message to the code", () => {
    const e = new HttpError(403, "forbidden");
    expect(e.status).toBe(403);
    expect(e.code).toBe("forbidden");
    expect(e.message).toBe("forbidden");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
  });

  it("returns the claim subject and the request client", async () => {
    const client = clientWith({ data: { claims: { sub: "11111111-1111-1111-1111-111111111111" } }, error: null });
    mockedCreate.mockReturnValue(client);
    const out = await requireUser(new Request("https://app.test/api/x",
      { headers: { "x-smc-account": "11111111-1111-1111-1111-111111111111" } }));
    expect(out.userId).toBe("11111111-1111-1111-1111-111111111111");
    expect(out.client).toBe(client);
  });

  it("throws 401 when there are no claims", async () => {
    mockedCreate.mockReturnValue(clientWith({ data: null, error: null }));
    await expect(requireUser(new Request("https://app.test/api/x"))).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("answers 409 account_mismatch when x-smc-account is not the JWT subject (Phase 9 §0.5a)", async () => {
    mockedCreate.mockReturnValue(clientWith({ data: { claims: { sub: B } }, error: null }));
    const req = new Request("https://app.test/api/x", { headers: { "x-smc-account": A } });
    await expect(requireUser(req)).rejects.toMatchObject({ status: 409, code: "account_mismatch" });
  });

  it("accepts a matching header", async () => {
    mockedCreate.mockReturnValue(clientWith({ data: { claims: { sub: B } }, error: null }));
    await expect(requireUser(new Request("https://app.test/api/x", { headers: { "x-smc-account": B } })))
      .resolves.toMatchObject({ userId: B });
  });

  // PR #248 review r3 #1: a missing header is an old tab; 401 keeps its writes queued.
  it("answers 401 account_header_required for a missing header (old tabs)", async () => {
    mockedCreate.mockReturnValue(clientWith({ data: { claims: { sub: B } }, error: null }));
    await expect(requireUser(new Request("https://app.test/api/x")))
      .rejects.toMatchObject({ status: 401, code: "account_header_required" });
  });

  it("throws 401 when getClaims errors", async () => {
    mockedCreate.mockReturnValue(clientWith({ data: null, error: { message: "bad jwt" } }));
    await expect(requireUser(new Request("https://app.test/api/x"))).rejects.toBeInstanceOf(HttpError);
  });
});
