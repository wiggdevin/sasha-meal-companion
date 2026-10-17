import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTokenUser } from "@/lib/server/privileged";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { HttpError } from "@/lib/server/auth";
import { emulateTokenUser, type ScopeLog } from "@/tests/helpers/token-user-mock";

vi.mock("@/lib/server/privileged", () => ({ withTokenUser: vi.fn() }));

const { POST } = await import("@/app/api/mcp/route");
const mockedWith = vi.mocked(withTokenUser);
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
let log: ScopeLog = { required: [] };

function tokenWith(scopes: string[], userId = USER_ID, tokenId = "tok-1") {
  mockedWith.mockImplementation(emulateTokenUser({ userId, tokenId, scopes }, log) as never);
}

const RETIRED_TOOLS = [
  "list_foods", "add_food", "set_food_status", "get_day",
  "log_gut", "search_foods", "log_food", "rules",
];
const ACTIVE_TOOLS = [
  "get_body_data", "get_expenditure_status", "get_targets",
  "get_constraints", "set_constraints", "list_coach_messages",
];

function rpc(method: string, name?: string): string {
  return JSON.stringify({
    jsonrpc: "2.0", id: 1, method,
    params: name ? { name, arguments: {} } : {},
  });
}

function post(body: string, token = "smc_x"): Request {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
}

async function listedTools(): Promise<string[]> {
  const res = await POST(new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer smc_x",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: rpc("tools/list"),
  }));
  const dataLine = (await res.text()).split("\n").find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(dataLine!.slice("data: ".length));
  return (parsed.result.tools as { name: string }[]).map((tool) => tool.name);
}

describe("the MCP scope gate", () => {
  beforeEach(() => {
    mockedWith.mockReset();
    resetRateLimits();
    log = { required: [] };
    tokenWith(["read", "constraints:write"]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("registers only user-scoped health, expenditure, and coach tools", async () => {
    const names = await listedTools();
    expect(names).toEqual(expect.arrayContaining(ACTIVE_TOOLS));
    expect(names).not.toEqual(expect.arrayContaining(RETIRED_TOOLS));
  });

  it("keeps the deleted MCP tool names out of the gut check-in feature row", () => {
    // F-031 still advertised `log_gut` and `get_day` as MCP tools after §4 deleted the legacy
    // MCP surface. `log_gut` is gone everywhere; `get_day` survives only inside the coach's own
    // read registry (F-094, `lib/coach/registry.ts`), which is not MCP, so the gut row may not
    // claim either one.
    const features = readFileSync("docs/features.md", "utf8");
    expect(features).not.toContain("log_gut");
    const row = features.split("\n").find((line) => line.startsWith("| F-031 |"));
    expect(row, "F-031 row is missing").toBeTypeOf("string");
    expect(row).not.toContain("get_day");
    // No backticked tool name may be presented as an MCP tool on this row.
    expect(row).not.toMatch(/MCP `[a-z_]+` tool/);
  });

  it("asks for read on every read tool and on tool listing", async () => {
    for (const tool of ACTIVE_TOOLS.filter((name) => name !== "set_constraints")) {
      log.required = [];
      await POST(post(rpc("tools/call", tool)));
      expect(log.required[0], tool).toEqual(["read"]);
    }
    log.required = [];
    await POST(post(rpc("tools/list")));
    expect(log.required[0]).toEqual(["read"]);
  });

  it("asks for constraints:write on set_constraints", async () => {
    await POST(post(rpc("tools/call", "set_constraints")));
    expect(log.required[0]).toEqual(["constraints:write"]);
  });

  it("lets any token owner reach the user-scoped tools", async () => {
    tokenWith(["read"], "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "tok-2");
    for (const tool of ACTIVE_TOOLS.filter((name) => name !== "set_constraints")) {
      const res = await POST(post(rpc("tools/call", tool)));
      expect(res.status, tool).not.toBe(404);
    }
  });

  it("requires every scope a batch needs", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_constraints", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_targets", arguments: {} } },
    ]);
    tokenWith(["read"]);
    const res = await POST(post(batch));
    expect(log.required[0]).toEqual(["constraints:write", "read"]);
    expect(res.status).toBe(403);
  });

  it("maps boundary authorization failures to HTTP responses", async () => {
    mockedWith.mockRejectedValueOnce(
      new HttpError(403, "forbidden", 'Token lacks the "constraints:write" scope.'),
    );
    expect((await POST(post(rpc("tools/call", "set_constraints")))).status).toBe(403);

    mockedWith.mockRejectedValueOnce(
      new HttpError(401, "unauthorized", "Unknown, revoked or expired token."),
    );
    const unauthorized = await POST(post(rpc("tools/list")));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects an oversized or malformed body after authentication", async () => {
    const oversized = await POST(post(JSON.stringify({ pad: "x".repeat(70_000) })));
    expect(oversized.status).toBe(413);
    expect(mockedWith).toHaveBeenCalledTimes(1);

    const malformed = await POST(post("not json"));
    expect(malformed.status).toBe(400);
    expect(mockedWith).toHaveBeenCalledTimes(2);
  });

  it("throttles repeated and distinct fabricated tokens before identity", async () => {
    let repeated!: Response;
    for (let i = 0; i < 31; i += 1) repeated = await POST(post(rpc("tools/list")));
    expect(repeated.status).toBe(429);
    expect(mockedWith).toHaveBeenCalledTimes(30);

    resetRateLimits();
    mockedWith.mockClear();
    let distinct!: Response;
    for (let i = 0; i < 31; i += 1) {
      distinct = await POST(post(rpc("tools/list"), `fake-token-${i}`));
    }
    expect(distinct.status).toBe(429);
    expect(mockedWith.mock.calls.length).toBeLessThan(31);
  });
});
