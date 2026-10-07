import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("reads every included table using valid primary-key ordering and completes its owned lease", async () => {
    const url = process.env.SUPABASE_TEST_URL!;
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
    vi.stubEnv("SUPABASE_URL", url);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_TEST_SERVICE_ROLE_KEY!);
    vi.stubEnv("CRON_SECRET", "synthetic-backup-route-integration");
    const { adminClient } = await import("@/lib/server/admin");
    const { GET } = await import("@/app/api/jobs/backup/route");
    const db = adminClient();

    // Far-future, randomized date + exact lease timestamp isolate this test from other jobs.
    const instant = new Date(Date.UTC(2400, 0, 1) + randomInt(0, 365 * 500) * 86_400_000 + randomInt(0, 86_400_000));
    const date = instant.toISOString().slice(0, 10);
    const startedAt = instant.toISOString();
    const existing = await db.from("backup_runs").select("local_date").eq("local_date", date).maybeSingle();
    expect(existing.error).toBeNull();
    expect(existing.data, "Refuse to modify an existing backup run").toBeNull();

    let uploaded: Buffer | undefined;
    const storageFrom = db.storage.from.bind(db.storage);
    vi.spyOn(db.storage, "from").mockImplementation((bucket) => {
      expect(bucket).toBe("backups");
      const storage = storageFrom(bucket);
      vi.spyOn(storage, "upload").mockImplementation(async (path, body) => {
        expect(path).toBe(`meal-companion/${date}.json`);
        // Streamed a page at a time (S3); the whole document is read back here.
        expect(body).toBeInstanceOf(ReadableStream);
        uploaded = Buffer.from(await new Response(body as ReadableStream).arrayBuffer());
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
        .eq("local_date", date).eq("started_at", startedAt).single();
      expect(recorded.error).toBeNull();
      expect(response.status, String(recorded.data?.error ?? result.error ?? "")).toBe(200);
      expect(recorded.data).toMatchObject({ status: "ok", bytes: uploaded?.length, error: null });
      const snapshot = JSON.parse(uploaded!.toString("utf8"));
      expect(snapshot.tables).toHaveProperty("media_objects");
      expect(snapshot.tables).toHaveProperty("change_log");
      expect(snapshot.tables).toHaveProperty("recipe_items");
    } finally {
      // This test owns only this date and lease; never delete another run or any user data.
      const removed = await db.from("backup_runs").delete()
        .eq("local_date", date).eq("started_at", startedAt);
      expect(removed.error).toBeNull();
    }
  }, 60_000);
});
