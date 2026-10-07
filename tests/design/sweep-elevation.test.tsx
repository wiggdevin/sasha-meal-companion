import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoggedExtraCard } from "@/components/LoggedExtras";
import type { LoggedFood } from "@/lib/types";

/**
 * Elevation in the stream F2 sweep (DESIGN.md §Elevation & Depth, PRD U11, 2026-10-04): a card on the
 * oat ground is E1, and everything inside a card is E0 — never a shadow inside a shadow. The Day
 * card's board tiles all sit inside the Day card, so none of them drops a shadow; the charcoal tiles
 * keep only the inset bevel as their edge. A logged extra stands on the ground, so its face is E1.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const block = (css: string, selector: string) => {
  const match = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`${selector} not found`);
  return match[1];
};

describe("board tiles", () => {
  const board = readFileSync(join(ROOT, "components/today/DayBoard.module.css"), "utf8");
  const tip = readFileSync(join(ROOT, "components/today/TipTile.module.css"), "utf8");

  it("are E0 inside the Day card: no tile drops a shadow", () => {
    for (const selector of [".next", ".player"]) {
      expect(block(board, selector)).not.toMatch(/--shadow-card|--shadow-float/);
      expect(block(board, selector)).toMatch(/box-shadow: var\(--bevel\);/);
    }
    for (const selector of [".week", ".pin"]) expect(block(board, selector)).not.toMatch(/box-shadow/);
    // The tip keeps its inner highlight only; its old 1 px contact drop is gone.
    expect(block(tip, ".surface")).toMatch(/box-shadow: inset 0 1px 0 var\(--highlight\);/);
  });

  it("draw their hairline at the one E0 strength", () => {
    for (const selector of [".week", ".pin"]) {
      expect(block(board, selector)).toMatch(/border: 1px solid rgb\(var\(--ink-rgb\) \/ 0\.06\)/);
    }
  });
});

describe("a logged extra", () => {
  const entry: LoggedFood = {
    id: "e", foodId: "f", name: "Chicken and rice", portionLabel: "plate", qty: 1, grams: 300,
    macros: { kcal: 500, protein: 40, carbs: 50, fat: 10 }, at: "2026-09-20T18:00:00.000Z",
  };

  it("stands on the ground at E1; the snack ticket keeps its own drop", () => {
    const face = (markup: string) => /class="(logged-card-in[^"]*)"/.exec(markup)?.[1].split(/\s+/) ?? [];
    expect(face(renderToStaticMarkup(<LoggedExtraCard entry={entry} pending={false} onOpen={() => {}} />)))
      .toContain("elev-1");
    expect(face(renderToStaticMarkup(<LoggedExtraCard entry={{ ...entry, slot: "snack" }} pending={false}
      onOpen={() => {}} />))).not.toContain("elev-1");
  });

  it("offers its actions as small secondary buttons, not chip tracks", () => {
    const markup = renderToStaticMarkup(<LoggedExtraCard entry={entry} pending={false} onOpen={() => {}} />);
    expect(markup).toMatch(/<button[^>]*class="btn btn-secondary btn-sm"[^>]*>.*Add note/);
    expect(markup).not.toContain("pill-in");
  });
});
