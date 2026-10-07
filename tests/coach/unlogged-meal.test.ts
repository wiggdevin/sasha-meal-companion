import { describe, expect, it, vi } from "vitest";
import { accountClock } from "@/lib/server/day-context";
import { hasUnloggedMeal } from "@/lib/server/coach-unlogged-meal";

const NOW = "2026-10-06T05:30:00.000Z"; // October 5, 23:30 in Denver
const REQUEST = { threadId: null, messageId: "m1", text: "", now: NOW,
  tz: "America/Denver" };

function entries(rows: Record<string, unknown>[], error: Error | null = null) {
  const calls: unknown[][] = [];
  const from = (table: string) => {
    calls.push(["from", table]);
    const filters: Record<string, unknown> = {};
    let limit = Infinity;
    const chain = {
      select: (fields: string) => { calls.push(["select", fields]); return chain; },
      eq: (field: string, value: unknown) => {
        calls.push(["eq", field, value]); filters[field] = value; return chain;
      },
      is: (field: string, value: unknown) => {
        calls.push(["is", field, value]); filters[field] = value; return chain;
      },
      limit: (n: number) => { calls.push(["limit", n]); limit = n; return chain; },
      then: (resolve: (result: unknown) => unknown) => Promise.resolve(resolve({
        data: rows.filter((row) => Object.entries(filters)
          .every(([field, value]) => row[field] === value)).slice(0, limit), error,
      })),
    };
    return chain;
  };
  return { client: { from } as never, calls };
}

describe("coach unlogged meal read", () => {
  it("uses the account's local date at the UTC boundary and a bounded owner read", async () => {
    const clock = accountClock(REQUEST, 0);
    expect(clock.date).toBe("2026-10-05");
    const { client, calls } = entries([{ id: "other", user_id: "other",
      local_date: "2026-10-05", deleted_at: null }]);
    expect(await hasUnloggedMeal(client, "u1", clock)).toBe(true);
    expect(calls).toEqual([
      ["from", "log_entries"], ["select", "id"], ["eq", "user_id", "u1"],
      ["eq", "local_date", "2026-10-05"], ["is", "deleted_at", null], ["limit", 1],
    ]);
  });

  it("ignores deleted entries and sees a live entry for the scoped past date", async () => {
    const clock = accountClock({ ...REQUEST, scope: { kind: "page", page: "today",
      date: "2026-10-04" } }, 0);
    const rows: Record<string, unknown>[] = [{ id: "deleted", user_id: "u1", local_date: "2026-10-04",
      deleted_at: NOW }];
    expect(await hasUnloggedMeal(entries(rows).client, "u1", clock)).toBe(true);
    rows.push({ id: "live", user_id: "u1", local_date: "2026-10-04",
      deleted_at: null });
    expect(await hasUnloggedMeal(entries(rows).client, "u1", clock)).toBe(false);
  });

  it("skips future dates and fails soft with a user-only warning on query errors", async () => {
    const future = accountClock({ ...REQUEST, scope: { kind: "page", page: "today",
      date: "2026-10-06" } }, 0);
    const read = vi.fn().mockResolvedValue(false);
    expect(await hasUnloggedMeal({} as never, "u1", future, read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const today = accountClock(REQUEST, 0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await hasUnloggedMeal(entries([], new Error("offline")).client, "u1", today))
      .toBe(false);
    expect(warn).toHaveBeenCalledWith("coach log entry read failed", { userId: "u1" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("passes the signal to a query builder that supports abortSignal", async () => {
    const clock = accountClock(REQUEST, 0);
    const signal = new AbortController().signal;
    const abortSignal = vi.fn().mockReturnValue({ data: [], error: null });
    const client = { from: () => ({ select() { return this; }, eq() { return this; },
      is() { return this; }, limit() { return this; }, abortSignal }) } as never;
    expect(await hasUnloggedMeal(client, "u1", clock, undefined, signal)).toBe(true);
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  it("skips an already-aborted read without querying or warning", async () => {
    const clock = accountClock(REQUEST, 0);
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn().mockRejectedValue(new Error("aborted"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await hasUnloggedMeal({} as never, "u1", clock, read, controller.signal))
        .toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
