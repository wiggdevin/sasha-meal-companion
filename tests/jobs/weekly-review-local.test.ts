/**
 * AI-integration audit P2 #15: the weekly review runs hourly and reaches each account only during
 * its own local Sunday 18:00–18:59, for its own local week, once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inWeeklyReviewWindow, weekStartOf } from "@/lib/server/jobs";
import { jobRunsTable } from "../helpers/job-doubles";

type Settings = { user_id: string; time_zone: string | null };

const state = vi.hoisted(() => ({
  settings: [] as { user_id: string; time_zone: string | null }[],
  jobRuns: [] as { job: string; user_id: string; run_key: string; status: string }[],
  delivered: new Set<string>(),
}));

/** user_settings (paged read) and a stateful job_runs (tests/helpers/job-doubles.ts). */
let jobRuns = jobRunsTable();
function fakeAdmin() {
  const from = (table: string) => {
    if (table === "user_settings") {
      const chain: Record<string, unknown> = {
        select: () => chain, not: () => chain, order: () => chain,
        range: async (start: number, end: number) =>
          ({ data: state.settings.slice(start, end + 1), error: null }),
      };
      return chain;
    }
    if (table !== "job_runs") throw new Error(`unexpected table ${table}`);
    return jobRuns.from();
  };
  return { from };
}

const writeWeeklyReview = vi.hoisted(() => vi.fn(
  async (_admin: unknown, userId: string, weekStart: string) => {
    const key = `${userId}:${weekStart}`;
    const duplicate = state.delivered.has(key);
    state.delivered.add(key);
    return { threadId: `thread-${userId}`, messageId: `message-${key}`, duplicate };
  }));

vi.mock("@/lib/server/admin", () => ({ adminClient: () => fakeAdmin() }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/coach", () => ({ writeWeeklyReview }));

const { GET } = await import("@/app/api/jobs/weekly-review/route");

const SECRET = "cron-secret";
const run = async (at: string) => {
  vi.setSystemTime(new Date(at));
  const res = await GET(new Request("https://app.test/api/jobs/weekly-review", {
    headers: { authorization: `Bearer ${SECRET}` } }));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ ran: number; skipped: number; errors: number }>;
};
const reviewed = () => writeWeeklyReview.mock.calls.map((c) => [c[1], c[2]]);

/** Every hourly :30 fire from `from` (inclusive) for `hours` hours. */
async function sweep(from: string, hours: number): Promise<void> {
  const start = Date.parse(from);
  for (let h = 0; h < hours; h += 1) await run(new Date(start + h * 3_600_000).toISOString());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("COACH_ENABLED", "1");
  vi.stubEnv("HEALTH_TZ", "");
  jobRuns = jobRunsTable();
  state.jobRuns = jobRuns.rows;
  state.delivered.clear();
  writeWeeklyReview.mockReset();   // back to the delivering default between tests
  state.settings = [
    { user_id: "denver", time_zone: "America/Denver" },
    { user_id: "tokyo", time_zone: "Asia/Tokyo" },
  ] satisfies Settings[];
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("inWeeklyReviewWindow", () => {
  it("is open only during the zone's own Sunday 18:00–18:59", () => {
    // Sunday 2026-10-11 18:00 MDT = 2026-10-12T00:00Z.
    expect(inWeeklyReviewWindow(new Date("2026-10-12T00:00:00Z"), "America/Denver")).toBe(true);
    expect(inWeeklyReviewWindow(new Date("2026-10-12T00:59:59Z"), "America/Denver")).toBe(true);
    expect(inWeeklyReviewWindow(new Date("2026-10-11T23:59:59Z"), "America/Denver")).toBe(false);
    expect(inWeeklyReviewWindow(new Date("2026-10-12T01:00:00Z"), "America/Denver")).toBe(false);
    // The same UTC instant is Monday 09:00 in Tokyo.
    expect(inWeeklyReviewWindow(new Date("2026-10-12T00:00:00Z"), "Asia/Tokyo")).toBe(false);
    // A Saturday 18:30 is not a review hour anywhere.
    expect(inWeeklyReviewWindow(new Date("2026-10-10T18:30:00Z"), "UTC")).toBe(false);
  });

  it("meets half-hour offsets on the :30 fire (Kolkata 18:00 = 12:30Z)", () => {
    expect(inWeeklyReviewWindow(new Date("2026-10-11T12:30:00Z"), "Asia/Kolkata")).toBe(true);
    expect(inWeeklyReviewWindow(new Date("2026-10-11T11:30:00Z"), "Asia/Kolkata")).toBe(false);
  });
});

describe("GET /api/jobs/weekly-review (hourly, local Sunday evening)", () => {
  it("reviews Denver only during its local Sunday 18:xx", async () => {
    expect(await run("2026-10-11T23:30:00Z")).toEqual({ ran: 0, skipped: 0, errors: 0 }); // 17:30 MDT
    expect(await run("2026-10-12T00:30:00Z")).toEqual({ ran: 1, skipped: 0, errors: 0 }); // 18:30 MDT
    expect(await run("2026-10-12T01:30:00Z")).toEqual({ ran: 0, skipped: 0, errors: 0 }); // 19:30 MDT
    expect(reviewed()).toEqual([["denver", "2026-10-05"]]);
  });

  it("reviews Tokyo at its own Sunday 18:xx, for its own local week", async () => {
    expect(await run("2026-10-11T09:30:00Z")).toEqual({ ran: 1, skipped: 0, errors: 0 }); // 18:30 JST
    expect(reviewed()).toEqual([["tokyo", "2026-10-05"]]);
    expect(weekStartOf(new Date("2026-10-11T09:30:00Z"), "Asia/Tokyo")).toBe("2026-10-05");
  });

  it("reaches every account exactly once across a whole week of hourly fires", async () => {
    state.settings = [...state.settings,
      { user_id: "kathmandu", time_zone: "Asia/Kathmandu" },
      { user_id: "no-zone", time_zone: null }];
    // From Monday 00:30 in Denver, after every zone's previous Sunday evening (and its catch-up
    // hours) has passed, through the next Sunday evening everywhere.
    await sweep("2026-10-05T06:30:00Z", 7 * 24 + 11);
    expect(reviewed().sort()).toEqual([
      ["denver", "2026-10-05"], ["kathmandu", "2026-10-05"], ["no-zone", "2026-10-05"],
      ["tokyo", "2026-10-05"],
    ]);
  });

  it("a run that stops at its time budget leaves the rest to the next hour, once each (S3)",
    async () => {
      state.settings = Array.from({ length: 6 }, (_, i) =>
        ({ user_id: `denver-${i}`, time_zone: "America/Denver" }));
      // Each review takes five minutes of wall clock: the first run's budget is spent after the
      // reviews already in flight, so it starts no more and says so.
      writeWeeklyReview.mockImplementation(async (_admin, userId, weekStart) => {
        vi.setSystemTime(Date.now() + 300_000);
        return { threadId: `thread-${userId}`, messageId: `${userId}:${weekStart}`, duplicate: false };
      });
      const first = await run("2026-10-12T00:30:00Z");                        // 18:30 MDT
      expect(first).toMatchObject({ errors: 0, incomplete: true });
      expect(first.ran).toBeGreaterThan(0);
      expect(first.ran).toBeLessThan(6);
      // The catch-up hours (19:30–23:30 MDT) review whoever the earlier fires did not reach.
      let total = first.ran;
      for (const at of ["01:30", "02:30", "03:30", "04:30", "05:30"]) {
        const next = await run(`2026-10-12T${at}:00Z`);
        expect(next).toMatchObject({ skipped: 0, errors: 0 });
        total += next.ran;
      }
      expect(total).toBe(6);
      expect(reviewed().map(([user]) => user).sort())
        .toEqual(state.settings.map((s) => s.user_id).sort());
      // Monday in Denver: the week is closed; nobody is due.
      expect(await run("2026-10-12T06:30:00Z")).toEqual({ ran: 0, skipped: 0, errors: 0 });
    });

  it("an account with no saved zone falls back to UTC", async () => {
    state.settings = [{ user_id: "no-zone", time_zone: null }];
    await run("2026-10-11T18:30:00Z");
    expect(reviewed()).toEqual([["no-zone", "2026-10-05"]]);
  });

  it("is idempotent: a re-run in the same hour writes nothing more", async () => {
    expect(await run("2026-10-12T00:30:00Z")).toMatchObject({ ran: 1 });
    expect(await run("2026-10-12T00:45:00Z")).toEqual({ ran: 0, skipped: 1, errors: 0 });
    expect(writeWeeklyReview).toHaveBeenCalledTimes(1);
  });

  it("counts a reclaimed lock whose week already has a review as skipped, not ran", async () => {
    await run("2026-10-12T00:30:00Z");
    state.jobRuns[0].status = "error";   // as if releaseLock had recorded a failure afterwards
    expect(await run("2026-10-12T00:40:00Z")).toEqual({ ran: 0, skipped: 1, errors: 0 });
  });

  it("retries a failed review once, at a later hour, and never pays for a third attempt", async () => {
    state.settings = [{ user_id: "denver", time_zone: "America/Denver" }];
    writeWeeklyReview.mockRejectedValue(new Error("save failed after generation"));
    expect(await run("2026-10-12T00:30:00Z")).toMatchObject({ errors: 1 });   // 18:30 MDT
    expect(await run("2026-10-12T00:45:00Z")).toMatchObject({ errors: 1 });   // the one retry
    expect(await run("2026-10-12T01:30:00Z")).toEqual({ ran: 0, skipped: 0, errors: 0 });
    expect(await run("2026-10-12T02:30:00Z")).toEqual({ ran: 0, skipped: 0, errors: 0 });
    expect(writeWeeklyReview).toHaveBeenCalledTimes(2);
  });

  it("an attempt whose status was never recorded counts as spent once stale: one retry only",
    async () => {
      state.settings = [{ user_id: "denver", time_zone: "America/Denver" }];
      // The first attempt's row was left "running" (its release write failed), long ago.
      state.jobRuns.push({ job: "weekly-review-local", user_id: "denver", run_key: "2026-10-05",
        status: "running", started_at: "2026-10-11T00:00:00.000Z", finished_at: null,
        detail: null } as never);
      writeWeeklyReview.mockRejectedValue(new Error("save failed"));
      expect(await run("2026-10-12T01:30:00Z")).toMatchObject({ errors: 1 });   // the retry
      expect(await run("2026-10-12T02:30:00Z")).toEqual({ ran: 0, skipped: 0, errors: 0 });
      expect(writeWeeklyReview).toHaveBeenCalledTimes(1);
      expect(state.jobRuns.find((r) => r.run_key === "2026-10-05")?.status).toBe("running");
    });

  it("follows Denver across the fall-back DST change (2026-11-01) without skipping or doubling",
    async () => {
      state.settings = [{ user_id: "denver", time_zone: "America/Denver" }];
      // 00:30Z was 18:30 MDT the week before; on 2026-11-01 it is 17:30 MST, and 01:30Z is 18:30.
      expect(inWeeklyReviewWindow(new Date("2026-10-26T00:30:00Z"), "America/Denver")).toBe(true);
      expect(inWeeklyReviewWindow(new Date("2026-11-02T00:30:00Z"), "America/Denver")).toBe(false);
      expect(inWeeklyReviewWindow(new Date("2026-11-02T01:30:00Z"), "America/Denver")).toBe(true);
      await sweep("2026-10-24T00:30:00Z", 17 * 24);    // Sundays 10-25, 11-01 (the change), 11-08
      expect(reviewed()).toEqual([
        ["denver", "2026-10-19"], ["denver", "2026-10-26"], ["denver", "2026-11-02"],
      ]);
    });

  it("follows Denver across the spring-forward DST change (2027-03-14)", async () => {
    state.settings = [{ user_id: "denver", time_zone: "America/Denver" }];
    await sweep("2027-03-07T00:30:00Z", 14 * 24);
    expect(reviewed()).toEqual([["denver", "2027-03-01"], ["denver", "2027-03-08"]]);
    // 2027-03-15T00:30Z is 18:30 MDT on the change day; one hour earlier is 17:30 MDT.
    expect(inWeeklyReviewWindow(new Date("2027-03-15T00:30:00Z"), "America/Denver")).toBe(true);
    expect(inWeeklyReviewWindow(new Date("2027-03-14T23:30:00Z"), "America/Denver")).toBe(false);
  });
});
