/**
 * Spec 3.5 canary for `/api/jobs/onboarding-events-purge` (Followups #18), a service-role entry
 * point. The job deletes every account's onboarding events older than 90 days by age alone: it
 * names no user, so the canary is B's fresh event, which must survive while A's and B's old
 * events go. The route runs against the local stack with the real admin client and the cron
 * secret.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HAS_BRANCH, HAS_DB, ensureUser, runSql, type TestUser } from "../helpers/supabase";
import { assertLocalTargets } from "./target-guard";

const { POST: onboardingEventsPurgeJob, GET } = await import("@/app/api/jobs/onboarding-events-purge/route");
const { resetRateLimits } = await import("@/lib/server/ratelimit");

const SECRET = `tenancy-${crypto.randomUUID()}`;

function event(owner: string, days: number): string {
  const id = crypto.randomUUID();
  runSql(`insert into public.onboarding_events (user_id, client_event_id, at, flow_version, kind,
    step, created_at)
    values ('${owner}', '${id}', now() - interval '${days} days', 'onboarding_v2', 'step_entered',
    'facts', now() - interval '${days} days')`);
  return id;
}

describe.skipIf(!HAS_BRANCH || !HAS_DB)("onboarding events purge job (canary)", () => {
  let a: TestUser;
  let b: TestUser;
  const clear = () => runSql(`delete from public.onboarding_events where user_id in ('${a.id}', '${b.id}')`);

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
    const old = event(a.id, 100);
    const res = await GET(new Request("https://app.test/api/jobs/onboarding-events-purge"));
    expect(res.status).toBe(401);
    expect(runSql(`select count(*) from public.onboarding_events where client_event_id = '${old}'`)).toBe("1");
  });

  it("removes only events past 90 days, for every account, and keeps B's fresh canary", async () => {
    const [oldA, oldB, canary] = [event(a.id, 100), event(b.id, 91), event(b.id, 2)];
    const res = await onboardingEventsPurgeJob(new Request("https://app.test/api/jobs/onboarding-events-purge",
      { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect((await res.json() as { purged: number }).purged).toBeGreaterThanOrEqual(2);
    const left = runSql(`select coalesce(string_agg(client_event_id::text, ','), '')
      from public.onboarding_events where client_event_id in ('${oldA}', '${oldB}', '${canary}')`);
    expect(left).toBe(canary);
  });
});
