import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminClient } from "@/lib/server/admin";
import { hashToken, toBytea } from "@/lib/server/tokens";
import { withTokenUser } from "./privileged";

vi.mock("@/lib/server/admin", () => ({ adminClient: vi.fn() }));

const rpc = vi.fn();
vi.mocked(adminClient).mockReturnValue({ rpc } as never);

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TOKEN_A = "smc_tokenA";

function req(auth?: string): Request {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("withTokenUser", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("looks the token up by hash, never by the raw value", async () => {
    rpc.mockResolvedValue({ data: [{ id: "tok-1", user_id: USER_A, scopes: ["read"] }], error: null });
    await withTokenUser(req(`Bearer ${TOKEN_A}`), "read", async () => "ok");
    expect(rpc).toHaveBeenCalledWith("lookup_api_token", {
      p_token_hash: toBytea(hashToken(TOKEN_A)),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(TOKEN_A);
  });

  it("hands the callback the token's user and the admin client", async () => {
    rpc.mockResolvedValue({
      data: [{ id: "tok-1", user_id: USER_A, scopes: ["read", "log:write"] }],
      error: null,
    });
    const fn = vi.fn().mockResolvedValue("done");
    await expect(withTokenUser(req(`Bearer ${TOKEN_A}`), "log:write", fn)).resolves.toBe("done");
    expect(fn).toHaveBeenCalledWith(
      { userId: USER_A, tokenId: "tok-1", scopes: ["read", "log:write"] },
      { rpc },
    );
  });

  it("401s without a bearer header", async () => {
    const fn = vi.fn();
    await expect(withTokenUser(req(), "read", fn)).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(fn).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("401s on a non-bearer scheme", async () => {
    await expect(withTokenUser(req("Basic abc"), "read", vi.fn())).rejects.toMatchObject({ status: 401 });
  });

  // The RPC returns no row for missing, revoked and expired alike; a row
  // without a user_id would break architecture §2.2 rule 3.
  it.each([
    ["no row", { data: [], error: null }],
    ["an RPC error", { data: null, error: { message: "boom" } }],
    ["a row with no user_id", { data: [{ id: "tok-1", user_id: null, scopes: ["read"] }], error: null }],
  ])("401s on %s, without calling the callback", async (_label, result) => {
    rpc.mockResolvedValue(result);
    const fn = vi.fn();
    await expect(withTokenUser(req(`Bearer ${TOKEN_A}`), "read", fn)).rejects.toMatchObject({ status: 401 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("403s when the token lacks the scope", async () => {
    rpc.mockResolvedValue({ data: [{ id: "tok-1", user_id: USER_A, scopes: ["read"] }], error: null });
    const fn = vi.fn();
    await expect(withTokenUser(req(`Bearer ${TOKEN_A}`), "log:write", fn)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  // Fix round: a malformed row (scopes arriving as a string, not an array)
  // must fail closed. String.prototype.includes would otherwise do substring
  // matching, so "log:write:all" would wrongly satisfy a "log:write" check.
  it("403s on a malformed row where scopes is a string, not an array", async () => {
    rpc.mockResolvedValue({
      data: [{ id: "tok-1", user_id: USER_A, scopes: "log:write:all" }],
      error: null,
    });
    const fn = vi.fn();
    await expect(withTokenUser(req(`Bearer ${TOKEN_A}`), "log:write", fn)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
