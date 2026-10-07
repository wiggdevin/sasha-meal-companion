/**
 * UI-NEEDS SPROUT-CARE item 2: POST /api/care/purchase and POST /api/care/equip at the route
 * edge, with the session client's RPC mocked. The database behaviour itself (the advisory lock,
 * idempotency, balance/ownership checks) is proven against Postgres by tests/tenancy/rpc-matrix
 * (care_purchase / care_equip cases) and is the Orchestrator's to run once the migrations land.
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
const purchase = await import("@/app/api/care/purchase/route");
const equip = await import("@/app/api/care/equip/route");

const rpc = vi.fn();

function post(path: string, body: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const buy = (body: unknown) => purchase.POST(post("/api/care/purchase", body));
const wear = (body: unknown) => equip.POST(post("/api/care/equip", body));

beforeEach(() => {
  resetRateLimits();
  rpc.mockReset();
  vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: { rpc } as never });
});
afterEach(() => { vi.restoreAllMocks(); });

const ACTION = "6f1c2f0e-4b7a-4a8e-9d2b-0c7d5e2a9b11";

describe("POST /api/care/purchase", () => {
  it("refuses a malformed body with 400 and calls no RPC", async () => {
    const response = await buy({ itemId: "leaf-pin", actionId: "not-a-uuid" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("bad_request");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps an applied receipt to 200", async () => {
    rpc.mockResolvedValue({ data: { status: "applied",
      receipt: { actionId: ACTION, itemId: "leaf-pin", price: 10, balance: 2 } }, error: null });
    const response = await buy({ itemId: "leaf-pin", actionId: ACTION });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "applied",
      receipt: { actionId: ACTION, itemId: "leaf-pin", price: 10, balance: 2 } });
    expect(rpc).toHaveBeenCalledWith("care_purchase", { p_user_id: "u1", p_item_id: "leaf-pin",
      p_action_id: ACTION, p_local_date: "2041-01-05", p_zone: "UTC" });
  });

  it("maps insufficient without treating it as an error", async () => {
    rpc.mockResolvedValue({ data: { status: "insufficient", short: 8 }, error: null });
    const response = await buy({ itemId: "leaf-pin", actionId: ACTION });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "insufficient", short: 8 });
  });

  it("answers 502 when the database returns an unrecognized shape", async () => {
    rpc.mockResolvedValue({ data: { status: "applied", receipt: { actionId: ACTION } }, error: null });
    const response = await buy({ itemId: "leaf-pin", actionId: ACTION });
    expect(response.status).toBe(502);
  });
});

describe("POST /api/care/equip", () => {
  it("refuses an unknown slot with 400 and calls no RPC", async () => {
    const response = await wear({ slot: "tail", itemId: null });
    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps a conflict to 200 with the current state, not an error", async () => {
    rpc.mockResolvedValue({ data: { status: "conflict", equipped: { pin: "leaf-pin" }, rev: 3 }, error: null });
    const response = await wear({ slot: "pin", itemId: "leaf-pin", rev: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "conflict", equipped: { pin: "leaf-pin" }, rev: 3 });
  });

  it("sends a null rev when the caller omits it", async () => {
    rpc.mockResolvedValue({ data: { status: "ok", equipped: {}, rev: 0 }, error: null });
    await wear({ slot: "pin", itemId: null });
    expect(rpc).toHaveBeenCalledWith("care_equip", { p_user_id: "u1", p_slot: "pin", p_item_id: null, p_rev: null });
  });
});
