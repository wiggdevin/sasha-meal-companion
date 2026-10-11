// tests/sync/ops-route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncOp } from "@/lib/sync/types";

const rpc = vi.fn();
const requireUser = vi.fn();
const enforceRateLimit = vi.fn();
const recomputeDerivedTarget = vi.fn();

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return { ...actual, requireUser: (req: Request) => requireUser(req) };
});
vi.mock("@/lib/server/ratelimit", () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
}));

vi.mock("@/lib/server/target-recompute", () => ({
  recomputeDerivedTarget: (...args: unknown[]) => recomputeDerivedTarget(...args),
}));

const { POST } = await import("@/app/api/sync/ops/route");
const { HttpError } = await import("@/lib/server/auth");

/** The JWT subject the mocked requireUser answers with. Phase 9 §0.5: ops carry their owner. */
const USER = "99999999-9999-4999-8999-999999999999";
type OwnedOp = SyncOp & { user_id?: string };
const withoutOwner = ({ user_id: _owner, ...rest }: OwnedOp): SyncOp => { void _owner; return rest; };

const op = (over: Partial<OwnedOp> = {}): OwnedOp => ({
  user_id: USER, op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-09-11", kind: "update",
  base_rev: 1, payload: { local_date: "2026-09-11", cups: 4 },
  client_ts: "2026-09-11T10:00:00.000Z", ...over,
});

const membershipOp = (
  status: "eats" | "avoid" | null,
  rev = 1_800_000_000_000,
): OwnedOp => op({
  entity: "food_membership",
  entity_id: "6f2d1a3c-0b1e-4d2a-9a3b-1c2d3e4f5a6b",
  base_rev: null,
  payload: {
    id: "6f2d1a3c-0b1e-4d2a-9a3b-1c2d3e4f5a6b",
    name_norm: "watermelon",
    status,
    note: "try again later",
    rev,
  },
});

const request = (body: unknown) => new Request("https://x.test/api/sync/ops", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  rpc.mockReset();
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  requireUser.mockReset().mockResolvedValue({ userId: USER, client: { rpc } });
  recomputeDerivedTarget.mockReset().mockResolvedValue({ status: "unchanged" });
});

describe("POST /api/sync/ops target recompute (#330)", () => {
  const settingsOp = () => op({ entity: "user_settings", entity_id: USER,
    payload: { activity_level: "light" } });

  it("re-derives the target once per batch after a user_settings op applies", async () => {
    rpc.mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "applied", rev: 2, seq: 1 }, error: null }));
    const res = await POST(request({ ops: [settingsOp(), settingsOp(), op()] }));
    expect(res.status).toBe(200);
    expect(recomputeDerivedTarget).toHaveBeenCalledTimes(1);
    expect(recomputeDerivedTarget).toHaveBeenCalledWith({ rpc }, USER,
      { clientDay: null, requestZone: null });
  });

  it("dates the recompute by the phone's day and zone the batch carries (t24b)", async () => {
    rpc.mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "applied", rev: 2, seq: 1 }, error: null }));
    await POST(request({ ops: [settingsOp()], local_date: "2026-10-05",
      time_zone: "America/Denver" }));
    expect(recomputeDerivedTarget).toHaveBeenCalledWith({ rpc }, USER,
      { clientDay: "2026-10-05", requestZone: "America/Denver" });
  });

  it("drops a malformed phone day instead of failing the batch", async () => {
    rpc.mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "applied", rev: 2, seq: 1 }, error: null }));
    const res = await POST(request({ ops: [settingsOp()], local_date: "tomorrow", time_zone: 7 }));
    expect(res.status).toBe(200);
    expect(recomputeDerivedTarget).toHaveBeenCalledWith({ rpc }, USER,
      { clientDay: null, requestZone: null });
  });

  it("recomputes after a conflict too: the stored row may be newer than the last derivation", async () => {
    rpc.mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "conflict", entity: "user_settings",
        current_rev: 3, current: {} }, error: null }));
    await POST(request({ ops: [settingsOp()] }));
    expect(recomputeDerivedTarget).toHaveBeenCalledTimes(1);
  });

  it("recomputes after a settings op error too: the row may have committed before the error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await POST(request({ ops: [settingsOp()] }));
    expect(recomputeDerivedTarget).toHaveBeenCalledTimes(1);
    vi.mocked(console.error).mockRestore();
  });

  it("does not recompute for a settings op refused for its owner", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await POST(request({ ops: [{ ...settingsOp(), user_id: "11111111-1111-4111-8111-111111111111" }] }));
    expect(recomputeDerivedTarget).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    vi.mocked(console.error).mockRestore();
  });

  it("does not recompute when no settings op ran", async () => {
    rpc.mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "applied", rev: 2, seq: 1 }, error: null }));
    await POST(request({ ops: [op()] }));
    expect(recomputeDerivedTarget).not.toHaveBeenCalled();
  });

  it("logs an unsettled recompute and still answers 200", async () => {
    rpc.mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "applied", rev: 2, seq: 1 }, error: null }));
    recomputeDerivedTarget.mockResolvedValue({ status: "unsettled", rounds: 4, active: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await POST(request({ ops: [settingsOp()] }));
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsettled"));
    warn.mockRestore();
  });

  it("keeps the applied result when the recompute fails", async () => {
    rpc.mockImplementation(async (_name: string, args: { p_op: SyncOp }) => ({
      data: { op_id: args.p_op.op_id, status: "applied", rev: 2, seq: 1 }, error: null }));
    recomputeDerivedTarget.mockRejectedValue(new Error("write_target_revision failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(request({ ops: [settingsOp()] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ results: [{ status: "applied" }] });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/target recompute for .+ failed/));
    error.mockRestore();
  });
});

describe("POST /api/sync/ops", () => {
  it("returns 401 when there is no session", async () => {
    requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
    const res = await POST(request({ ops: [op()] }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rate-limits at 60 a minute, keyed by the user", async () => {
    rpc.mockResolvedValue({ data: { op_id: "x", status: "gone" }, error: null });
    await POST(request({ ops: [op()] }));
    expect(enforceRateLimit).toHaveBeenCalledWith(`sync:ops:${USER}`, 60, 60);
  });

  it("rejects a bad op shape with 400 and never echoes the body", async () => {
    const res = await POST(request({ ops: [{ ...op(), kind: "obliterate" }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "bad_request" });
    expect(JSON.stringify(body)).not.toContain("obliterate");
  });

  it("rejects more than 200 ops", async () => {
    expect((await POST(request({ ops: Array.from({ length: 201 }, () => op()) }))).status).toBe(400);
  });

  it("calls apply_sync_op once per op, in array order, and returns the results", async () => {
    const a = op();
    const id = "6f2d1a3c-0b1e-4d2a-9a3b-1c2d3e4f5a6b";
    const b = op({ entity: "gut_log", entity_id: id, payload: { id, state: "good" } });
    rpc
      .mockResolvedValueOnce({ data: { op_id: a.op_id, status: "applied", rev: 2, seq: 8 }, error: null })
      .mockResolvedValueOnce({ data: { op_id: b.op_id, status: "duplicate" }, error: null });
    const res = await POST(request({ ops: [a, b] }));
    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0]).toEqual(["apply_sync_op", { p_user_id: USER, p_op: withoutOwner(a) }]);
    expect(rpc.mock.calls.map((c) => c[1].p_op.op_id)).toEqual([a.op_id, b.op_id]);
    const body = await res.json();
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(["applied", "duplicate"]);
    expect(typeof body.server_time).toBe("string");
  });

  it("dispatches a logical membership op to the normalized-name RPC", async () => {
    const membership = membershipOp(null);
    rpc.mockResolvedValue({ data: { rev: 1_800_000_000_000, status: null }, error: null });

    const res = await POST(request({ ops: [membership] }));

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("set_food_membership", {
      p_user: USER,
      p_name_norm: "watermelon",
      p_status: null,
      p_note: "try again later",
      p_rev: 1_800_000_000_000,
      // W029: the op id, so the server answers a retry from its ledger.
      p_op_id: membership.op_id,
    });
    await expect(res.json()).resolves.toMatchObject({
      results: [{ op_id: membership.op_id, status: "applied", rev: 1_800_000_000_000, seq: 0 }],
    });
  });

  it("reports a stale membership revision as rejected with the server state", async () => {
    const membership = membershipOp("avoid", 100);
    rpc.mockResolvedValue({ data: { rev: 200, status: "eats" }, error: null });

    const res = await POST(request({ ops: [membership] }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      results: [{
        op_id: membership.op_id,
        status: "rejected",
        user_id: USER,
        name_norm: "watermelon",
        current_status: "eats",
        current_rev: 200,
      }],
    });
  });

  it("one name-wide RPC updates every same-name ref and neutral clears them all", async () => {
    const prefs = new Map([
      ["ref-user", { name: "watermelon", status: "eats" as "eats" | "avoid" }],
      ["ref-catalog-1", { name: "watermelon", status: "eats" as "eats" | "avoid" }],
      ["ref-catalog-2", { name: "watermelon", status: "eats" as "eats" | "avoid" }],
      ["ref-juice", { name: "watermelon juice", status: "eats" as "eats" | "avoid" }],
    ]);
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("set_food_membership");
      for (const [ref, row] of [...prefs]) {
        if (row.name !== args.p_name_norm) continue;
        if (args.p_status === null) prefs.delete(ref);
        else prefs.set(ref, { ...row, status: args.p_status as "eats" | "avoid" });
      }
      return { data: { rev: args.p_rev, status: args.p_status }, error: null };
    });

    await POST(request({ ops: [membershipOp("avoid", 100)] }));
    expect([...prefs.values()].filter((row) => row.name === "watermelon"))
      .toHaveLength(3);
    expect([...prefs.values()].filter((row) => row.name === "watermelon")
      .every((row) => row.status === "avoid")).toBe(true);
    expect(prefs.get("ref-juice")?.status).toBe("eats");

    await POST(request({ ops: [membershipOp(null, 101)] }));
    expect([...prefs.values()].filter((row) => row.name === "watermelon")).toEqual([]);
    expect(prefs.get("ref-juice")?.status).toBe("eats");
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("turns a single op's RPC error into an 'error' result, not a 500 for the whole batch", async () => {
    const failing = op();
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock on log_entries", code: "40P01" } });
    const res = await POST(request({ ops: [failing] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // W026 (A137): a deadlock is the database's moment, not the op's fault.
    expect(body.results).toEqual([
      { op_id: failing.op_id, status: "error", message: "deadlock on log_entries", retryable: true },
    ]);
  });

  it("keeps applying later ops after an earlier one errors, and never throws past the first success", async () => {
    const a = op();
    const b = op({ entity: "gut_log", entity_id: "6f2d1a3c-0b1e-4d2a-9a3b-1c2d3e4f5a6b" });
    rpc
      .mockResolvedValueOnce({ data: { op_id: a.op_id, status: "applied", rev: 2, seq: 8 }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "check failed on gut_log", code: "23514" } });
    const res = await POST(request({ ops: [a, b] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { op_id: a.op_id, status: "applied", rev: 2, seq: 8 },
      { op_id: b.op_id, status: "error", message: "check failed on gut_log" },
    ]);
  });

  it.each([
    ["57014", true], ["08006", true], ["40001", true], ["53300", true], ["55P03", true],
    ["PGRST003", true], ["", true], ["23505", false], ["22023", false], ["PGRST202", false],
  ])("marks an RPC error with code %j retryable: %s (W026, A137)", async (code, retryable) => {
    const failing = op();
    rpc.mockResolvedValue({ data: null, error: { message: "failed", code } });
    const body = await (await POST(request({ ops: [failing] }))).json();
    expect(body.results[0].retryable === true).toBe(retryable);
  });

  it("names the deployment that answered, so a parked op can be released by a new one (W026)", async () => {
    const before = process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    try {
      const applied = op();
      rpc.mockResolvedValue({ data: { op_id: applied.op_id, status: "applied", rev: 2, seq: 1 }, error: null });
      const body = await (await POST(request({ ops: [applied] }))).json();
      expect(body.server_build).toBe("abc123");
    } finally {
      if (before === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
      else process.env.VERCEL_GIT_COMMIT_SHA = before;
    }
  });

  it("turns a null RPC result into an 'error' result instead of pushing it on the wire", async () => {
    const failing = op();
    rpc.mockResolvedValue({ data: null, error: null });
    const res = await POST(request({ ops: [failing] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      results: [{ op_id: failing.op_id, status: "error", message: "malformed rpc result" }],
    });
  });

  it("rejects an RPC result that is missing op_id or status", async () => {
    const failing = op();
    rpc.mockResolvedValue({ data: { rev: 2 }, error: null });
    const body = await (await POST(request({ ops: [failing] }))).json();
    expect(body.results).toEqual([
      { op_id: failing.op_id, status: "error", message: "malformed rpc result" },
    ]);
  });

  it("logs the op that failed, with its id and entity", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = op();
    rpc.mockResolvedValue({ data: null, error: { message: "deadlock on water_log" } });
    await POST(request({ ops: [failing] }));
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain(failing.op_id);
    expect(logged).toContain("water_log");
    error.mockRestore();
  });

  it("catches a thrown exception from one op's rpc call the same way as a driver error", async () => {
    const failing = op();
    rpc.mockImplementation(async () => { throw new Error("connection reset"); });
    const res = await POST(request({ ops: [failing] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([{ op_id: failing.op_id, status: "error", message: "connection reset" }]);
  });
});

describe("POST /api/sync/ops function config (scale S1)", () => {
  it("runs on node beside the database, with no duration cap until a full batch is measured", async () => {
    const mod: Record<string, unknown> = await import("@/app/api/sync/ops/route");
    expect(mod.runtime).toBe("nodejs");
    expect(mod.preferredRegion).toEqual(["sfo1"]);
    expect(mod.maxDuration).toBeUndefined();
  });
});
