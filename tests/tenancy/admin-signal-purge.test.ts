/**
 * Spec 3.5 canary for `/api/jobs/signal-purge` (Phase 18 W6), a service-role entry point. The job
 * deletes every account's food signal events older than 180 days by age alone: it names no user,
 * so the canary is B's fresh event, which must survive while A's and B's old events go. The route
 * runs against the local stack with the real admin client and the cron secret.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql, type TestUser } from "../helpers/supabase";
import { assertLocalTargets } from "./target-guard";

const { POST: signalPurgeJob, GET } = await import("@/app/api/jobs/signal-purge/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

const SECRET = `tenancy-${crypto.randomUUID()}`;

function event(owner: string, days: number): string {
  const id = crypto.randomUUID();
  runSql(`insert into public.food_signal_events (user_id, client_event_id, slate_id, at,
    local_date, surface, kind, occasion, chosen_key, offered_keys, ranking_version, created_at)
    values ('${owner}', '${id}', gen_random_uuid(), now() - interval '${days} days',
    (now() - interval '${days} days')::date, 'plan_sheet', 'not_this', 'dinner',
    'food:canary-stew', '{food:canary-stew}', 'o2.1', now() - interval '${days} days')`);
  return id;
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("signal purge job (canary)", () => {
  let a: TestUser;
  let b: TestUser;
  const clear = () => runSql(`delete from public.food_signal_events where user_id in ('${a.id}', '${b.id}')`);

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
    const old = event(a.id, 200);
    const res = await GET(new Request("https://app.test/api/jobs/signal-purge"));
    expect(res.status).toBe(401);
    expect(runSql(`select count(*) from public.food_signal_events where client_event_id = '${old}'`)).toBe("1");
  });

  it("removes only events past 180 days, for every account, and keeps B's fresh canary", async () => {
    const [oldA, oldB, canary] = [event(a.id, 200), event(b.id, 181), event(b.id, 2)];
    const res = await signalPurgeJob(new Request("https://app.test/api/jobs/signal-purge",
      { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect((await res.json() as { purged: number }).purged).toBeGreaterThanOrEqual(2);
    const left = runSql(`select coalesce(string_agg(client_event_id::text, ','), '')
      from public.food_signal_events where client_event_id in ('${oldA}', '${oldB}', '${canary}')`);
    expect(left).toBe(canary);
  });
});
