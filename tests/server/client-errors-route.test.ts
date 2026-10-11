/**
 * POST /api/client-errors (audit 2026-10-08 §5, W053): one allowlisted log line per report, no free text,
 * no request echo; 413 over 4 KB, 429 past the per-IP limit, 202 for everything else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ERROR_LOG_PREFIX } from "@/lib/client-errors";

let logged: unknown[][] = [];
beforeEach(async () => {
  (await import("@/lib/server/ratelimit")).resetRateLimits();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const post = (body: string, ip = "203.0.113.9", headers: Record<string, string> = {}) =>
  new Request("https://a.test/api/client-errors", {
    method: "POST", body, headers: { "content-type": "application/json", "x-real-ip": ip,
      cookie: "sb-access-token=secret-session", authorization: "Bearer secret-token", ...headers },
  });

async function route() { return (await import("@/app/api/client-errors/route")).POST; }

function reportLines(): Record<string, unknown>[] {
  return logged.filter((args) => args[0] === CLIENT_ERROR_LOG_PREFIX)
    .map((args) => JSON.parse(String(args[1])) as Record<string, unknown>);
}

describe("POST /api/client-errors", () => {
  it("logs one line under the stable prefix with only the report fields, and answers 202", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "srv123");
    const POST = await route();
    const res = await POST(post(JSON.stringify({
      source: "boundary", name: "TypeError", message: "Cannot read 'kcal' of undefined",
      digest: "abc_123", route: "/foods?tab=eats#x", build: "def4567", at: "2026-10-08T12:00:00.000Z",
      userId: "11111111-1111-4111-8111-111111111111", stack: "at secret (file.ts:1:1)",
    })));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    const lines = reportLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]).sort())
      .toEqual(["at", "build", "code", "digest", "name", "route", "serverBuild", "source"]);
    expect(lines[0]).toMatchObject({ name: "TypeError", code: "unknown", route: "/foods", digest: null,
      build: "def4567", serverBuild: "srv123", source: "boundary" });
  });

  it("logs allowlisted values only: free text in any field is dropped, whatever the caller sends", async () => {
    const POST = await route();
    await POST(post(JSON.stringify({ name: "sasha@example.com", code: "weighed 172 lb",
      message: `sasha@example.com weighed 172 lb on 2026-10-08 ${"x".repeat(500)}`,
      route: "/day/2026-10-08?user=sasha@example.com", digest: "sasha", build: "sasha example" })));
    const [line] = reportLines();
    expect(line).toMatchObject({ name: "Other", code: "unknown", route: "other", digest: null, build: null });
    const text = JSON.stringify(line);
    for (const leak of ["sasha", "example", "172", "2026-10-08", "weighed", "xxx"]) expect(text).not.toContain(leak);
  });

  it("keeps an allowlisted code and route pattern as sent", async () => {
    const POST = await route();
    await POST(post(JSON.stringify({ source: "window-error", name: "ChunkLoadError", code: "chunk_load",
      route: "/design/:page", digest: "1234567@E12", build: "0123abcd" })));
    expect(reportLines()[0]).toMatchObject({ source: "window-error", name: "ChunkLoadError", code: "chunk_load",
      route: "/design/:page", digest: "1234567@E12", build: "0123abcd" });
  });

  it("never logs the request itself: no cookie, token, IP or raw body", async () => {
    const POST = await route();
    await POST(post(JSON.stringify({ message: "boom", extra: "raw-body-canary" })));
    const all = JSON.stringify(logged);
    for (const canary of ["secret-session", "secret-token", "203.0.113.9", "raw-body-canary"])
      expect(all).not.toContain(canary);
  });

  it("answers 202 and logs nothing for a body that is not a JSON object", async () => {
    const POST = await route();
    for (const body of ["not json", "[1,2]", "null", "\"text\""]) {
      expect((await POST(post(body))).status).toBe(202);
    }
    expect(reportLines()).toEqual([]);
  });

  it("answers 413 over 4 KB, declared or actual, and logs nothing", async () => {
    const POST = await route();
    const big = JSON.stringify({ code: "unknown", pad: "y".repeat(5000) });
    expect((await POST(post(big))).status).toBe(413);
    expect((await POST(post("{}", "203.0.113.9", { "content-length": "9000" }))).status).toBe(413);
    expect(reportLines()).toEqual([]);
  });

  it("checks the cap while reading: an undeclared oversized stream is cut off, not read whole", async () => {
    const POST = await route();
    const chunk = new TextEncoder().encode("y".repeat(1024));
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) controller.close(); else controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const req = new Request("https://a.test/api/client-errors", {
      method: "POST", body, headers: { "x-real-ip": "203.0.113.10" }, duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(req.headers.get("content-length")).toBeNull();
    expect((await POST(req)).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(6);
    expect(cancelled).toBe(true);
    expect(reportLines()).toEqual([]);
  });

  it("checks the declared length before the limiter or the body: no read at all", async () => {
    const POST = await route();
    const req = post("{}", "203.0.113.11", { "content-length": "999999" });
    const text = vi.spyOn(req, "text");
    expect((await POST(req)).status).toBe(413);
    expect(text).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
  });

  it("limits each IP with the shared limiter (429 past the window's allowance)", async () => {
    const POST = await route();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await POST(post("{}", "198.51.100.4"))).status);
    expect(statuses.slice(0, 30).every((s) => s === 202)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Another IP has its own allowance.
    expect((await POST(post("{}", "198.51.100.5"))).status).toBe(202);
  });
});
