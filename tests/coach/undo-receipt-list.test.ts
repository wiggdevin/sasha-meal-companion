/**
 * The Undo list's read side for receipts (docs/specs/coach-undo-receipt.md §6.4, §6.5) and the
 * refusal codes (§4.5), against an in-memory stand-in for the caller's RLS-scoped client:
 *
 * - R1-5: a 500-record page with 500 receipts lists 500 complete cards; a failed receipt page fails
 *   the whole request (500 undo_store_failed) and returns no card.
 * - U1 (server half): a legacy set_slot_meal record lists exactly once, as the generic card, and
 *   the list never reads a coach message to infer one.
 * - Receipt records refuse `local` (409 undo_receipt_record) and pass the database's own refusals.
 *
 * The real tables, RLS and functions are proven in tests/coach/undo-receipt-local.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_LIMIT, listUndos, performUndo, recordUndo } from "@/lib/server/coach-undo";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), requireUser: vi.fn(),
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/capabilities", async (original) => ({
  ...(await original<typeof import("@/lib/capabilities")>()), coachEnabled: () => true,
}));

const { requireUser } = await import("@/lib/server/auth");
const { GET: listRoute } = await import("@/app/api/coach/undo/route");
const { POST: undoRoute } = await import("@/app/api/coach/undo/[id]/route");

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000011";
const NOW = new Date("2026-10-05T12:00:00.000Z");

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function undoRow(n: number, over: Row = {}): Row {
  return { id: uuid(n), user_id: A, thread_id: null, message_id: null, action_id: `act-${n}`,
    kind: "log_meal", inverse: {}, expected_rev: null, created_at: `2026-10-05T10:00:00.${String(n % 1000)
      .padStart(3, "0")}Z`, undone_at: null, expires_at: "2026-10-12T10:00:00.000Z",
    record_mode: "receipt_v1", source_check: "match", ...over };
}

function receiptRow(n: number): Row {
  return { id: uuid(100_000 + n), user_id: A, action_id: `act-${n}`, kind: "log_meal",
    source: { messageId: MESSAGE, cardIndex: 0 }, source_check: "match",
    applied: { entryId: uuid(200_000 + n), date: "2026-10-05", slot: "snack",
      eatenAt: "2026-10-05T10:00:00Z", rev: 1, title: null,
      items: [{ itemId: uuid(300_000 + n), foodRefId: uuid(9), name: "Eggs", grams: 100 }] } };
}

/** The session client: reads scoped to `uid` (RLS), `.in` and `.range` as PostgREST pages them. */
function makeClient(db: Db, uid: string) {
  const reads: string[] = [];
  const failing = new Set<string>();
  const rpc = vi.fn(async (_name: string, _args: Row): Promise<{ data: unknown; error: unknown }> =>
    ({ data: { status: "undone", undone_at: NOW.toISOString() }, error: null }));
  const from = (table: string) => {
    reads.push(table);
    const filters: ((row: Row) => boolean)[] = [(row) => row.user_id === uid];
    const orders: [string, boolean][] = [];
    let window: [number, number] = [0, Infinity];
    const run = () => {
      if (failing.has(table)) return { data: null, error: { message: `${table} read failed` } };
      const rows = (db[table] ?? []).filter((row) => filters.every((f) => f(row)));
      rows.sort((x, y) => {
        for (const [col, asc] of orders) {
          const c = String(x[col]).localeCompare(String(y[col]));
          if (c !== 0) return asc ? c : -c;
        }
        return 0;
      });
      return { data: rows.slice(window[0], window[1] + 1).map((r) => ({ ...r })), error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
      or: () => chain,
      order: (col: string, opts?: { ascending?: boolean }) => {
        orders.push([col, opts?.ascending !== false]); return chain;
      },
      limit: (n: number) => { window = [0, n - 1]; return chain; },
      range: (lo: number, hi: number) => { window = [lo, hi]; return chain; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return chain;
  };
  return { client: { from, rpc } as never, rpc, reads, failing };
}

let db: Db;
let a: ReturnType<typeof makeClient>;

beforeEach(() => {
  db = { coach_action_undos: [], coach_action_receipts: [], coach_messages: [] };
  a = makeClient(db, A);
  vi.mocked(requireUser).mockResolvedValue({ userId: A, client: a.client } as never);
});

const listReq = () => new Request("http://local/api/coach/undo");
const undoReq = (id: string, body: object = {}) => [new Request(`http://local/api/coach/undo/${id}`,
  { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
{ params: Promise.resolve({ id }) }] as const;

describe("the receipt read behind the Undo list", () => {
  it("R1-5: a 500-record page with 500 receipts lists 500 complete cards", async () => {
    for (let n = 0; n < LIST_LIMIT; n += 1) {
      db.coach_action_undos.push(undoRow(n));
      db.coach_action_receipts.push(receiptRow(n));
    }
    const page = await listUndos(a.client, A, {}, NOW);
    expect(page.undos).toHaveLength(LIST_LIMIT);
    expect(page.undos.every((u) => u.card.type === "receipt" && u.card.complete && u.serverUndoable))
      .toBe(true);
    const first = page.undos.find((u) => u.actionId === "act-7");
    expect(first?.target).toEqual({ date: "2026-10-05", entryId: uuid(200_007) });
    // Chunked by IN_CHUNK_SIZE (150): four receipt reads.
    expect(a.reads.filter((t) => t === "coach_action_receipts")).toHaveLength(4);
  });

  it("R1-5: a failed receipt page fails the request whole, with no card", async () => {
    for (let n = 0; n < 3; n += 1) {
      db.coach_action_undos.push(undoRow(n));
      db.coach_action_receipts.push(receiptRow(n));
    }
    a.failing.add("coach_action_receipts");
    const res = await listRoute(listReq());
    expect(res.status).toBe(500);
    const body = await res.json() as Row;
    expect(body.error).toBe("undo_store_failed");
    expect(body.undos).toBeUndefined();
  });

  it("a receipt record whose receipt the read did not hold is incomplete and phone-free of server Undo", async () => {
    db.coach_action_undos.push(undoRow(1));
    const [view] = (await listUndos(a.client, A, {}, NOW)).undos;
    expect(view.card).toMatchObject({ type: "receipt", complete: false });
    expect(view.serverUndoable).toBe(false);
    expect(view.target).toBeUndefined();
  });

  it("U1: a legacy set_slot_meal record lists once, as the generic card, without reading a message", async () => {
    db.coach_messages.push({ id: MESSAGE, user_id: A, tool_calls: { composed: [
      { wish: "eggs", slot: "meal-3", items: [{ foodRefId: "egg", grams: 100 }] },
      { wish: "eggs", slot: "meal-2", pendingSlots: [{ slot: "meal-3" }], items: [{ foodRefId: "egg", grams: 100 }] }] } });
    db.coach_action_undos.push(undoRow(1, { kind: "set_slot_meal", record_mode: "legacy", source_check: null,
      message_id: MESSAGE, inverse: { kind: "set_slot_meal", date: "2026-10-05", slot: "meal-3" } }));
    const page = await listUndos(a.client, A, {}, NOW);
    expect(page.undos).toHaveLength(1);
    expect(page.undos[0].card).toEqual({ type: "generic", kind: "set_slot_meal", title: "Coach change" });
    expect(page.undos[0].serverUndoable).toBe(false);
    expect(a.reads).not.toContain("coach_messages");
    expect(a.reads).not.toContain("coach_action_receipts");
  });

  it("a record from a database before the receipt steps (no record_mode) reads legacy", async () => {
    const row = undoRow(1, { kind: "log_water", inverse: { kind: "log_water", date: "2026-10-05", cups: 2,
      after: 6, afterRev: 2 } });
    delete row.record_mode;
    delete row.source_check;
    db.coach_action_undos.push(row);
    const [view] = (await listUndos(a.client, A, {}, NOW)).undos;
    expect(view.card.type).toBe("generic");
    expect(view.serverUndoable).toBe(true);
  });
});

describe("receipt record refusals", () => {
  it("R2-1: local on a receipt record answers 409 undo_receipt_record and never reaches the database", async () => {
    db.coach_action_undos.push(undoRow(1));
    db.coach_action_receipts.push(receiptRow(1));
    const res = await undoRoute(...undoReq(uuid(1), { local: true }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe("undo_receipt_record");
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["undo_receipt_mismatch", 409], ["undo_receipt_inconsistent", 422], ["undo_source_mismatch", 422],
    ["undo_conflict", 409], ["undo_not_synced", 409],
  ])("passes the database's %s as %i", async (code, status) => {
    db.coach_action_undos.push(undoRow(1, { source_check: "mismatch" }));
    a.rpc.mockResolvedValueOnce({ data: null, error: { message: code, code: "P0001" } });
    const res = await undoRoute(...undoReq(uuid(1)));
    expect(res.status).toBe(status);
    expect(((await res.json()) as Row).error).toBe(code);
    expect(a.rpc).toHaveBeenCalledWith("perform_coach_undo", { p_undo_id: uuid(1), p_local: false });
  });

  it("a server Undo of a receipt record answers its card and the entry it removed", async () => {
    db.coach_action_undos.push(undoRow(1));
    db.coach_action_receipts.push(receiptRow(1));
    const view = await performUndo(a.client, A, uuid(1), {}, NOW);
    expect(view.undoneAt).toBe(NOW.toISOString());
    expect(view.serverUndoable).toBe(false);
    expect(view.card).toMatchObject({ type: "receipt", complete: true });
    expect(view.target).toEqual({ date: "2026-10-05", entryId: uuid(200_001) });
  });

  it("R2-1: an undone mark on a receipt record answers 409 undo_receipt_record", async () => {
    a.rpc.mockResolvedValueOnce({ data: null, error: { message: "undo_receipt_record", code: "P0001" } });
    await expect(recordUndo(a.client, A, { actionId: "act-1", kind: "log_meal",
      token: { kind: "log_meal" }, undone: true })).rejects.toMatchObject(
      { status: 409, code: "undo_receipt_record" });
  });
});
