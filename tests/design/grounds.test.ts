import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GROUND, GROUNDS, isGroundId } from "@/lib/design/grounds";
import { THEME_COLOR, themeColorFor } from "@/lib/design/theme-color";
import { contrast, hexToRgb, MIN, over, ROLES, ROOT, token } from "./contrast-table";

const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const triple = (hex: string) => hexToRgb(hex).join(" ");

const corner = (g: (typeof GROUNDS)[number]) => over(hexToRgb(g.shade), 0.6, hexToRgb(g.base));
/** The shades the contrast table checks for the page, plus the top wash (lighter, so never worse). */
const pageShades = (g: (typeof GROUNDS)[number]) =>
  [hexToRgb(g.base), over(hexToRgb(g.lift), 0.9, hexToRgb(g.base))];
const lightRoles = ROLES.filter((r) => r.scope === "light" && r.id !== "text-text-faint");

describe("selectable grounds (DESIGN.md §Grounds)", () => {
  it("offers four grounds, Oat first and equal to the token ground", () => {
    expect(GROUNDS.map((g) => g.id)).toEqual(["oat", "sage", "clay", "mist"]);
    expect(DEFAULT_GROUND).toBe("oat");
    expect(hexToRgb(GROUNDS[0].base)).toEqual(token("paper"));
    expect(hexToRgb(GROUNDS[0].base)).toEqual(token("background"));
    expect(THEME_COLOR).toBe(GROUNDS[0].base);
    expect(isGroundId("sage")).toBe(true);
    expect(isGroundId("neon")).toBe(false);
  });

  it("the browser chrome colour follows the ground", () => {
    for (const g of GROUNDS) expect(themeColorFor(g.id)).toBe(g.base);
  });

  it("globals.css writes the same colours as grounds.ts", () => {
    for (const g of GROUNDS.slice(1)) {
      const rule = new RegExp(`html\\[data-ground="${g.id}"\\] \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule, g.id).toContain(`--color-paper: ${g.base};`);
      expect(rule, g.id).toContain(`--color-background: ${g.base};`);
      expect(rule, g.id).toContain(`--ground-lift-rgb: ${triple(g.lift)};`);
      expect(rule, g.id).toContain(`--ground-shade-rgb: ${triple(g.shade)};`);
    }
    const root = /--ground-lift-rgb: ([\d ]+);\s*--ground-shade-rgb: ([\d ]+);/.exec(css)!;
    expect(root[1]).toBe(triple(GROUNDS[0].lift));
    expect(root[2]).toBe(triple(GROUNDS[0].shade));
    for (const g of GROUNDS) expect(css).toContain(`.ground-swatch-${g.id} {`);
  });

  it("every light text role that may sit on the page meets its threshold on every ground", () => {
    const failures: string[] = [];
    for (const g of GROUNDS) {
      for (const role of lightRoles) {
        const worst = Math.min(...pageShades(g).map((shade) => contrast(role.color, shade)));
        if (worst < MIN[role.use]) failures.push(`${role.id} on ${g.id}: ${worst.toFixed(2)}:1 < ${MIN[role.use]}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("the lower-corner shade is never darker than Oat's, so no ground reads worse there", () => {
    const oat = corner(GROUNDS[0]);
    const failures: string[] = [];
    for (const g of GROUNDS.slice(1)) {
      for (const role of lightRoles) {
        if (contrast(role.color, corner(g)) < contrast(role.color, oat) - 0.005) failures.push(`${role.id} on ${g.id}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
