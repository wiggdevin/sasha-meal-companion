/**
 * Phase 13 §7 — `pnpm timings:ai [--purpose X] [--days N] [--by-model]`: the argument reading and
 * the table layout, which are all this script owns. The p50/p95 bucketing is `summarize` in
 * lib/timing.ts, tested there, exactly as tests/speed/timings-report.test.ts pins for `pnpm timings`;
 * this file asserts that the script maps `ai_calls` rows into that bucketing and formats the result.
 */
import { describe, expect, it } from "vitest";
import { parseArgs, renderReport, toSamples, type AiCallRow } from "@/scripts/ai-calls-timings";
import { summarize } from "@/lib/timing";

const row = (over: Partial<AiCallRow> = {}): AiCallRow => ({
  purpose: "coach", provider: "google", model_id: "gemini-coach", status: "ok", latency_ms: 100,
  ...over,
});

describe("parseArgs", () => {
  it("defaults to every purpose over the last 7 days, grouped by purpose and status", () => {
    expect(parseArgs([])).toEqual({ purpose: null, days: 7, byModel: false });
  });

  it("reads --purpose, --days and --by-model", () => {
    expect(parseArgs(["--purpose", "photoToItems", "--days", "30", "--by-model"]))
      .toEqual({ purpose: "photoToItems", days: 30, byModel: true });
  });

  it("refuses an empty purpose", () => {
    expect(() => parseArgs(["--purpose"])).toThrow(/purpose/i);
  });

  it("refuses a days count that is not a positive whole number", () => {
    expect(() => parseArgs(["--days", "0"])).toThrow(/days/i);
    expect(() => parseArgs(["--days", "week"])).toThrow(/days/i);
  });
});

describe("toSamples", () => {
  it("buckets one row per purpose and status", () => {
    expect(toSamples([row({ status: "timeout", latency_ms: 30_000 })], false))
      .toEqual([{ path: "coach", step: "timeout", ms: 30_000 }]);
  });

  it("splits the purpose by provider and model when asked", () => {
    expect(toSamples([row()], true))
      .toEqual([{ path: "coach google/gemini-coach", step: "ok", ms: 100 }]);
  });

  it("drops a row with no latency rather than counting it as 0 ms", () => {
    expect(toSamples([row({ latency_ms: null })], false)).toEqual([]);
  });
});

describe("renderReport", () => {
  it("prints one line per purpose and status with p50, p95 and n", () => {
    const samples = toSamples([
      row({ latency_ms: 10 }), row({ latency_ms: 20 }), row({ latency_ms: 30 }),
      row({ status: "timeout", latency_ms: 30_000 }),
    ], false);
    const text = renderReport(summarize(samples), 7);
    expect(text).toContain("ai_calls");
    expect(text).toContain("last 7 days");
    expect(text).toMatch(/coach\s+ok\s+20\s+29\s+3/);
    expect(text).toMatch(/coach\s+timeout\s+30000\s+30000\s+1/);
  });

  it("orders by purpose, then status, whatever order the rows arrived in", () => {
    const samples = toSamples([
      row({ purpose: "photoToItems", status: "timeout" }),
      row({ purpose: "coach" }),
      row({ purpose: "photoToItems" }),
    ], false);
    const lines = renderReport(summarize(samples), 7).split("\n").slice(3);
    expect(lines.map((l) => l.split(/\s+/).slice(0, 2).join(" ")))
      .toEqual(["coach ok", "photoToItems ok", "photoToItems timeout"]);
  });

  it("says so rather than printing an empty table", () => {
    expect(renderReport([], 7)).toContain("No ai_calls");
  });
});
