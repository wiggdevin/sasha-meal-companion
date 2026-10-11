import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { BACKUP_TABLES } from "@/lib/server/backup-tables";
import {
  PAGE, START, afterFilter, manifestPath, parseCursor, partPath, serializeCursor,
} from "@/lib/server/backup-dump";
import { HARD_STOP_MS } from "@/lib/server/job-cursor";

type Row = Record<string, unknown>;

let tableData: Record<string, Row[]>;
let uploads: Map<string, Buffer>;
let uploadLog: string[];
let run: Row | null;
let cursorRow: Row | null;
let claimFails: boolean;
let uploadFails: boolean;
let hangUpload: boolean;
let completionFails: boolean;
let failTable: string | null;
let orders: Record<string, string[]>;
let pageReads: Record<string, number>;
/** Runs before each page read: lets a case write to a table mid-dump or move the clock. */
let onPageRead: ((table: string, read: number) => void) | null;
/** Runs inside the upload with the part stream, before it is drained (the S3 streaming check). */
let onUpload: ((reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<Uint8Array[]>) | null;

async function drain(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks = onUpload ? await onUpload(reader) : [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function compare(a: unknown, b: string): number {
  if (typeof a === "number") return a - Number(b);
  const text = String(a);
  return text < b ? -1 : text > b ? 1 : 0;
}

/** Splits on commas outside quotes and parentheses. */
function split(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (quoted) {
      if (c === "\\") i += 1;
      else if (c === "\"") quoted = false;
    } else if (c === "\"") quoted = true;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) { out.push(expr.slice(start, i)); start = i + 1; }
  }
  out.push(expr.slice(start));
  return out;
}

/** The PostgREST `or` grammar the dump writes: `k.gt."v"` and `and(k.eq."v",…,k.gt."v")`. */
function orFilter(expr: string): (row: Row) => boolean {
  const term = (text: string) => {
    const m = /^([a-z_0-9]+)\.(gt|eq)\."((?:[^"\\]|\\.)*)"$/.exec(text);
    if (!m) throw new Error(`unexpected filter term ${text}`);
    const value = m[3].replace(/\\(.)/g, "$1");
    return (row: Row) => (m[2] === "gt" ? compare(row[m[1]], value) > 0 : compare(row[m[1]], value) === 0);
  };
  const anyOf = split(expr).map((part) => {
    if (!part.startsWith("and(")) return term(part);
    const all = split(part.slice(4, -1)).map(term);
    return (row: Row) => all.every((t) => t(row));
  });
  return (row) => anyOf.some((t) => t(row));
}

const byColumns = (columns: string[]) => (a: Row, b: Row) => {
  for (const c of columns) {
    const d = compare(a[c], String(b[c]));
    if (d !== 0) return d;
  }
  return 0;
};

vi.mock("@/lib/server/admin", () => ({
  adminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "claim_job_cursor") throw new Error(`unexpected rpc ${fn}`);
      if (claimFails) return { data: null, error: { message: "relation job_cursors does not exist" } };
      const now = Date.now();
      cursorRow ??= { after_key: null, listed: false, retry_keys: [], relist: false, done: false,
        pass_started_at: new Date(now).toISOString(), lease_owner: null, lease_until: null };
      if (cursorRow.lease_until !== null && (cursorRow.lease_until as number) >= now) {
        return { data: [], error: null };
      }
      cursorRow = { ...cursorRow, lease_owner: args.p_owner,
        lease_until: now + (args.p_lease_seconds as number) * 1000 };
      const { after_key, listed, retry_keys, relist, done, pass_started_at } = cursorRow;
      return { data: [{ after_key, listed, retry_keys, relist, done, pass_started_at }], error: null };
    },
    from: (table: string) => {
      if (table === "job_cursors") {
        return { update: (fields: Row) => {
          let owner: unknown;
          const query = {
            eq: (key: string, value: unknown) => { if (key === "lease_owner") owner = value; return query; },
            select: async () => {
              if (!cursorRow || cursorRow.lease_owner !== owner) return { data: [], error: null };
              cursorRow = { ...cursorRow, ...fields };
              return { data: [{ job: "backup" }], error: null };
            },
          };
          return query;
        } };
      }
      if (table === "backup_runs") {
        return { upsert: async (row: Row) => {
          if (row.status === "ok" && completionFails) return { error: { message: "completion failed" } };
          run = { ...(run ?? {}), ...row };
          return { error: null };
        } };
      }
      return { select: () => {
        orders[table] = [];
        const filters: ((row: Row) => boolean)[] = [];
        const query = {
          gt: (key: string, value: string) => { filters.push((row) => compare(row[key], value) > 0); return query; },
          or: (expr: string) => { filters.push(orFilter(expr)); return query; },
          order: (key: string) => { orders[table].push(key); return query; },
          limit: async (n: number) => {
            pageReads[table] = (pageReads[table] ?? 0) + 1;
            onPageRead?.(table, pageReads[table]);
            if (table === failTable) return { data: null, error: { message: "read failed" } };
            const rows = (tableData[table] ?? []).filter((row) => filters.every((f) => f(row)))
              .sort(byColumns(orders[table])).slice(0, n);
            return { data: rows, error: null };
          },
        };
        return query;
      } };
    },
    storage: { from: () => ({
      upload: async (path: string, body: ReadableStream<Uint8Array> | string) => {
        uploadLog.push(path);
        if (uploadFails) return { error: { message: "upload failed" } };
        if (hangUpload) return new Promise(() => undefined);
        uploads.set(path, typeof body === "string" ? Buffer.from(body) : await drain(body));
        return { error: null };
      },
    }) },
  }),
}));

const { GET, POST } = await import("@/app/api/jobs/backup/route");
const request = (method = "POST", token: string | null = "test-cron-secret") => new Request("https://app.test/api/jobs/backup", {
  method, headers: token ? { authorization: `Bearer ${token}` } : {},
});
const today = () => new Date(Date.now()).toISOString().slice(0, 10);
const json = (path: string) => JSON.parse(uploads.get(path)!.toString("utf8"));

/** What a restore reads: the manifest, then each part in order, each table's rows joined. */
function restored(date = today()): Record<string, Row[]> {
  const manifest = json(manifestPath(date));
  expect(manifest.format).toBe("user-table-export-v2");
  const tables: Record<string, Row[]> = {};
  for (const path of manifest.parts as string[]) {
    const part = json(path);
    expect(part.format).toBe("user-table-export-v2-part");
    for (const [name, rows] of Object.entries(part.tables as Record<string, Row[]>)) {
      tables[name] = [...(tables[name] ?? []), ...rows];
    }
  }
  return tables;
}

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({
  id: `row-${String(from + i).padStart(5, "0")}` }));

describe("scheduled user-table backup", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    tableData = {}; uploads = new Map(); uploadLog = []; run = null; cursorRow = null;
    orders = {}; pageReads = {}; onUpload = null; onPageRead = null; failTable = null;
    claimFails = false; uploadFails = false; hangUpload = false; completionFails = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not truncate beyond 1000 rows and orders every page by complete primary key", async () => {
    tableData.user_foods = ids(1500);
    expect((await POST(request())).status).toBe(200);
    expect(restored().user_foods).toEqual(tableData.user_foods);
    expect(orders.user_foods).toEqual(["id"]);
    expect(orders.change_log).toEqual(["user_id", "seq"]);
    expect(orders.recipe_items).toEqual(["recipe_revision_id", "seq"]);
    expect(orders.user_allergen_checks).toEqual(["user_id", "food_key", "allergen"]);
    expect(json(manifestPath(today())).consistency).toBe("keyset");
  });

  it("dumps every user-owned table, including the ones the first list missed (A083)", async () => {
    tableData.user_dietary_profiles = [{ user_id: "u", profile_id: "halal" }];
    tableData.user_allergen_checks = [{ user_id: "u", food_key: "f", allergen: "peanut" }];
    tableData.shopping_lines = [{ id: "line-1" }];
    tableData.recipe_plan_selections = [{ id: "sel-1" }];
    expect((await POST(request())).status).toBe(200);
    const dump = restored();
    expect(Object.keys(dump)).toEqual(BACKUP_TABLES.map((t) => t.name));
    for (const name of ["user_dietary_profiles", "user_allergen_checks", "shopping_lines",
      "recipe_plan_selections"]) expect(dump[name]).toEqual(tableData[name]);
  });

  it.each([
    ["a row on an earlier page is deleted", (rows: Row[]) => rows.filter((r) => r.id !== "row-00005")],
    ["a row is inserted below the read position", (rows: Row[]) => [...rows, { id: "row-00005a" }]],
  ])("pages by key: %s mid-dump, and no row is skipped or repeated (A122)", async (_, write) => {
    tableData.user_foods = ids(2500);
    const before = tableData.user_foods.map((r) => r.id);
    onPageRead = (table, read) => {
      if (table === "user_foods" && read === 2) tableData.user_foods = write(tableData.user_foods);
    };
    expect((await POST(request())).status).toBe(200);
    expect(restored().user_foods.map((r) => r.id)).toEqual(before);
  });

  it("pages a composite key by tuple, with commas, quotes and brackets in its text", async () => {
    const odd = ["a,b", "c\"d", "e(f)", "g\\h", "i.j"];
    tableData.user_allergen_checks = Array.from({ length: 2300 }, (_, i) => ({
      user_id: `u${i % 3}`, food_key: `${odd[i % odd.length]}-${String(i).padStart(4, "0")}`,
      allergen: i % 2 ? "milk" : "egg" }));
    expect((await POST(request())).status).toBe(200);
    const sorted = [...tableData.user_allergen_checks].sort(byColumns(["user_id", "food_key", "allergen"]));
    expect(restored().user_allergen_checks).toEqual(sorted);
    expect(pageReads.user_allergen_checks).toBe(3);
  });

  it("builds the tuple filter PostgREST reads", () => {
    expect(afterFilter(["user_id", "seq"], ["u,1", "7"]))
      .toBe('user_id.gt."u,1",and(user_id.eq."u,1",seq.gt."7")');
    expect(afterFilter(["a"], ['x"y\\z'])).toBe('a.gt."x\\"y\\\\z"');
  });

  it("streams each part a page at a time: rows are read only as the upload pulls them (S3)",
    async () => {
      tableData.user_foods = ids(5000);
      let readsWhenFirstRowsArrived = -1;
      onUpload = async (reader) => {
        const taken: Uint8Array[] = [];
        const decoder = new TextDecoder();
        let seen = "";
        while (!seen.includes('"row-00000"')) {
          const { value, done } = await reader.read();
          if (done) break;
          taken.push(value);
          seen += decoder.decode(value);
        }
        readsWhenFirstRowsArrived = pageReads.user_foods ?? 0;
        return taken;
      };
      expect((await POST(request())).status).toBe(200);
      expect(readsWhenFirstRowsArrived).toBeGreaterThan(0);
      expect(readsWhenFirstRowsArrived).toBeLessThanOrEqual(2);
      expect(pageReads.user_foods).toBe(6);
    });

  it("stops at its time budget and the next run continues the same pass (A123)", async () => {
    let clock = Date.UTC(2026, 9, 10, 3, 45);
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    tableData.user_foods = ids(3500);
    onPageRead = (table) => { if (table === "user_foods") clock += 100_000; };

    const first = await POST(request());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, done: false, incomplete: true, parts: 1 });
    expect(run).toMatchObject({ status: "running" });
    expect(uploads.has(manifestPath(today()))).toBe(false);
    expect(parseCursor(cursorRow!.after_key as string))
      .toMatchObject({ table: "user_foods", after: ["row-02999"], part: 2 });
    expect(cursorRow).toMatchObject({ lease_owner: null, done: false });

    const second = await POST(request());
    expect(await second.json()).toMatchObject({ ok: true, done: true, parts: 2 });
    expect(json(manifestPath(today())).parts).toEqual([partPath(today(), 1), partPath(today(), 2)]);
    expect(restored().user_foods).toEqual(tableData.user_foods);
    const partBytes = uploads.get(partPath(today(), 1))!.length + uploads.get(partPath(today(), 2))!.length;
    expect(run).toMatchObject({ status: "ok", bytes: partBytes, error: null });
    expect(cursorRow).toMatchObject({ done: true, listed: true, lease_owner: null });

    const third = await POST(request());
    expect(await third.json()).toMatchObject({ ok: true, alreadyDone: true });
    expect(uploadLog).toHaveLength(3);
  });

  it("records the failure before the platform kill when a part is still uploading at the hard stop",
    async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      tableData.user_foods = ids(10);
      hangUpload = true;
      const pending = POST(request());
      await vi.advanceTimersByTimeAsync(HARD_STOP_MS + 1_000);
      expect((await pending).status).toBe(500);
      expect(run).toMatchObject({ status: "error" });
      expect(String(run!.error)).toMatch(/hard stop/);
      expect(parseCursor(cursorRow!.after_key as string)).toEqual(START);
      expect(cursorRow).toMatchObject({ lease_owner: null, lease_until: null });

      hangUpload = false;
      expect((await POST(request())).status).toBe(200);
      expect(restored().user_foods).toEqual(tableData.user_foods);
    });

  it("a failed read keeps the parts already written and the retry resumes after them", async () => {
    let clock = Date.UTC(2026, 9, 10, 3, 45);
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    tableData.user_foods = ids(3500);
    onPageRead = (table) => { if (table === "user_foods") clock += 100_000; };
    expect((await POST(request())).status).toBe(200);

    failTable = "recipe_items";
    expect((await POST(request())).status).toBe(500);
    expect(run).toMatchObject({ status: "error" });
    expect(parseCursor(cursorRow!.after_key as string)).toMatchObject({ part: 2, after: ["row-02999"] });

    failTable = null;
    uploadLog = [];
    expect((await POST(request())).status).toBe(200);
    expect(uploadLog).toEqual([partPath(today(), 2), manifestPath(today())]);
    expect(restored().user_foods).toEqual(tableData.user_foods);
  });

  it("never runs two at once: a live lease on today's pass answers 409", async () => {
    cursorRow = { after_key: null, listed: false, retry_keys: [], relist: false, done: false,
      pass_started_at: new Date().toISOString(), lease_owner: "other", lease_until: Date.now() + 60_000 };
    expect((await POST(request())).status).toBe(409);
    expect(uploadLog).toEqual([]);
  });

  it("without a job cursor it dumps the whole pass in one run when that fits", async () => {
    claimFails = true;
    tableData.user_foods = ids(3);
    expect((await POST(request())).status).toBe(200);
    expect(restored().user_foods).toEqual(tableData.user_foods);
    expect(run).toMatchObject({ status: "ok" });
  });

  it("without a job cursor a dump that outruns the budget fails loudly instead of resuming", async () => {
    let clock = Date.UTC(2026, 9, 10, 3, 45);
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    claimFails = true;
    tableData.user_foods = ids(3500);
    onPageRead = (table) => { if (table === "user_foods") clock += 100_000; };
    expect((await POST(request())).status).toBe(500);
    expect(run).toMatchObject({ status: "error" });
    expect(String(run!.error)).toMatch(/no job cursor/);
  });

  it.each([null, "wrong"])("rejects a missing or wrong GET bearer (%s) before touching storage", async (token) => {
    expect((await GET(request("GET", token))).status).toBe(401);
    expect(run).toBeNull();
    expect(cursorRow).toBeNull();
    expect(uploadLog).toEqual([]);
  });

  it("GET runs the same backup as POST", async () => {
    expect((await GET(request("GET"))).status).toBe(200);
    expect(run).toMatchObject({ status: "ok" });
    expect(uploads.has(manifestPath(today()))).toBe(true);
  });

  it("can retry a failed upload on the same UTC date", async () => {
    uploadFails = true;
    expect((await POST(request())).status).toBe(500);
    expect(run).toMatchObject({ status: "error" });
    uploadFails = false;
    expect((await POST(request())).status).toBe(200);
    expect(run).toMatchObject({ status: "ok" });
  });

  it("failed completion bookkeeping is a failure; the retry finishes without dumping again", async () => {
    completionFails = true;
    expect((await POST(request())).status).toBe(500);
    expect(run).toMatchObject({ status: "error" });
    expect(cursorRow).toMatchObject({ listed: true, done: false });
    completionFails = false;
    uploadLog = [];
    expect((await POST(request())).status).toBe(200);
    expect(uploadLog).toEqual([manifestPath(today())]);
    expect(run).toMatchObject({ status: "ok" });
  });

  it("does not dump again once today's pass is done", async () => {
    expect((await POST(request())).status).toBe(200);
    const written = uploadLog.length;
    const again = await POST(request());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyDone: true });
    expect(uploadLog).toHaveLength(written);
  });

  it("reads back only cursors it can resume", () => {
    const cursor = { table: "change_log", after: ["u", "12"], part: 3, bytes: 99 };
    expect(parseCursor(serializeCursor(cursor))).toEqual(cursor);
    expect(parseCursor(serializeCursor({ ...cursor, after: ["u"] }))).toBeNull();
    expect(parseCursor(serializeCursor({ ...cursor, table: "nope" }))).toBeNull();
    expect(parseCursor("{")).toBeNull();
    expect(PAGE).toBe(1000);
  });
});
