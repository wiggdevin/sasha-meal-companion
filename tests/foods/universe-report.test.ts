/**
 * Phase 18 W1, acceptance 3: docs/catalog/universe.md carries the per-allergen clear-share report
 * exactly as scripts/universe-report.ts generates it from the manifest, so it cannot go stale.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLERGEN_KEYS } from "@/lib/foods/universe/derive";
import { REPORT_PATH, renderUniverseReport, withReport } from "@/scripts/universe-report";

describe("the universe report", () => {
  const block = renderUniverseReport();

  it("lists every allergen in ALLERGEN_RULES with its clear share", () => {
    for (const key of ALLERGEN_KEYS) expect(block).toMatch(new RegExp(`\\(\`${key}\`\\) \\| \\d+ \\| \\d+ \\| \\d+ \\| \\d+\\.\\d %`));
  });

  it("is the generated block in docs/catalog/universe.md", () => {
    const doc = readFileSync(REPORT_PATH, "utf8");
    expect(withReport(doc, block)).toBe(doc);
  });
});
