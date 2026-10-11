/**
 * W017 (audit 2026-10-10 A033, A030): a queued log write drained through /api/sync/ops gets the
 * commit's policy marks, and a queued label commit goes through the commit path whole so its
 * placeholder becomes the account's own food.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABEL_FOOD_PLACEHOLDER_REF } from "@/lib/capture/label-food";
import type { OpResult, SyncOp } from "@/lib/sync/types";

const rpc = vi.fn();
const requireUser = vi.fn();
const applyLogEntry = vi.fn();
const storedEntryFlags = vi.fn();

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
const stamp = vi.fn(async () => undefined);
vi.mock("@/lib/server/log-occasion", () => ({
  stampLogOccasionsSafely: (...args: unknown[]) => stamp(...(args as [])),
}));
vi.mock("@/lib/server/log", () => ({
  applyLogEntry: (...args: unknown[]) => applyLogEntry(...args),
  storedEntryFlags: (...args: unknown[]) => storedEntryFlags(...args),
}));

const { POST } = await import("@/app/api/sync/ops/route");

const USER = "99999999-9999-4999-8999-999999999999";
const ENTRY = "20000000-0000-4000-8000-000000000001";
const FLAG = { path: "items.0", message: "blocked:allergen:gluten" };

const logOp = (over: Partial<SyncOp> = {}): SyncOp & { user_id: string } => ({
  user_id: USER, op_id: crypto.randomUUID(), entity: "log_entries", entity_id: ENTRY,
  kind: "create", base_rev: null, client_ts: "2026-09-11T10:00:00.000Z",
  payload: { id: ENTRY, entry_id: ENTRY, local_date: "2026-09-11", items: [
    { id: "i1", seq: 1, food_ref_id: "30000000-0000-4000-8000-000000000001" }] },
  ...over,
});

async function post(ops: unknown[]): Promise<OpResult[]> {
  const res = await POST(new Request("https://x.test/api/sync/ops", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }),
  }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: OpResult[] }).results;
}

beforeEach(() => {
  rpc.mockReset().mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
    data: { op_id: args.p_op.op_id, status: "applied", rev: 1, seq: 4 }, error: null }));
  requireUser.mockReset().mockResolvedValue({ userId: USER, client: { rpc } });
  applyLogEntry.mockReset();
  stamp.mockClear();
  storedEntryFlags.mockReset().mockResolvedValue([FLAG]);
});

describe("POST /api/sync/ops — queued log writes (A033)", () => {
  it("answers an applied log create with the commit's marks", async () => {
    const [result] = await post([logOp()]);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "applied", rev: 1, flagged: [FLAG] });
    expect(storedEntryFlags).toHaveBeenCalledWith({ rpc }, USER, ENTRY);
  });

  it("marks a replayed create too, and leaves deletes and other entities alone", async () => {
    rpc.mockImplementationOnce(async (_n: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "duplicate" }, error: null }));
    const results = await post([logOp(), logOp({ kind: "delete", payload: {} }),
      logOp({ entity: "water_log", entity_id: "2026-09-11", kind: "update", base_rev: 1,
        payload: { local_date: "2026-09-11", cups: 4 } })]);
    expect(results[0]).toMatchObject({ status: "duplicate", flagged: [FLAG] });
    expect(results[1]).not.toHaveProperty("flagged");
    expect(results[2]).not.toHaveProperty("flagged");
    expect(storedEntryFlags).toHaveBeenCalledTimes(1);
  });

  it("keeps the applied result when the marks cannot be read", async () => {
    storedEntryFlags.mockRejectedValueOnce(new Error("policy read failed"));
    const [result] = await post([logOp()]);
    expect(result).toMatchObject({ status: "applied", rev: 1 });
    expect(result).not.toHaveProperty("flagged");
  });
});

describe("POST /api/sync/ops — queued label commit (A030)", () => {
  const labelOp = () => logOp({ payload: { id: ENTRY, entry_id: ENTRY, method: "label",
    save_label_as_food: true, label_food: { name: "Crackers", per100g: {}, allergenTags: [] },
    items: [{ id: "i1", seq: 1, food_ref_id: LABEL_FOOD_PLACEHOLDER_REF }] } });

  it("applies it through the commit path, label food and marks included", async () => {
    applyLogEntry.mockResolvedValue({ status: "ok", entry_id: ENTRY, rev: 1, items: [],
      totals: {}, flagged: [FLAG] });
    const op = labelOp();
    const [result] = await post([op]);
    expect(result).toEqual({ op_id: op.op_id, status: "applied", rev: 1, seq: 0, flagged: [FLAG] });
    expect(rpc).not.toHaveBeenCalled();
    expect(applyLogEntry).toHaveBeenCalledWith({ rpc }, USER, op.payload,
      { labelFood: op.payload.label_food });
    // The commit path stamps its own write; a replay answered "ok" must not be restamped here.
    expect(stamp).not.toHaveBeenCalled();
  });

  it("parks a refused label commit as an error rather than applying the placeholder", async () => {
    applyLogEntry.mockResolvedValue({ status: "stale_revision", food_ref_id: "x", revision_id: 2 });
    const [result] = await post([labelOp()]);
    expect(result).toMatchObject({ status: "error", message: "stale_revision" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
