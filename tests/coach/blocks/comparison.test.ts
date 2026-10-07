import { describe, expect, it } from "vitest";
import { hydrateComparison } from "@/lib/coach/blocks/hydrate-comparison";
import { uiBlockV1Schema } from "@/lib/coach/ui-blocks";

const option = (kcal: number, protein: number, carbs: number, fat: number) =>
  ({ totals: { kcal, protein, carbs, fat } });

describe("hydrateComparison", () => {
  it("returns null for fewer than two options: nothing to compare", () => {
    expect(hydrateComparison("b", [])).toBeNull();
    expect(hydrateComparison("b", [option(500, 30, 40, 15)])).toBeNull();
  });

  it("draws the Compare card, schema-valid, from the options' macros alone", () => {
    const block = hydrateComparison("block-d", [option(520, 32, 44, 18), option(610, 40, 50, 20)]);
    expect(uiBlockV1Schema.safeParse(block).success).toBe(true);
    expect(block).toEqual({ kind: "ui", v: 1, id: "block-d", root: { type: "card", title: "Compare",
      children: [
        { type: "text", variant: "eyebrow", text: "Option 1" },
        { type: "metric_row", items: [{ label: "kcal", value: "520" },
          { label: "protein", value: "32g" }, { label: "carbs", value: "44g" },
          { label: "fat", value: "18g" }] },
        { type: "text", variant: "eyebrow", text: "Option 2" },
        { type: "metric_row", items: [{ label: "kcal", value: "610" },
          { label: "protein", value: "40g" }, { label: "carbs", value: "50g" },
          { label: "fat", value: "20g" }] },
      ] } });
  });

  it("rounds macros and caps the card at four options", () => {
    const composed = Array.from({ length: 6 }, (_, i) => option(500 + i, 30.4, 40.6, 15));
    const block = hydrateComparison("b", composed);
    const text = JSON.stringify(block);
    expect(text.match(/Option \d/g)).toEqual(["Option 1", "Option 2", "Option 3", "Option 4"]);
    expect(text).toContain('"value":"41g"');
  });
});
