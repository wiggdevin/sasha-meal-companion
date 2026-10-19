/**
 * UI makeover W7: saved, named and dated shopping lists on the period routes
 * (app/api/shopping/periods/route.ts, app/api/shopping/periods/[id]/route.ts).
 *
 * - POST stores an optional trimmed title (1-60 characters); a blank or 61-character title is 400.
 * - PATCH `title: null` clears it; a patch that omits `title` keeps it.
 * - DELETE soft-deletes on the revision the caller saw: a repeat with the same request id is done,
 *   a stale revision is 409, a list that is gone or another account's is 404; the body is strict.
 * - GET never lists a deleted list.
 * - Without recipe access every handler is the pilot 404.
 *
 * The real repository runs against an in-memory `shopping_periods` table; the session comes from a
 * mocked `requireUser`, so `requireRecipeUser`'s own gate is what answers the pilot 404.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: mocks.requireUser,
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/server/shopping-rule-marks", () => ({
  markShoppingItems: async (_client: unknown, _user: unknown, lines: unknown[]) => lines,
}));

import { GET as listRoute, POST as createRoute } from "@/app/api/shopping/periods/route";
import { DELETE as deleteRoute, GET as getRoute, PATCH as patchRoute }
  from "@/app/api/shopping/periods/[id]/route";

const USER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/** A small PostgREST stand-in over in-memory tables: the filters and terminals the repository uses. */
function memoryClient(tables: Record<string, Row[]>, inserts: Row[]): SupabaseClient {
  return { from(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Filter[] = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let order: { column: string; ascending: boolean } | null = null;
    let limit = Infinity;
    const run = (): { data: Row[] | null; error: { code: string; message: string } | null } => {
      if (op === "insert") {
        if (payload.request_id && rows.some((row) => row.user_id === payload.user_id
          && row.request_id === payload.request_id)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const row: Row = { id: crypto.randomUUID(), meal_coverage: [], lock_mode: "none",
          plan_revision: 0, rev: 1, last_request_id: null, deleted_at: null, title: null,
          updated_at: new Date().toISOString(), ...payload };
        rows.push(row);
        return { data: [{ ...row }], error: null };
      }
      const matched = rows.filter((row) => filters.every((filter) => filter(row)));
      if (op === "update") {
        for (const row of matched) Object.assign(row, payload);
        return { data: matched.map((row) => ({ ...row })), error: null };
      }
      const sorted = order ? [...matched].sort((a, b) => {
        const sign = order!.ascending ? 1 : -1;
        return String(a[order!.column]).localeCompare(String(b[order!.column])) * sign;
      }) : matched;
      return { data: sorted.slice(0, limit).map((row) => ({ ...row })), error: null };
    };
    const query: Record<string, unknown> = {
      select: () => query,
      insert: (value: Row) => { op = "insert"; payload = value; inserts.push(value); return query; },
      update: (value: Row) => { op = "update"; payload = value; return query; },
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return query; },
      gte: (column: string, value: string) => { filters.push((row) => String(row[column]) >= value); return query; },
      lte: (column: string, value: string) => { filters.push((row) => String(row[column]) <= value); return query; },
      order: (column: string, options?: { ascending?: boolean }) => {
        order = { column, ascending: options?.ascending ?? true }; return query;
      },
      limit: (n: number) => { limit = n; return query; },
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return query;
  } } as unknown as SupabaseClient;
}

const draft = { startDate: "2026-10-19", endDate: "2026-10-25", timezone: "UTC", people: 1,
  mealCoverage: ["meal-1"], mode: "simple", effort: "none", maxActiveMinutes: null,
  variety: "balanced", budgetAmount: null, currency: null, locale: null, lockMode: "none" };

function json(method: string, body: unknown, url = "http://test/api/shopping/periods"): Request {
  return new Request(url, { method, headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const itemUrl = (id: string) => `http://test/api/shopping/periods/${id}`;

let tables: Record<string, Row[]>;
let inserts: Row[];

beforeEach(() => {
  vi.stubEnv("RECIPE_PLANNING_USER_IDS", USER);
  tables = { shopping_periods: [], shopping_lines: [], shopping_purchase_windows: [] };
  inserts = [];
  mocks.limit.mockReset().mockResolvedValue(undefined);
  mocks.requireUser.mockReset().mockImplementation(async () =>
    ({ client: memoryClient(tables, inserts), userId: USER }));
});
afterEach(() => { vi.unstubAllEnvs(); });

async function create(period: Record<string, unknown> = draft, requestId = crypto.randomUUID()) {
  return createRoute(json("POST", { requestId, period }));
}
async function created(period: Record<string, unknown> = draft): Promise<{ id: string; revision: number; title: string | null }> {
  const response = await create(period);
  expect(response.status).toBe(201);
  return (await response.json() as { period: { id: string; revision: number; title: string | null } }).period;
}
function remove(id: string, expectedRevision: number, requestId: string) {
  return deleteRoute(json("DELETE", { expectedRevision, requestId }, itemUrl(id)), ctx(id));
}
function patch(id: string, expectedRevision: number, body: Record<string, unknown>) {
  return patchRoute(json("PATCH", { expectedRevision, requestId: crypto.randomUUID(), patch: body },
    itemUrl(id)), ctx(id));
}

describe("POST /api/shopping/periods title", () => {
  it("stores a trimmed title and answers it", async () => {
    const period = await created({ ...draft, title: "  Weekly shop  " });
    expect(period.title).toBe("Weekly shop");
    expect(tables.shopping_periods[0].title).toBe("Weekly shop");
    expect(inserts[0].title).toBe("Weekly shop");
  });

  it("writes no title column when the draft has none, and answers null", async () => {
    const period = await created();
    expect(period.title).toBeNull();
    expect(inserts[0]).not.toHaveProperty("title");
  });

  it("accepts an explicit null and a 60-character title", async () => {
    expect((await created({ ...draft, title: null })).title).toBeNull();
    expect(inserts[0].title).toBeNull();
    expect((await created({ ...draft, title: "a".repeat(60) })).title).toBe("a".repeat(60));
  });

  it("refuses a 61-character or blank title with 400 and writes nothing", async () => {
    for (const title of ["a".repeat(61), "", "   "]) {
      const response = await create({ ...draft, title });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "bad_request" });
    }
    expect(tables.shopping_periods).toHaveLength(0);
  });
});

describe("PATCH /api/shopping/periods/[id] title", () => {
  it("clears the title with null and keeps it when the patch omits it", async () => {
    const period = await created({ ...draft, title: "Party" });
    const kept = await patch(period.id, 1, { people: 2 });
    expect(kept.status).toBe(200);
    expect((await kept.json()).period).toMatchObject({ title: "Party", people: 2, revision: 2 });

    const renamed = await patch(period.id, 2, { title: " Big party " });
    expect((await renamed.json()).period).toMatchObject({ title: "Big party", revision: 3 });

    const cleared = await patch(period.id, 3, { title: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).period).toMatchObject({ title: null, revision: 4 });
    expect(tables.shopping_periods[0].title).toBeNull();
  });

  it("refuses a 61-character title with 400", async () => {
    const period = await created({ ...draft, title: "Party" });
    const response = await patch(period.id, 1, { title: "b".repeat(61) });
    expect(response.status).toBe(400);
    expect(tables.shopping_periods[0]).toMatchObject({ title: "Party", rev: 1 });
  });
});

describe("DELETE /api/shopping/periods/[id]", () => {
  it("soft-deletes on the revision the caller saw, behind the item limiter, no-store", async () => {
    const period = await created();
    mocks.limit.mockClear();
    const response = await remove(period.id, 1, crypto.randomUUID());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.limit).toHaveBeenCalledWith(`shopping-period-item:${USER}`, 60, 60);
    // Soft: the row stays, marked deleted, with the next revision.
    expect(tables.shopping_periods).toHaveLength(1);
    expect(tables.shopping_periods[0]).toMatchObject({ rev: 2 });
    expect(tables.shopping_periods[0].deleted_at).toEqual(expect.any(String));
    // The deleted list no longer reads.
    const read = await getRoute(new Request(itemUrl(period.id)), ctx(period.id));
    expect(read.status).toBe(404);
  });

  it("answers a repeat of the same request as done, and another request on it as gone", async () => {
    const period = await created();
    const requestId = crypto.randomUUID();
    expect((await remove(period.id, 1, requestId)).status).toBe(200);
    const repeat = await remove(period.id, 1, requestId);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ deleted: true });
    expect(tables.shopping_periods[0]).toMatchObject({ rev: 2, last_request_id: requestId });

    const other = await remove(period.id, 2, crypto.randomUUID());
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: "not_found" });
  });

  it("is 409 stale_revision when the list moved on since the caller read it", async () => {
    const period = await created();
    expect((await patch(period.id, 1, { title: "Renamed" })).status).toBe(200);
    const response = await remove(period.id, 1, crypto.randomUUID());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "stale_revision" });
    expect(tables.shopping_periods[0].deleted_at).toBeNull();
  });

  it("is 404 for an unknown list and for another account's list, which it leaves alone", async () => {
    expect((await remove(crypto.randomUUID(), 1, crypto.randomUUID())).status).toBe(404);
    const theirs = { id: crypto.randomUUID(), user_id: OTHER, ...draft, rev: 1, deleted_at: null,
      last_request_id: null, title: "Theirs" };
    tables.shopping_periods.push(theirs);
    const response = await remove(theirs.id, 1, crypto.randomUUID());
    expect(response.status).toBe(404);
    expect(theirs).toMatchObject({ rev: 1, deleted_at: null });
  });

  it("takes a strict body: an unknown key or a missing revision is 400", async () => {
    const period = await created();
    const extra = await deleteRoute(json("DELETE", { expectedRevision: 1,
      requestId: crypto.randomUUID(), force: true }, itemUrl(period.id)), ctx(period.id));
    expect(extra.status).toBe(400);
    const missing = await deleteRoute(json("DELETE", { requestId: crypto.randomUUID() },
      itemUrl(period.id)), ctx(period.id));
    expect(missing.status).toBe(400);
    const badId = await deleteRoute(json("DELETE", { expectedRevision: 1,
      requestId: crypto.randomUUID() }, itemUrl("not-a-uuid")), ctx("not-a-uuid"));
    expect(badId.status).toBe(400);
    expect(tables.shopping_periods[0].deleted_at).toBeNull();
  });
});

describe("GET /api/shopping/periods", () => {
  it("never lists a deleted list", async () => {
    const kept = await created({ ...draft, title: "Kept" });
    const gone = await created({ ...draft, startDate: "2026-10-26", endDate: "2026-11-01", title: "Gone" });
    expect((await remove(gone.id, 1, crypto.randomUUID())).status).toBe(200);
    const response = await listRoute(new Request("http://test/api/shopping/periods"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { periods } = await response.json() as { periods: { id: string; title: string | null }[] };
    expect(periods.map((period) => [period.id, period.title])).toEqual([[kept.id, "Kept"]]);
  });
});

describe("recipe access off", () => {
  it("answers the pilot 404 on every handler and touches no list", async () => {
    vi.stubEnv("RECIPE_PLANNING_USER_IDS", OTHER);
    const id = crypto.randomUUID();
    const answers = [
      await listRoute(new Request("http://test/api/shopping/periods")),
      await create({ ...draft, title: "Nope" }),
      await getRoute(new Request(itemUrl(id)), ctx(id)),
      await patch(id, 1, { title: "Nope" }),
      await remove(id, 1, crypto.randomUUID()),
    ];
    for (const response of answers) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "recipe_pilot_unavailable" });
    }
    expect(tables.shopping_periods).toHaveLength(0);
    expect(mocks.limit).not.toHaveBeenCalled();
  });
});
