/**
 * T9 §2, AC2 — the half of the acceptance criterion that must not need a branch database.
 *
 * tests/log/commit-route-move.test.ts pins what the commit route ANSWERS, and skips without a
 * branch. This pins where the code LIVES, and never skips: the five names §2 names are importable
 * from the files §2 puts them in, `lib/server/log.ts` keeps only `applyLogEntry` and re-exports
 * none of them, and the route reaches them through those files. A merge that quietly restored the
 * old single module would pass every behavioural test and fail here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("the files T9 §2 splits lib/server/log.ts into", () => {
  it("exports applyLogEntry from lib/server/log.ts", async () => {
    const log = await import("@/lib/server/log");
    expect(typeof log.applyLogEntry).toBe("function");
  });

  it("exports the label-food half from lib/server/log-label-food.ts", async () => {
    const label = await import("@/lib/server/log-label-food");
    expect(label.LABEL_FOOD_PLACEHOLDER_REF).toBe("00000000-0000-4000-8000-000000000000");
    expect(typeof label.labelFoodSchema.safeParse).toBe("function");
  });

  it("exports both day-totals readers from lib/server/day-totals.ts", async () => {
    const totals = await import("@/lib/server/day-totals");
    expect(typeof totals.dayTotals).toBe("function");
    expect(typeof totals.dayTotalsPrivileged).toBe("function");
  });

  it("exports the duplicate-fingerprint recorder from lib/server/log-duplicates.ts", async () => {
    const duplicates = await import("@/lib/server/log-duplicates");
    expect(typeof duplicates.recordFingerprint).toBe("function");
  });

  it("keeps lib/server/log.ts inside the 400-line budget with room to spare", () => {
    const lines = readFileSync("lib/server/log.ts", "utf8").split("\n").length;
    expect(lines).toBeLessThanOrEqual(380);
  });

  it("re-exports none of the moved names from lib/server/log.ts", async () => {
    const log = await import("@/lib/server/log") as Record<string, unknown>;
    for (const name of ["dayTotals", "dayTotalsPrivileged", "labelFoodSchema",
      "LABEL_FOOD_PLACEHOLDER_REF", "recordFingerprint"]) {
      expect(log[name]).toBeUndefined();
    }
  });

  it("has the commit route import from the new files, not around them", () => {
    const route = readFileSync("app/api/log/commit/route.ts", "utf8");
    expect(route).toContain('from "@/lib/server/log"');
    // The MCP route stopped reading day totals when the legacy sync tools were retired
    // (run 5, R3); it must still never reach them through lib/server/log.
    const mcp = readFileSync("app/api/mcp/route.ts", "utf8");
    expect(mcp).not.toContain('from "@/lib/server/log"');
    expect(mcp).not.toContain('dayTotalsPrivileged } from "@/lib/server/log"');
  });

  /** The two dynamic importers §2 named. A dynamic specifier is invisible to tsc, so it is read. */
  it.each(["lib/server/coach-ports.ts", "lib/coach/weekly-review.ts"])(
    "has %s reach the day totals through lib/server/day-totals.ts", (file) => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain('"@/lib/server/day-totals"');
      expect(source).not.toContain('from "@/lib/server/log"');
      expect(source).not.toContain('import("@/lib/server/log")');
    });
});
