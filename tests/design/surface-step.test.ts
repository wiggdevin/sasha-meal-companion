import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUNDS } from "@/lib/design/grounds";
import { contrast, gradient, GLOBALS_CSS, hexToRgb, over, PANEL_ALPHA, ROOT, SECTIONS, type Rgb } from "./contrast-table";

/**
 * The contrast step (UI makeover §3, DESIGN.md §Elevation): a surface on another surface differs
 * from it by at least 1.10:1 at every gradient stop, so a card never blends into the card behind it.
 * ground → card (E1) → inset (E0) → card (E0), and the olive panel steps off the card it sits on.
 * The colours are read from app/globals.css and lib/design/grounds.ts, never copied here.
 */
const STEP = 1.1;
const CARD = gradient("card");
const INSET = gradient("card-inset");
const INK = gradient("matte");
const INK_INSET = gradient("card-ink-inset");

/** The lowest contrast between any stop of `top` and any stop of `under`. */
const worst = (top: Rgb[], under: Rgb[]) => Math.min(...top.flatMap((a) => under.map((b) => contrast(a, b))));

describe("the contrast step between surfaces", () => {
  it("the lifted card steps off every ground at every stop", () => {
    for (const ground of GROUNDS) {
      expect(worst(CARD, [hexToRgb(ground.base)]), ground.id).toBeGreaterThanOrEqual(STEP);
    }
  });

  it("the inset steps off the card, and the card steps off the inset", () => {
    expect(worst(INSET, CARD)).toBeGreaterThanOrEqual(STEP);
    expect(worst(CARD, INSET)).toBeGreaterThanOrEqual(STEP);
  });

  it("the ink card steps off every ground and the ivory card; its inset steps down off it", () => {
    for (const ground of GROUNDS) {
      expect(worst(INK, [hexToRgb(ground.base)]), ground.id).toBeGreaterThanOrEqual(STEP);
    }
    expect(worst(INK, CARD)).toBeGreaterThanOrEqual(STEP);
    expect(worst(INK_INSET, INK)).toBeGreaterThanOrEqual(STEP);
    expect(worst(INK, INK_INSET)).toBeGreaterThanOrEqual(STEP);
  });

  it("the olive panel steps off the card under it, in every section hue", () => {
    for (const [name, hue] of Object.entries(SECTIONS)) {
      const panel = CARD.map((stop) => over(hue, PANEL_ALPHA, stop));
      const ratios = CARD.map((stop, i) => contrast(stop, panel[i]));
      expect(Math.min(...ratios), name).toBeGreaterThanOrEqual(STEP);
    }
  });

  it("--grad-panel stays a literal copy of the card's stops", () => {
    expect(gradient("panel")).toEqual(CARD);
  });

  it("defines the card roles: hairline, padding and radius scales", () => {
    expect(GLOBALS_CSS).toMatch(/--hairline-card: rgb\(var\(--ink-rgb\) \/ 0\.16\);/);
    for (const [size, steps] of [["sm", 3], ["md", 4], ["lg", 5]] as const) {
      expect(GLOBALS_CSS).toContain(`--card-pad-${size}: calc(var(--spacing) * ${steps});`);
    }
    for (const [size, px] of [["sm", 16], ["md", 24], ["lg", 32]] as const) {
      expect(GLOBALS_CSS).toContain(`--card-radius-${size}: ${px}px;`);
    }
    expect(/\n\.surface \{([^}]*)\}/.exec(GLOBALS_CSS)![1]).toMatch(/border: 1px solid rgb\(var\(--ink-rgb\) \/ 0\.14\);/);
  });
});

describe("the guarded rule for legacy nested cards", () => {
  const exempt = ":not(.matte, .meal-card-in, .matte-reset, .olive-panel, .card-olive)";

  it("gives a .surface inside a .surface the inset, and one inside that the card again", () => {
    const inset = new RegExp(`html\\[data-card-step\\] \\.surface :where\\(\\.surface\\)${escapeRe(exempt)} \\{([^}]*)\\}`)
      .exec(GLOBALS_CSS)?.[1] ?? "";
    expect(inset).toMatch(/background: var\(--grad-card-inset\);/);
    expect(inset).toMatch(/border-color: var\(--hairline-card\);/);
    expect(inset).toMatch(/box-shadow: none;/);
    const card = new RegExp(`html\\[data-card-step\\] \\.surface \\.surface :where\\(\\.surface\\)${escapeRe(exempt)} \\{([^}]*)\\}`)
      .exec(GLOBALS_CSS)?.[1] ?? "";
    expect(card).toMatch(/background: var\(--grad-card\);/);
  });

  it("runs the same steps in charcoal inside an ink card: the ink inset, then the ink face", () => {
    const inset = new RegExp(`html\\[data-card-step\\] \\.surface\\.card-ink :where\\(\\.surface\\)${escapeRe(exempt)} \\{([^}]*)\\}`)
      .exec(GLOBALS_CSS)?.[1] ?? "";
    expect(inset).toMatch(/background: var\(--grad-card-ink-inset\);/);
    expect(inset).toMatch(/box-shadow: none;/);
    const again = new RegExp(`html\\[data-card-step\\] \\.surface\\.card-ink \\.surface :where\\(\\.surface\\)${escapeRe(exempt)} \\{([^}]*)\\}`)
      .exec(GLOBALS_CSS)?.[1] ?? "";
    expect(again).toMatch(/background: var\(--grad-matte\);/);
  });

  it("is switched on by data-card-step on <html> (app/layout.tsx)", () => {
    const layout = readFileSync(join(ROOT, "app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<html[^>]*\bdata-card-step=""/);
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
