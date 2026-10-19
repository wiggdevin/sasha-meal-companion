import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Day card's board tiles (moved verbatim from tests/design/sweep-elevation.test.tsx, UI makeover
 * W0; the workstream that deletes DayBoard and TipTile deletes this file with them). Elevation in the
 * stream F2 sweep (DESIGN.md §Elevation & Depth, PRD U11, 2026-10-04): the board tiles all sit inside
 * the Day card, so none of them drops a shadow; the charcoal tiles keep only the inset bevel as their
 * edge.
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
