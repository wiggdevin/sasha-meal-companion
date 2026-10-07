/**
 * Two inks in clear water (owner, 2026-10-07: "clear water with whatever color dye with those squirts
 * of each color at different sides to see how they all interact … real water and dye with real
 * physics"). A stable-fluids solver (Jos Stam: semi-Lagrangian advection, a pressure projection)
 * with the two things that make ink look like ink: vorticity confinement, which keeps the small
 * swirls alive so a jet curls into tendrils instead of smearing, and buoyancy, so the ink (a little
 * denser than water) sinks and billows. Jets squirt each ink in from a side wall; the jet pushes the
 * water, the water carries the ink, and where the two inks meet they wrap round each other and mix.
 *
 * On the CPU, so any phone runs it without float render targets: 96 × 48 cells over the water body
 * (row 0 at the surface), fixed 1/60 s steps (the same physics at 60 or 120 Hz), velocities in cells
 * per second. Pure numbers; the water shader (water-gl.ts) draws `pack()`'s texture.
 */

export type Jet = {
  /** Where the jet enters (0..1 across, 0..1 down from the surface) and its direction (unit vector). */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Jet speed, cells per second, and how much ink per second. */
  speed: number;
  ink: number;
  channel: "a" | "b";
  /** Seconds left to squirt, and an optional pause before it starts. */
  left: number;
  wait?: number;
};

export type Dye = {
  nx: number;
  ny: number;
  u: Float32Array;
  v: Float32Array;
  a: Float32Array;
  b: Float32Array;
  s1: Float32Array;
  s2: Float32Array;
  s3: Float32Array;
  curl: Float32Array;
  jets: Jet[];
  /** Unspent time, s, carried to the next frame so steps stay fixed. */
  spare: number;
  /** Seconds since the last jet stopped (see SETTLE_AT). */
  quiet: number;
  rgba: Uint8Array;
};

const STEP = 1 / 60;
const ITERATIONS = 20;
/** How strongly small swirls are kept alive (vorticity confinement), and how fast ink sinks. */
const SWIRL = 8;
const SINK = 60;
/** Water's own drag on the flow, per second, and the ink's slow fade, per second. */
const DRAG = 0.2;
const FADE = 0.04;
/** Per-step diffusion of the ink (see `smooth`): enough to clear single-cell speckle, no more. */
const INK_SPREAD = 0.012;
const MAX_SPEED = 140;
/**
 * After the show, in seconds since the last jet: from SETTLE_AT the water's drag grows, from CLEAR_AT
 * the ink fades faster, and from STILL_AT the flow is left at rest and only the fade runs, so the long
 * tail costs nearly nothing. The inks are gone about 20 s after the last squirt.
 */
const SETTLE_AT = 4;
const CLEAR_AT = 6;
const STILL_AT = 12;

export function createDye(nx = 96, ny = 48): Dye {
  const n = (nx + 2) * (ny + 2);
  const field = () => new Float32Array(n);
  return { nx, ny, u: field(), v: field(), a: field(), b: field(), s1: field(), s2: field(), s3: field(), curl: field(),
    jets: [], spare: 0, quiet: 0, rgba: new Uint8Array(nx * ny * 4) };
}

const at = (d: Dye, i: number, j: number) => i + (d.nx + 2) * j;

/** The glass all round: the flow slides along a wall but never crosses it (kind 1 mirrors u, 2 mirrors v). */
function bound(d: Dye, kind: 0 | 1 | 2, x: Float32Array) {
  const { nx, ny } = d;
  for (let i = 1; i <= nx; i += 1) {
    x[at(d, i, 0)] = kind === 2 ? -x[at(d, i, 1)] : x[at(d, i, 1)];
    x[at(d, i, ny + 1)] = kind === 2 ? -x[at(d, i, ny)] : x[at(d, i, ny)];
  }
  for (let j = 1; j <= ny; j += 1) {
    x[at(d, 0, j)] = kind === 1 ? -x[at(d, 1, j)] : x[at(d, 1, j)];
    x[at(d, nx + 1, j)] = kind === 1 ? -x[at(d, nx, j)] : x[at(d, nx, j)];
  }
}

/** Carry `src` along the flow for one step (look back along the velocity, sample there). */
function advect(d: Dye, kind: 0 | 1 | 2, out: Float32Array, src: Float32Array, dt: number) {
  const { nx, ny, u, v } = d;
  for (let j = 1; j <= ny; j += 1) {
    for (let i = 1; i <= nx; i += 1) {
      const x = Math.max(0.5, Math.min(nx + 0.5, i - dt * u[at(d, i, j)]));
      const y = Math.max(0.5, Math.min(ny + 0.5, j - dt * v[at(d, i, j)]));
      const i0 = Math.floor(x); const j0 = Math.floor(y);
      const s = x - i0; const t = y - j0;
      out[at(d, i, j)] = (1 - s) * ((1 - t) * src[at(d, i0, j0)] + t * src[at(d, i0, j0 + 1)])
        + s * ((1 - t) * src[at(d, i0 + 1, j0)] + t * src[at(d, i0 + 1, j0 + 1)]);
    }
  }
  bound(d, kind, out);
}

/**
 * Carry an ink along the flow with little blur (MacCormack): step forward, step back, and correct by
 * half the error; clamped to the cells the forward step read, so it never invents ink. Plain
 * advection smears a thin tendril into fog within a second; this keeps its edge.
 */
function advectInk(d: Dye, field: Float32Array, dt: number) {
  const { nx, ny, u, v, s1: fwd, s2: back, s3: src } = d;
  src.set(field);
  advect(d, 0, fwd, src, dt);
  advect(d, 0, back, fwd, -dt);
  for (let j = 1; j <= ny; j += 1) {
    for (let i = 1; i <= nx; i += 1) {
      const k = at(d, i, j);
      const x = Math.max(0.5, Math.min(nx + 0.5, i - dt * u[k]));
      const y = Math.max(0.5, Math.min(ny + 0.5, j - dt * v[k]));
      const i0 = Math.floor(x); const j0 = Math.floor(y);
      const c00 = src[at(d, i0, j0)]; const c10 = src[at(d, i0 + 1, j0)];
      const c01 = src[at(d, i0, j0 + 1)]; const c11 = src[at(d, i0 + 1, j0 + 1)];
      const lo = Math.min(c00, c10, c01, c11); const hi = Math.max(c00, c10, c01, c11);
      field[k] = Math.min(hi, Math.max(lo, fwd[k] + 0.5 * (src[k] - back[k])));
    }
  }
  bound(d, 0, field);
}

/**
 * A touch of molecular diffusion (an explicit Laplacian, `k` ≤ 0.25 stays stable): it smooths what the
 * coarse grid cannot hold (single-cell speckle) and leaves the curls, which are many cells wide.
 */
function smooth(d: Dye, field: Float32Array, k: number) {
  const { nx, ny, s1: tmp } = d;
  tmp.set(field);
  for (let j = 1; j <= ny; j += 1) {
    for (let i = 1; i <= nx; i += 1) {
      const c = at(d, i, j);
      field[c] = tmp[c] + k * (tmp[at(d, i - 1, j)] + tmp[at(d, i + 1, j)] + tmp[at(d, i, j - 1)] + tmp[at(d, i, j + 1)] - 4 * tmp[c]);
    }
  }
  bound(d, 0, field);
}

/** Water does not compress: remove the part of the flow that would pile it up, leaving the swirl. */
function project(d: Dye) {
  const { nx, ny, u, v, s1: p, s2: div } = d;
  for (let j = 1; j <= ny; j += 1) {
    for (let i = 1; i <= nx; i += 1) {
      div[at(d, i, j)] = -0.5 * (u[at(d, i + 1, j)] - u[at(d, i - 1, j)] + v[at(d, i, j + 1)] - v[at(d, i, j - 1)]);
      p[at(d, i, j)] = 0;
    }
  }
  bound(d, 0, div);
  bound(d, 0, p);
  for (let k = 0; k < ITERATIONS; k += 1) {
    for (let j = 1; j <= ny; j += 1) {
      for (let i = 1; i <= nx; i += 1) {
        p[at(d, i, j)] = (div[at(d, i, j)] + p[at(d, i - 1, j)] + p[at(d, i + 1, j)] + p[at(d, i, j - 1)] + p[at(d, i, j + 1)]) / 4;
      }
    }
    bound(d, 0, p);
  }
  for (let j = 1; j <= ny; j += 1) {
    for (let i = 1; i <= nx; i += 1) {
      u[at(d, i, j)] -= 0.5 * (p[at(d, i + 1, j)] - p[at(d, i - 1, j)]);
      v[at(d, i, j)] -= 0.5 * (p[at(d, i, j + 1)] - p[at(d, i, j - 1)]);
    }
  }
  bound(d, 1, u);
  bound(d, 2, v);
}

/** Vorticity confinement: push each small eddy round its own centre, so swirls survive as tendrils. */
function confine(d: Dye, dt: number) {
  const { nx, ny, u, v, curl } = d;
  for (let j = 1; j <= ny; j += 1) {
    for (let i = 1; i <= nx; i += 1) {
      curl[at(d, i, j)] = 0.5 * ((v[at(d, i + 1, j)] - v[at(d, i - 1, j)]) - (u[at(d, i, j + 1)] - u[at(d, i, j - 1)]));
    }
  }
  for (let j = 2; j < ny; j += 1) {
    for (let i = 2; i < nx; i += 1) {
      const gx = 0.5 * (Math.abs(curl[at(d, i + 1, j)]) - Math.abs(curl[at(d, i - 1, j)]));
      const gy = 0.5 * (Math.abs(curl[at(d, i, j + 1)]) - Math.abs(curl[at(d, i, j - 1)]));
      const len = Math.hypot(gx, gy) + 1e-5;
      const w = curl[at(d, i, j)];
      u[at(d, i, j)] += SWIRL * (gy / len) * w * dt;
      v[at(d, i, j)] -= SWIRL * (gx / len) * w * dt;
    }
  }
}

/** Squirt an ink in from a side: it keeps going for `seconds`, pushing the water as it comes. */
export function squirt(d: Dye, jet: Omit<Jet, "left">, seconds: number) {
  d.jets.push({ ...jet, left: seconds });
}

function applyJets(d: Dye, dt: number) {
  for (const jet of d.jets) {
    if (jet.wait && jet.wait > 0) { jet.wait -= dt; continue; }
    if (jet.left <= 0) continue;
    jet.left -= dt;
    const ci = 1 + jet.x * (d.nx - 1);
    const cj = 1 + jet.y * (d.ny - 1);
    const r = 3;
    // A little wobble, as a hand squeezing a bottle never holds perfectly still.
    const wob = Math.sin(jet.left * 23) * 0.12;
    const dx = jet.dx * Math.cos(wob) - jet.dy * Math.sin(wob);
    const dy = jet.dx * Math.sin(wob) + jet.dy * Math.cos(wob);
    const field = jet.channel === "a" ? d.a : d.b;
    for (let j = Math.max(1, Math.floor(cj - r)); j <= Math.min(d.ny, Math.ceil(cj + r)); j += 1) {
      for (let i = Math.max(1, Math.floor(ci - r)); i <= Math.min(d.nx, Math.ceil(ci + r)); i += 1) {
        const fall = Math.exp(-((i - ci) ** 2 + (j - cj) ** 2) / (r * r * 0.5));
        const k = at(d, i, j);
        // The jet sets the speed it squirts at; it never keeps adding to it.
        d.u[k] += (dx * jet.speed - d.u[k]) * fall * 0.6;
        d.v[k] += (dy * jet.speed - d.v[k]) * fall * 0.6;
        field[k] = Math.min(2, field[k] + jet.ink * fall * dt);
      }
    }
  }
  d.jets = d.jets.filter((jet) => jet.left > 0);
}

function step(d: Dye, dt: number) {
  const { nx, ny, u, v, a, b, s1, s2 } = d;
  applyJets(d, dt);
  const wasStill = d.quiet >= STILL_AT;
  d.quiet = d.jets.length > 0 ? 0 : d.quiet + dt;
  const keep = Math.exp(-(FADE + Math.max(0, d.quiet - CLEAR_AT) * 0.06) * dt);
  if (d.quiet >= STILL_AT) {
    // Still water: the ink only fades where it lies.
    if (!wasStill) { u.fill(0); v.fill(0); }
    for (let k = 0; k < a.length; k += 1) { a[k] *= keep; b[k] *= keep; }
    return;
  }
  // Ink is a touch denser than water: where there is ink, the water sinks with it. Interior cells
  // only — v's ghost row mirrors (negates) the row it borders, and adding to both sides by the same
  // (copied) ink amount would pull the mirror apart rather than keep it, until the next `bound()`.
  for (let j = 1; j <= ny; j += 1) {
    for (let i = 1; i <= nx; i += 1) {
      const k = at(d, i, j);
      v[k] += SINK * (a[k] + b[k]) * dt;
    }
  }
  confine(d, dt);
  s1.set(u); s2.set(v);
  advect(d, 1, u, s1, dt);
  advect(d, 2, v, s2, dt);
  const drag = Math.exp(-(DRAG + Math.max(0, d.quiet - SETTLE_AT) * 0.5) * dt);
  for (let k = 0; k < u.length; k += 1) {
    u[k] = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, u[k] * drag));
    v[k] = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v[k] * drag));
  }
  project(d);
  advectInk(d, a, dt);
  advectInk(d, b, dt);
  smooth(d, a, INK_SPREAD);
  smooth(d, b, INK_SPREAD);
  for (let k = 0; k < a.length; k += 1) { a[k] *= keep; b[k] *= keep; }
}

/** Advance by `dt` seconds in fixed steps (at most four per call, so a slow frame never stalls). */
export function stepDye(d: Dye, dt: number) {
  d.spare = Math.min(4 * STEP, d.spare + dt);
  while (d.spare >= STEP) {
    step(d, STEP);
    d.spare -= STEP;
  }
}

/** How much ink is in the water (0 when clear). */
export function dyeAmount(d: Dye): number {
  let sum = 0;
  for (let k = 0; k < d.a.length; k += 1) sum += d.a[k] + d.b[k];
  return sum / (d.nx * d.ny);
}
/** Whether the inks need drawing or stepping: a jet still squirting, or ink still in the water. */
export const dyeBusy = (d: Dye): boolean => d.jets.length > 0 || dyeAmount(d) > 0.001;

/** The inks as an RGBA texture, row 0 at the surface: red is the first ink, green the second. */
export function pack(d: Dye): Uint8Array {
  const { nx, ny, a, b, rgba } = d;
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const k = (j * nx + i) * 4;
      rgba[k] = Math.min(255, a[at(d, i + 1, j + 1)] * 160);
      rgba[k + 1] = Math.min(255, b[at(d, i + 1, j + 1)] * 160);
      rgba[k + 2] = 0;
      rgba[k + 3] = 255;
    }
  }
  return rgba;
}
