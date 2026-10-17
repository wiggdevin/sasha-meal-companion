/**
 * Spec 3.5 canary for `/api/jobs/retention-purge` (W044), a service-role entry point. The job
 * deletes every account's rows past each table's retention window by age alone: it names no user,
 * so the canaries are B's fresh client timing and B's ai_calls row that an unsettled spend hold
 * still names, which must survive while A's and B's old timings go. The route runs against the
 * local stack with the real admin client and the cron secret.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql, type TestUser } from "../helpers/supabase";
import { assertLocalTargets } from "./target-guard";

const { POST: retentionPurgeJob, GET } = await import("@/app/api/jobs/retention-purge/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

const SECRET = `tenancy-${crypto.randomUUID()}`;
const TAG = `canary-${crypto.randomUUID().slice(0, 8)}`;

function timing(owner: string, days: number): string {
  return runSql(`insert into public.client_timings (user_id, run_id, path, step, ms, device, created_at)
    values ('${owner}', gen_random_uuid(), 'barcode', 'decode', 1, '${TAG}',
    now() - interval '${days} days') returning run_id`).split("\n")[0];
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("retention purge job (canary)", () => {
  let a: TestUser;
  let b: TestUser;
  let hold = "";
  const clear = () => runSql(`delete from public.client_timings where device = '${TAG}';
    delete from public.ai_calls where purpose = '${TAG}';
    delete from public.ai_spend_reservations where id = ${hold ? `'${hold}'` : "null"};`);

  beforeAll(async () => {
    assertLocalTargets();
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    clear();
  });
  beforeEach(() => {
    resetRateLimits();
    vi.stubEnv("CRON_SECRET", SECRET);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    clear();
  });

  it("refuses a caller without the cron secret and deletes nothing", async () => {
    const old = timing(a.id, 120);
    const res = await GET(new Request("https://app.test/api/jobs/retention-purge"));
    expect(res.status).toBe(401);
    expect(runSql(`select count(*) from public.client_timings where run_id = '${old}'`)).toBe("1");
  });

  it("removes old rows for every account and keeps B's fresh and held canaries", async () => {
    const [oldA, oldB, canary] = [timing(a.id, 120), timing(b.id, 91), timing(b.id, 2)];
    // A zero-dollar, unexpired hold: it moves no cap and no sweep reconciles it during the run.
    hold = runSql(`insert into public.ai_spend_reservations (user_id, day, amount_usd, expires_at)
      values ('${b.id}', current_date, 0, now() + interval '1 hour') returning id`).split("\n")[0];
    const held = runSql(`insert into public.ai_calls (user_id, purpose, provider, model_id, sdk_version,
      created_at, spend_reservation_id) values ('${b.id}', '${TAG}', 'test', 'm', '1',
      now() - interval '120 days', '${hold}') returning id`).split("\n")[0];
    const res = await retentionPurgeJob(new Request("https://app.test/api/jobs/retention-purge",
      { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    const body = await res.json() as { tables: Record<string, { purged: number; before: number | null;
      after: number | null }> };
    expect(body.tables.client_timings.purged).toBeGreaterThanOrEqual(2);
    expect(typeof body.tables.client_timings.before).toBe("number");
    const left = runSql(`select coalesce(string_agg(run_id::text, ','), '')
      from public.client_timings where run_id in ('${oldA}', '${oldB}', '${canary}')`);
    expect(left).toBe(canary);
    expect(runSql(`select count(*) from public.ai_calls where id = '${held}'`)).toBe("1");
  });
});
