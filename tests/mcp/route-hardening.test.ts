/** W037, audit 2026-10-10 A059, A102, A131, A150: the MCP route's scope and body gaps. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTokenUser } from "@/lib/server/privileged";
import {
  memoryRateLimitStore, resetRateLimits, setRateLimitStore, type RateLimitStore,
} from "@/lib/server/ratelimit";
import { emulateTokenUser, type ScopeLog } from "@/tests/helpers/token-user-mock";

vi.mock("@/lib/server/privileged", () => ({ withTokenUser: vi.fn() }));

const { POST } = await import("@/app/api/mcp/route");
const mockedWith = vi.mocked(withTokenUser);
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
let log: ScopeLog = { required: [] };

function tokenWith(scopes: string[]) {
  mockedWith.mockImplementation(emulateTokenUser({ userId: USER_ID, tokenId: "tok-1", scopes },
    log) as never);
}

const call = (id: number, name: string) =>
  ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

function post(body: string, init: { token?: string; headers?: Record<string, string> } = {}) {
  return new Request("https://app.test/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${init.token ?? "smc_x"}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...init.headers,
    },
    body,
  });
}

beforeEach(() => {
  mockedWith.mockReset();
  resetRateLimits();
  log = { required: [] };
  tokenWith(["read", "constraints:write"]);
});

afterEach(() => setRateLimitStore(null));

describe("batch scopes (A059)", () => {
  const mixed = JSON.stringify([call(1, "get_constraints"), call(2, "set_constraints")]);

  it("refuses a write-only token a read tool hidden in a batch with a write tool", async () => {
    tokenWith(["constraints:write"]);
    const res = await POST(post(mixed));
    expect(res.status).toBe(403);
    expect(log.required[0]).toEqual(expect.arrayContaining(["read", "constraints:write"]));
  });

  it("needs read for any non-tool message in a batch", async () => {
    tokenWith(["constraints:write"]);
    const body = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" },
      call(2, "set_constraints")]);
    expect((await POST(post(body))).status).toBe(403);
  });

  it("lets a token with both scopes run the mixed batch", async () => {
    const res = await POST(post(mixed));
    expect(res.status).not.toBe(403);
    expect(res.status).toBeLessThan(500);
  });

  it("keeps an existing write-only token working on a lone set_constraints call", async () => {
    tokenWith(["constraints:write"]);
    const res = await POST(post(JSON.stringify(call(1, "set_constraints"))));
    expect(res.status).not.toBe(403);
    expect(log.required[0]).toEqual(["constraints:write"]);
  });
});

describe("body shape (A102)", () => {
  it.each(["[null]", "[1]", '["x"]', "[[]]", "[]", "null", "7"])(
    "answers 400, not 500, for %s, after authentication", async (body) => {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(mockedWith).toHaveBeenCalledTimes(1);
    });

  it("treats an inherited property name as an unknown tool needing read", async () => {
    tokenWith(["read"]);
    for (const name of ["constructor", "toString", "__proto__"]) {
      log.required = [];
      const res = await POST(post(JSON.stringify(call(1, name))));
      expect(res.status, name).not.toBe(403);
      expect(log.required[0], name).toEqual(["read"]);
    }
  });
});

describe("body size (A131)", () => {
  it("refuses a declared oversize body before authentication", async () => {
    const res = await POST(post("{}", { headers: { "content-length": String(64 * 1024 + 1) } }));
    expect(res.status).toBe(413);
    expect(mockedWith).not.toHaveBeenCalled();
  });

  it("reads no body byte before the token is verified", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    mockedWith.mockRejectedValueOnce(Object.assign(new Error("no"), { status: 401 }));
    await POST(new Request("https://app.test/api/mcp", {
      method: "POST", headers: { authorization: "Bearer smc_bad" }, body: stream,
      duplex: "half",
    } as RequestInit));
    expect(pulled).toBe(false);
  });

  it("stops a streamed body at the cap after authentication", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 64) controller.close(); else controller.enqueue(chunk);
      },
    });
    const res = await POST(new Request("https://app.test/api/mcp", {
      method: "POST", headers: { authorization: "Bearer smc_x" }, body: stream, duplex: "half",
    } as RequestInit));
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(10);
  });
});

describe("pre-identity limiter order (A150)", () => {
  it("checks the IP key before any per-token key reaches the store", async () => {
    const memory = memoryRateLimitStore();
    const keys: string[] = [];
    const recording: RateLimitStore = {
      hit: (key, limit, windowSeconds) => {
        keys.push(key);
        return memory.hit(key, limit, windowSeconds);
      },
    };
    setRateLimitStore(recording);
    const headers = { "x-real-ip": "203.0.113.9" };
    for (let i = 0; i < 30; i += 1) {
      await POST(post(JSON.stringify(call(1, "get_constraints")), { token: `t-${i}`, headers }));
    }
    expect(keys[0]).toBe("mcp:pre:ip:203.0.113.9");

    keys.length = 0;
    for (let i = 30; i < 40; i += 1) {
      const res = await POST(post("{}", { token: `fresh-${i}`, headers }));
      expect(res.status).toBe(429);
    }
    expect(keys.filter((key) => key.startsWith("mcp:pre:") && !key.includes(":ip:")))
      .toEqual([]);
  });
});
