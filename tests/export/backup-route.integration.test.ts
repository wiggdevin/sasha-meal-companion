import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_TABLES } from "@/lib/server/backup-tables";
import { HAS_BRANCH } from "../helpers/supabase";

// The SQL reads, ordering, lease claim and completion all hit the actual migrated database.
// Only uploaded bytes and rate limiting are replaced; no user tables are seeded or cleared.
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => {}) }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(!HAS_BRANCH)("backup route against the migrated isolated database", () => {
  it("reads every included table by keyset in primary-key order and completes its pass", async () => {
    const url = process.env.SUPABASE_TEST_URL!;
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
    vi.stubEnv("SUPABASE_URL", url);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!);
    vi.stubEnv("CRON_SECRET", "synthetic-backup-route-integration");
    const { adminClient } = await import("@/lib/server/admin");
    const { GET } = await import("@/app/api/jobs/backup/route");
    const db = adminClient();

    // A far-future, randomized date isolates this test from other runs.
    const instant = new Date(Date.UTC(2400, 0, 1) + randomInt(0, 365 * 500) * 86_400_000 + randomInt(0, 86_400_000));
    const date = instant.toISOString().slice(0, 10);
    const existing = await db.from("backup_runs").select("local_date").eq("local_date", date).maybeSingle();
    expect(existing.error).toBeNull();
    expect(existing.data, "Refuse to modify an existing backup run").toBeNull();

    const cursor = await db.from("job_cursors").select("job").eq("job", "backup").eq("period", date)
      .maybeSingle();
    expect(cursor.error).toBeNull();
    expect(cursor.data, "Refuse to modify an existing backup pass").toBeNull();

    const uploaded = new Map<string, Buffer>();
    const storageFrom = db.storage.from.bind(db.storage);
    vi.spyOn(db.storage, "from").mockImplementation((bucket) => {
      expect(bucket).toBe("backups");
      const storage = storageFrom(bucket);
      vi.spyOn(storage, "upload").mockImplementation(async (path, body) => {
        expect(path.startsWith(`meal-companion/${date}`)).toBe(true);
        // A part is streamed a page at a time (S3); the manifest is one small string.
        uploaded.set(path, typeof body === "string" ? Buffer.from(body)
          : Buffer.from(await new Response(body as ReadableStream).arrayBuffer()));
        return { data: { id: "synthetic-upload", path, fullPath: `${bucket}/${path}` }, error: null };
      });
      return storage;
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(instant);
    try {
      const response = await GET(new Request("http://localhost/api/jobs/backup", {
        headers: { authorization: "Bearer synthetic-backup-route-integration" },
      }));
      const result = await response.json();
      const recorded = await db.from("backup_runs").select("status, bytes, error")
        .eq("local_date", date).single();
      expect(recorded.error).toBeNull();
      expect(response.status, String(recorded.data?.error ?? result.error ?? "")).toBe(200);
      const manifest = JSON.parse(uploaded.get(`meal-companion/${date}.json`)!.toString("utf8"));
      expect(manifest.format).toBe("user-table-export-v2");
      const parts = (manifest.parts as string[]).map((path) => uploaded.get(path)!);
      expect(recorded.data).toMatchObject({ status: "ok", error: null,
        bytes: parts.reduce((sum, part) => sum + part.length, 0) });
      const tables = new Set(parts.flatMap((part) => Object.keys(JSON.parse(part.toString("utf8")).tables)));
      // Every listed table exists in the migrated schema and was read (A083).
      expect([...tables]).toEqual(BACKUP_TABLES.map((t) => t.name));
    } finally {
      // This test owns only this date's run and pass; never delete another run or any user data.
      const removed = await db.from("backup_runs").delete().eq("local_date", date);
      expect(removed.error).toBeNull();
      const pass = await db.from("job_cursors").delete().eq("job", "backup").eq("period", date);
      expect(pass.error).toBeNull();
    }
  }, 60_000);
});
