import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedPairs, contrast, forbiddenPairs, glyphPairs, hexToRgb, markdownTable, MIN, noticePairs,
  resetValues, ROLES, ROOT, SECTIONS, SURFACES, tagPairs,
} from "./contrast-table";

/**
 * WCAG contrast for every text role on every surface the design system defines (DESIGN.md
 * §Contrast): ≥ 4.5:1 for body and small text, ≥ 3:1 for large text and icons. The colours come
 * from the token files, so a token edit that breaks a pair fails here before anyone sees it.
 */
const show = (n: number) => Number(n.toFixed(2));

describe("WCAG contrast maths", () => {
  it("matches the published reference values", () => {
    expect(show(contrast(hexToRgb("#000000"), hexToRgb("#ffffff")))).toBe(21);
    expect(show(contrast(hexToRgb("#767676"), hexToRgb("#ffffff")))).toBe(4.54);
    expect(show(contrast(hexToRgb("#777"), hexToRgb("#fff")))).toBe(4.48);
  });
});

describe("the contrast table", () => {
  it("covers every surface and every section hue", () => {
    const surfaces = SURFACES.map((s) => s.id);
    for (const id of ["oat ground", "ivory card (.surface, sheets)", "beige recess (.well, trays)", "field",
      "sage wash", "Dijon wash", "persimmon wash", "red wash", ".olive-panel on ivory", "olive fill (primary)",
      "charcoal matte", ".olive-panel in .matte", ".matte-reset tray", "plan header band", "plan header chip"]) {
      expect(surfaces).toContain(id);
    }
    expect(Object.keys(SECTIONS).sort()).toEqual(["body", "coach", "foods", "settings", "today"]);
    expect(ROLES.length).toBeGreaterThan(20);
  });

  it("every allowed text role meets its threshold on every surface it may sit on", () => {
    const failures = [...allowedPairs(), ...glyphPairs(), ...noticePairs(), ...tagPairs()]
      .filter((pair) => pair.ratio < MIN[pair.use])
      .map((pair) => `${pair.role} on ${pair.surface}: ${show(pair.ratio)}:1 < ${MIN[pair.use]}:1 (${pair.use})`);
    expect(failures).toEqual([]);
  });

  it("checks the neutral Tag (the AI label) on every surface it rides on, light and matte", () => {
    expect(tagPairs().map((pair) => pair.surface)).toEqual([
      "neutral tag on ivory card", "neutral tag on beige recess", "neutral tag on field",
      "neutral tag on oat ground", "neutral tag on coach bubble", "neutral tag in the matte",
    ]);
  });

  it("every forbidden pair really fails, so the list stays true", () => {
    const passing = forbiddenPairs().filter((pair) => pair.ratio >= MIN[pair.use])
      .map((pair) => `${pair.role} on ${pair.surface} passes at ${show(pair.ratio)}:1 — drop it from the forbidden list`);
    expect(passing).toEqual([]);
  });

  it("the protein card's panel text is ink, not cream (the 2026-10-04 bug)", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    const panel = /\n\.olive-panel \{([^}]*)\}/.exec(css)![1];
    expect(panel).toMatch(/color: var\(--color-text-primary\)/);
    expect(panel).not.toMatch(/on-olive/);
  });

  it(".matte-reset and .notice map every text role back to its ink value", () => {
    for (const [role, light, reset] of resetValues()) expect(reset, role).toBe(light);
  });

  it("DESIGN.md §Contrast embeds the current table", () => {
    const design = readFileSync(join(ROOT, "DESIGN.md"), "utf8");
    const embedded = /<!-- contrast-table:start -->\n([\s\S]*?)\n<!-- contrast-table:end -->/.exec(design)?.[1];
    expect(embedded, "regenerate with: npx tsx tests/design/print-contrast-table.ts").toBe(markdownTable());
  });
});
