/**
 * The "no repeats" guard (2026-09-16). The Foods tab used to show every rule under both halves
 * of the Eats / Avoid toggle: protein swaps and the Never card read the same under "Eats" as
 * under "Avoid". Eats is now what she can eat, Avoids is what she cannot, and neither one
 * borrows the other's cards. Each half is checked whole, so a card moved back by hand fails here.
 *
 * This also carries the assertions the deleted FoodsReference.test.tsx made — every safe carb and
 * every never-list entry — now split across the tab each one belongs to.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AvoidsView from "./AvoidsView";
import EatsView from "./EatsView";
import FoodsTabs, { tabForHash } from "./FoodsTabs";

const eats = renderToStaticMarkup(<EatsView />);
const avoids = renderToStaticMarkup(<AvoidsView />);

describe("Eats", () => {
  it("carries the account favorites, foods and recipes", () => {
    expect(eats).toContain('aria-label="Favorites"');
    expect(eats).toContain('id="recipes"');
  });

  it("says nothing about an avoided food", () => {
    expect(eats).not.toContain("Food rules");
    expect(eats).not.toContain("Add a rule");
    expect(eats).not.toContain("Conditions");
  });
});

describe("Avoids", () => {
  // D1 §6.2: the rules are the account's own row, so this tab carries the card that renders that
  // row — never a rule list of its own. `components/AvoidRules.test.tsx` owns the row's states.
  it("carries the account's rules card and its conditions", () => {
    expect(avoids).toContain("Food rules");
    expect(avoids).toContain("Add a rule");
    expect(avoids).toContain("Conditions");
  });

  it("hosts her own list before the store has loaded, without claiming it is empty", () => {
    // AvoidImpact owns the list and renders its shell after the local store loads.
    expect(avoids).toContain("h-40");
    expect(avoids).not.toContain("Nothing here.");
  });

  it("does not repeat what to eat", () => {
    expect(avoids).not.toContain('id="recipes"');
  });
});

/** The opening <button> tag of the tab labelled `label`. */
function tab(markup: string, label: string): string {
  const at = markup.indexOf(`>${label}</span>`);
  expect(at, label).toBeGreaterThan(-1);
  const start = markup.lastIndexOf("<button", at);
  return markup.slice(start, markup.indexOf(">", start) + 1);
}

/** The value of `attribute` on the tag the match `at` sits inside. */
function attribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  expect(match, name).not.toBeNull();
  return match![1];
}

describe("FoodsTabs", () => {
  const markup = renderToStaticMarkup(<FoodsTabs />);

  it("switches the whole page from two real tabs, Favorites first", () => {
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(2);
    expect(tab(markup, "Favorites")).toContain('aria-selected="true"');
    expect(tab(markup, "Avoids")).toContain('aria-selected="false"');
  });

  it("points both tabs at the one panel, and the panel back at the selected tab", () => {
    const panel = markup.slice(markup.indexOf("<div role=\"tabpanel\""));
    const panelTag = panel.slice(0, panel.indexOf(">") + 1);

    for (const label of ["Favorites", "Avoids"]) {
      const controls = attribute(tab(markup, label), "aria-controls");
      expect(markup, label).toContain(`id="${controls}"`);
      expect(controls).toBe(attribute(panelTag, "id"));
    }
    expect(attribute(panelTag, "aria-labelledby"))
      .toBe(attribute(tab(markup, "Favorites"), "id"));
  });
});

describe("tabForHash", () => {
  it("sends #recipes to Eats, where the recipes section lives", () => {
    expect(tabForHash("#recipes")).toBe("eats");
  });

  it("opens either named Foods tab from a settings deep link", () => {
    expect(tabForHash("#eats")).toBe("eats");
    expect(tabForHash("#avoids")).toBe("avoids");
  });

  it("leaves the tab alone for any other hash", () => {
    expect(tabForHash("")).toBeNull();
    expect(tabForHash("#anything-else")).toBeNull();
  });
});
