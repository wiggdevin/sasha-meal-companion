import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FullPanel, panelSpoken, type PanelData } from "@/components/today/LiveWidgetPanels";
import { WIDGET_PANELS, cleanPrefs } from "@/lib/today/widget-prefs";

const data: PanelData = {
  targets: { kcal: 2000, protein: 150, carbs: 200, fat: 70 },
  consumed: { kcal: 500, protein: 60, carbs: 40, fat: 20 },
  partial: false,
};

const macrosIn = (markup: string) => [...markup.matchAll(/<g[^>]*data-macro="(\w+)"/g)].map((m) => m[1]);

describe("the liquid rings views", () => {
  it("are panels a person can choose and keep", () => {
    expect(WIDGET_PANELS).toEqual(expect.arrayContaining(["rings", "macroRings"]));
    expect(cleanPrefs({ panels: ["rings", "macroRings"], expanded: true, index: 1 }).panels)
      .toEqual(["rings", "macroRings"]);
  });

  it("draws all four rings with Sprout in the middle", () => {
    const markup = renderToStaticMarkup(<FullPanel panel="rings" data={data} centre={<i>sprout</i>} />);
    expect(macrosIn(markup)).toEqual(["kcal", "protein", "carbs", "fat"]);
    expect(markup).toContain("<i>sprout</i>");
  });

  it("draws the three macro rings without calories", () => {
    const markup = renderToStaticMarkup(<FullPanel panel="macroRings" data={data} centre={<i>sprout</i>} />);
    expect(macrosIn(markup)).toEqual(["protein", "carbs", "fat"]);
    expect(markup).toContain("<i>sprout</i>");
  });

  it("says the numbers to a screen reader", () => {
    expect(panelSpoken("rings", data)).toMatch(/1,500 kcal left/);
    expect(panelSpoken("macroRings", data)).toMatch(/90 grams protein left/);
    expect(panelSpoken("macroRings", data)).not.toMatch(/kcal/);
  });
});
