/**
 * Spec 3.5 (Phase 9 slice 3), the backup job: by design it dumps every account's rows with the
 * admin client, so its tenancy boundary is who can reach the dump. The job runs for real, but only
 * against a local, disposable Supabase stack (it skips otherwise), and never on today's date:
 * the clock is frozen to a synthetic day in 2001, the test refuses to run if that day already has
 * a lease or a dump, and it removes only the lease and the object it created (review r6 finding 2).
 * B holds a canary row; the dump must contain it (control), and signed-in A must not be able to
 * download or list the manifest or any part. A caller without the cron secret gets nothing.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { purge } from "./seed";
import { localTargets } from "./target-guard";

const { POST: backupJob } = await import("@/app/api/jobs/backup/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

const CANARY = `canary-${crypto.randomUUID()}`;
const SECRET = `tenancy-${crypto.randomUUID()}`;
// A synthetic day no real run can have: 2001-01-01 plus 0..364 days.
const DAY = new Date(Date.UTC(2001, 0, 1) + Math.floor(Math.random() * 365) * 86_400_000)
  .toISOString().slice(0, 10);
const OBJECT = `meal-companion/${DAY}.json`;
let parts: string[] = [];
const cron = (secret = SECRET) => new Request("https://app.test/api/jobs/backup",
  { method: "POST", headers: { authorization: `Bearer ${secret}` } });

describe.skipIf(!HAS_BRANCH || !HAS_DB || !localTargets())(
  "the backup dump is out of every user's reach", () => {
    let a: TestUser;
    let b: TestUser;
    let created = false;

    beforeAll(async () => {
      [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
      await purge([a.id, b.id]);
      const { error } = await adminClient().from("user_foods").insert({ user_id: b.id,
        name: CANARY, kind: "custom" });
      if (error) throw new Error(error.message);
      // Refuse to run over anything that already exists for the synthetic day.
      const lease = await adminClient().from("backup_runs").select("local_date")
        .eq("local_date", DAY);
      if (lease.error) throw new Error(lease.error.message);
      const listed = await adminClient().storage.from("backups").list("meal-companion",
        { search: `${DAY}.json` });
      if (listed.error) throw new Error(listed.error.message);
      const pass = await adminClient().from("job_cursors").select("job").eq("job", "backup")
        .eq("period", DAY);
      if (pass.error) throw new Error(pass.error.message);
      if ((lease.data ?? []).length > 0 || (listed.data ?? []).length > 0
        || (pass.data ?? []).length > 0) {
        throw new Error(`a backup lease or dump already exists for ${DAY}; refusing to run`);
      }
    });

    beforeEach(() => {
      resetRateLimits();
      vi.stubEnv("CRON_SECRET", SECRET);
    });

    afterAll(async () => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      if (created) {
        await adminClient().storage.from("backups").remove([OBJECT, ...parts]);
        await adminClient().from("backup_runs").delete().eq("local_date", DAY);
        await adminClient().from("job_cursors").delete().eq("job", "backup").eq("period", DAY);
      }
      await purge([a.id, b.id]);
    });

    it("a caller without the cron secret gets 401 and no dump", async () => {
      expect((await backupJob(cron("wrong"))).status).toBe(401);
    });

    it("the dump holds B's canary, and signed-in A can neither download nor list it",
      async () => {
        vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${DAY}T12:00:00Z`) });
        let res: Response;
        try {
          res = await backupJob(cron());
        } finally {
          vi.useRealTimers();
        }
        created = true;
        expect(res.status).toBe(200);

        // The manifest names the parts; the parts hold the rows (audit 2026-10-10 F10).
        const manifest = await adminClient().storage.from("backups").download(OBJECT);
        expect(manifest.error).toBeNull();
        parts = JSON.parse(await manifest.data!.text()).parts as string[];
        const texts = await Promise.all(parts.map(async (path) => {
          const part = await adminClient().storage.from("backups").download(path);
          expect(part.error).toBeNull();
          return part.data!.text();
        }));
        expect(texts.some((text) => text.includes(CANARY))).toBe(true);   // control

        const bucket = (await userClient(a)).storage.from("backups");
        expect((await bucket.download(OBJECT)).data).toBeNull();
        for (const path of parts) expect((await bucket.download(path)).data).toBeNull();
        expect((await bucket.list("meal-companion")).data ?? []).toEqual([]);
        expect((await bucket.list(`meal-companion/${DAY}`)).data ?? []).toEqual([]);
      });
  });
