import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoImplementMethods } from "next/dist/server/route-modules/app-route/helpers/auto-implement-methods";
import type { AppRouteHandlers } from "next/dist/server/route-modules/app-route/module";
import { DEFAULT_TZ } from "@/lib/health/contract";

const mocked = vi.hoisted(() => ({
  expiredCounts: 0,
  spendSweeps: 0,
  signalPurges: 0,
  deleteMedia: vi.fn(async () => undefined),
  pullTwoDays: vi.fn(async () => ({ inserted: 1, updated: 0, skipped: 0 })),
  runEstimate: vi.fn(async () => ({ status: "estimating", tdeeKcal: 2200 })),
  writeWeeklyReview: vi.fn(async (_admin: unknown, _userId: string, _weekStart: string) =>
    ({ threadId: "thread-1", messageId: "message-1", duplicate: false })),
  accountIds: vi.fn(),
  accountZones: vi.fn(),
  upload: vi.fn(async () => ({ error: null })),
  timeZoneFor: vi.fn(async (_admin: unknown, _userId: string) => "UTC"),
  warmEatsFacets: vi.fn(async () => ({ foods: 0, warmed: 0, skipped: 0, errors: 0,
    stoppedEarly: false })),
}));

function updateChain() {
  const chain = {
    eq: () => chain,
    lt: () => chain,
    select: async () => ({ data: [{}], error: null }),
    then: (resolveValue: (value: unknown) => unknown) =>
      Promise.resolve({ data: [{}], error: null }).then(resolveValue),
  };
  return chain;
}

/** A keyset listing double: filters and order chain, `range` answers the rows once. */
function listingChain(rows: Record<string, unknown>[]) {
  let after: string | null = null;
  const chain = {
    eq: () => chain, is: () => chain, lt: () => chain, order: () => chain,
    gt: (_key: string, value: string) => { after = value; return chain; },
    range: async () => ({ data: after === null ? rows : [], error: null }),
  };
  return chain;
}

/** The S3 resume cursors: none saved, every write accepted. */
const jobCursors = () => {
  const chain = { select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }) };
  return { ...chain, upsert: async () => ({ error: null }) };
};

async function* listOf<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}
const twoOwners = () => listOf(["user-1", "user-2"]);
const twoZones = () => listOf([
  { userId: "user-1", timeZone: "UTC" }, { userId: "user-2", timeZone: "UTC" },
]);

const admin = {
  from: (table: string) => {
    if (table === "job_cursors") return jobCursors();
    if (table === "media_objects") {
      return { select: () => listingChain([{ path: "media/user-1/old.jpg" }]) };
    }
    if (table === "health_sources") {
      return { select: () => listingChain([{ id: "source-1", user_id: "user-1", oauth: "sealed" }]) };
    }
    if (table === "job_runs") {
      return {
        insert: (row: unknown) => ({ select: async () => ({ data: [row], error: null }) }),
        update: () => ({ match: async () => ({ error: null }) }),
      };
    }
    if (table === "expenditure_estimates") {
      return { select: () => {
        const routeChain = { eq: () => ({
          maybeSingle: async () => ({ data: { id: "estimate-1" }, error: null }),
        }) };
        const chain = {
          eq: () => routeChain,
          order: () => chain,
          range: async () => ({ data: [], error: null }),
        };
        return chain;
      } };
    }
    if (table === "backup_runs") {
      return {
        insert: (row: unknown) => ({ select: async () => ({ data: [row], error: null }) }),
        update: () => updateChain(),
      };
    }
    return {
      select: () => {
        const chain = {
          order: () => chain,
          range: async () => ({ data: [], error: null }),
        };
        return chain;
      },
    };
  },
  // Scale S2 spend sweep: expired-hold counts alternate 1, 0 (one hold before each pass, none
  // after it), and each sweep pass reports one reconciled hold.
  rpc: vi.fn(async (fn: string) => {
    if (fn === "ai_spend_expired_count") return { data: mocked.expiredCounts++ % 2 === 0 ? 1 : 0, error: null };
    if (fn === "ai_spend_sweep") { mocked.spendSweeps += 1; return { data: 1, error: null }; }
    // Phase 18 W6: one partial purge pass (fewer rows than a full batch) ends the run.
    if (fn === "food_signal_events_purge") { mocked.signalPurges += 1; return { data: 3, error: null }; }
    return { data: "proposal-1", error: null };
  }),
  storage: { from: () => ({ upload: mocked.upload }) },
};

vi.mock("@/lib/server/admin", () => ({ adminClient: () => admin }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/media", () => ({ deleteMedia: mocked.deleteMedia }));
vi.mock("@/lib/server/oura", () => ({ pullTwoDays: mocked.pullTwoDays }));
vi.mock("@/lib/server/expenditure", () => ({
  runEstimate: mocked.runEstimate,
  upsertEstimate: vi.fn(async () => undefined),
  // The jobs resolve each user's zone before their local date; the cron tests keep the default
  // zone unless a case stubs one per user.
  timeZoneFor: mocked.timeZoneFor,
}));
vi.mock("@/lib/server/health-daily", () => ({
  weighInsKg: vi.fn(async () => []),
  // No merged health days: the estimate keeps its base path (activity coverage insufficient).
  mergedDays: vi.fn(async () => []),
}));
vi.mock("@/lib/server/coach", () => ({ writeWeeklyReview: mocked.writeWeeklyReview }));
vi.mock("@/lib/server/eats-facet-warm", () => ({ warmEatsFacets: mocked.warmEatsFacets }));
vi.mock("@/lib/server/targets", () => ({ activeProfile: vi.fn(async () => ({
  kcal_train: 2200,
  kcal_rest: 2000,
})) }));
vi.mock("@/lib/proposal", () => ({
  buildProposal: vi.fn(() => ({
    kind: "proposal",
    proposed: {
      kcalTrain: 2210,
      kcalRest: 2010,
      proteinG: 150,
      fatG: 60,
      carbG: 200,
      deltaKcalTrain: 10,
      deltaKcalRest: 10,
      raisedToFloor: false,
    },
  })),
}));
vi.mock("@/lib/server/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/jobs")>();
  return {
    ...actual,
    accountIds: mocked.accountIds,
    accountZones: mocked.accountZones,
    // The local Sunday-evening window has its own tests (tests/jobs/weekly-review-local.test.ts);
    // here every run is treated as inside it so the registration checks see the job body run.
    inWeeklyReviewWindow: () => true,
    weeklyReviewDue: () => true,
    takeLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => undefined),
  };
});

type CronHandler = (request: Request) => Response | Promise<Response>;
type CronRoute = Omit<AppRouteHandlers, "GET" | "POST"> & {
  GET?: CronHandler;
  POST?: CronHandler;
};

const routeLoaders: Record<string, () => Promise<CronRoute>> = {
  "/api/jobs/backup": () => import("@/app/api/jobs/backup/route"),
  "/api/jobs/estimate": () => import("@/app/api/jobs/estimate/route"),
  "/api/jobs/facet-warm": () => import("@/app/api/jobs/facet-warm/route"),
  "/api/jobs/media-sweep": () => import("@/app/api/jobs/media-sweep/route"),
  "/api/jobs/oura-pull": () => import("@/app/api/jobs/oura-pull/route"),
  "/api/jobs/weekly-proposal": () => import("@/app/api/jobs/weekly-proposal/route"),
  "/api/jobs/weekly-review": () => import("@/app/api/jobs/weekly-review/route"),
  "/api/jobs/spend-sweep": () => import("@/app/api/jobs/spend-sweep/route"),
  "/api/jobs/signal-purge": () => import("@/app/api/jobs/signal-purge/route"),
};

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
) as { crons: { path: string; schedule: string }[] };

const jobRuns: Record<string, () => number> = {
  "/api/jobs/backup": () => mocked.upload.mock.calls.length,
  "/api/jobs/estimate": () => mocked.runEstimate.mock.calls.length,
  "/api/jobs/facet-warm": () => mocked.warmEatsFacets.mock.calls.length,
  "/api/jobs/media-sweep": () => mocked.deleteMedia.mock.calls.length,
  "/api/jobs/oura-pull": () => mocked.pullTwoDays.mock.calls.length,
  "/api/jobs/weekly-proposal": () => mocked.runEstimate.mock.calls.length,
  "/api/jobs/weekly-review": () => mocked.writeWeeklyReview.mock.calls.length,
  "/api/jobs/spend-sweep": () => mocked.spendSweeps,
  "/api/jobs/signal-purge": () => mocked.signalPurges,
};

const cronRequest = (path: string, method: "GET" | "POST", token?: string) => new Request(
  `https://app.test${path}`,
  { method, headers: token ? { authorization: `Bearer ${token}` } : {} },
);

beforeEach(() => {
  vi.clearAllMocks();
  mocked.expiredCounts = 0;
  mocked.spendSweeps = 0;
  mocked.signalPurges = 0;
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("ESTIMATOR_ENABLED", "1");
  vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
  vi.stubEnv("COACH_ENABLED", "1");
  mocked.accountIds.mockImplementation(twoOwners);
  mocked.accountZones.mockImplementation(twoZones);
  mocked.timeZoneFor.mockImplementation(async () => DEFAULT_TZ);
});

afterEach(() => vi.unstubAllEnvs());

describe("Vercel cron route registration", () => {
  it.each(manifest.crons)("$path exports GET", async ({ path }) => {
    const load = routeLoaders[path];
    expect(load, `${path} is missing from the route test registry`).toBeTypeOf("function");
    expect((await load()).GET, `${path} does not export GET`).toBeTypeOf("function");
  });

  it.each(manifest.crons)("$path GET rejects missing and wrong bearer tokens", async ({ path }) => {
    const route = await routeLoaders[path]();
    expect((await route.GET!(cronRequest(path, "GET"))).status).toBe(401);
    expect((await route.GET!(cronRequest(path, "GET", "wrong"))).status).toBe(401);
    expect(jobRuns[path]()).toBe(0);
  });

  it.each(manifest.crons)("$path GET runs the job and matches POST status", async ({ path }) => {
    const route = await routeLoaders[path]();
    const post = await route.POST!(cronRequest(path, "POST", "cron-secret"));
    const get = await route.GET!(cronRequest(path, "GET", "cron-secret"));
    expect(get.status).toBe(post.status);
    expect(get.status).toBe(200);
    const iteratesSettingsOwners = [
      "/api/jobs/estimate", "/api/jobs/facet-warm", "/api/jobs/weekly-proposal",
      "/api/jobs/weekly-review",
    ].includes(path);
    expect(jobRuns[path]()).toBe(iteratesSettingsOwners ? 4 : 2);
  });

  it("weekly review runs once for every settings owner", async () => {
    const route = await routeLoaders["/api/jobs/weekly-review"]();
    const response = await route.GET!(cronRequest(
      "/api/jobs/weekly-review", "GET", "cron-secret",
    ));
    expect(response.status).toBe(200);
    expect(mocked.writeWeeklyReview.mock.calls.map((call) => call[1])).toEqual([
      "user-1", "user-2",
    ]);
  });

  it("takes each user's week start from that user's own timezone", async () => {
    // Sunday 23:30 UTC is already Monday 11:30 in Auckland (UTC+12; NZDT starts 2026-09-27), so
    // the two users sit in different weeks at the same instant. A job that computed one week start
    // for everyone would write the same string twice and give one of them last week's review.
    mocked.accountZones.mockImplementation(() => listOf([
      { userId: "user-1", timeZone: "UTC" }, { userId: "user-2", timeZone: "Pacific/Auckland" },
    ]));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T23:30:00.000Z"));
    try {
      const route = await routeLoaders["/api/jobs/weekly-review"]();
      const response = await route.GET!(cronRequest(
        "/api/jobs/weekly-review", "GET", "cron-secret",
      ));
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }

    const weekStartByUser = Object.fromEntries(
      mocked.writeWeeklyReview.mock.calls.map((call) => [call[1], call[2]]),
    );
    expect(weekStartByUser["user-1"]).toBe("2026-09-14");
    expect(weekStartByUser["user-2"]).toBe("2026-09-21");
    expect(weekStartByUser["user-1"]).not.toBe(weekStartByUser["user-2"]);
  });

  it.each(manifest.crons)("$path rejects PUT with 405", async ({ path }) => {
    const route = await routeLoaders[path]();
    const handlers = autoImplementMethods(route as AppRouteHandlers);
    const response = await handlers.PUT(
      new Request(`https://app.test${path}`, { method: "PUT" }) as never,
      {},
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(405);
  });
});
