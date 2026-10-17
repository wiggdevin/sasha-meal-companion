import { DEFAULT_GROUND, groundById, type GroundId } from "./grounds";

/**
 * The browser chrome colour (`<meta name="theme-color">`). Next's metadata API needs a literal,
 * not a CSS variable, so this is the one colour kept outside the token files; it is the base of the
 * default ground (DESIGN.md `colors.background`). `themeColorFor` gives the chosen ground's.
 */
export const THEME_COLOR = groundById(DEFAULT_GROUND).base;

export function themeColorFor(id: GroundId): string {
  return groundById(id).base;
}
