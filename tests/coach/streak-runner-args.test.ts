import { describe, expect, it } from "vitest";
import { optionalValue } from "@/scripts/eval/coach-streak-args";
import { withRunDate } from "@/scripts/eval/coach-streak-run-date";
import { runConfig } from "@/scripts/eval/coach-streak-state";

describe("--resolve failure id", () => {
  it("takes the id when one follows", () => {
    expect(optionalValue(["--resolve", "f3", "--diagnosis", "x"], "--resolve")).toBe("f3");
  });
  it("is null when another flag follows or nothing does", () => {
    expect(optionalValue(["--resolve", "--diagnosis", "x"], "--resolve")).toBeNull();
    expect(optionalValue(["--resolve"], "--resolve")).toBeNull();
    expect(optionalValue(["--diagnosis", "x"], "--resolve")).toBeNull();
  });
});

describe("COACH_STREAK_RUN_DATE", () => {
  const base = runConfig(null, "b");
  it("accepts a suffix", () => {
    for (const raw of ["2026-10-17b", "2026-10-17-rerun2"]) {
      const config = withRunDate(base, raw);
      expect(config.statePath).toContain(`${raw}-coach-streak-state.json`);
      expect(config.title).toContain(raw);
    }
  });
  it("still refuses an unsafe or malformed value", () => {
    for (const raw of ["10-17", "2026-10-17/../x", "2026-10-17 b", "2026-10-17B"]) {
      expect(() => withRunDate(base, raw)).toThrow(/COACH_STREAK_RUN_DATE/);
    }
  });
});
