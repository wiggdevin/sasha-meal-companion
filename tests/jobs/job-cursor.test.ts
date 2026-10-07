/**
 * Scale-readiness S3, review round 1: one pass strung across budgeted runs (lib/server/job-cursor.ts)
 * and the lock states the routes map onto it (`claimLock`, lib/server/jobs.ts).
 *
 * - A pass is done only when the listing ended AND nothing is left to retry; later runs retry
 *   exactly the accounts that failed or were held.
 * - One run at a time holds a pass (lease); a run that lost its lease cannot overwrite it.
 * - Every run of a pass sees the same start instant; a restart starts a fresh pass.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { keysetRows } from "@/lib/server/job-sweep";
import { MAX_RETRY_KEYS, savePass, sweep } from "@/lib/server/job-cursor";
import { claimLock, releaseLock } from "@/lib/server/jobs";
import { jobRunsTable, passStore } from "../helpers/job-doubles";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u-${String(i).padStart(5, "0")}`);

function listing(keys: string[]) {
  const calls: (string | null)[] = [];
  const page = async (after: string | null, size: number) => {
    calls.push(after);
    return { data: keys.filter((k) => after === null || k > after).slice(0, size), error: null };
  };
  return { page, calls };
}

async function* listOf(keys: string[]): AsyncGenerator<string> { yield* keys; }

function adminWith(store: ReturnType<typeof passStore>) {
  return {
    rpc: async (name: string, params: never) => {
      expect(name).toBe("claim_job_cursor");
      return store.claim(params);
    },
    from: (table: string) => {
      expect(table).toBe("job_cursors");
      return store.table();
    },
  } as never;
}

afterEach(() => vi.restoreAllMocks());

describe("sweep: one pass across budgeted runs", () => {
  it("a budget stop resumes exactly where it stopped; every account once; then the pass is done",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const owners = ids(2_600);
      const store = passStore();
      const { page, calls } = listing(owners);
      const processed: string[] = [];
      let clock = 0;
      const run = () => sweep(adminWith(store), {
        job: "estimate", period: "2026-10-06", byKeys: listOf,
        list: (after) => keysetRows(page, (k) => k, after), keyOf: (k) => k,
        concurrency: 8, deadline: clock + 1_000, now: () => clock,
        work: async (id) => { clock += 1; await Promise.resolve(); processed.push(id); },
      });

      const first = await run();
      expect(first.complete).toBe(false);
      expect(first.passDone).toBe(false);
      calls.length = 0;
      let last = await run();
      expect(calls[0]).toBe(first.cursor);           // resumed after the saved key
      while (!last.passDone) last = await run();
      expect(processed.length).toBe(owners.length);
      expect([...processed].sort()).toEqual(owners);
      expect(store.rows.get("estimate|2026-10-06")?.done).toBe(true);
      expect(await run()).toMatchObject({ alreadyDone: true, started: 0 });
    });

  it("is not done while an account failed: the next run retries exactly the failed ones",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const store = passStore();
      const failing = new Set(["u-00002", "u-00005"]);
      const attempts: string[] = [];
      const run = () => sweep(adminWith(store), {
        job: "facet-warm", period: "d", byKeys: listOf, concurrency: 3, deadline: Infinity,
        list: (after) => keysetRows(listing(ids(8)).page, (k) => k, after), keyOf: (k) => k,
        work: async (id) => {
          attempts.push(id);
          if (id === "u-00005") throw new Error("model 503");    // a thrown failure
          return failing.has(id) ? "retry" : "ok";               // a handled failure
        },
        onError: () => undefined,
      });

      const first = await run();
      expect(first).toMatchObject({ complete: true, passDone: false, retry: ["u-00002", "u-00005"] });
      expect(store.rows.get("facet-warm|d")).toMatchObject({ listed: true, done: false,
        retry_keys: ["u-00002", "u-00005"] });

      attempts.length = 0;
      failing.delete("u-00002");
      const second = await run();
      expect(attempts).toEqual(["u-00002", "u-00005"]);          // only the failures
      expect(second.passDone).toBe(false);
      expect(store.rows.get("facet-warm|d")?.retry_keys).toEqual(["u-00005"]);

      attempts.length = 0;
      const third = await sweep(adminWith(store), {
        job: "facet-warm", period: "d", byKeys: listOf, concurrency: 3, deadline: Infinity,
        list: () => listOf([]), keyOf: (k) => k, work: async (id) => { attempts.push(id); },
      });
      expect(attempts).toEqual(["u-00005"]);
      expect(third.passDone).toBe(true);
      expect(store.rows.get("facet-warm|d")).toMatchObject({ done: true, retry_keys: [] });
    });

  it("an account held by another run is retried, not counted done", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = passStore();
    const result = await sweep(adminWith(store), {
      job: "j", period: "p", byKeys: listOf, concurrency: 2, deadline: Infinity,
      list: () => listOf(["a", "b"]), keyOf: (k) => k,
      work: async (id) => (id === "b" ? "retry" : "skip"),
    });
    expect(result).toMatchObject({ passDone: false, retry: ["b"] });
  });

  it("one run at a time: a second run while the lease is live does nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = passStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const options = {
      job: "j", period: "p", byKeys: listOf, concurrency: 1, deadline: Infinity,
      list: () => listOf(["a"]), keyOf: (k: string) => k,
    };
    const first = sweep(adminWith(store), { ...options, work: async () => { await gate; } });
    await new Promise((r) => setTimeout(r, 5));
    const second = await sweep(adminWith(store), { ...options, work: async () => undefined });
    expect(second).toMatchObject({ busy: true, started: 0 });
    release();
    expect(await first).toMatchObject({ passDone: true });
  });

  it("a run that lost its lease cannot overwrite the pass a newer run saved", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let clock = 0;
    const store = passStore(() => clock);
    const admin = adminWith(store);
    store.claim({ p_job: "j", p_period: "p", p_owner: "old", p_lease_seconds: 1,
      p_restart: false });
    clock = 5_000;                                              // the old lease lapsed
    store.claim({ p_job: "j", p_period: "p", p_owner: "new", p_lease_seconds: 360,
      p_restart: false });
    await savePass(admin, "j", "p", "new", { after: null, listed: true, retry: [], relist: false,
      done: true });
    await savePass(admin, "j", "p", "old", { after: "x", listed: false, retry: [], relist: false,
      done: false });
    expect(store.rows.get("j|p")).toMatchObject({ done: true, listed: true, after_key: null });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("lease lost"), expect.anything());
  });

  it("every run of a pass sees its start instant; a restart begins a new pass", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clock = Date.parse("2026-10-12T01:00:00Z");
    const store = passStore(() => clock);
    const seen: string[] = [];
    const run = (restart = false) => sweep(adminWith(store), {
      job: "weekly-proposal", period: "2026-10-12", restart, byKeys: listOf, concurrency: 1,
      deadline: Infinity, list: () => listOf(["a"]), keyOf: (k) => k,
      work: async (_id, pass) => { seen.push(pass.passStartedAt.toISOString()); return "retry"; },
    });
    await run();
    clock = Date.parse("2026-10-12T02:00:00Z");
    await run();
    expect(seen).toEqual(["2026-10-12T01:00:00.000Z", "2026-10-12T01:00:00.000Z"]);
    await run(true);
    expect(seen[2]).toBe("2026-10-12T02:00:00.000Z");
  });

  it("a failed claim walks the whole listing with no cursor instead of failing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = { rpc: async () => ({ data: null, error: { message: "no such function" } }),
      from: () => { throw new Error("must not save without a lease"); } } as never;
    const seen: string[] = [];
    const result = await sweep(admin, {
      job: "j", period: "p", byKeys: listOf, concurrency: 2, deadline: Infinity,
      list: () => listOf(["a", "b", "c"]), keyOf: (k) => k,
      work: async (id) => { seen.push(id); },
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(result.passDone).toBe(true);
    expect(error).toHaveBeenCalled();
  });

  it("a failed listing page saves the exact progress, rethrows, and the next run resumes",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const owners = ids(1_500);
      const store = passStore();
      let failOnce = true;
      const page = async (after: string | null, size: number) => {
        if (after !== null && failOnce) {
          failOnce = false;
          return { data: null, error: { message: "page 2 timed out" } };
        }
        return { data: owners.filter((k) => after === null || k > after).slice(0, size), error: null };
      };
      const processed: string[] = [];
      const run = () => sweep(adminWith(store), {
        job: "j", period: "d", byKeys: listOf, concurrency: 5, deadline: Infinity,
        list: (after) => keysetRows(page, (k) => k, after), keyOf: (k) => k,
        work: async (id) => { processed.push(id); },
      });
      await expect(run()).rejects.toThrow("page 2 timed out");
      expect(store.rows.get("j|d")).toMatchObject({ after_key: owners[999], done: false });
      await run();
      expect(processed.sort()).toEqual(owners);
      expect(store.rows.get("j|d")?.done).toBe(true);
    });
});

describe("sweep: a bounded retry queue", () => {
  it("past MAX_RETRY_KEYS failures the pass lists again from the start instead of queueing",
    async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const owners = ids(MAX_RETRY_KEYS + 500);
      const store = passStore();
      let failing = true;
      const attempts = new Map<string, number>();
      const run = () => sweep(adminWith(store), {
        job: "j", period: "p", byKeys: listOf, concurrency: 16, deadline: Infinity,
        list: (after) => keysetRows(listing(owners).page, (k) => k, after), keyOf: (k) => k,
        work: async (id) => {
          attempts.set(id, (attempts.get(id) ?? 0) + 1);
          return failing ? "retry" : "ok";
        },
      });
      const first = await run();
      expect(first.passDone).toBe(false);
      const row = store.rows.get("j|p")!;
      expect(row).toMatchObject({ after_key: null, listed: false, relist: false });
      expect(row.retry_keys.length).toBe(0);                  // never stored past the bound
      expect(error).toHaveBeenCalledWith(expect.stringContaining("overflow"), expect.anything());
      failing = false;
      const second = await run();                              // a full re-list, from the start
      expect(second.passDone).toBe(true);
      expect(attempts.get(owners[0])).toBe(2);
      expect(attempts.get(owners.at(-1)!)).toBe(2);
    });
});

describe("runWithinBudget: a stalled listing page", () => {
  it("stops at the hard stop instead of waiting on the page; nothing past the cursor started",
    async () => {
      const t0 = Date.now();
      async function* stalls(): AsyncGenerator<string> {
        yield "a";
        await new Promise(() => undefined);                    // the second page never answers
      }
      const { runWithinBudget } = await import("@/lib/server/job-sweep");
      const outcome = await runWithinBudget({ items: stalls(), keyOf: (k) => k, concurrency: 2,
        deadline: t0 + 10_000, hardStop: t0 + 50, work: async () => undefined });
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(outcome).toMatchObject({ started: 1, cursor: "a", complete: false, stalled: true });
    });
});

describe("claimLock", () => {
  const admin = (table: ReturnType<typeof jobRunsTable>) => ({ from: table.from }) as never;

  it("takes a free lock, reports a finished one as done and a live one as busy", async () => {
    const table = jobRunsTable([
      { job: "j", user_id: "done", run_key: "k", status: "ok" },
      { job: "j", user_id: "live", run_key: "k", status: "running" },
    ]);
    expect(await claimLock(admin(table), "j", "free", "k")).toBe("taken");
    expect(await claimLock(admin(table), "j", "done", "k")).toBe("done");
    expect(await claimLock(admin(table), "j", "live", "k")).toBe("busy");
  });

  it("reclaims an error row and a stale running row; with reclaimErrors off an error is failed",
    async () => {
      const old = new Date(Date.now() - 60 * 60_000).toISOString();
      const table = jobRunsTable([
        { job: "j", user_id: "err", run_key: "k", status: "error" },
        { job: "j", user_id: "err2", run_key: "k", status: "error" },
        { job: "j", user_id: "killed", run_key: "k", status: "running", started_at: old },
      ]);
      expect(await claimLock(admin(table), "j", "err", "k")).toBe("taken");
      expect(await claimLock(admin(table), "j", "err2", "k", { reclaimErrors: false }))
        .toBe("failed");
      expect(await claimLock(admin(table), "j", "killed", "k", { reclaimErrors: false }))
        .toBe("taken");
    });

  it("with reclaimStale off, a stale running row is a spent attempt, never taken again", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const table = jobRunsTable([{ job: "j", user_id: "u", run_key: "w", status: "running",
      started_at: old }, { job: "j", user_id: "v", run_key: "w", status: "running" }]);
    const once = { reclaimErrors: false, reclaimStale: false };
    expect(await claimLock(admin(table), "j", "u", "w", once)).toBe("failed");
    expect(await claimLock(admin(table), "j", "v", "w", once)).toBe("busy");
    expect(table.rows[0].status).toBe("running");
  });

  it("releaseLock retries a failed write once, then throws loudly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    const flaky = (failures: number) => ({ from: () => {
      const chain: Record<string, unknown> = { update: () => chain, eq: () => chain,
        then: (r: (v: unknown) => unknown) => Promise.resolve(
          calls++ < failures ? { error: { message: "timeout" } } : { error: null }).then(r) };
      return chain;
    } }) as never;
    await expect(releaseLock(flaky(1), "j", "u", "k", "error")).resolves.toBeUndefined();
    calls = 0;
    await expect(releaseLock(flaky(2), "j", "u", "k", "error")).rejects.toThrow(/could not record/);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("RELEASE FAILED"), expect.anything());
  });

  it("a failed run released as error is taken again by the next attempt; ok is final", async () => {
    const table = jobRunsTable();
    expect(await claimLock(admin(table), "oura-pull", "u", "d")).toBe("taken");
    await releaseLock(admin(table), "oura-pull", "u", "d", "error", { message: "500" });
    expect(await claimLock(admin(table), "oura-pull", "u", "d")).toBe("taken");
    await releaseLock(admin(table), "oura-pull", "u", "d", "ok");
    expect(await claimLock(admin(table), "oura-pull", "u", "d")).toBe("done");
  });
});
