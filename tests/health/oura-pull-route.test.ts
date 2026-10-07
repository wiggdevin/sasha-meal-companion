import { beforeEach, describe, expect, it, vi } from "vitest";
import { pullTwoDays } from "@/lib/server/oura";
import { resetRateLimits } from "@/lib/server/ratelimit";
import { jobRunsTable } from "../helpers/job-doubles";

vi.mock("@/lib/server/oura", () => ({ pullTwoDays: vi.fn() }));

const insert = vi.fn();
const sources = vi.fn();
/** health_sources as the keyset listing reads it; `sources` answers the first page. */
function sourceListing() {
  let after: string | null = null;
  const chain = {
    eq: () => chain, is: () => chain, order: () => chain,
    gt: (_key: string, value: string) => { after = value; return chain; },
    range: async () => (after === null ? sources() : { data: [], error: null }),
  };
  return chain;
}

/** No saved resume cursor (lib/server/job-sweep.ts); every cursor write accepted. */
function cursors() {
  const chain = { select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }), upsert: async () => ({ error: null }) };
  return chain;
}

/** A stateful job_runs (the reclaimable lock); every insert is also recorded in `insert`. */
let jobRuns = jobRunsTable();
function lockTable() {
  const chain = jobRuns.from() as Record<string, (...a: unknown[]) => unknown>;
  const realInsert = chain.insert;
  chain.insert = (row: unknown) => { insert(row); return realInsert(row); };
  return chain;
}

vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({
  from: (table: string) => table === "job_runs" ? lockTable()
    : table === "job_cursors" ? cursors()
    : { select: () => sourceListing() } }) }));

const { GET, POST } = await import("@/app/api/jobs/oura-pull/route");

function request(method: "GET" | "POST", secret?: string): Request {
  return new Request("https://app.test/api/jobs/oura-pull", {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const post = (secret = "cron-secret") => request("POST", secret);

describe("POST /api/jobs/oura-pull", () => {
  beforeEach(() => {
    resetRateLimits();
    insert.mockClear();
    jobRuns = jobRunsTable();
    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("HEALTH_INGEST_ENABLED", "1");
    sources.mockResolvedValue({ data: [{ id: "src-o", user_id: "user-1", oauth: "sealed" }],
      error: null });
    vi.mocked(pullTwoDays).mockReset()
      .mockResolvedValue({ inserted: 4, updated: 0, skipped: 2 });
  });

  it("401s a wrong secret and never reads a source", async () => {
    expect((await POST(post("wrong"))).status).toBe(401);
    expect(sources).not.toHaveBeenCalled();
  });

  it.each([undefined, "wrong"])("GET 401s a missing or wrong secret (%s) and never reads a source", async (secret) => {
    expect((await GET(request("GET", secret))).status).toBe(401);
    expect(sources).not.toHaveBeenCalled();
  });

  it("GET runs the same pull and returns the same status as POST", async () => {
    const postResponse = await POST(post());
    jobRuns = jobRunsTable();   // as on a day whose pull has not run yet
    const getResponse = await GET(request("GET", "cron-secret"));
    expect(getResponse.status).toBe(postResponse.status);
    expect(getResponse.status).toBe(200);
    expect(pullTwoDays).toHaveBeenCalledTimes(2);
  });

  it("no-ops with the flag unset", async () => {
    vi.stubEnv("HEALTH_INGEST_ENABLED", "");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: 0, sources: 0, results: [] });
    expect(pullTwoDays).not.toHaveBeenCalled();
  });

  it("takes the job_runs lock per user and local date, then pulls", async () => {
    const res = await POST(post());
    expect(await res.json()).toMatchObject({ users: 1, sources: 1,
      results: [{ user_id: "user-1", inserted: 4, updated: 0, skipped: 2 }] });
    expect(insert.mock.calls[0][0]).toMatchObject({ job: "oura-pull", user_id: "user-1",
      status: "running" });
    expect(String((insert.mock.calls[0][0] as { run_key: string }).run_key))
      .toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("records a source's error without failing the whole run", async () => {
    vi.mocked(pullTwoDays).mockRejectedValue(new Error("Oura sleep failed with 500"));
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].error).toBe("Oura sleep failed with 500");
  });

  it("isolates each source: one failing pull never stops the others", async () => {
    sources.mockResolvedValue({ data: ["a", "b", "c"].map((u) => ({ id: `src-${u}`, user_id: u,
      oauth: "sealed" })), error: null });
    vi.mocked(pullTwoDays).mockImplementation(async (_admin, source) => {
      if (source.user_id === "b") throw new Error("Oura 500");
      return { inserted: 1, updated: 0, skipped: 0 };
    });
    const body = await (await POST(post())).json();
    expect(body.sources).toBe(3);
    expect(body.results.filter((r: { error?: string }) => !r.error)
      .map((r: { user_id: string }) => r.user_id).sort()).toEqual(["a", "c"]);
  });

  it("a failed pull does not block the day: the next run (even an explicit POST) pulls again",
    async () => {
      vi.mocked(pullTwoDays).mockRejectedValueOnce(new Error("Oura 500"));
      expect((await (await POST(post())).json()).results[0].error).toBe("Oura 500");
      expect(jobRuns.rows[0]).toMatchObject({ job: "oura-pull", user_id: "user-1", status: "error" });
      const retried = await (await POST(post())).json();
      expect(retried.results).toEqual([{ user_id: "user-1", inserted: 4, updated: 0, skipped: 2 }]);
      expect(jobRuns.rows[0].status).toBe("ok");
      // A finished pull is final for the day.
      expect((await (await POST(post())).json()).results).toEqual([]);
      expect(pullTwoDays).toHaveBeenCalledTimes(2);
    });

  it("a running row a killed worker left behind is reclaimed after it goes stale", async () => {
    jobRuns = jobRunsTable([{ job: "oura-pull", user_id: "user-1",
      run_key: new Date().toISOString().slice(0, 10), status: "running",
      started_at: new Date(Date.now() - 60 * 60_000).toISOString() }]);
    const body = await (await POST(post())).json();
    expect(body.results).toEqual([{ user_id: "user-1", inserted: 4, updated: 0, skipped: 2 }]);
  });

  it("500s when the source listing itself fails", async () => {
    sources.mockResolvedValue({ data: null, error: { message: "timeout" } });
    expect((await POST(post())).status).toBe(500);
  });
});
