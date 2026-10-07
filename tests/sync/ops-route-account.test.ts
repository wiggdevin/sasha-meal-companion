// Phase 9 §0.5 (plan decision P8, reversed in round 2): the server applies an op only when it
// names its owner and that owner is the JWT subject. Anything else is an `error` result, which an
// old build parks and keeps (never deletes), and nothing is written.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncOp } from "@/lib/sync/types";

const rpc = vi.fn();
const requireUser = vi.fn();

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));

const { POST } = await import("@/app/api/sync/ops/route");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type OwnedOp = SyncOp & { user_id?: string };
const waterOp = (over: Partial<OwnedOp> = {}): OwnedOp => ({
  op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-09-22", kind: "update",
  base_rev: 1, payload: { local_date: "2026-09-22", cups: 3 },
  client_ts: "2026-09-22T10:00:00.000Z", ...over,
});
const request = (body: unknown) => new Request("https://x.test/api/sync/ops", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  rpc.mockReset();
  requireUser.mockReset().mockResolvedValue({ userId: B, client: { rpc } });
});

describe("POST /api/sync/ops account check", () => {
  it("refuses an op stamped for another account with error/account_mismatch and applies nothing", async () => {
    const res = await POST(request({ ops: [waterOp({ user_id: A })] }));
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ status: "error", message: "account_mismatch" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses an op with no user_id with error/account_unbound and applies nothing", async () => {
    const res = await POST(request({ ops: [waterOp()] }));
    expect((await res.json()).results[0]).toMatchObject({ status: "error", message: "account_unbound" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("applies an op stamped for the JWT user, without user_id in p_op", async () => {
    rpc.mockResolvedValue({ data: { op_id: "x", status: "applied", rev: 2, seq: 1 }, error: null });
    await POST(request({ ops: [waterOp({ user_id: B })] }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_op).not.toHaveProperty("user_id");
  });

  it("judges each op on its own: a stale op does not stop the owned one after it", async () => {
    rpc.mockResolvedValue({ data: { op_id: "x", status: "applied", rev: 2, seq: 1 }, error: null });
    const res = await POST(request({ ops: [waterOp({ user_id: A }), waterOp({ user_id: B })] }));
    const body = await res.json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(["error", "applied"]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
