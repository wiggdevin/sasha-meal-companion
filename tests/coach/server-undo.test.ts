/**
 * Server-recorded coach Undo (audit 2026-10-04 P1 #6, criterion C4): recording, undo from a device
 * with no local token, double undo, conflicts, another account, expiry, and the record-undone path
 * — against an in-memory stand-in for the caller's RLS-scoped Supabase client. The database
 * function's own checks and writes are proven on Postgres in tests/migrations/coach-undo-sql.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { decodeCursor, LIST_LIMIT, listUndos, performUndo, recordUndo } from "@/lib/server/coach-undo";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), requireUser: vi.fn(),
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/capabilities", async (original) => ({
  ...(await original<typeof import("@/lib/capabilities")>()), coachEnabled: () => true,
}));

const { requireUser } = await import("@/lib/server/auth");
const { GET: listRoute, POST: recordRoute } = await import("@/app/api/coach/undo/route");
const { POST: undoRoute } = await import("@/app/api/coach/undo/[id]/route");

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const THREAD = "3f1b1a2c-0000-4000-8000-000000000001";
const MESSAGE = "3f1b1a2c-0000-4000-8000-000000000011";
const ENTRY = "3f1b1a2c-0000-4000-8000-0000000000e1";
const RECIPE = "3f1b1a2c-0000-4000-8000-0000000000c1";
const DATE = "2026-10-05";
const NOW = new Date("2026-10-05T12:00:00.000Z");

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

const actions = [
  { actionId: "act-log", kind: "log_meal" },
  { actionId: "act-water", kind: "log_water", date: DATE },
  { actionId: "act-skip", kind: "skip_slot" },
  { actionId: "act-restore", kind: "restore_slot" },
  { actionId: "act-recipe", kind: "save_recipe" },
  { actionId: "act-avoid", kind: "add_to_avoid" },
  { actionId: "act-eats", kind: "add_to_eats" },
  { actionId: "act-unavoid", kind: "remove_from_avoid" },
  { actionId: "act-uneats", kind: "remove_from_eats" },
  { actionId: "act-weight", kind: "log_weight" },
];

function seed(): Db {
  return {
    coach_messages: [{ id: MESSAGE, thread_id: THREAD, user_id: A,
      tool_calls: { actions, composed: [{ wish: "eggs", items: [{ foodRefId: "egg", grams: 100 }] }] } }],
    coach_action_undos: [],
    log_entries: [{ id: ENTRY, user_id: A, rev: 3, deleted_at: null }],
    water_log: [{ user_id: A, local_date: DATE, cups: 6, rev: 2 }],
    plan_days: [],
    recipes: [{ id: RECIPE, user_id: A, rev: 1, deleted_at: null }],
    food_membership_revisions: [],
  };
}


/**
 * The caller's session client: every table read and write is scoped to `uid`, as RLS scopes it.
 * `perform_coach_undo` is a stand-in that records what it was sent and marks the record; its real
 * checks and writes are proven against Postgres in tests/migrations/coach-undo-sql.test.ts.
 */
function makeClient(db: Db, uid: string, clock: () => Date = () => NOW) {
  const outcome: { next: null | { error: string } } = { next: null };
  /** record_coach_undo: the own-message and kind checks, then the insert the trigger stamps. */
  const recordRpc = (args: Row) => {
    const existing = db.coach_action_undos.find((r) => r.user_id === uid && r.action_id === args.p_action_id);
    if (existing) {
      if (existing.kind !== args.p_kind) return { status: "kind_mismatch" };
      if (args.p_undone && !existing.undone_at) existing.undone_at = clock().toISOString();
      return { status: "ok", row: { ...existing } };
    }
    let message: Row | undefined;
    if (args.p_source_message) {
      message = db.coach_messages.find((m) => m.id === args.p_source_message && m.user_id === uid
        && (((m.tool_calls as { composed?: Row[] }).composed ?? [])[Number(args.p_source_card)]
          ?.items as unknown[] | undefined)?.length);
      if (!message) return { status: "unknown_action" };
    } else {
      message = db.coach_messages.find((m) => m.user_id === uid
        && (!args.p_thread_id || m.thread_id === args.p_thread_id)
        && ((m.tool_calls as { actions: Row[] }).actions ?? []).some((a) => a.actionId === args.p_action_id));
      if (!message) return { status: "unknown_action" };
      const issued = ((message.tool_calls as { actions: Row[] }).actions)
        .find((a) => a.actionId === args.p_action_id)!;
      if (issued.kind !== args.p_kind) return { status: "kind_mismatch" };
      const inverse = args.p_inverse as Row;
      if (["date", "slot", "name"].some((f) => typeof issued[f] === "string" && f in inverse
        && inverse[f] !== issued[f])) return { status: "target_mismatch" };
    }
    const created = clock();
    const row = { id: crypto.randomUUID(), user_id: uid, thread_id: message.thread_id,
      message_id: message.id, action_id: args.p_action_id, kind: args.p_kind, inverse: args.p_inverse,
      expected_rev: args.p_expected_rev, created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + 7 * 86_400_000).toISOString(),
      undone_at: args.p_undone ? created.toISOString() : null };
    db.coach_action_undos.push(row);
    return { status: "ok", row: { ...row } };
  };

  const rpc = vi.fn(async (name: string, args: { p_undo_id: string; p_local: boolean } & Row) => {
    if (name === "record_coach_undo") return { data: recordRpc(args), error: null };
    if (name !== "perform_coach_undo") throw new Error(`unexpected rpc ${name}`);
    const record = db.coach_action_undos.find((r) => r.id === args.p_undo_id && r.user_id === uid);
    if (!record) return { data: { status: "not_found" }, error: null };
    if (record.undone_at) return { data: { status: "already_undone" }, error: null };
    if (!args.p_local && Date.parse(String(record.expires_at)) <= clock().getTime()) {
      return { data: { status: "expired" }, error: null };
    }
    if (!args.p_local && outcome.next) {
      const { error } = outcome.next;
      outcome.next = null;
      return { data: null, error: { message: error, code: "P0001" } };
    }
    record.undone_at = clock().toISOString();
    return { data: { status: "undone", undone_at: record.undone_at }, error: null };
  });

  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [(row) => row.user_id === uid];
    let mode: "select" | "update" | "insert" = "select";
    let inserted: Row | null = null;
    let limit = Infinity;
    const run = (): { data: Row[]; error: unknown } => {
      if (mode === "insert") {
        if (inserted!.user_id !== uid) return { data: [], error: { code: "42501" } };
        if (db[table].some((r) => r.user_id === inserted!.user_id && r.action_id === inserted!.action_id)) {
          return { data: [], error: { code: "23505" } };
        }
        // The table's trigger stamps the lifetime.
        const created = clock();
        const row = { id: crypto.randomUUID(), ...inserted, created_at: created.toISOString(),
          expires_at: new Date(created.getTime() + 7 * 86_400_000).toISOString(),
          undone_at: inserted!.undone_at ? created.toISOString() : null };
        db[table].push(row);
        return { data: [row], error: null };
      }
      if (mode === "update") return { data: [], error: { code: "42501" } };
      const matched = (db[table] ?? []).filter((row) => filters.every((pick) => pick(row)));
      const sorted = orders.length === 0 ? matched : [...matched].sort((x, y) => {
        for (const [col, asc] of orders) {
          const c = String(x[col]).localeCompare(String(y[col]));
          if (c !== 0) return asc ? c : -c;
        }
        return 0;
      });
      const rows = sorted.slice(0, limit);
      return { data: rows.map((row) => ({ ...row })), error: null };
    };
    const orders: [string, boolean][] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (row: Row) => { mode = "insert"; inserted = row; return chain; },
      update: () => { mode = "update"; return chain; },
      eq: (col: string, val: unknown) => { filters.push((row) => row[col] === val); return chain; },
      contains: (col: string, val: { actions: { actionId: string }[] }) => {
        filters.push((row) => ((row[col] as { actions?: Row[] })?.actions ?? [])
          .some((a) => a.actionId === val.actions[0].actionId));
        return chain;
      },
      // Only the list cursor's shape: created_at < X, or created_at = X and id < Y.
      or: (expr: string) => {
        const m = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/.exec(expr);
        if (!m) throw new Error(`unexpected or: ${expr}`);
        const [, at, , id] = m;
        filters.push((row) => String(row.created_at) < at
          || (row.created_at === at && String(row.id) < id));
        return chain;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orders.push([col, opts?.ascending !== false]); return chain;
      },
      limit: (n: number) => { limit = n; return chain; },
      maybeSingle: async () => { const r = run(); return { data: r.data[0] ?? null, error: r.error }; },
      single: async () => { const r = run(); return { data: r.data[0] ?? null, error: r.error }; },
      then: (resolve: (value: { data: Row[]; error: unknown }) => unknown) =>
        Promise.resolve(run()).then(resolve),
    };
    return chain;
  };
  return { client: { from, rpc } as never, rpc, outcome };
}

let db: Db;
let a: ReturnType<typeof makeClient>;
let b: ReturnType<typeof makeClient>;

beforeEach(() => {
  db = seed();
  a = makeClient(db, A);
  b = makeClient(db, B);
});

const logToken = { kind: "log_meal", date: DATE, entryId: ENTRY, baseRev: 3 };
const waterToken = { kind: "log_water", date: DATE, cups: 2, after: 6, afterRev: 2 };

const record = (actionId: string, kind: string, token: Row, extra: Row = {}) =>
  recordUndo(a.client, A, { actionId, kind, token, ...extra }, NOW);

async function status(promise: Promise<unknown>): Promise<[number, string]> {
  try { await promise; return [200, "ok"]; }
  catch (error) {
    if (error instanceof HttpError) return [error.status, error.code];
    throw error;
  }
}

describe("recordUndo", () => {
  it("records an applied action against the coach message that carries it", async () => {
    const view = await record("act-log", "log_meal", logToken);
    expect(view).toMatchObject({ actionId: "act-log", kind: "log_meal", threadId: THREAD,
      messageId: MESSAGE, undoneAt: null, serverUndoable: true,
      expiresAt: "2026-10-12T12:00:00.000Z" });
    expect(db.coach_action_undos[0]).toMatchObject({ user_id: A, expected_rev: 3, inverse: logToken });
    expect(view.target).toEqual({ date: DATE, entryId: ENTRY });
  });

  it("is idempotent per action, and refuses a repeat under another kind", async () => {
    const first = await record("act-log", "log_meal", logToken);
    expect((await record("act-log", "log_meal", logToken)).id).toBe(first.id);
    expect(await status(record("act-log", "log_water", waterToken))).toEqual([409, "undo_kind_mismatch"]);
    expect(db.coach_action_undos).toHaveLength(1);
  });

  it("refuses an action id no own message carries, and a kind that does not match", async () => {
    expect(await status(record("invented", "log_meal", logToken))).toEqual([404, "unknown_action"]);
    expect(await status(record("act-water", "log_meal", logToken))).toEqual([409, "undo_kind_mismatch"]);
    expect(await status(recordUndo(b.client, B, { actionId: "act-log", kind: "log_meal",
      token: logToken }, NOW))).toEqual([404, "unknown_action"]);
  });

  it("refuses a token pointed at another target than the issued action names", async () => {
    expect(await status(record("act-water", "log_water", { ...waterToken, date: "2026-10-01" })))
      .toEqual([409, "undo_target_mismatch"]);
  });

  it("records a composed card's button by its message and card index", async () => {
    const view = await recordUndo(a.client, A, { actionId: "tapped-1", kind: "log_meal", token: logToken,
      source: { messageId: MESSAGE, cardIndex: 0 } }, NOW);
    expect(view).toMatchObject({ actionId: "tapped-1", messageId: MESSAGE, serverUndoable: true });
    expect(a.rpc).toHaveBeenLastCalledWith("record_coach_undo", expect.objectContaining({
      p_source_message: MESSAGE, p_source_card: 0 }));
    expect(await status(recordUndo(a.client, A, { actionId: "tapped-2", kind: "log_meal", token: logToken,
      source: { messageId: MESSAGE, cardIndex: 3 } }, NOW))).toEqual([404, "unknown_action"]);
  });

  it("marks kinds the server cannot invert as phone-only; a meal queued offline binds revision 1", async () => {
    const weight = await record("act-weight", "log_weight",
      { kind: "log_weight", date: DATE, previousLb: null, tz: "UTC" });
    expect(weight.serverUndoable).toBe(false);
    expect(await status(performUndo(a.client, A, weight.id, {}, NOW))).toEqual([422, "undo_local_only"]);
    // A meal queued offline: its new entry's create lands at revision 1, which the record binds.
    const queued = await record("act-log", "log_meal", { ...logToken, baseRev: null });
    expect(queued.serverUndoable).toBe(true);
    expect(db.coach_action_undos.find((r) => r.action_id === "act-log")?.expected_rev).toBe(1);
    const water = await record("act-water", "log_water", { kind: "log_water", date: DATE, cups: 2 });
    expect(water.serverUndoable).toBe(false);
  });

  it("stores the record already undone when the phone undid it first, so a late record cannot re-open it", async () => {
    const marked = await record("act-water", "log_water", waterToken, { undone: true });
    expect(marked.undoneAt).toBe(NOW.toISOString());
    const late = await record("act-water", "log_water", waterToken);
    expect(late.undoneAt).toBe(NOW.toISOString());
    expect(await status(performUndo(a.client, A, late.id, {}, NOW))).toEqual([409, "undo_already_undone"]);
    expect(db.water_log[0].cups).toBe(6);
  });

  it("closes an existing record when the phone undid it, through record_coach_undo", async () => {
    const view = await record("act-water", "log_water", waterToken);
    const marked = await record("act-water", "log_water", waterToken, { undone: true });
    expect(marked.id).toBe(view.id);
    expect(marked.undoneAt).toBe(NOW.toISOString());
    expect(a.rpc).toHaveBeenLastCalledWith("record_coach_undo", expect.objectContaining({
      p_action_id: "act-water", p_kind: "log_water", p_undone: true }));
  });
});

describe("performUndo", () => {
  it("sends only the record id: the database builds the inverse from the stored record", async () => {
    const view = await record("act-log", "log_meal", logToken);
    const undone = await performUndo(a.client, A, view.id, {}, NOW);
    expect(undone.undoneAt).toBe(NOW.toISOString());
    expect(a.rpc).toHaveBeenCalledWith("perform_coach_undo", { p_undo_id: view.id, p_local: false });
  });

  it("answers 409 already undone on a second undo", async () => {
    const view = await record("act-log", "log_meal", logToken);
    await performUndo(a.client, A, view.id, {}, NOW);
    expect(await status(performUndo(a.client, A, view.id, {}, NOW))).toEqual([409, "undo_already_undone"]);
  });

  it.each([
    ["undo_conflict", 409, "undo_conflict"],
    ["undo_not_synced", 409, "undo_not_synced"],
    ["undo_local_only", 422, "undo_local_only"],
    ["deadlock detected", 502, "undo_failed"],
  ])("maps the database's %s to %i %s, leaving the record open", async (raised, code, error) => {
    const view = await record("act-log", "log_meal", logToken);
    a.outcome.next = { error: raised };
    expect(await status(performUndo(a.client, A, view.id, {}, NOW))).toEqual([code, error]);
    expect(db.coach_action_undos[0].undone_at).toBeNull();
  });

  it("hides one account's records from another (404, nothing listed, no RPC)", async () => {
    const view = await record("act-log", "log_meal", logToken);
    expect((await listUndos(b.client, B, {}, NOW)).undos).toEqual([]);
    expect(await status(performUndo(b.client, B, view.id, {}, NOW))).toEqual([404, "not_found"]);
    expect(b.rpc).not.toHaveBeenCalled();
  });

  it("refuses an expired record with 410, lists it as expired, and still lets the phone mark it", async () => {
    const view = await record("act-water", "log_water", waterToken);
    const later = new Date(NOW.getTime() + 7 * 86_400_000 + 1);
    const late = makeClient(db, A, () => later);
    expect(await status(performUndo(late.client, A, view.id, {}, later))).toEqual([410, "undo_expired"]);
    const [listed] = (await listUndos(late.client, A, {}, later)).undos;
    expect(listed).toMatchObject({ id: view.id, expired: true, serverUndoable: false, undoneAt: null });
    const marked = await recordUndo(late.client, A,
      { actionId: "act-water", kind: "log_water", token: waterToken, undone: true }, later);
    expect(marked).toMatchObject({ undoneAt: later.toISOString(), expired: true });
  });

  it("only marks the record when the phone already undid it locally", async () => {
    const view = await record("act-log", "log_meal", logToken);
    const marked = await performUndo(a.client, A, view.id, { local: true }, NOW);
    expect(marked.undoneAt).toBe(NOW.toISOString());
    expect(a.rpc).toHaveBeenCalledWith("perform_coach_undo", { p_undo_id: view.id, p_local: true });
  });

  it("stamps the normalized name on a list mark, and keeps a note-changing mark phone-only", async () => {
    const view = await record("act-avoid", "add_to_avoid",
      { kind: "add_to_avoid", foodRefId: "r", localId: null, previous: null, name: "Watermelon, raw",
        nameNorm: "forged", markRev: 1_800_000_000_000 });
    expect(db.coach_action_undos[0]).toMatchObject({ inverse: { nameNorm: "watermelon" },
      expected_rev: 1_800_000_000_000 });
    expect(view.serverUndoable).toBe(true);
    // Without the mark's revision a later choice could not be told apart: phone-only.
    const old = await record("act-uneats", "remove_from_eats", { kind: "remove_from_eats",
      foodRefId: "r", localId: null, previous: { status: "eats", note: null }, name: "Kale" });
    expect(old.serverUndoable).toBe(false);
    const noted = await record("act-eats", "add_to_eats", { kind: "add_to_eats", foodRefId: "r",
      localId: null, previous: { status: "avoid", note: "old" }, name: "Kale", appliedNote: "new" });
    expect(noted.serverUndoable).toBe(false);
  });
});

describe("paging (review t25 #3)", () => {
  it("pages past one full page with a created_at + id cursor, losing none", async () => {
    for (let i = 0; i < LIST_LIMIT + 5; i += 1) {
      db.coach_action_undos.push({ id: `3f1b1a2c-0000-4000-8000-${String(i).padStart(12, "0")}`,
        user_id: A, thread_id: THREAD, message_id: MESSAGE, action_id: `bulk-${i}`, kind: "log_water",
        inverse: {}, expected_rev: null,
        // Ties on created_at are broken by id.
        created_at: new Date(NOW.getTime() - Math.floor(i / 2) * 1000).toISOString(),
        expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(), undone_at: null });
    }
    const first = await listUndos(a.client, A, { threadId: THREAD }, NOW);
    expect(first.undos).toHaveLength(LIST_LIMIT);
    expect(first.next).not.toBeNull();
    const cursor = decodeCursor(first.next!);
    expect(cursor).not.toBeNull();
    const second = await listUndos(a.client, A, { threadId: THREAD, before: cursor! }, NOW);
    expect(second.undos).toHaveLength(5);
    expect(second.next).toBeNull();
    const all = new Set([...first.undos, ...second.undos].map((u) => u.actionId));
    expect(all.size).toBe(LIST_LIMIT + 5);
  });
});

describe("routes", () => {
  const asUser = (userId: string, client: unknown) =>
    vi.mocked(requireUser).mockResolvedValue({ userId, client: client as never });

  it("records, lists by thread and undoes over HTTP; a second POST answers 409", async () => {
    asUser(A, a.client);
    const recorded = await recordRoute(new Request("http://x/api/coach/undo", { method: "POST",
      body: JSON.stringify({ actionId: "act-log", kind: "log_meal", token: logToken, threadId: THREAD }) }));
    expect(recorded.status).toBe(200);
    const { undo } = await recorded.json() as { undo: { id: string } };

    const listed = await listRoute(new Request(`http://x/api/coach/undo?threadId=${THREAD}`));
    expect((await listed.json() as { undos: unknown[] }).undos).toHaveLength(1);

    const ctx = { params: Promise.resolve({ id: undo.id }) };
    const first = await undoRoute(new Request("http://x", { method: "POST", body: "{}" }), ctx);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ performed: "server", undo: { id: undo.id } });
    const second = await undoRoute(new Request("http://x", { method: "POST", body: "{}" }), ctx);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "undo_already_undone" });
  });

  it("answers another account 404 for a record it does not own", async () => {
    const view = await record("act-log", "log_meal", logToken);
    asUser(B, b.client);
    const res = await undoRoute(new Request("http://x", { method: "POST", body: "{}" }),
      { params: Promise.resolve({ id: view.id }) });
    expect(res.status).toBe(404);
    const listed = await listRoute(new Request("http://x/api/coach/undo"));
    expect((await listed.json() as { undos: unknown[] }).undos).toEqual([]);
  });

  it("rejects a malformed filter or cursor", async () => {
    asUser(A, a.client);
    expect((await listRoute(new Request("http://x/api/coach/undo?threadId=nope"))).status).toBe(400);
    expect((await listRoute(new Request("http://x/api/coach/undo?before=yesterday"))).status).toBe(400);
  });

  it("a last page that is exactly full ends the list: no `next`, no extra empty read", async () => {
    for (let i = 0; i < LIST_LIMIT; i += 1) {
      db.coach_action_undos.push({ id: `3f1b1a2c-0000-4000-8000-${String(i).padStart(12, "0")}`,
        user_id: A, thread_id: THREAD, message_id: MESSAGE, action_id: `full-${i}`, kind: "log_water",
        inverse: {}, expected_rev: null,
        created_at: new Date(NOW.getTime() - i * 1000).toISOString(),
        expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(), undone_at: null });
    }
    const only = await listUndos(a.client, A, { threadId: THREAD }, NOW);
    expect(only.undos).toHaveLength(LIST_LIMIT);
    expect(only.next).toBeNull();
  });

  it("pages over HTTP: `next` on a full page, null on a short one", async () => {
    asUser(A, a.client);
    for (let i = 0; i < LIST_LIMIT + 1; i += 1) {
      db.coach_action_undos.push({ id: `3f1b1a2c-0000-4000-8000-${String(i).padStart(12, "0")}`,
        user_id: A, thread_id: THREAD, message_id: MESSAGE, action_id: `bulk-${i}`, kind: "log_water",
        inverse: {}, expected_rev: null,
        created_at: new Date(NOW.getTime() - i * 1000).toISOString(),
        expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(), undone_at: null });
    }
    const first = await listRoute(new Request(`http://x/api/coach/undo?threadId=${THREAD}`));
    const firstBody = await first.json() as { undos: unknown[]; next: string | null };
    expect(firstBody.undos).toHaveLength(LIST_LIMIT);
    expect(firstBody.next).not.toBeNull();
    const second = await listRoute(
      new Request(`http://x/api/coach/undo?threadId=${THREAD}&before=${encodeURIComponent(firstBody.next!)}`));
    const secondBody = await second.json() as { undos: unknown[]; next: string | null };
    expect(secondBody.undos).toHaveLength(1);
    expect(secondBody.next).toBeNull();
  });
});
