/**
 * Where the orbit's seven nodes sit (Health Overview Orbit, 2026-09-30). Clockwise from 12 o'clock,
 * one seventh of a turn apart. The ring turns, so any node can reach any point of its circle: the
 * radius comes from the measured stage width so a 72 px node a full radius out on either side still
 * fits a 320 px phone without clipping; a wider stage spreads the ring up to a cap instead of
 * changing what is on it. The open stage has
 * one fixed height for the ring and for a selected metric's detail, so choosing a node never grows
 * the card: the ring is centred in it, and the detail's entity sits at the top centre.
 */
export const ORBIT_COUNT = 7;
export const ORB_SIZE = 104;
export const NODE_WIDTH = 72;
export const NODE_HEIGHT = 80;
const EDGE = 8;
const MIN_RADIUS = 96;
const MAX_RADIUS = 140;
/** The open stage is never shorter than this, so every detail fits under its entity. */
const MIN_OPEN_HEIGHT = 344;
/** A selected metric's large entity: its box and its top inset in the open stage. */
export const HEADER_SIZE = 96;
export const HEADER_TOP = 8;
/** The mark's centre inside a node, above the node's centre (the amount and label sit under it). */
export const NODE_MARK_LIFT = 18;
/** The stage width a 320 px phone gives the card before it is measured (288 content − 2 border). */
export const DEFAULT_STAGE = 286;

export type OrbitGeometry = { radius: number; center: number; height: number;
  closedCenter: number; closedHeight: number };

export function orbitGeometry(stageWidth: number | null): OrbitGeometry {
  const width = stageWidth && stageWidth > 0 ? stageWidth : DEFAULT_STAGE;
  const radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, Math.floor((width - NODE_WIDTH - 2 * EDGE) / 2)));
  const ringHeight = 2 * (radius + NODE_HEIGHT / 2 + EDGE);
  const height = Math.max(ringHeight, MIN_OPEN_HEIGHT);
  const center = radius + NODE_HEIGHT / 2 + EDGE + Math.floor((height - ringHeight) / 2);
  const closedHeight = ORB_SIZE + 32;
  return { radius, center, height, closedCenter: closedHeight / 2, closedHeight };
}

/** A node's offset from the ring's centre, in px, clockwise from 12 o'clock, after the ring has
 *  turned `turn` degrees clockwise. */
export function nodeOffset(index: number, radius: number, turn = 0): { x: number; y: number } {
  const angle = (index * 2 * Math.PI) / ORBIT_COUNT + (turn * Math.PI) / 180;
  return { x: Math.round(radius * Math.sin(angle)), y: Math.round(-radius * Math.cos(angle)) };
}

/** How far the closing spiral turns clockwise on its way into the orb, in full turns. */
export const SPIRAL_TURNS = 1.25;

/** A node's closing path: a brief outward kick, then at least one full clockwise turn inward to
 *  the orb's centre. Keyframes in the ring's frame, first at the node's resting offset. */
export function spiralPath(index: number, radius: number, steps = 16): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const r = i === 1 ? radius * 1.08 : radius * (1 - t) ** 1.4;
    const point = nodeOffset(index, r, t * SPIRAL_TURNS * 360);
    x.push(point.x);
    y.push(point.y);
  }
  return { x, y };
}
