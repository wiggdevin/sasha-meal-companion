/**
 * Unit-level (no Supabase branch) coverage for two truncation bugs in the export route that the
 * HAS_BRANCH-gated suites in this directory can't catch in an environment with no
 * SUPABASE_TEST_* env (CI finding #37 tracks that gap separately):
 *
 * - finding 45: the meals CSV drops `next_cursor` entirely, so a truncated export looks identical
 *   to a complete one.
 * - finding 65: `kind=weight`'s buffered `.range()` pagination orders by `start_time` alone, with
 *   no tie-breaker, so two rows sharing a timestamp can be skipped or duplicated across a page
 *   boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/server/auth";
import { streamMeals } from "@/lib/server/export";
import { resetRateLimits } from "@/lib/server/ratelimit";

// lib/server/export.ts imports "server-only" (see tests/export/cursor.test.ts): only the marker
// package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn() }));
vi.mock("@/lib/server/export", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/export")>()), streamMeals: vi.fn() }));

const { GET } = await import("@/app/api/export/route");
const user = vi.mocked(requireUser);

function get(query: string): Request {
  return new Request(`https://app.test/api/export?${query}`);
}

/** A chainable fake query builder in the shape `.from().select().order()....` that resolves to
 *  `result` and records every `order()` call so a test can assert the tie-breaker exists. */
function fakeClient(result: { data: unknown[]; error: null }) {
  const orderCalls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "range", "is"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.order = vi.fn((...args: unknown[]) => { orderCalls.push(args); return builder; });
  // The real supabase-js query builder is itself a thenable; `await query` resolves it directly.
  (builder as { then: PromiseLike<unknown>["then"] }).then = (resolve) =>
    Promise.resolve(result).then(resolve as never);
  const client = { from: vi.fn(() => builder) };
  return { client, orderCalls };
}

describe("GET /api/export — kind=meals CSV truncation signal", () => {
  beforeEach(() => {
    resetRateLimits();
    user.mockResolvedValue({ userId: "user-1", client: {} as never });
  });

  it("appends a truncation notice when the page has a next_cursor", async () => {
    vi.mocked(streamMeals).mockResolvedValue({
      rows: [], notices: [], next_cursor: "some-cursor" });
    const res = await GET(get("kind=meals&format=csv"));
    const body = await res.text();
    expect(body).toMatch(/^# .*truncat/im);
  });

  it("emits no truncation notice when the page is complete", async () => {
    vi.mocked(streamMeals).mockResolvedValue({ rows: [], notices: [], next_cursor: null });
    const res = await GET(get("kind=meals&format=csv"));
    const body = await res.text();
    expect(body).not.toMatch(/truncat/i);
    expect(res.headers.get("x-export-next-cursor")).toBeNull();
    expect(res.headers.get("x-export-notice-lines")).toBe("0");
  });

  // W012 (A086): the cursor used to exist only in the JSON body, so a CSV page could say it was
  // cut short and still never be continued.
  it("hands a truncated CSV page its cursor in the notice and in a header", async () => {
    vi.mocked(streamMeals).mockResolvedValue({ rows: [], notices: ["ODbL"],
      next_cursor: "abc_DEF-1" });
    const res = await GET(get("kind=meals&format=csv"));
    expect(res.headers.get("x-export-next-cursor")).toBe("abc_DEF-1");
    expect(res.headers.get("x-export-notice-lines")).toBe("2");
    const lines = (await res.text()).trimEnd().split("\r\n");
    expect(lines.slice(-2)).toEqual(["# ODbL",
      "# Export truncated: more rows exist. Re-request with cursor=abc_DEF-1 to get the rest."]);
  });
});

// W012 review (Sol WARN): a multi-page download is one first request plus cursor continuations.
// Counting the continuations against the 10/hour export budget made the second download in an
// hour fail partway, so they draw on their own budget.
describe("GET /api/export — cursor continuations and the hourly limit", () => {
  beforeEach(() => {
    resetRateLimits();
    user.mockResolvedValue({ userId: "user-1", client: {} as never });
    vi.mocked(streamMeals).mockImplementation(async () =>
      ({ rows: [], notices: [], next_cursor: null }));
  });

  it("serves continuations after the hour's ten first pages are spent", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await GET(get("kind=meals&format=csv"))).status).toBe(200);
    }
    expect((await GET(get("kind=meals&format=csv"))).status).toBe(429);
    for (let i = 0; i < 7; i += 1) {
      expect((await GET(get(`kind=meals&format=csv&cursor=c${i}`))).status).toBe(200);
    }
  });

  it("does not spend the hourly first-page budget on continuations", async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await GET(get(`kind=meals&format=csv&cursor=c${i}`))).status).toBe(200);
    }
    expect((await GET(get("kind=meals&format=csv"))).status).toBe(200);
  });

  it("caps continuations at seventy an hour", async () => {
    for (let i = 0; i < 70; i += 1) {
      expect((await GET(get(`kind=meals&format=csv&cursor=c${i}`))).status).toBe(200);
    }
    expect((await GET(get("kind=meals&format=csv&cursor=c70"))).status).toBe(429);
  });

  it("counts an empty cursor as a first page", async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await GET(get("kind=meals&format=csv&cursor="))).status).toBe(200);
    }
    expect((await GET(get("kind=meals&format=csv"))).status).toBe(429);
  });
});

describe("GET /api/export — kind=weight buffered pagination", () => {
  beforeEach(() => {
    resetRateLimits();
    user.mockResolvedValue({ userId: "user-1", client: {} as never });
  });

  it("orders by a unique tie-breaker in addition to start_time", async () => {
    const { client, orderCalls } = fakeClient({ data: [], error: null });
    user.mockResolvedValue({ userId: "user-1", client: client as never });
    const res = await GET(get("kind=weight&format=json&page=0"));
    expect(res.status).toBe(200);
    // start_time alone is not unique (two weigh-ins can share a timestamp); a second .order()
    // call on a unique column (e.g. id) is required for stable pagination across pages.
    expect(orderCalls.length).toBeGreaterThan(1);
    const tieBreakerColumns = orderCalls.slice(1).map((args) => args[0]);
    expect(tieBreakerColumns).toContain("id");
  });
});
