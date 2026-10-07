import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The scales (DESIGN.md §Typography, §Shapes; Devin 2026-09-22: "the font size varies so much
 * throughout the application"). Every literal size in a component must be one of these steps.
 *   type   12 label · 14 caption · 16 body · 20 title · 28 numeral · 40 display · 64 dial
 *   radius 12 button · 16 well · 24 card · 32 sheet · 9999 pill
 */
const TYPE_STEPS = new Set([12, 14, 16, 20, 28, 40, 64]);
const RADIUS_STEPS = new Set([12, 16, 24, 32, 9999]);
/** KIT.md §1: white alpha 5 · 8 · 12 · 20 · 40 · 70 %; black alpha 5 · 12 · 20 · 30 · 50 · 80 %;
 *  element opacity 40 % disabled, 60 % pending, 70 % readable disabled on a primary button over a
 *  dark surface (and 0 / 100 for animation). */
const WHITE_ALPHA = new Set([0.05, 0.08, 0.12, 0.2, 0.4, 0.7]);
const BLACK_ALPHA = new Set([0.05, 0.12, 0.2, 0.3, 0.5, 0.8]);
const OPACITY = new Set([0, 40, 60, 70, 100]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function offenders(pattern: RegExp, allowed: Set<number>, scale = 1): string[] {
  const found: string[] = [];
  for (const path of [...files("components"), ...files("app")]) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(pattern)) {
      const n = Number(match[1]) * scale;
      if (!allowed.has(n)) found.push(`${path}: ${match[0]}`);
    }
  }
  return found;
}

describe("the design scales", () => {
  it("uses only the seven type steps", () => {
    expect(offenders(/fontSize: (\d+)/g, TYPE_STEPS)).toEqual([]);
    expect(offenders(/text-\[(\d+)px\]/g, TYPE_STEPS)).toEqual([]);
  });

  it("uses only the opacity scale", () => {
    expect(offenders(/rgba\(255, ?255, ?255, ?(\d*\.?\d+)\)/g, WHITE_ALPHA)).toEqual([]);
    expect(offenders(/rgba\(0, ?0, ?0, ?(\d*\.?\d+)\)/g, BLACK_ALPHA)).toEqual([]);
    expect(offenders(/\bopacity-(\d+)\b/g, OPACITY)).toEqual([]);
    expect(offenders(/opacity: (\d*\.?\d+)[,} ]/g, OPACITY, 100)).toEqual([]);
  });

  it("uses only the five radius steps", () => {
    expect(offenders(/borderRadius: (\d+)/g, RADIUS_STEPS)).toEqual([]);
    expect(offenders(/rounded-\[(\d+)px\]/g, RADIUS_STEPS)).toEqual([]);
  });
});
