/**
 * S3 review round 1, BLOCK 3: every fire of one weekly-proposal pass computes the same week for an
 * account. At 01:00 UTC Monday it is still Sunday 23:00 in America/Noronha (UTC-2); at 02:00 UTC it
 * is Monday there. A resumed fire that read "now" would hand a retried account the week now
 * starting; the pass's start instant (job_cursors.pass_started_at) keeps it on the week ending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobRunsTable, keysetListing, passStore } from "../helpers/job-doubles";

const runEstimate = vi.fn();
const zoneOf: Record<string, string> = {};
let owners = ["u1", "u2"];
const proposals: { user: string; week: string }[] = [];
let store = passStore();
let jobRuns = jobRunsTable();

const admin = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "claim_job_cursor") return store.claim(args as never);
    proposals.push({ user: String(args.p_user_id), week: String(args.p_week_start) });
    return { data: `proposal-${proposals.length}`, error: null };
  },
  from: (table: string) => {
    if (table === "job_cursors") return store.table();
    if (table === "job_runs") return jobRuns.from();
    if (table === "user_settings") return { select: () => ({
      not: () => keysetListing(() => ({ data: owners.map((user_id) => ({ user_id })),
        error: null })),
      eq: () => ({ maybeSingle: async () => ({ data: { time_zone: "America/Noronha" },
        error: null }) }) }) };
    if (table === "expenditure_estimates") return { select: () => ({ eq: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { id: "est-1" }, error: null }) }) }) }) };
    throw new Error(`unexpected table ${table}`);
  },
};

vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin }));
vi.mock("@/lib/server/expenditure", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/expenditure")>()),
  runEstimate: (...a: unknown[]) => runEstimate(...a),
  timeZoneFor: async (_a: unknown, user: string) => zoneOf[user] ?? "America/Noronha",
  upsertEstimate: async () => undefined,
}));
vi.mock("@/lib/server/health-daily", () => ({ weighInsKg: vi.fn(async () => []),
  mergedDays: vi.fn(async () => []) }));
vi.mock("@/lib/server/targets", () => ({ activeProfile: async () => ({ kcal_train: 2200,
  kcal_rest: 2000 }) }));
vi.mock("@/lib/proposal", () => ({ buildProposal: () => ({ kind: "proposal", proposed: {
  kcalTrain: 2210, kcalRest: 2010, proteinG: 150, fatG: 60, carbG: 200, deltaKcalTrain: 10,
  deltaKcalRest: 10, raisedToFloor: false } }) }));

const { GET } = await import("@/app/api/jobs/weekly-proposal/route");
const { weekJustEnding } = await import("@/lib/server/jobs");

/** The week just ending, in each account's own calendar, at every Monday-UTC fire. */
const ZONES = ["UTC", "Europe/London", "Pacific/Kiritimati", "Pacific/Pago_Pago",
  "America/Noronha", "America/Los_Angeles"];
const FIRES = ["2026-10-12T01:00:00Z", "2026-10-12T02:00:00Z", "2026-10-12T03:00:00Z"];
const fire = async (at: string) => {
  vi.setSystemTime(new Date(at));
  const res = await GET(new Request("https://x.test/api/jobs/weekly-proposal",
    { headers: { authorization: "Bearer s3cret" } }));
  expect(res.status).toBe(200);
  return res.json();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("ESTIMATOR_ENABLED", "1");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  store = passStore();
  jobRuns = jobRunsTable();
  proposals.length = 0;
  owners = ["u1", "u2"];
  for (const key of Object.keys(zoneOf)) delete zoneOf[key];
  runEstimate.mockReset().mockResolvedValue({ status: "estimating", tdeeKcal: 2200 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("weekly-proposal pass across its Monday fires", () => {
  it("a retried account gets the week the pass began on, not the week its later fire sees",
    async () => {
      let u2Failures = 1;                                  // u2 fails on the first fire only
      runEstimate.mockImplementation(async (_a: unknown, user: string) => {
        if (user === "u2" && u2Failures-- > 0) throw new Error("estimate failed");
        return { status: "estimating", tdeeKcal: 2200 };
      });
      expect(await fire("2026-10-12T01:00:00Z")).toMatchObject({ ran: 1, errors: 1,
        incomplete: true });
      expect(await fire("2026-10-12T02:00:00Z")).toEqual({ ran: 1, skipped: 0, errors: 0 });
      expect(proposals).toEqual([{ user: "u1", week: "2026-10-05" },
        { user: "u2", week: "2026-10-05" }]);
      // The pass is finished: the third fire does nothing.
      expect(await fire("2026-10-12T03:00:00Z")).toEqual({ ran: 0, skipped: 0, errors: 0 });
      expect(runEstimate).toHaveBeenCalledTimes(3);
    });

  it.each(ZONES.flatMap((zone) => FIRES.map((fire) => [zone, fire])))(
    "%s at %s: the week just ending is 2026-10-05", (zone, fire) => {
      expect(weekJustEnding(zone, new Date(fire))).toBe("2026-10-05");
    });

  it("the week just ending, not the one starting: a local Monday reviews last week", () => {
    expect(weekJustEnding("Europe/London", new Date("2026-10-12T01:00:00Z"))).toBe("2026-10-05");
    expect(weekJustEnding("America/Los_Angeles", new Date("2026-10-12T01:00:00Z")))
      .toBe("2026-10-05");                                   // Sunday 18:00 local
    expect(weekJustEnding("UTC", new Date("2026-10-18T12:00:00Z"))).toBe("2026-10-12"); // Sunday
  });

  it("every zone's account gets 2026-10-05 from a pass that runs across the three fires",
    async () => {
      owners = ZONES.map((_, i) => `z${i}`);
      ZONES.forEach((zone, i) => { zoneOf[`z${i}`] = zone; });
      // Every account fails on the first fire, so each is proposed on a later one.
      const failedOnce = new Set<string>();
      runEstimate.mockImplementation(async (_a: unknown, user: string) => {
        if (!failedOnce.has(user)) { failedOnce.add(user); throw new Error("first fire fails"); }
        return { status: "estimating", tdeeKcal: 2200 };
      });
      for (const at of FIRES) await fire(at);
      expect(proposals.map((p) => p.week)).toEqual(ZONES.map(() => "2026-10-05"));
      expect(proposals.map((p) => p.user).sort()).toEqual([...owners].sort());
    });
});

