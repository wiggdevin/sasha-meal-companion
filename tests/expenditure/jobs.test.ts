// tests/expenditure/jobs.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keysetListing, noCursors } from "../helpers/job-doubles";
const enforceRateLimit = vi.fn();
const proposalRpc = vi.fn();
// The S3 pass store is not modelled here: its claim fails (logged) and each run walks the whole
// listing, so `proposalRpc` sees only the job's own RPCs.
const admin = { from: vi.fn(), rpc: (name: string, args: unknown) => (name === "claim_job_cursor"
  ? Promise.resolve({ data: null, error: { message: "no pass store in this double" } })
  : proposalRpc(name, args)) };
const runEstimate = vi.fn();
const timeZoneFor = vi.fn();
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: (...a: unknown[]) => enforceRateLimit(...a) }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin }));
vi.mock("@/lib/server/expenditure", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/expenditure")>("@/lib/server/expenditure");
  return { ...actual,
    runEstimate: (...a: unknown[]) => runEstimate(...a),
    timeZoneFor: (...a: unknown[]) => timeZoneFor(...a),
  };
});
// The jobs inject weigh-ins through Lane P's `weighInsKg`; the test doubles only that export,
// keeping the rest of health-daily (mergedDays, listSources) real for any other consumer.
const mergedDays = vi.fn(async () => []);
vi.mock("@/lib/server/health-daily", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/health-daily")>("@/lib/server/health-daily");
  return { ...actual, weighInsKg: vi.fn(async () => []), mergedDays };
});
const buildProposal = vi.fn();
const activeProfile = vi.fn();
vi.mock("@/lib/proposal", () => ({ buildProposal: (...a: unknown[]) => buildProposal(...a) }));
vi.mock("@/lib/server/targets", () => ({ activeProfile: (...a: unknown[]) => activeProfile(...a) }));
const { GET: weeklyProposalGET, POST: weeklyProposalPOST } = await import("@/app/api/jobs/weekly-proposal/route");
const { GET, POST } = await import("@/app/api/jobs/estimate/route");
const { mondayOf, takeLock } = await import("@/lib/server/jobs");

// A chainable double for `update(...).eq(...).eq(...).eq(...).or(...).select(...)` — the shape
// `takeLock`'s reclaim step and `releaseLock` both issue. Resolving to `{ data: [], error: null }`
// by default means "the reclaim condition matched nothing" (a held lock stays held), matching the
// pre-reclaim behavior for every existing caller that never checks the update's return value.
const updateChain = (): Record<string, unknown> => {
  const c: Record<string, unknown> = {};
  Object.assign(c, {
    eq: () => c, or: () => c, select: () => c,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  });
  return c;
};
const lockOk = () => ({ insert: () => ({ select: async () => ({ data: [{}], error: null }) }),
  update: () => updateChain(),
  select: () => ({ eq: async () => ({ data: [{ user_id: "u1" }], error: null }) }) });
const lockHeld = () => ({ ...lockOk(),
  insert: () => ({ select: async () => ({ data: null, error: { code: "23505" } }) }),
  // claimLock reads the held row: today's estimate already finished.
  select: () => ({ match: async () => ({ data: [{ status: "ok" }], error: null }) }) });

const estimateRequest = (method: "GET" | "POST", secret?: string) => new Request(
  "https://x.test/api/jobs/estimate",
  { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} },
);
const call = (secret = "s3cret") => POST(estimateRequest("POST", secret));

/**
 * A tiny in-memory `job_runs` table that models real Postgres semantics for exactly the calls
 * `takeLock` makes: a unique-violation on a duplicate insert, and a conditional `UPDATE ...
 * WHERE ... OR (...)` that only touches rows matching the filters/or-expression — so these tests
 * exercise the actual reclaim condition, not a hand-picked mock response.
 */
type JobRunRow = { job: string; user_id: string; run_key: string; status: "running" | "ok" | "error";
  started_at: string; finished_at: string | null; detail: unknown };

function fakeJobRunsAdmin(seed: JobRunRow[] = []) {
  const rows: JobRunRow[] = seed.map((r) => ({ ...r }));

  function splitTop(expr: string): string[] {
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of expr) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  }
  function evalClause(clause: string, row: JobRunRow): boolean {
    if (clause.startsWith("and(") && clause.endsWith(")")) {
      return splitTop(clause.slice(4, -1)).every((c) => evalClause(c, row));
    }
    const [field, op, ...rest] = clause.split(".");
    let value = rest.join(".");
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const actual = (row as unknown as Record<string, unknown>)[field];
    if (op === "eq") return String(actual) === value;
    if (op === "lt") return new Date(String(actual)).getTime() < new Date(value).getTime();
    throw new Error(`fakeJobRunsAdmin: unsupported filter op "${op}"`);
  }

  const from = (table: string) => {
    if (table !== "job_runs") throw new Error(`fakeJobRunsAdmin only models job_runs, got "${table}"`);
    let mode: "insert" | "update" | null = null;
    let payload: Record<string, unknown> = {};
    const filters: { field: string; value: unknown }[] = [];
    let orExpr: string | null = null;

    const chain: Record<string, unknown> = {
      insert: (row: Record<string, unknown>) => { mode = "insert"; payload = row; return chain; },
      update: (row: Record<string, unknown>) => { mode = "update"; payload = row; return chain; },
      eq: (field: string, value: unknown) => { filters.push({ field, value }); return chain; },
      or: (expr: string) => { orExpr = expr; return chain; },
      select: () => chain,
      then: (resolve: (v: unknown) => unknown) => {
        let result: { data: unknown; error: unknown };
        if (mode === "insert") {
          const key = payload as Partial<JobRunRow>;
          const exists = rows.find((r) =>
            r.job === key.job && r.user_id === key.user_id && r.run_key === key.run_key);
          if (exists) {
            result = { data: null, error: { code: "23505", message: "duplicate key" } };
          } else {
            const full: JobRunRow = {
              job: key.job as string, user_id: key.user_id as string, run_key: key.run_key as string,
              status: (key.status as JobRunRow["status"]) ?? "running",
              started_at: new Date().toISOString(), finished_at: null, detail: null,
            };
            rows.push(full);
            result = { data: [full], error: null };
          }
        } else if (mode === "update") {
          const matched = rows.filter((r) =>
            filters.every((f) => (r as unknown as Record<string, unknown>)[f.field] === f.value)
            && (!orExpr || splitTop(orExpr).some((clause) => evalClause(clause, r))));
          matched.forEach((r) => Object.assign(r, payload));
          result = { data: matched, error: null };
        } else {
          result = { data: [], error: null };
        }
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  };
  return { from, rows };
}

/** `user_settings` for the jobs: the owner list (`.not`) and each owner's stored zone (`.eq`). */
let zones: Record<string, string | null> = {};
const settingsTable = (users: string[]) => ({ select: () => ({
  not: () => keysetListing({ data: users.map((user_id) => ({ user_id })), error: null }),
  eq: (_k: string, user: string) => ({ maybeSingle: async () => ({
    data: { time_zone: user in zones ? zones[user] : "America/Denver" }, error: null }) }),
}) });

beforeEach(() => {
  zones = {};
  process.env.CRON_SECRET = "s3cret";
  process.env.ESTIMATOR_ENABLED = "1";
  enforceRateLimit.mockReset().mockResolvedValue(undefined);
  runEstimate.mockReset().mockResolvedValue({ status: "estimating", tdeeKcal: 2200 });
  timeZoneFor.mockReset().mockResolvedValue("America/Denver");
  mergedDays.mockClear();
  admin.from.mockReset().mockImplementation((t: string) =>
    t === "user_settings" ? settingsTable(["u1"]) : t === "job_cursors" ? noCursors() : lockOk());
});

describe("POST /api/jobs/estimate", () => {
  it("checks the secret before it spends the shared rate limit (scale S2)", async () => {
    await call("wrong");
    expect(enforceRateLimit).not.toHaveBeenCalled();
    await call();
    expect(enforceRateLimit).toHaveBeenCalledWith("jobs:estimate", 10, 3600);
  });
  it("401s a bad cron secret", async () => {
    expect((await call("wrong")).status).toBe(401);
  });
  it.each([undefined, "wrong"])("GET 401s a missing or wrong cron secret (%s)", async (secret) => {
    expect((await GET(estimateRequest("GET", secret))).status).toBe(401);
    expect(runEstimate).not.toHaveBeenCalled();
  });
  it("GET runs the same estimate and returns the same status as POST", async () => {
    const post = await call();
    const get = await GET(estimateRequest("GET", "s3cret"));
    expect(get.status).toBe(post.status);
    expect(get.status).toBe(200);
    expect(runEstimate).toHaveBeenCalledTimes(2);
  });
  it("503s when ESTIMATOR_ENABLED is unset", async () => {
    delete process.env.ESTIMATOR_ENABLED;
    expect((await call()).status).toBe(503);
  });
  it("runs one estimate per user and reports the counts", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ran: 1, skipped: 0, errors: 0 });
    expect(runEstimate).toHaveBeenCalledTimes(1);
    expect(runEstimate).toHaveBeenCalledWith(admin, "u1", expect.any(String),
      { weighIns: expect.any(Function), activityDays: expect.any(Function),
        timeZone: "America/Denver" });
  });

  it("uses each user's local date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T05:30:00Z"));
    try {
      await call();
      expect(runEstimate).toHaveBeenCalledWith(admin, "u1", "2026-09-19",
        expect.objectContaining({ timeZone: "America/Denver" }));
    } finally {
      vi.useRealTimers();
    }
  });
  it("an invalid stored zone dates by UTC, logged, and every user is still estimated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T05:30:00Z"));
    zones = { "u-bad": "Not/A_Time_Zone" };
    admin.from.mockImplementation((t: string) => t === "user_settings"
      ? settingsTable(["u-bad", "u-good"]) : t === "job_cursors" ? noCursors() : lockOk());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await call();
      await expect(res.json()).resolves.toEqual({ ran: 2, skipped: 0, errors: 0 });
      expect(runEstimate).toHaveBeenCalledWith(admin, "u-bad", "2026-09-20",
        expect.objectContaining({ timeZone: "UTC" }));
      expect(runEstimate).toHaveBeenCalledWith(admin, "u-good", "2026-09-19",
        expect.objectContaining({ timeZone: "America/Denver" }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("estimate job"));
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
  it("skips a user whose per-day lock is already held", async () => {
    admin.from.mockImplementation((t: string) =>
      t === "user_settings" ? settingsTable(["u1"]) : t === "job_cursors" ? noCursors() : lockHeld());
    await expect((await call()).json()).resolves.toEqual({ ran: 0, skipped: 1, errors: 0 });
    expect(runEstimate).not.toHaveBeenCalled();
  });
  it("counts a thrown estimate as an error and keeps going", async () => {
    runEstimate.mockRejectedValue(new Error("boom"));
    // The failed account is queued for retry, so the day's pass is not finished yet.
    await expect((await call()).json()).resolves.toEqual({ ran: 0, skipped: 0, errors: 1,
      incomplete: true });
  });
});

describe("mondayOf", () => {
  it("returns the Monday that starts the week a date falls in", () => {
    expect(mondayOf("2026-09-13")).toBe("2026-09-07");   // a Sunday belongs to the week just ending
    expect(mondayOf("2026-09-14")).toBe("2026-09-14");
  });
});

describe("POST /api/jobs/weekly-proposal", () => {
  const rpc = proposalRpc;
  const request = (method: "GET" | "POST", secret?: string) => new Request(
    "https://x.test/api/jobs/weekly-proposal",
    { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} },
  );
  const call = (secret = "s3cret") => weeklyProposalPOST(request("POST", secret));

  beforeEach(() => {
    activeProfile.mockReset().mockResolvedValue({ kcal_train: 2200, kcal_rest: 2000 });
    buildProposal.mockReset().mockReturnValue({
      kind: "proposal",
      proposed: { kcalTrain: 2210, kcalRest: 2010, proteinG: 150, fatG: 60, carbG: 200,
        deltaKcalTrain: 10, deltaKcalRest: 10, raisedToFloor: false },
    });
    rpc.mockReset().mockResolvedValue({ data: "proposal-id-1", error: null });
    admin.from.mockReset().mockImplementation((t: string) => {
      if (t === "user_settings") {
        return { select: () => ({ not: () => keysetListing({ data: [{ user_id: "u1" }], error: null }) }) };
      }
      if (t === "job_cursors") return noCursors();
      if (t === "expenditure_estimates") {
        return { select: () => ({ eq: () => ({ eq: () => ({
          maybeSingle: async () => ({ data: { id: "est-1" }, error: null }) }) }) }) };
      }
      return lockOk();
    });
  });

  it.each([undefined, "wrong"])("GET 401s a missing or wrong cron secret (%s)", async (secret) => {
    expect((await weeklyProposalGET(request("GET", secret))).status).toBe(401);
    expect(runEstimate).not.toHaveBeenCalled();
  });

  it("GET runs the same proposal job and returns the same status as POST", async () => {
    const post = await call();
    const get = await weeklyProposalGET(request("GET", "s3cret"));
    expect(get.status).toBe(post.status);
    expect(get.status).toBe(200);
    expect(runEstimate).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("calls write_target_proposal once, with the rejecting-RPC doing the reject before the insert", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("write_target_proposal", expect.objectContaining({
      p_user_id: "u1", p_based_on_estimate_id: "est-1",
    }));
    // Exactly one RPC call per user per run: the single transactional write_target_proposal is
    // what "reject happens before insert" now means at the route layer — there is no separate
    // insert-then-update pair left in application code to race.
    expect(admin.from).not.toHaveBeenCalledWith("target_proposals");
  });

  it("a same-week retry calls the RPC again but the second call is a no-op — the SQL's week_start exclusion, not this mock, is what leaves the existing pending row untouched", async () => {
    rpc.mockResolvedValueOnce({ data: "proposal-week-1", error: null });
    const first = await call();
    expect(first.status).toBe(200);

    // Same mocked clock as the first call, so the route computes the same week_start — this is
    // a same-week retry, not a second week. `on conflict (user_id, week_start) do nothing`
    // returns null because a row for this week already exists (and, after the migration fix,
    // the UPDATE never touched it — it excludes week_start = p_week_start).
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const second = await call();
    expect(second.status).toBe(200);

    expect(rpc).toHaveBeenCalledTimes(2);
    // Both calls went through the same transactional RPC — the route never bypasses it with its
    // own insert or update on target_proposals. Which row survives a retry is the migration's
    // job (verified by reading the SQL, not by this mock, which cannot exercise real conflicts).
    expect(admin.from).not.toHaveBeenCalledWith("target_proposals");
  });

  it("returns none when the RPC returns no id (same-week retry, already proposed)", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const res = await call();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ran: 1, errors: 0 });
  });

  it("backfills a missed week via an explicit weekStart override, instead of silently landing the retry in whichever week wall-clock 'now' happens to fall in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T15:00:00Z")); // Monday local (America/New_York) — current week already started
    try {
      const missedWeekStart = "2026-09-07"; // the Sunday-just-passed week whose cron run failed
      const res = await weeklyProposalPOST(new Request("https://x.test/api/jobs/weekly-proposal", {
        method: "POST",
        headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
        body: JSON.stringify({ weekStart: missedWeekStart }),
      }));
      expect(res.status).toBe(200);
      expect(rpc).toHaveBeenCalledWith("write_target_proposal", expect.objectContaining({
        p_week_start: missedWeekStart,
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("takeLock reclaim (audit findings #32, #63)", () => {
  const JOB = "weekly-proposal";
  const USER = "u1";
  const KEY = "2026-09-14";

  it("still refuses the lock while an existing row is a genuinely live 'running' run", async () => {
    const { from } = fakeJobRunsAdmin([{ job: JOB, user_id: USER, run_key: KEY, status: "running",
      started_at: new Date().toISOString(), finished_at: null, detail: null }]);
    await expect(takeLock(({ from }) as never, JOB, USER, KEY)).resolves.toBe(false);
  });

  it("reclaims a lock left at status='error' by a previous failed run (finding #32)", async () => {
    const { from, rows } = fakeJobRunsAdmin([{ job: JOB, user_id: USER, run_key: KEY, status: "error",
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), detail: { message: "boom" } }]);
    await expect(takeLock(({ from }) as never, JOB, USER, KEY)).resolves.toBe(true);
    expect(rows[0].status).toBe("running");
  });

  it("reclaims a 'running' lock abandoned long enough ago to be a crash, not a live run (finding #63)", async () => {
    const abandoned = new Date(Date.now() - 60 * 60 * 1000).toISOString();   // 1h ago
    const { from, rows } = fakeJobRunsAdmin([{ job: JOB, user_id: USER, run_key: KEY, status: "running",
      started_at: abandoned, finished_at: null, detail: null }]);
    await expect(takeLock(({ from }) as never, JOB, USER, KEY)).resolves.toBe(true);
    expect(rows[0].status).toBe("running");
    expect(new Date(rows[0].started_at).getTime()).toBeGreaterThan(new Date(abandoned).getTime());
  });
});
