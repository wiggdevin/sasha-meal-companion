/**
 * The overview orb's shader (Health Overview Orbit, 2026-09-30), adapted from the phosphor WebGL2
 * reference. The reference marches 80 steps with an 8-step twist per pixel over a full screen; this
 * draws one small circle, so the march is cut to a few dozen steps, the loop bounds are compile-time
 * constants chosen per device, and the colour comes from three role colours (uniforms fed from
 * `--orb-core-rgb`, `--orb-rim-rgb` and `--orb-fire-rgb` in app/globals.css) instead of the
 * reference's rainbow. Harvest (2026-10-01): olive, sage and wheat ink marbled on an ivory sphere.
 *
 * HD pass (2026-09-30): the orb is drawn at the screen's full pixel density (up to 3×) so its
 * strands stay crisp on a phone; the per-pixel work stays inside the same budget.
 */

/** The reference's per-pixel work: 80 march steps × 8 twist steps. */
export const REFERENCE_WORK = 80 * 8;

export type OrbQuality = { dpr: number; steps: number; twist: number; fps: number };

/** Never draw more than 3 device pixels per CSS pixel; no screen needs more for an 84 px orb. */
export const MAX_ORB_DPR = 3;

/** A phone (coarse pointer or few cores) gets fewer steps and 30 fps, but every screen pixel. */
export function orbQuality({ coarse, dpr, cores }: { coarse: boolean; dpr: number; cores: number }): OrbQuality {
  const ratio = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, MAX_ORB_DPR);
  if (coarse || cores <= 4) return { dpr: ratio, steps: 30, twist: 5, fps: 30 };
  return { dpr: ratio, steps: 48, twist: 6, fps: 60 };
}

/** Backing-store size for a CSS box at the capped device-pixel ratio; never zero. */
export function canvasPixels(cssPx: number, dpr: number): number {
  return Math.max(1, Math.round(cssPx * dpr));
}

export const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export function fragmentSource({ steps, twist }: Pick<OrbQuality, "steps" | "twist">): string {
  return `#version 300 es
precision highp float;
#define STEPS ${steps}
#define TWIST ${twist}
out vec4 fragColor;
uniform vec2 uRes;
uniform float uTime;
uniform float uEnergy;
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uFire;

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  float radius = length(uv);
  // A one-pixel anti-aliased rim instead of a wide fade: the disc reads sharp at any density.
  float px = 2.0 / uRes.y;
  float mask = 1.0 - smoothstep(1.0 - 2.0 * px, 1.0, radius);
  if (mask <= 0.0) { fragColor = vec4(0.0); return; }

  float t = uTime * 0.6;
  vec3 dir = normalize(vec3(uv, -1.6));
  float z = 0.0;
  float d = 0.0;
  float s = 0.0;
  float glow = 0.0;
  float tint = 0.0;
  float heat = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = z * dir;
    vec3 a = normalize(cos(vec3(5.0, 0.0, 1.0) + t - d * 4.0));
    p.z += 5.0;
    a = a * dot(a, p) - cross(a, p);
    for (int k = 2; k < TWIST + 2; k++) {
      float fk = float(k);
      a -= sin(a * fk + t).zxy / fk;
    }
    s = a.y;
    d = 0.1 * abs(length(p) - 3.0) + 0.07 * abs(cos(s));
    z += d;
    float w = 1.0 / max(d, 0.002);
    glow += w;
    tint += (cos(s) * 0.5 + 0.5) * w;
    // The fire strands: one phase of the same twist, drifting on its own clock.
    heat += pow(max(sin(s * 1.7 + t * 0.9), 0.0), 6.0) * w;
  }
  float scale = 80.0 / float(STEPS);
  float energy = pow(tanh(glow * scale / 3400.0), 1.5) * (0.85 + 0.35 * uEnergy);
  float hue = clamp(tint / max(glow, 0.001), 0.0, 1.0);
  float fire = smoothstep(0.16, 0.45, heat / max(glow, 0.001));
  // Harvest (2026-10-01): the strands are coloured ink on a warm ivory sphere — marbled olive, sage
  // and wheat rather than plasma on black. Energy decides how much colour shows through.
  vec3 ink = mix(uRim, uCore, smoothstep(0.15, 0.65, hue));
  ink = mix(ink, uFire, fire * 0.7);
  vec3 skin = vec3(0.965, 0.948, 0.912);
  vec3 col = mix(skin, ink, clamp(energy * 1.15, 0.0, 0.9));
  // Soft sphere shading: a highlight up and to the left, a gentle shade toward the lower right.
  col *= 1.0 - 0.14 * smoothstep(0.35, 1.25, length(uv - vec2(-0.38, 0.42)));
  col += 0.22 * (1.0 - smoothstep(0.0, 0.42, length(uv - vec2(-0.34, 0.4))));
  col = clamp(col, 0.0, 1.0);
  fragColor = vec4(col * mask, mask);
}
`;
}

/** "134 195 255" (a CSS rgb triplet) → [0.53, 0.76, 1]; a missing value falls back to `fallback`. */
export function rgbTriplet(value: string, fallback: [number, number, number]): [number, number, number] {
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return parts.map((n) => Math.min(1, Math.max(0, n / 255))) as [number, number, number];
}
