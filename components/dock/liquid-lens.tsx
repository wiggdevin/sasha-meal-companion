"use client";

import { useEffect, useState } from "react";

/**
 * Refraction for the dock's glass (Chromium only: it is the one engine that runs an SVG filter
 * inside backdrop-filter; Safari and Firefox drop it and keep the frosted fallback).
 *
 * Each glass body is modelled as a convex capsule of glass, thickest along its middle:
 * - the dome magnifies what is underneath (more across the short axis, like a glass rod), and
 * - a steep bevel at the rim pulls content in from further inside, the bend at a thick edge.
 * The map stores those per-pixel sample offsets as fractions of the box (red = x, green = y,
 * 0.5 = none), so it stretches cleanly with the box while the dock morphs.
 */

export type LensOptions = {
  /** Width of the bevel that bends light at the rim, px. */
  bezel: number;
  /** Largest rim offset, px. */
  rim: number;
  /** Magnification toward the middle along x and y (0.1 ≈ 1.1×). */
  magX: number;
  magY: number;
};

export const LENS_DEFAULTS: LensOptions = { bezel: 22, rim: 16, magX: 0.09, magY: 0.2 };

/** Per-pixel sample offsets (px) for a stadium-shaped lens of width w and height h. */
export function lensOffset(px: number, py: number, w: number, h: number, o: LensOptions = LENS_DEFAULTS) {
  const r = h / 2;
  const cx = w / 2;
  const cy = h / 2;
  const qx = Math.min(Math.max(px, r), w - r);
  const vx = px - qx;
  const vy = py - cy;
  const len = Math.hypot(vx, vy);
  const inside = r - len;
  if (inside <= 0) return { dx: 0, dy: 0 };
  let dx = -(px - cx) * o.magX;
  let dy = -(py - cy) * o.magY;
  if (len > 0) {
    const t = Math.min(1, inside / o.bezel);
    // Ease the bend in over the outermost pixels so the rim has no seam where glass begins.
    const edge = Math.min(1, inside / 3);
    const bend = o.rim * (1 - t) ** 2.2 * edge * edge * (3 - 2 * edge);
    dx += (-vx / len) * bend;
    dy += (-vy / len) * bend;
  }
  return { dx, dy };
}

/** The displacement map as a PNG data URL, in box-relative units (feDisplacementMap scale = 1). */
export function lensMapDataUrl(w: number, h: number, o: LensOptions = LENS_DEFAULTS): string | null {
  if (typeof document === "undefined" || w <= 0 || h <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const { dx, dy } = lensOffset(x + 0.5, y + 0.5, canvas.width, canvas.height, o);
      const i = (y * canvas.width + x) * 4;
      image.data[i] = Math.max(0, Math.min(255, Math.round(127.5 + (dx / canvas.width) * 255)));
      image.data[i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + (dy / canvas.height) * 255)));
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

export const LENS_PILL_ID = "dock-lens-pill";
export const LENS_ROUND_ID = "dock-lens-round";

/* Red, green and blue bend by slightly different amounts (dispersion), so bright edges and text
   near the rim pick up the faint colour fringe real glass has. */
const DISPERSION = [1, 0.965, 0.93] as const;
const CHANNEL = [
  "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0",
  "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0",
  "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
] as const;

function LensFilter({ id, map }: { id: string; map: string }) {
  return <filter id={id} x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox"
    colorInterpolationFilters="sRGB">
    <feImage href={map} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map" />
    {DISPERSION.map((scale, i) => <feDisplacementMap key={`d${i}`} in="SourceGraphic" in2="map" scale={scale}
      xChannelSelector="R" yChannelSelector="G" result={`d${i}`} />)}
    {CHANNEL.map((values, i) => <feColorMatrix key={`c${i}`} in={`d${i}`} type="matrix" values={values}
      result={`c${i}`} />)}
    <feBlend in="c0" in2="c1" mode="screen" result="c01" />
    <feBlend in="c01" in2="c2" mode="screen" />
  </filter>;
}

/** Only Chromium renders an SVG filter inside backdrop-filter. */
export function useLensing(): boolean {
  const [lensing, setLensing] = useState(false);
  useEffect(() => {
    const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
      .userAgentData?.brands ?? [];
    if (!brands.some((b) => /Chromium/i.test(b.brand))) return;
    const frame = requestAnimationFrame(() => setLensing(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return lensing;
}

/** The two lens filters the dock uses: a long capsule and a round bubble, both 64 px tall. */
export function LiquidLensFilters({ pillWidth, height }: { pillWidth: number; height: number }) {
  const [maps, setMaps] = useState<{ key: string; pill: string; round: string } | null>(null);
  const key = `${Math.round(pillWidth)}x${height}`;
  useEffect(() => {
    if (pillWidth <= 0 || maps?.key === key) return;
    const frame = requestAnimationFrame(() => {
      const pill = lensMapDataUrl(pillWidth, height);
      const round = lensMapDataUrl(height, height);
      if (pill && round) setMaps({ key, pill, round });
    });
    return () => cancelAnimationFrame(frame);
  }, [key, pillWidth, height, maps?.key]);
  if (!maps) return null;
  return <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }}>
    <LensFilter id={LENS_PILL_ID} map={maps.pill} />
    <LensFilter id={LENS_ROUND_ID} map={maps.round} />
  </svg>;
}
