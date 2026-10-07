/**
 * Scale-readiness S3: the shared job helpers (lib/server/job-sweep.ts) at 1,000+ accounts — keyset
 * paging past the API's 1,000-row cap, a hard bound on work in flight, a time budget that stops
 * cleanly with an exact resume point, a hard stop that never waits past it, and one account's
 * failure never stopping another. The pass across runs is tests/jobs/job-cursor.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { keysetRows, runWithinBudget } from "@/lib/server/job-sweep";
import { accountIds, accountZones } from "@/lib/server/jobs";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u-${String(i).padStart(5, "0")}`);

/** A sorted, unique key listing that honours `key > after` and the page size, as PostgREST does. */
function listing(keys: string[]) {
  const calls: (string | null)[] = [];
  const page = async (after: string | null, size: number) => {
    calls.push(after);
    return { data: keys.filter((k) => after === null || k > after).slice(0, size), error: null };
  };
  return { page, calls };
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

/** user_settings as the account listers query it: not / gt / order / range. */
function settingsAdmin(rows: { user_id: string; time_zone?: string | null }[]) {
  const pages: (string | null)[] = [];
  const from = (table: string) => {
    expect(table).toBe("user_settings");
    let after: string | null = null;
    const chain = {
      select: () => chain, not: () => chain, order: () => chain,
      gt: (_key: string, value: string) => { after = value; return chain; },
      range: async (start: number, end: number) => {
        pages.push(after);
        const sorted = [...rows].sort((a, b) => (a.user_id < b.user_id ? -1 : 1))
          .filter((r) => after === null || r.user_id > after);
        return { data: sorted.slice(start, end + 1), error: null };
      },
    };
    return chain;
  };
  return { admin: { from } as never, pages };
}

describe("keysetRows", () => {
  it("pages past 1,000 rows by key, each page starting after the last key", async () => {
    const keys = ids(2_500);
    const { page, calls } = listing(keys);
    expect(await collect(keysetRows(page, (k) => k))).toEqual(keys);
    expect(calls).toEqual([null, keys[999], keys[1_999]]);
  });

  it("starts after a resume key", async () => {
    const keys = ids(1_200);
    const { page } = listing(keys);
    expect(await collect(keysetRows(page, (k) => k, keys[1_099]))).toEqual(keys.slice(1_100));
  });

  it("rejects a failed page instead of returning a partial set", async () => {
    let n = 0;
    const page = async (after: string | null) => (n++ === 0
      ? { data: ids(1_000).filter((k) => after === null || k > after), error: null }
      : { data: null, error: { message: "boom" } });
    await expect(collect(keysetRows(page, (k) => k))).rejects.toThrow("boom");
  });

  it("refuses a listing that ignores its key instead of looping on one page", async () => {
    const page = async () => ({ data: ids(1_000), error: null });
    await expect(collect(keysetRows(page, (k) => k))).rejects.toThrow(/ignores its key/);
  });
});

describe("account listers", () => {
  it("accountIds reaches every settings owner past the 1,000-row cap", async () => {
    const owners = ids(2_345);
    const { admin, pages } = settingsAdmin(owners.map((user_id) => ({ user_id })));
    expect(await collect(accountIds(admin))).toEqual(owners);
    expect(pages).toEqual([null, owners[999], owners[1_999]]);
  });

  it("accountZones resolves each owner's zone, UTC when none is saved", async () => {
    vi.stubEnv("HEALTH_TZ", "");
    const { admin } = settingsAdmin([{ user_id: "b", time_zone: "Asia/Tokyo" },
      { user_id: "a", time_zone: null }]);
    expect(await collect(accountZones(admin))).toEqual([
      { userId: "a", timeZone: "UTC" }, { userId: "b", timeZone: "Asia/Tokyo" }]);
    vi.unstubAllEnvs();
  });
});

describe("runWithinBudget", () => {
  it("never has more than `concurrency` items in flight and finishes them all", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: string[] = [];
    const outcome = await runWithinBudget({
      items: keysetRows(listing(ids(40)).page, (k) => k), keyOf: (k) => k,
      concurrency: 5, deadline: Infinity,
      work: async (id) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, Number(id.slice(2)) % 3));
        inFlight -= 1;
        done.push(id);
      },
    });
    expect(peak).toBe(5);
    expect(done.sort()).toEqual(ids(40));
    expect(outcome).toMatchObject({ started: 40, failed: 0, complete: true, cursor: ids(40)[39] });
  });

  it("isolates each item's failure: the rest still run, the failure is counted and reported", async () => {
    const reported: string[] = [];
    const done: string[] = [];
    const outcome = await runWithinBudget({
      items: keysetRows(listing(ids(10)).page, (k) => k), keyOf: (k) => k,
      concurrency: 3, deadline: Infinity,
      work: async (id) => {
        if (id === "u-00003" || id === "u-00007") throw new Error(`bad ${id}`);
        done.push(id);
      },
      onError: (id, e) => { reported.push(`${id}:${(e as Error).message}`); },
    });
    expect(done.sort()).toEqual(ids(10).filter((id) => id !== "u-00003" && id !== "u-00007"));
    expect(reported.sort()).toEqual(["u-00003:bad u-00003", "u-00007:bad u-00007"]);
    expect(outcome).toMatchObject({ started: 10, failed: 2, complete: true,
      retry: ["u-00003", "u-00007"] });
  });

  it("stops starting items at the deadline, lets in-flight ones finish, and reports the cursor",
    async () => {
      let clock = 0;
      const done: string[] = [];
      const outcome = await runWithinBudget({
        items: keysetRows(listing(ids(100)).page, (k) => k), keyOf: (k) => k,
        concurrency: 4, deadline: 50, now: () => clock,
        work: async (id) => { clock += 5; await Promise.resolve(); done.push(id); },
      });
      expect(outcome.complete).toBe(false);
      // Everything started finished, and what finished is exactly the prefix up to the cursor.
      expect(done.sort()).toEqual(ids(100).slice(0, outcome.started));
      expect(outcome.cursor).toBe(ids(100)[outcome.started - 1]);
      expect(outcome.started).toBeGreaterThan(0);
      expect(outcome.started).toBeLessThan(100);
    });
});

describe("runWithinBudget: retry and the hard stop", () => {
  it("queues for retry every item whose work says so, in listing order", async () => {
    const outcome = await runWithinBudget({
      items: keysetRows(listing(ids(6)).page, (k) => k), keyOf: (k) => k,
      concurrency: 3, deadline: Infinity,
      work: async (id) => (id === "u-00001" || id === "u-00004" ? "retry" : "ok"),
    });
    expect(outcome).toMatchObject({ complete: true, failed: 0, retry: ["u-00001", "u-00004"] });
  });

  it("does not wait past the hard stop: work still running is abandoned and queued for retry",
    async () => {
      const t0 = Date.now();
      const outcome = await runWithinBudget({
        items: keysetRows(listing(ids(3)).page, (k) => k), keyOf: (k) => k,
        concurrency: 3, deadline: t0 + 20, hardStop: t0 + 60,
        work: async (id) => {
          if (id === "u-00001") await new Promise(() => undefined);   // never settles
        },
      });
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(outcome).toMatchObject({ started: 3, complete: true, retry: ["u-00001"] });
    });

  it("a page that arrives after the deadline starts nothing from it; the cursor stays before it",
    async () => {
      let clock = 0;
      const keys = ids(1_500);
      const page = async (after: string | null, size: number) => {
        if (after !== null) clock = 1_000;                 // the second page is slow
        return { data: keys.filter((k) => after === null || k > after).slice(0, size), error: null };
      };
      const outcome = await runWithinBudget({
        items: keysetRows(page, (k) => k), keyOf: (k) => k,
        concurrency: 4, deadline: 500, now: () => clock, work: async () => undefined,
      });
      expect(outcome).toMatchObject({ started: 1_000, complete: false, cursor: keys[999] });
    });
});
