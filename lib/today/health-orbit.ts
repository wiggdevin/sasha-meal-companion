/**
 * The Health Overview Orbit's numbers (2026-09-30): seven nodes around the overview orb, each with
 * the amount it shows, the words a screen reader hears, and a truthful state. Pure: the targets and
 * consumed macros come from the day's effective target revision (lib/resolve.ts), water from the
 * viewed day's log, and body data from the shared viewed-date read (lib/health/today-card.ts).
 * Missing, loading or switched-off data never becomes a zero.
 */
import type { BodyCapability } from "@/lib/health/capability";
import type { DailyHealthRow } from "@/lib/health/contract";
import type { Macros } from "@/lib/types";
import { boundLabel, eatenBound, withBound } from "@/lib/nutrition-display";
import { formatWater, formatWaterOf, type WaterUnit } from "@/lib/water-units";

export const ORBIT_KEYS = ["calories", "carbs", "protein", "fat", "water", "activity", "recovery"] as const;
export type OrbitKey = (typeof ORBIT_KEYS)[number];
export type NutrientKey = "calories" | "carbs" | "protein" | "fat";

/** The shared body read, narrowed to what the orbit reads. `undefined` means not asked yet. */
export type OrbitBody = { capability: BodyCapability; loading: boolean; row: DailyHealthRow | null;
  offline: boolean; fetchedAt: string | null };

/** Cups and the goal in cups (canonical storage); `unit` is how they read, cups when absent. */
export type OrbitWater = { cups: number; goal: number; unit?: WaterUnit };

/** ready: a real value · loading: not read yet · off: body data is switched off · empty: read, none. */
export type OrbitState = "ready" | "loading" | "off" | "empty";

export type OrbitNode = {
  key: OrbitKey;
  /** The full name: the heading of the detail and the start of the accessible name. */
  name: string;
  /** The concise label under the amount on the ring. */
  label: string;
  amount: string;
  spoken: string;
  state: OrbitState;
  /** 0..1 against a target, or null when the metric has no target. */
  progress: number | null;
  over: boolean;
  /** The figure is a lower bound (#21): the label says so ("At least", "At least, over"). */
  bound?: boolean;
};

export const NUTRIENTS: Record<NutrientKey, { macro: keyof Macros; name: string; label: string; unit: string }> = {
  calories: { macro: "kcal", name: "Calories eaten", label: "Eaten", unit: "kcal" },
  carbs: { macro: "carbs", name: "Carbohydrates", label: "Carbs", unit: "g" },
  protein: { macro: "protein", name: "Protein", label: "Protein", unit: "g" },
  fat: { macro: "fat", name: "Fat", label: "Fat", unit: "g" },
};

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** What is left of a target, or by how much it is passed. Exactly one of the two is non-zero. */
export function nutrientBalance(consumed: number, target: number): { remaining: number; over: number } {
  const diff = Math.round(target - consumed);
  return diff >= 0 ? { remaining: diff, over: 0 } : { remaining: 0, over: -diff };
}

/** 444 → "7h 24m"; under an hour → "45m". A duration, never a clock time. */
export function sleepAmount(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`;
}

export function cupsText(cups: number): string {
  return `${cups} ${cups === 1 ? "cup" : "cups"}`;
}

/** `partial`: the day holds a partly measured recipe serving (#21), so every eaten figure is a
 *  lower bound. Spoken in full; every nutrient node's label says it ("At least", which fits the 72 px
 *  node where "At least eaten" would not; the mark names the nutrient), and an over node keeps the
 *  word ("At least, over", which may wrap to two lines — review: Sol). */
function nutrientNode(key: NutrientKey, targets: Macros, consumed: Macros, partial = false): OrbitNode {
  const spec = NUTRIENTS[key];
  const value = consumed[spec.macro];
  const target = targets[spec.macro];
  const { over } = nutrientBalance(value, target);
  const amount = `${fmt(value)} ${spec.unit}`;
  const bound = eatenBound(partial);
  const eaten = withBound(fmt(value), bound);
  const spoken = target > 0
    ? `${spec.name}: ${eaten} of ${fmt(target)} ${spec.unit}${over > 0 ? `, ${withBound(fmt(over), bound)} ${spec.unit} over` : ""}`
    : `${spec.name}: ${withBound(amount, bound)}`;
  // Over target is said in words on the ring too, never by colour alone.
  const passed = target > 0 && over > 0;
  const label = partial ? `${boundLabel(bound)}${passed ? ", over" : ""}` : passed ? `${spec.label} over` : spec.label;
  return { key, name: spec.name, label, amount, spoken, state: "ready", ...(partial ? { bound: true } : {}),
    progress: target > 0 ? Math.min(1, value / target) : null, over: passed };
}

function waterNode(water: OrbitWater | undefined): OrbitNode {
  const base = { key: "water" as const, name: "Water", label: "Water" };
  if (!water) {
    return { ...base, amount: "…", spoken: "Water: loading", state: "loading", progress: null, over: false };
  }
  const unit = water.unit ?? "cups";
  const spoken = water.goal > 0 ? `Water: ${formatWaterOf(water.cups, water.goal, unit)}` : `Water: ${formatWater(water.cups, unit)}`;
  return { ...base, amount: formatWater(water.cups, unit), spoken, state: "ready",
    progress: water.goal > 0 ? Math.min(1, water.cups / water.goal) : null, over: false };
}

/** The state every body node shares before any of its values are read. */
export function bodyState(body: OrbitBody | undefined): Exclude<OrbitState, "ready" | "empty"> | "read" {
  if (!body || body.capability === "unknown") return "loading";
  if (body.capability === "disabled") return "off";
  return body.loading ? "loading" : "read";
}

function bodyNode(key: "activity" | "recovery", name: string, fallbackLabel: string,
  body: OrbitBody | undefined, pick: (row: DailyHealthRow) => { label: string; amount: string } | null): OrbitNode {
  const base = { key, name, progress: null, over: false };
  const state = bodyState(body);
  if (state === "loading") return { ...base, label: fallbackLabel, amount: "…", spoken: `${name}: loading`, state };
  if (state === "off") return { ...base, label: fallbackLabel, amount: "Off", spoken: `${name}: body data off`, state };
  const value = body?.row ? pick(body.row) : null;
  if (!value) return { ...base, label: fallbackLabel, amount: "—", spoken: `${name}: nothing recorded`, state: "empty" };
  return { ...base, ...value, spoken: `${name}: ${value.amount}`, state: "ready" };
}

export function orbitNodes({ targets, consumed, water, body, partial = false }: {
  targets: Macros; consumed: Macros; water: OrbitWater | undefined; body: OrbitBody | undefined;
  partial?: boolean;
}): OrbitNode[] {
  return [
    nutrientNode("calories", targets, consumed, partial),
    nutrientNode("carbs", targets, consumed, partial),
    nutrientNode("protein", targets, consumed, partial),
    nutrientNode("fat", targets, consumed, partial),
    waterNode(water),
    bodyNode("activity", "Active burn", "Active", body, (row) => row.active_kcal != null
      ? { label: "Active", amount: `${fmt(row.active_kcal)} kcal` }
      : row.steps != null ? { label: "Steps", amount: fmt(row.steps) } : null),
    bodyNode("recovery", "Sleep and recovery", "Recovery", body, (row) => row.sleep_minutes != null
      ? { label: "Sleep", amount: sleepAmount(row.sleep_minutes) }
      : row.readiness_score != null ? { label: "Readiness", amount: fmt(row.readiness_score) } : null),
  ];
}
