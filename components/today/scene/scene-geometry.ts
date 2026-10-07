/**
 * Sprout's pond (owner, 2026-10-07; layout from GPT-6 Astra's scene spec §A, kept in the owner's
 * plans folder). Every position is in one 350 × 420 box;
 * the scene scales it to the card's width, so nothing here knows about pixels on screen.
 */

export const BOX = { w: 350, h: 420 } as const;

/** Where the far shore meets the water (the painted backdrop's own waterline). */
export const HORIZON = 226;

/** The rainbow: one band per measure, outside in, all standing on the horizon. */
export const RAINBOW = { cx: 214, cy: HORIZON, radii: [128, 116, 104, 92], band: 8 } as const;
export type Band = "kcal" | "protein" | "carbs" | "fat";
export const BANDS: readonly Band[] = ["kcal", "protein", "carbs", "fat"];
/** A saved "Macro rings" view keeps its meaning: the rainbow without the calorie band. */
export const MACRO_BANDS: readonly Band[] = ["protein", "carbs", "fat"];

/** Sprout's sprite frame (640 × 665 art) and the rock under it, both drawn at this box. */
export const SPRITE = { x: -50, y: 83, w: 327, h: 340 } as const;
/** Rod tips in the sprite frame (0..1), measured from the art: resting, winding up, landing a catch. */
export const ROD_TIP = {
  fishing: [0.9797, 0.206],
  cast: [0.0188, 0.0135],
  catch: [0.8641, 0.0316],
} as const;
/** Where the lure lands: centre right, a little below the middle. */
export const LURE = { x: 256, y: 300 } as const;
/** The key, shown in the water when the rainbow is tapped. */
export const KEY = { x: 186, y: 246, w: 148 } as const;

export const CLOUDS = [
  { src: "/pet/scene/cloud-1.webp", x: 14, y: 34, w: 74, drift: 18, period: 36 },
  { src: "/pet/scene/cloud-2.webp", x: 246, y: 70, w: 86, drift: -14, period: 49 },
] as const;

/**
 * The rainbow's tap area: the band of sky its arcs cover (8 beyond each edge, at least 60 deep, which is
 * still 44 CSS px on a 320 px phone),
 * as a box plus a clip-path polygon in that box's own percentages, so a tap on open sky passes through.
 */
export function rainbowHit(count: number) {
  const outer = RAINBOW.radii[0] + RAINBOW.band;
  const inner = Math.min(RAINBOW.radii[count - 1] - RAINBOW.band, outer - 60);
  const left = RAINBOW.cx - outer;
  const top = RAINBOW.cy - outer;
  const size = { w: outer * 2, h: outer };
  const point = (r: number, theta: number) =>
    `${(((RAINBOW.cx + r * Math.cos(theta)) - left) / size.w * 100).toFixed(2)}% ${(((RAINBOW.cy - r * Math.sin(theta)) - top) / size.h * 100).toFixed(2)}%`;
  const steps = 24;
  const outerArc = Array.from({ length: steps + 1 }, (_, i) => point(outer, Math.PI - (Math.PI * i) / steps));
  const innerArc = Array.from({ length: steps + 1 }, (_, i) => point(inner, (Math.PI * i) / steps));
  return { left, top, w: size.w, h: size.h, clip: `polygon(${[...outerArc, ...innerArc].join(", ")})` };
}

/** A rod tip in the box, from its spot in the sprite frame. */
export function rodTip(pose: keyof typeof ROD_TIP): { x: number; y: number } {
  const [u, v] = ROD_TIP[pose];
  return { x: SPRITE.x + u * SPRITE.w, y: SPRITE.y + v * SPRITE.h };
}

/** One band's half circle, left foot to right foot, for a stroke drawn with pathLength 1. */
export function bandPath(radius: number): string {
  const { cx, cy } = RAINBOW;
  return `M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`;
}

/** How much of a band is lit: the share eaten of its target, 0..1. An unknown target lights nothing. */
export function bandShare(consumed: number, target: number): number {
  if (!(target > 0) || !Number.isFinite(consumed)) return 0;
  return Math.max(0, Math.min(1, consumed / target));
}

/**
 * The fishing line from the rod tip to the lure: it sags under its own weight, more when slack.
 * A quadratic curve whose control point hangs below the straight line.
 */
export function linePath(tip: { x: number; y: number }, lure: { x: number; y: number }, slack = 1): string {
  const mx = (tip.x + lure.x) / 2;
  const my = Math.max(tip.y, lure.y) + 14 * slack;
  return `M ${tip.x.toFixed(1)} ${tip.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${lure.x.toFixed(1)} ${lure.y.toFixed(1)}`;
}

/** The lure's flight on a cast: from the rod tip, up over an arc, down to the water. t is 0..1. */
export function castFlight(from: { x: number; y: number }, to: { x: number; y: number }, t: number) {
  const peak = { x: (from.x + to.x) / 2 - 10, y: Math.min(from.y, to.y) - 70 };
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * peak.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * peak.y + t * t * to.y,
  };
}

/**
 * Screen (box) point on the water → its spot on the lake's ground plane (0..1 each way). The lake is
 * seen in perspective: a step toward the horizon covers more water, so ripples far away are small and
 * flat and ones near Sprout are big. The water shader uses the same mapping (pond-gl.ts).
 */
export const PERSPECTIVE = { d0: 0.09, zCap: 4.2 } as const;
export function groundFromBox(x: number, y: number): { gx: number; gz: number } | null {
  const d = (y - HORIZON) / (BOX.h - HORIZON);
  if (d <= 0) return null;
  const z = 1 / (d + PERSPECTIVE.d0);
  const zMin = 1 / (1 + PERSPECTIVE.d0);
  const gz = (z - zMin) / (PERSPECTIVE.zCap - zMin);
  const gx = 0.5 + (x / BOX.w - 0.5) * (z / PERSPECTIVE.zCap);
  if (gz < 0 || gz > 1 || gx < 0 || gx > 1) return null;
  return { gx, gz };
}
