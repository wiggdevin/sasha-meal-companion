/**
 * The section hue (DESIGN.md §Colors): each tab tints its glass with one macro hue. A route maps
 * to the tab it belongs to; anything unknown reads as Today.
 */
export type Section = "today" | "body" | "foods" | "coach" | "settings";

const ROOTS: ReadonlyArray<[prefix: string, section: Section]> = [
  ["/body", "body"],
  ["/foods", "foods"],
  ["/recipes", "foods"],
  ["/scan", "foods"],
  ["/coach", "coach"],
  ["/settings", "settings"],
  ["/week", "today"],
  ["/onboarding", "settings"],
];

export function sectionFor(pathname: string): Section {
  for (const [prefix, section] of ROOTS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return section;
  }
  return "today";
}
