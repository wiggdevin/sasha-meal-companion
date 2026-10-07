/**
 * Design §8.2: the weight-trend line on `/body` must be drawn from real stored trend values, not
 * from an empty array the caller invented. `weightTrendSeries` reads the last
 * `WEIGHT_TREND_SERIES_DAYS` dated `expenditure_estimates` rows and hands them back oldest-first,
 * so the sparkline reads left-to-right the way every other series on the screen does.
 *
 * It is a read of its own rather than a widening of `latestEstimate`, because `latestEstimate` is
 * also the coach's expenditure port (`lib/server/coach-ports.ts:29`,
 * `lib/server/coach-context.ts:110`): a second query inside it would put 21 extra rows on every
 * coach turn for a line only `/body` draws.
 *
 * A stored `null` is a day the engine computed no trend (burn-in, or a held row). It stays `null`
 * so `Sparkline` leaves a gap; a zero there would read as "you weighed nothing".
 */
import { describe, expect, it, vi } from "vitest";
import { weightTrendSeries } from "@/lib/server/expenditure";
import { WEIGHT_TREND_SERIES_DAYS } from "@/lib/api-types";

/** A chainable stand-in for the PostgREST query `weightTrendSeries` builds, ending in an await. */
function clientWith(rows: Record<string, unknown>[], onSelect?: (columns: string) => void) {
  const state = { table: "", eqColumn: "", eqValue: "", ascending: true, limit: 0 };
  let q = [...rows];
  const builder = {
    select: (columns: string) => { onSelect?.(columns); return builder; },
    eq: (column: string, value: string) => {
      state.eqColumn = column; state.eqValue = value; return builder;
    },
    not: () => builder,
    order: (column: string, { ascending }: { ascending: boolean }) => {
      state.ascending = ascending;
      q = [...q].sort((a, b) => (ascending ? 1 : -1)
        * String(a[column]).localeCompare(String(b[column])));
      return builder;
    },
    limit: (n: number) => { state.limit = n; q = q.slice(0, n); return builder; },
    then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data: q, error: null }).then(resolve),
  };
  const from = vi.fn((table: string) => { state.table = table; return builder; });
  return { client: { from } as never, state, from };
}

const row = (date: string, trend: number | null) =>
  ({ local_date: date, weight_trend_kg: trend });

describe("weightTrendSeries", () => {
  it("reads expenditure_estimates for that user only, newest first, capped at the window", async () => {
    const columns: string[] = [];
    const { client, state, from } = clientWith([row("2026-09-12", 57.6)], (c) => columns.push(c));

    await weightTrendSeries(client, "user-a");

    expect(from).toHaveBeenCalledWith("expenditure_estimates");
    expect(columns[0]).toContain("weight_trend_kg");
    expect(state.eqColumn).toBe("user_id");
    expect(state.eqValue).toBe("user-a");
    expect(state.ascending).toBe(false);
    expect(state.limit).toBe(WEIGHT_TREND_SERIES_DAYS);
  });

  it("returns the values oldest-first, so the line reads left to right", async () => {
    const { client } = clientWith([
      row("2026-09-10", 58.1), row("2026-09-12", 57.6), row("2026-09-11", 57.9),
    ]);

    await expect(weightTrendSeries(client, "user-a")).resolves.toEqual([58.1, 57.9, 57.6]);
  });

  it("keeps a day with no stored trend as a gap, never as a zero", async () => {
    const { client } = clientWith([
      row("2026-09-10", null), row("2026-09-11", 57.9), row("2026-09-12", null),
    ]);

    await expect(weightTrendSeries(client, "user-a")).resolves.toEqual([null, 57.9, null]);
  });

  it("is an empty series for an account with no estimate rows at all", async () => {
    const { client } = clientWith([]);

    await expect(weightTrendSeries(client, "new-user")).resolves.toEqual([]);
  });

  it("raises the read error rather than drawing a line out of nothing", async () => {
    const failing = {
      from: () => ({
        select: () => ({ eq: () => ({ order: () => ({ limit: () => ({
          then: (resolve: (r: { data: null; error: { message: string } }) => unknown) =>
            Promise.resolve({ data: null, error: { message: "read failed" } }).then(resolve),
        }) }) }) }),
      }),
    } as never;

    await expect(weightTrendSeries(failing, "user-a")).rejects.toMatchObject({
      message: "read failed",
    });
  });
});
