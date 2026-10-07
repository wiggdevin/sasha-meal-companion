/**
 * T0 §1 — `pnpm timings [--path X] [--days N]`: the argument reading and the table layout, which
 * are all this script owns. The p50/p95 bucketing it prints from is `summarize` in lib/timing.ts,
 * tested there; this file only asserts that the script formats what that returns.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, renderReport } from "@/scripts/timings";
import { summarize } from "@/lib/timing";

const rows = (...msByStep: [string, number[]][]) =>
  msByStep.flatMap(([step, values]) =>
    values.map((ms) => ({ path: "barcode", step, ms })));

describe("parseArgs", () => {
  it("defaults to every path over the last 7 days", () => {
    expect(parseArgs([])).toEqual({ path: null, days: 7 });
  });

  it("reads --path and --days", () => {
    expect(parseArgs(["--path", "barcode", "--days", "30"]))
      .toEqual({ path: "barcode", days: 30 });
  });

  it("refuses a path outside the spec's nine", () => {
    expect(() => parseArgs(["--path", "everything"])).toThrow(/path/i);
  });

  it("refuses a days count that is not a positive whole number", () => {
    expect(() => parseArgs(["--days", "0"])).toThrow(/days/i);
    expect(() => parseArgs(["--days", "week"])).toThrow(/days/i);
  });
});

describe("renderReport", () => {
  it("prints one line per step with p50, p95 and n", () => {
    const text = renderReport(summarize(rows(["decode", [10, 20, 30]])), 7);
    expect(text).toContain("last 7 days");
    expect(text).toMatch(/barcode\s+decode\s+20\s+29\s+3/);
  });

  it("says so rather than printing an empty table", () => {
    expect(renderReport([], 7)).toContain("No client timings");
  });
});
