/**
 * UI-NEEDS SPROUT-CARE items 1, 3, 4, 6: GET /api/care/points, GET/POST /api/care/accolades*,
 * GET/POST /api/care/messages*, GET /api/care/log-growth, with the session client mocked. The
 * RPC/eligibility behaviour itself is proven against Postgres by tests/tenancy/rpc-matrix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));
vi.mock("@/lib/server/account-day", async (original) => ({
  ...(await original<typeof import("@/lib/server/account-day")>()),
  accountDay: vi.fn(async () => ({ date: "2041-01-05", zone: "UTC", source: "request_zone" as const })),
  readAccountZone: vi.fn(async () => "UTC"),
}));

const { requireUser } = await import("@/lib/server/auth");
const points = await import("@/app/api/care/points/route");
const accolades = await import("@/app/api/care/accolades/route");
const accoladesSeen = await import("@/app/api/care/accolades/seen/route");
const messages = await import("@/app/api/care/messages/route");
const messageRead = await import("@/app/api/care/messages/[id]/read/route");
const logGrowth = await import("@/app/api/care/log-growth/route");

const rpc = vi.fn();
const from = vi.fn();

function get(path: string): Request {
  return new Request(`https://app.test${path}`);
}
function post(path: string, body: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

/** A chainable `.from(table).select().eq().order().limit()/is()/...` that always resolves to `rows`. */
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ["select", "eq", "order", "limit", "is", "in"]) chain[method] = vi.fn(self);
  chain.maybeSingle = vi.fn(async () => ({ data: rows[0] ?? null, error: null }));
  chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) => resolve({ data: rows, error: null });
  return chain;
}

beforeEach(() => {
  resetRateLimits();
  rpc.mockReset();
  from.mockReset();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: { rpc, from } as never });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("GET /api/care/points", () => {
  it("syncs, then answers the whole-ledger totals from care_balance and the newest rows", async () => {
    rpc.mockImplementation(async (name: string) => name === "care_balance"
      ? { data: { balance: 2002, pending: 1 }, error: null }
      : { data: { balance: 2002, pending: 1, awarded: [] }, error: null });
    from.mockReturnValue(selectChain([
      { id: "1", kind: "day_recorded", delta: 2, local_date: "2041-01-04", status: "settled", source: {} },
      { id: "2", kind: "water_goal", delta: 1, local_date: "2041-01-05", status: "pending", source: {} },
    ]));
    const response = await points.GET(get("/api/care/points"));
    expect(response.status).toBe(200);
    // W067 (audit A106): the totals are care_balance's SQL sum over every row, not a JS sum of
    // the rows a select returned (the API's 1,000-row cap cut that short; 1,001+ rows are proven
    // against Postgres in tests/care/care-ledger-db.test.ts).
    expect(await response.json()).toEqual({ balance: 2002, pending: 1, recent: [
      { id: "1", kind: "day_recorded", delta: 2, localDate: "2041-01-04", status: "settled", itemId: null },
      { id: "2", kind: "water_goal", delta: 1, localDate: "2041-01-05", status: "pending", itemId: null },
    ] });
    expect(rpc).toHaveBeenCalledWith("care_points_sync", { p_user_id: "u1", p_local_date: "2041-01-05", p_zone: "UTC" });
    expect(rpc).toHaveBeenCalledWith("care_balance", { p_user_id: "u1" });
  });

  it("forwards the phone's own day to the sync; the database takes it within one date (W067, A108)", async () => {
    const { accountDay } = await import("@/lib/server/account-day");
    vi.mocked(accountDay).mockResolvedValueOnce({ date: "2041-01-06", zone: "UTC", source: "client_day" as const });
    rpc.mockImplementation(async () => ({ data: { balance: 0, pending: 0, awarded: [] }, error: null }));
    from.mockReturnValue(selectChain([]));
    const response = await points.GET(get("/api/care/points?date=2041-01-06"));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("care_points_sync", { p_user_id: "u1", p_local_date: "2041-01-06", p_zone: "UTC" });
  });

  it("answers 502, never a partial balance, when care_balance fails", async () => {
    rpc.mockImplementation(async (name: string) => name === "care_balance"
      ? { data: null, error: { code: "XX000", message: "boom" } }
      : { data: { balance: 0, pending: 0, awarded: [] }, error: null });
    from.mockReturnValue(selectChain([]));
    const response = await points.GET(get("/api/care/points"));
    expect(response.status).toBe(502);
  });
});

describe("GET /api/care/accolades", () => {
  it("syncs, then reads only unseen when asked", async () => {
    rpc.mockResolvedValue({ data: { granted: [] }, error: null });
    from.mockReturnValue(selectChain([
      { key: "first-meal", version: 1, earned_at: "2041-01-01T00:00:00Z", evidence: {}, seen_at: null },
    ]));
    const response = await accolades.GET(get("/api/care/accolades?unseen=1"));
    expect(response.status).toBe(200);
    const body = await response.json() as { accolades: unknown[] };
    expect(body.accolades).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith("care_accolades_sync", { p_user_id: "u1", p_local_date: "2041-01-05", p_zone: "UTC" });
  });
});

describe("POST /api/care/accolades/seen", () => {
  it("refuses an unknown key with 400 and calls no RPC", async () => {
    const response = await accoladesSeen.POST(post("/api/care/accolades/seen", { keys: ["not-a-key"] }));
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns the marked count", async () => {
    rpc.mockResolvedValue({ data: 2, error: null });
    const response = await accoladesSeen.POST(post("/api/care/accolades/seen", { keys: ["first-meal", "seven-days"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marked: 2 });
  });
});

describe("GET /api/care/messages", () => {
  it("excludes dismissed messages by construction (the query itself filters them)", async () => {
    const chain = selectChain([
      { id: "m1", type: "observation", payload: { text: "hi" }, created_at: "2041-01-01T00:00:00Z",
        read_at: null, dismissed_at: null },
    ]);
    from.mockReturnValue(chain);
    const response = await messages.GET(get("/api/care/messages"));
    expect(response.status).toBe(200);
    expect(chain.is).toHaveBeenCalledWith("dismissed_at", null);
  });
});

describe("POST /api/care/messages/[id]/read", () => {
  it("refuses a non-uuid id with 400 and calls no RPC", async () => {
    const response = await messageRead.POST(post("/api/care/messages/x/read", {}),
      { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("marks a real id read", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const id = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";
    const response = await messageRead.POST(post(`/api/care/messages/${id}/read`, {}),
      { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marked: true });
    expect(rpc).toHaveBeenCalledWith("care_message_mark", { p_user_id: "u1", p_id: id, p_action: "read" });
  });
});

describe("GET /api/care/log-growth", () => {
  it("refuses a missing opId with 400 and calls no RPC", async () => {
    const response = await logGrowth.GET(get("/api/care/log-growth"));
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("answers grew:false for a correction (op kind update)", async () => {
    rpc.mockResolvedValue({ data: { opId: "x", kind: "update", localDate: "2041-01-05", grew: false }, error: null });
    const id = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";
    const response = await logGrowth.GET(get(`/api/care/log-growth?opId=${id}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "update", grew: false });
  });
});
