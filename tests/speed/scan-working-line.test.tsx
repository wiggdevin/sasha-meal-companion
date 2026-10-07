/**
 * T0 §2 — "after 2 s on any step the sheet shows what it is doing", on the last save that had no
 * such line: logging a scanned food. The capture, the search pick and the meal save all mount one;
 * the scan sheet's Log button simply went quiet and disabled for as long as the commit took, which
 * is up to the whole ten-second budget (Grok pass 19, MEDIUM 2).
 *
 * `WorkingLine` renders nothing before its two seconds, `renderToStaticMarkup` never runs an
 * effect, and this sheet keeps `saving` in its own state, so no static render can put the line on
 * screen. What is asserted is that the sheet mounts the line, tied to that state — the delay
 * itself is covered in components/WorkingLine.test.tsx.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ScanConfirmSheet from "@/components/ScanConfirmSheet";
import type { BarcodeMatch, BarcodeResponse } from "@/lib/barcode/client";

vi.mock("@/components/WorkingLine", () => ({
  default: ({ active, step }: { active: boolean; step: string }) =>
    active ? <p data-working={step}>working</p> : null,
}));

const MATCH = {
  foodRefId: "cccccccc-3333-4333-8333-333333333333", catalogFoodId: 41, revisionId: 910,
  description: "Ella's pouch", brand: "Ella's Kitchen", source: "off", qualityClass: "label",
  qualityFlags: [], per100g: { energy_kcal: 60, protein: 1, carbohydrate: 12, fat_total: 0.4 },
  portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
  ingredientsText: null, allergenTags: [], attribution: null,
  policy: { verdict: "allowed" },
} as unknown as BarcodeMatch;

const RESPONSE: BarcodeResponse = {
  status: "resolved", gtin14: "00000000000000", cached: false, match: MATCH,
};

describe("logging a scanned food", () => {
  it("says nothing at all before she taps Log it", () => {
    const markup = renderToStaticMarkup(
      <ScanConfirmSheet response={RESPONSE} slot="meal-2" onLogged={() => {}} onClose={() => {}} />
    );
    expect(markup).toContain("Log it");
    expect(markup).not.toContain("data-working");
  });

  it("mounts the line for the commit, active exactly while it is saving", () => {
    const source = readFileSync(
      new URL("../../components/ScanConfirmSheet.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<WorkingLine active=\{saving\} step="commit"/);
  });
});
