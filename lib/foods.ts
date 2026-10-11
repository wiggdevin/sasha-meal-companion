/** Account-owned foods and the meal compiler that sizes them to a slot target. */

import { macroKcal, roundToServing, SERVING_STEP } from "./scaling";
import type { DayType, FoodComponent, Macros, Meal, SlotId } from "./types";

export type FoodRole = "protein" | "carb" | "fat";
export type FoodStatus = "eats" | "avoid" | "neutral";
export type FoodUnit = FoodComponent["unit"];
export type MacroKey = "protein" | "carbs" | "fat";

/** The nutrient code each `perUnit` macro is stored under (`user_foods.per_100g`, snapshots). */
export const MACRO_NUTRIENT_CODES = { protein: "protein", carbs: "carbohydrate", fat: "fat_total" } as const;

export type Food = {
  id: string;
  name: string;
  role: FoodRole;
  unit: FoodUnit;
  /** Macros for ONE unit. */
  perUnit: { protein: number; carbs: number; fat: number };
  /**
   * Energy for ONE unit as the source measured it — reported, else calculated (the one energy
   * rule, lib/nutrients/energy.ts) — when the food's row carries it (W004, audit A156). Absent:
   * the energy is derived from `perUnit` (4/4/9). Read it through `foodKcalPerUnit`.
   */
  kcalPerUnit?: number;
  /** True when the stored row records no nutrition at all, so a zero `perUnit` means unknown, not
   *  zero calories (lib/foods/display.ts). Absent means the numbers are the food's own. */
  nutritionUnknown?: boolean;
  /**
   * Macros the stored row never measured (W004 review): `perUnit` reads them as 0 for arithmetic,
   * and every writer leaves their codes out rather than storing that 0 as a measurement
   * (`omitUnmeasured`). Absent: every macro is the food's own.
   */
  unmeasured?: readonly MacroKey[];
  status: FoodStatus;
  note?: string;
  noCook?: boolean;
  updatedAt: string;
  /** Present when this account row was created from a catalog result. */
  catalogFoodId?: number;
};

/**
 * One unit's energy: the measured `kcalPerUnit` when the food has a usable one, else 4 P + 4 C + 9 F
 * from its macros. Alcohol energy is in no macro, so a drink logged without its measured energy
 * would count about an eighth of it (W004, audit A156).
 */
export function foodKcalPerUnit(food: Pick<Food, "perUnit" | "kcalPerUnit">): number {
  const measured = food.kcalPerUnit;
  return typeof measured === "number" && Number.isFinite(measured) && measured >= 0
    ? measured : macroKcal(food.perUnit);
}

/**
 * The food with new per-unit macros. Measured energy belongs to the numbers it was measured with:
 * an edit that changes any macro drops it, so the energy follows the user's own numbers.
 */
export function withPerUnit(food: Food, perUnit: Food["perUnit"]): Food {
  const same = food.perUnit.protein === perUnit.protein && food.perUnit.carbs === perUnit.carbs
    && food.perUnit.fat === perUnit.fat;
  if (same) return { ...food, perUnit };
  // The user's own numbers replace every macro, so none of them stays unmeasured either.
  const { kcalPerUnit: _dropped, unmeasured: _unmeasured, ...rest } = food;
  void _dropped;
  void _unmeasured;
  return { ...rest, perUnit };
}

/** A nutrient map without the codes of the food's unmeasured macros: never a stored 0 for them. */
export function omitUnmeasured<T extends Partial<Record<string, number>>>(
  food: Pick<Food, "unmeasured">, values: T,
): T {
  if (!food.unmeasured?.length) return values;
  const drop = new Set<string>(food.unmeasured.map((key) => MACRO_NUTRIENT_CODES[key]));
  return Object.fromEntries(Object.entries(values).filter(([code]) => !drop.has(code))) as T;
}

export const ROLE_LABELS: Record<FoodRole, string> = {
  protein: "Protein",
  carb: "Carbs",
  fat: "Fats",
};

export const UNIT_LABELS: Record<FoodUnit, string> = {
  oz: "oz",
  cup: "cup",
  tbsp: "tbsp",
  tsp: "tsp",
  whole: "each",
  pouch: "pouch",
  can: "can",
  g: "g",
  ml: "ml",
};

export function bannedReason(name: string): string | null {
  return name.trim() ? null : "Enter a food name.";
}

/**
 * Does a note suggest that this food caused a problem? Word-bounded and case-insensitive
 * (so "painting" is not "pain"), a fixed list rather than a model call — one
 * person's vocabulary is enough. Deliberately simple about negation: "not
 * tired at all" matches. The offer is only ever a suggestion.
 */
const AVOID_WORDS =
  /\b(hate|hated|hurt|sick|tired|bloat|bloated|flare|pain|nausea|cramps|gassy|awful|never again)\b/i;

export function noteSuggestsAvoid(note: string): boolean {
  return AVOID_WORDS.test(note);
}

/**
 * Move a food to Avoid without deleting its note or other account-owned data.
 */
export function foodToAvoid(food: Food): Food {
  return { ...food, status: "avoid" };
}

/** The change the one-tap offer makes after a bad note (F-03). */
export function applyAvoidOffer(food: Food): Food {
  return foodToAvoid(food);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function eatsByRole(foods: Record<string, Food>): Record<FoodRole, Food[]> {
  const out: Record<FoodRole, Food[]> = { protein: [], carb: [], fat: [] };
  for (const f of Object.values(foods)) {
    if (f.status === "eats") out[f.role].push(f);
  }
  for (const role of Object.keys(out) as FoodRole[]) {
    out[role].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

// ---------------------------------------------------------------- compose

export type Picks = { protein: Food | null; carb: Food | null; fat: Food | null };

const COMPOSE_PREFIX = "compose:";

export function composeId(picks: Picks): string {
  return `${COMPOSE_PREFIX}${picks.protein?.id ?? "-"}+${picks.carb?.id ?? "-"}+${picks.fat?.id ?? "-"}`;
}

export function isComposeId(id: string): boolean {
  return id.startsWith(COMPOSE_PREFIX);
}

/** Resolve a compose id back to picks. Null if any named food is not `eats`. */
export function picksFromId(id: string, foods: Record<string, Food>): Picks | null {
  if (!isComposeId(id)) return null;
  const parts = id.slice(COMPOSE_PREFIX.length).split("+");
  if (parts.length !== 3) return null;
  const resolve = (fid: string, role: FoodRole): Food | null | undefined => {
    if (fid === "-") return null;
    const f = foods[fid];
    if (!f || f.status !== "eats" || f.role !== role) return undefined;
    return f;
  };
  const protein = resolve(parts[0], "protein");
  const carb = resolve(parts[1], "carb");
  const fat = resolve(parts[2], "fat");
  if (protein === undefined || carb === undefined || fat === undefined) return null;
  return { protein, carb, fat };
}

export function componentFor(f: Food, qty: number): FoodComponent {
  if (!f.role) throw new Error("A meal component needs a food role");
  const protein = Math.round(f.perUnit.protein * qty);
  const carbs = Math.round(f.perUnit.carbs * qty);
  const fat = Math.round(f.perUnit.fat * qty);
  return {
    name: f.name,
    qty,
    unit: f.unit,
    role: f.role,
    macros: { protein, carbs, fat, kcal: macroKcal({ protein, carbs, fat }) },
  };
}

/** The calorie tolerance a plate may go over its target by (lib/meals/size.ts fitsTarget: 10 %). */
const KCAL_TOLERANCE = 0.1;

/**
 * The added fat's quantity. A positive need is served, rounded to a serving — never dropped
 * because it is smaller than half a step (audit N1). Every step of it must keep the plate inside
 * its calorie tolerance (review round 6): the serving steps down one step at a time until it fits,
 * and when even one step does not, the fat is left off and the remaining need stands for the
 * fit checks (fitsTarget, the shortfall notices) to report.
 */
function fatServing(qty: number, unit: FoodUnit, fits: (qty: number) => boolean): number {
  if (!(qty > 0)) return 0;
  const step = SERVING_STEP[unit];
  for (let served = roundToServing(qty, unit); served > 1e-9; served = roundToServing(served - step, unit)) {
    if (fits(served)) return served;
    if (served - step < 1e-9) break;
  }
  return 0;
}

/**
 * Size three foods to a slot target. Protein and carb are each sized from
 * their own target alone — so a calorie change never moves the chicken
 * (PRD acceptance 13) — and the fat is filled net of what both already
 * brought, so a fatty protein means less added oil, not more. The few grams
 * of protein a carb carries land on top; over is fine, under is not.
 * Components are listed protein first for a predictable plate summary.
 */
export function composeMeal(slot: SlotId, target: Macros, picks: Picks): Meal {
  let have = { protein: 0, carbs: 0, fat: 0 };
  const sized: Partial<Record<FoodRole, FoodComponent>> = {};
  const add = (c: FoodComponent) => {
    sized[c.role as FoodRole] = c;
    have = {
      protein: have.protein + c.macros.protein,
      carbs: have.carbs + c.macros.carbs,
      fat: have.fat + c.macros.fat,
    };
  };

  if (picks.carb && picks.carb.perUnit.carbs > 0) {
    const qty = roundToServing(target.carbs / picks.carb.perUnit.carbs, picks.carb.unit);
    if (qty > 0) add(componentFor(picks.carb, qty));
  }
  if (picks.protein && picks.protein.perUnit.protein > 0) {
    const qty = roundToServing(target.protein / picks.protein.perUnit.protein, picks.protein.unit);
    if (qty > 0) add(componentFor(picks.protein, qty));
  }
  if (picks.fat && picks.fat.perUnit.fat > 0) {
    const need = Math.max(0, target.fat - have.fat);
    const fat = picks.fat;
    const fits = (qty: number) => {
      const extra = componentFor(fat, qty).macros;
      return macroKcal({ protein: have.protein + extra.protein, carbs: have.carbs + extra.carbs,
        fat: have.fat + extra.fat }) <= target.kcal * (1 + KCAL_TOLERANCE);
    };
    const qty = fatServing(need / fat.perUnit.fat, fat.unit, fits);
    if (qty > 0) add(componentFor(fat, qty));
  }
  const components = [sized.protein, sized.carb, sized.fat].filter(Boolean) as FoodComponent[];

  // Name only what is actually on the plate — a fat that rounded to zero
  // (four eggs already cover the fat target) must not be promised.
  const names = components.map((c) => shortName(c.name));
  const name =
    names.length === 0
      ? "Nothing picked yet"
      : names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;

  const allNoCook = [picks.protein, picks.carb, picks.fat].every((f) => !f || f.noCook);

  return {
    id: composeId(picks),
    name,
    slot,
    components,
    macros: { ...have, kcal: macroKcal(have) },
    prepMinutes: allNoCook ? 5 : 20,
    tags: allNoCook ? ["low-fibre", "no-cook"] : ["low-fibre"],
  };
}

function shortName(name: string): string {
  return name.split(",")[0].trim();
}

// ------------------------------------------------------------- rotation pool

const MAX_POOL = 120;

/**
 * The day-by-day sequence for a meal slot: index i takes protein i mod P,
 * carb i mod C, fat i mod F. With pool sizes that are not multiples of each
 * other, every role changes every day and the full combination cycles slowly.
 *
 * All three roles must be present. Missing account foods produce no automatic meal.
 */
export function rotationPool(
  dayType: DayType,
  slot: SlotId,
  target: Macros,
  foods: Record<string, Food>
): Meal[] {
  const by = eatsByRole(foods);
  const proteinPool = by.protein;
  const carbPool = by.carb;
  const fatPool = by.fat;
  const P = proteinPool.length;
  const C = carbPool.length;
  const F = fatPool.length;
  const cycle = lcm(lcm(Math.max(P, 1), Math.max(C, 1)), Math.max(F, 1));
  const n = Math.min(cycle, MAX_POOL);
  if (P === 0 || C === 0 || F === 0) return [];

  const out: Meal[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      composeMeal(slot, target, {
        protein: P ? proteinPool[i % P] : null,
        carb: C ? carbPool[i % C] : null,
        fat: F ? fatPool[i % F] : null,
      })
    );
  }
  void dayType;
  return out;
}

/** Every protein × carb × fat combination. Used for tests and the API. */
export function composedOptions(
  dayType: DayType,
  slot: SlotId,
  foods: Record<string, Food>,
  target: Macros | null
): Meal[] {
  // No revision, no numbers: composition never invents a gram target (design §5).
  if (!target) return [];
  const by = eatsByRole(foods);
  if (by.protein.length === 0 || by.carb.length === 0 || by.fat.length === 0) return [];
  const t = target;
  const out: Meal[] = [];
  for (const protein of by.protein.length ? by.protein : [null])
    for (const carb of by.carb.length ? by.carb : [null])
      for (const fat of by.fat.length ? by.fat : [null])
        out.push(composeMeal(slot, t, { protein, carb, fat }));
  void dayType;
  return out;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}
