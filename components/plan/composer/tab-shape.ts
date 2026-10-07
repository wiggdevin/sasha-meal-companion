/**
 * The ask box's silhouette: the paper pill, and the tab that rises out of its top edge on the left,
 * just right of "+", when "+" is tapped. One closed path, so the pill and the tab are a single piece
 * of material.
 *
 * Read along the top edge from the left: the left flank starts where the pill's left cap ends, so
 * the tab sits as close to "+"/"×" as the pill allows. It bends up in an S (concave, then convex),
 * runs flat across the tab's top `rise` px above the pill, bends back down the same way, and the top
 * edge runs flat on to the right cap over Send. `spread` (0..1) narrows the tab while it is low, so
 * it grows out of the edge like a drop of the same material and widens as it rises. Pure, no DOM.
 */

/** How far the tab's top stands above the pill: tall enough to hold a 22 px glyph with 4 px of the
 *  tab's own material above and below it (2026-10-04, owner: the icons "should fit in the expanded
 *  portion"). */
export const RISE = 30;
/** Width of each S-curve, from the flat top edge to the tab's flat top. */
export const FLANK = 40;
/** The tab's glyphs: bare 22 px icons, no backing (owner: "get rid of the little button behind
 *  them, so it's just the icon"). */
export const TAB_GLYPH = 22;
/** Each action owns an equal share of the tab's flat top and sits at its centre, so two glyphs land
 *  at 25 % and 75 % of the tab (owner: "split evenly so that they're in the middle of each of their
 *  halves"). A share is wider than the 44 px it takes to hit one. */
export const TAB_SHARE = 52;
/** The pill's resting height before it is measured. */
export const PILL_HEIGHT = 56;

/** The flat top's width for `count` actions. */
export function plateauWidth(count: number): number {
  return Math.max(1, count) * TAB_SHARE;
}

/**
 * The box the tab's actions share, in the pill's coordinates: the raised region from the tab's flat
 * top down to the pill's edge, as wide as the tab reads at the glyphs' centre line (the flat top plus
 * half of each S-curve). Each action takes an equal part of it and centres its glyph there.
 */
export function tabBox(height: number, count: number) {
  const plateau = plateauWidth(count);
  return { left: tabLeftOffset(height) - FLANK / 2, top: -RISE, width: plateau + FLANK, height: RISE };
}

export type TabGeometry = {
  /** The pill's width and height (px). */
  width: number; height: number;
  /** How far the tab stands up right now (px); clamped at 0, so a settling spring never dents. */
  rise: number;
  /** How wide the tab has grown (0 narrow .. 1 full); clamped to 0..1. */
  spread: number;
  /** The flat top's full width (plateauWidth). */
  plateau: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const n = (value: number) => Number(value.toFixed(2));

/** Where the tab's full-width flat top starts, measured from the pill's left edge (px). */
export function tabLeftOffset(height: number): number {
  return height / 2 + FLANK;
}

/** The tab's stretch of the top edge: from where its left S leaves the flat edge to where the right
 *  S lands again, as `start`, `end` and the path commands between them. */
function tabEdge({ width, height, rise, spread, plateau }: TabGeometry) {
  const r = height / 2;
  const h = Math.max(0, rise);
  const s = clamp(spread, 0, 1);
  const centre = tabLeftOffset(height) + plateau / 2;
  const top = plateau * (0.35 + 0.65 * s);
  const flank = FLANK * (0.6 + 0.4 * s);
  const a = centre - top / 2;
  const b = centre + top / 2;
  const start = Math.max(r, a - flank);
  const end = Math.min(width - r, b + flank);
  // Each S leaves and meets a flat line, so both control points sit level with the ends they serve.
  const kl = Math.max(0, a - start) * 0.55;
  const kr = Math.max(0, end - b) * 0.55;
  const commands = [
    `C${n(start + kl)} 0 ${n(a - kl)} ${n(-h)} ${n(a)} ${n(-h)}`,
    `L${n(b)} ${n(-h)}`,
    `C${n(b + kr)} ${n(-h)} ${n(end - kr)} 0 ${n(end)} 0`,
  ];
  return { start, end, commands };
}

/** The pill-plus-tab outline as an SVG path, in the pill's own coordinates. */
export function tabPath(geometry: TabGeometry): string {
  const { width, height } = geometry;
  const r = height / 2;
  const { start, commands } = tabEdge(geometry);
  return [
    `M${n(r)} 0`,
    `L${n(start)} 0`,
    ...commands,
    `L${n(width - r)} 0`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(width - r)} ${n(height)}`,
    `L${n(r)} ${n(height)}`,
    `A${n(r)} ${n(r)} 0 0 1 ${n(r)} 0`,
    "Z",
  ].join(" ");
}

/** The tab's own region: the same top edge, closed along the pill's top line. Used as a clip, so
 *  the tab's tint is the outline's fill cut to exactly the part that stands above the pill. */
export function tabRegionPath(geometry: TabGeometry): string {
  const { start, commands } = tabEdge(geometry);
  return [`M${n(start)} 0`, ...commands, "Z"].join(" ");
}
