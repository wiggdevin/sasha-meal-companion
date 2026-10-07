import { describe, expect, it, vi } from "vitest";

// lib/server/export.ts imports "server-only", which throws outside a server component (see
// tests/export/cursor.test.ts). Only the marker package is stubbed, never the module itself.
vi.mock("server-only", () => ({}));

const { groupTotalsByDate } = await import("@/lib/server/export");
type TotalRow = Parameters<typeof groupTotalsByDate>[0][number];

function row(local_date: string, nutrient_code: string): TotalRow {
  return { local_date, nutrient_code, amount: 10, items_with_value: 1, items_total: 1,
    coverage: 1 };
}

describe("groupTotalsByDate", () => {
  it("drops the last date when the read came back past the row cap", () => {
    const rows = [row("2026-09-01", "energy_kcal"), row("2026-09-02", "energy_kcal"),
      row("2026-09-03", "energy_kcal")];
    const { byDate, itemsByDate } = groupTotalsByDate(rows, rows.length - 1);
    expect([...byDate.keys()]).toEqual(["2026-09-01", "2026-09-02"]);
    expect(itemsByDate.has("2026-09-03")).toBe(false);
  });

  it("keeps every date when exactly the cap or fewer rows come back", () => {
    const rows = [row("2026-09-01", "energy_kcal"), row("2026-09-02", "energy_kcal"),
      row("2026-09-03", "energy_kcal")];
    expect([...groupTotalsByDate(rows, rows.length).byDate.keys()].sort())
      .toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect([...groupTotalsByDate(rows, rows.length + 1).byDate.keys()].sort())
      .toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("returns empty maps for no rows", () => {
    const { byDate, itemsByDate } = groupTotalsByDate([], 40);
    expect(byDate.size).toBe(0);
    expect(itemsByDate.size).toBe(0);
  });

  // finding 85: streamProgress's cap assumes exactly NUTRIENT_CODES.length rows per date. If a
  // future date carries one extra row (a nutrient code added to the catalog without updating
  // NUTRIENT_CODES), the drop-last-date logic can still leave exactly `opts.limit` complete
  // dates behind — so `dates.length > opts.limit` alone can't tell a truncated read from a
  // complete one. groupTotalsByDate itself already knows whether the raw read hit the cap
  // (that's what decides whether to drop the last date); it must surface that signal instead of
  // discarding it, so the caller can OR it into `hasMore` rather than re-deriving it from
  // per-date counts that a miscalibrated cap can get wrong.
  it("flags the read as truncated even when dropping the last date leaves exactly one page", () => {
    // 3 dates × 2 rows each = 6 rows, cap = 4 (as if the caller assumed 2 dates worth at 2
    // rows/date but a 3rd code showed up): the raw read exceeded the cap, so this must be
    // reported as truncated even though only one date gets dropped.
    const rows = [
      row("2026-09-01", "energy_kcal"), row("2026-09-01", "protein"),
      row("2026-09-02", "energy_kcal"), row("2026-09-02", "protein"),
      row("2026-09-03", "energy_kcal"), row("2026-09-03", "protein"),
    ];
    const result = groupTotalsByDate(rows, 4);
    expect([...result.byDate.keys()]).toEqual(["2026-09-01", "2026-09-02"]);
    expect(result.truncated).toBe(true);
  });

  it("does not flag truncation when the read never hit the cap", () => {
    const rows = [row("2026-09-01", "energy_kcal"), row("2026-09-02", "energy_kcal")];
    expect(groupTotalsByDate(rows, rows.length).truncated).toBe(false);
  });
});
