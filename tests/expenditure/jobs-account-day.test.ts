// t24b: the estimate and weekly-proposal jobs date each account by its own day (stored zone, else
// UTC as the logged last resort), never by the deployment-wide HEALTH_TZ. The probe: no stored
// zone, HEALTH_TZ=America/Denver, 2026-10-05T01:00Z — Denver is still Oct 4, the rule says Oct 5.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keysetListing, noCursors } from "../helpers/job-doubles";
const admin = { from: vi.fn(), rpc: vi.fn() };
const runEstimate = vi.fn();
const timeZoneFor = vi.fn();
const buildProposal = vi.fn();
const activeProfile = vi.fn();
// Onboarding v2 pace holds are covered in tests/expenditure/jobs.test.ts; this file tests weeks.
vi.mock("@/lib/server/target-eligibility", () => ({
  readTargetEligibility: async () => ({ holds: [], minor: false }) }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin }));
vi.mock("@/lib/server/expenditure", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/expenditure")>("@/lib/server/expenditure");
  return { ...actual, runEstimate: (...a: unknown[]) => runEstimate(...a),
    timeZoneFor: (...a: unknown[]) => timeZoneFor(...a) };
});
vi.mock("@/lib/server/health-daily", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/health-daily")>("@/lib/server/health-daily");
  return { ...actual, weighInsKg: vi.fn(async () => []), mergedDays: vi.fn(async () => []) };
});
vi.mock("@/lib/proposal", () => ({ buildProposal: (...a: unknown[]) => buildProposal(...a) }));
vi.mock("@/lib/server/targets", () => ({ activeProfile: (...a: unknown[]) => activeProfile(...a) }));
const { POST: estimatePOST } = await import("@/app/api/jobs/estimate/route");
const { POST: proposalPOST } = await import("@/app/api/jobs/weekly-proposal/route");

const lock = () => ({ insert: () => ({ select: async () => ({ data: [{}], error: null }) }),
  update: () => { const c: Record<string, unknown> = {};
    Object.assign(c, { eq: () => c, or: () => c, select: () => c,
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r) });
    return c; } });
const call = (post: (req: Request) => Promise<Response>) => post(new Request("https://x.test/job",
  { method: "POST", headers: { authorization: "Bearer s3cret" } }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T01:00:00Z"));
  vi.stubEnv("HEALTH_TZ", "America/Denver");
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("ESTIMATOR_ENABLED", "1");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  runEstimate.mockReset().mockResolvedValue({ status: "estimating", tdeeKcal: 2200 });
  timeZoneFor.mockReset().mockResolvedValue("America/Denver"); // HEALTH_TZ, as the real one answers
  activeProfile.mockReset().mockImplementation(async (_c: unknown, _u: string, date: string) =>
    ({ id: date >= "2026-10-05" ? "oct5" : "oct4", kcal_train: 2200, kcal_rest: 2000 }));
  buildProposal.mockReset().mockReturnValue({ kind: "proposal", proposed: { kcalTrain: 2210,
    kcalRest: 2010, proteinG: 150, fatG: 60, carbG: 200, deltaKcalTrain: 10, deltaKcalRest: 10,
    raisedToFloor: false } });
  admin.rpc.mockReset().mockResolvedValue({ data: "proposal-1", error: null });
  admin.from.mockReset().mockImplementation((t: string) => {
    if (t === "job_cursors") return noCursors();
    if (t === "user_settings") return { select: () => ({
      not: () => keysetListing({ data: [{ user_id: "u1" }], error: null }),
      eq: () => ({ maybeSingle: async () => ({ data: { time_zone: null }, error: null }) }) }) };
    if (t === "expenditure_estimates") return { select: () => ({ eq: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { id: "est-1" }, error: null }) }) }) }) };
    return lock();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("job account day (t24b probe)", () => {
  it("estimate job: Oct 5 in UTC, logged, not HEALTH_TZ's Oct 4", async () => {
    expect((await call(estimatePOST)).status).toBe(200);
    expect(runEstimate).toHaveBeenCalledWith(admin, "u1", "2026-10-05",
      expect.objectContaining({ timeZone: "UTC" }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("estimate job"));
  });

  it("weekly proposal: estimate and target lookup on Oct 5; week_start keeps the cron zone", async () => {
    expect((await call(proposalPOST)).status).toBe(200);
    expect(activeProfile).toHaveBeenCalledWith(admin, "u1", "2026-10-05");
    expect(runEstimate).toHaveBeenCalledWith(admin, "u1", "2026-10-05",
      expect.objectContaining({ timeZone: "UTC" }));
    expect(buildProposal).toHaveBeenCalledWith(expect.objectContaining({
      active: expect.objectContaining({ id: "oct5" }) }));
    // Shared with the weekly-review job (weekStartOf), so it is left on the cron zone chain.
    expect(admin.rpc).toHaveBeenCalledWith("write_target_proposal", expect.objectContaining({
      p_week_start: "2026-09-28" }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("weekly-proposal job"));
  });
});
