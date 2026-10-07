import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "@/lib/server/ratelimit";

let tableData: Record<string, Record<string, unknown>[]>;
let uploads: { path: string; body: Buffer }[];
let run: Record<string, unknown> | null;
let uploadFails: boolean;
let completionFails: boolean;
let orders: Record<string, string[]>;
let pageReads: Record<string, number>;
/** Runs inside the upload with the dump stream, before it is drained (the S3 streaming check). */
let onUpload: ((reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<Uint8Array[]>) | null;

/** Reads the upload body to the end, after whatever `onUpload` already took from it. */
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

vi.mock("@/lib/server/admin", () => ({
  adminClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => ({
        select: async () => {
          if (run) return { data: null, error: { code: "23505" } };
          run = { ...row };
          return { data: [row], error: null };
        },
      }),
      select: () => {
        orders[table] = [];
        const query = {
          order: (key: string) => { orders[table].push(key); return query; },
          range: async (start: number, end: number) => {
            pageReads[table] = (pageReads[table] ?? 0) + 1;
            return { data: (tableData[table] ?? []).slice(start, end + 1), error: null };
          },
        };
        return query;
      },
      update: (fields: Record<string, unknown>) => {
        const filters: ((row: Record<string, unknown>) => boolean)[] = [];
        const apply = async () => {
          if (fields.status === "ok" && completionFails) return { data: null, error: { message: "completion failed" } };
          if (!run || !filters.every((filter) => filter(run!))) return { data: [], error: null };
          run = { ...run, ...fields };
          return { data: [run], error: null };
        };
        const query = {
          eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return query; },
          lt: (key: string, value: string) => { filters.push((row) => String(row[key]) < value); return query; },
          select: apply,
          then: (resolve: (value: unknown) => unknown) => apply().then(resolve),
        };
        return query;
      },
    }),
    storage: { from: () => ({
      upload: async (path: string, body: ReadableStream<Uint8Array>) => {
        if (uploadFails) return { error: { message: "upload failed" } };
        uploads.push({ path, body: await drain(body) });
        return { error: null };
      },
    }) },
  }),
}));

const { GET, POST } = await import("@/app/api/jobs/backup/route");
const request = (method = "POST", token: string | null = "test-cron-secret") => new Request("https://app.test/api/jobs/backup", {
  method, headers: token ? { authorization: `Bearer ${token}` } : {},
});
const uploadedDump = () => JSON.parse(uploads[0].body.toString("utf8"));

describe("scheduled user-table backup", () => {
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    tableData = {}; uploads = []; run = null; orders = {}; pageReads = {}; onUpload = null;
    uploadFails = false; completionFails = false;
  });

  it("does not truncate beyond 1000 rows and orders every page by complete primary key", async () => {
    tableData.user_foods = Array.from({ length: 1500 }, (_, i) => ({ id: `row-${i}` }));
    expect((await POST(request())).status).toBe(200);
    expect(uploadedDump().tables.user_foods).toHaveLength(1500);
    expect(orders.user_foods).toEqual(["id"]);
    expect(orders.change_log).toEqual(["user_id", "seq"]);
    expect(orders.recipe_items).toEqual(["recipe_revision_id", "seq"]);
    expect(uploadedDump().consistency).toBe("per-request");
  });

  it("streams the dump a page at a time: rows are read only as the upload pulls them (S3)",
    async () => {
      tableData.user_foods = Array.from({ length: 5_000 }, (_, i) => ({ id: `row-${i}`, n: i }));
      let readsWhenFirstRowsArrived = -1;
      onUpload = async (reader) => {
        const taken: Uint8Array[] = [];
        const decoder = new TextDecoder();
        let seen = "";
        while (!seen.includes('"row-0"')) {
          const { value, done } = await reader.read();
          if (done) break;
          taken.push(value);
          seen += decoder.decode(value);
        }
        readsWhenFirstRowsArrived = pageReads.user_foods ?? 0;
        return taken;
      };
      expect((await POST(request())).status).toBe(200);
      // The first rows were in hand after at most the page being sent plus one queued ahead,
      // never the table's five pages: memory holds what is in flight, not the dump.
      expect(readsWhenFirstRowsArrived).toBeGreaterThan(0);
      expect(readsWhenFirstRowsArrived).toBeLessThanOrEqual(2);
      expect(pageReads.user_foods).toBe(6);
    });

  it("writes the same user-table-export-v1 document a whole-dump stringify did", async () => {
    tableData.user_foods = [{ id: "a", name: "Oats \"rolled\"" }, { id: "b", name: "Kale" }];
    tableData.change_log = [{ user_id: "u", seq: 1, op: { k: [1, 2] } }];
    expect((await POST(request())).status).toBe(200);
    const text = uploads[0].body.toString("utf8");
    const dump = JSON.parse(text);
    expect(Object.keys(dump)).toEqual(["format", "consistency", "taken_at", "tables"]);
    expect(dump.format).toBe("user-table-export-v1");
    expect(dump.tables.user_foods).toEqual(tableData.user_foods);
    expect(dump.tables.change_log).toEqual(tableData.change_log);
    expect(dump.tables.recipe_items).toEqual([]);
    // Byte for byte what JSON.stringify of the whole document writes, so any reader of v1 reads it.
    expect(text).toBe(JSON.stringify(dump));
    expect(run).toMatchObject({ status: "ok", bytes: Buffer.byteLength(text) });
  });

  it("a table read failing mid-dump fails the run and leaves it retryable", async () => {
    tableData.user_foods = [{ id: "a" }];
    const original = tableData;
    tableData = new Proxy(original, { get: (t, key) => {
      if (key === "recipe_items") throw new Error("recipe_items read failed");
      return Reflect.get(t, key);
    } });
    try {
      expect((await POST(request())).status).toBe(500);
      expect(run).toMatchObject({ status: "error" });
    } finally {
      tableData = original;
    }
  });

  it("includes media metadata and records verified completion", async () => {
    tableData.media_objects = [{ path: "owner/media-1.png" }];
    expect((await POST(request())).status).toBe(200);
    expect(uploadedDump().tables.media_objects).toHaveLength(1);
    expect(orders.media_objects).toEqual(["path"]);
    expect(run).toMatchObject({ status: "ok", bytes: uploads[0].body.length });
  });

  it.each([null, "wrong"])("rejects a missing or wrong GET bearer (%s) before touching storage", async (token) => {
    expect((await GET(request("GET", token))).status).toBe(401);
    expect(run).toBeNull();
    expect(uploads).toEqual([]);
  });

  it("runs the same backup and returns the same status as POST", async () => {
    const post = await POST(request("POST"));
    run = null;
    uploads = [];

    const get = await GET(request("GET"));
    expect(get.status).toBe(post.status);
    expect(get.status).toBe(200);
    expect(run).toMatchObject({ status: "ok" });
    expect(uploads).toHaveLength(1);
  });

  it("can retry a failed upload on the same UTC date", async () => {
    uploadFails = true;
    expect((await POST(request())).status).toBe(500);
    expect(run).toMatchObject({ status: "error" });
    uploadFails = false;
    expect((await POST(request())).status).toBe(200);
    expect(run).toMatchObject({ status: "ok" });
    expect(uploads).toHaveLength(1);
  });

  it("allows only one concurrent retry to claim a failed daily run", async () => {
    run = { local_date: new Date().toISOString().slice(0, 10), status: "error", started_at: new Date().toISOString() };
    const responses = await Promise.all([POST(request()), POST(request())]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(uploads).toHaveLength(1);
  });

  it("does not overwrite an already completed daily backup", async () => {
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request())).status).toBe(409);
    expect(uploads).toHaveLength(1);
  });

  it("reclaims an abandoned run but never steals a live lease", async () => {
    run = { local_date: new Date().toISOString().slice(0, 10), status: "running", started_at: new Date().toISOString() };
    expect((await POST(request())).status).toBe(409);
    run.started_at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect((await POST(request())).status).toBe(200);
  });

  it("reports failed completion bookkeeping as failure, allowing an explicit retry", async () => {
    completionFails = true;
    expect((await POST(request())).status).toBe(500);
    expect(run).toMatchObject({ status: "error" });
    completionFails = false;
    expect((await POST(request())).status).toBe(200);
  });
});
