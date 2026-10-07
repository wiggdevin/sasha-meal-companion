import { describe, expect, it } from "vitest";
import { preserveEditedLines } from "@/lib/shopping/preserve";
import type { ShoppingLine } from "@/lib/shopping/types";

const line = (id: string, patch: Partial<ShoppingLine> = {}): ShoppingLine => ({
  id, periodId: "period", origin: "plan", name: id, identity: null,
  category: "core", needGrams: 100, confirmedStockGrams: 0, buyGrams: null,
  packageGrams: null, purchaseConversionStatus: "unknown", sources: [], pinned: false,
  checked: false, note: null, revision: 1, ...patch,
});

describe("shopping edit preservation", () => {
  it("retains bought, pinned and noted rows removed by a new plan", () => {
    const old = [line("bought", { checked: true }), line("pinned", { pinned: true }),
      line("noted", { note: "Look for large tins" }), line("plain")];
    const result = preserveEditedLines(old, []);
    expect(result.retained.map((row) => row.id)).toEqual(["bought", "pinned", "noted"]);
    expect(result.lines.every((row) => row.retained)).toBe(true);
    expect(old[0]).not.toHaveProperty("retained");
  });

  it("keeps a continuing derived row once and leaves manual items in the proposal", () => {
    const old = line("same", { checked: true, note: "Keep" });
    const next = line("same", { checked: true, note: "Keep" });
    const manual = line("soap", { origin: "manual", category: "manual" });
    const result = preserveEditedLines([old], [next, manual]);
    expect(result.retained).toEqual([]);
    expect(result.lines).toEqual([next, manual]);
  });
});
