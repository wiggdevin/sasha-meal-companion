/**
 * The Plan / Log panel's header (2026-10-04, owner: "Give the meal plan cards some personality at the
 * top, some colour, and hierarchical text"). Three steps of hierarchy: a tracked overline
 * ("PLAN · MEAL 1") in the section hue, a serif title naming the meal from its clock time
 * (lib/coach/meal-type.ts) with the time beside it, and the slot's target as chips — calories in the
 * shared `.kcal` persimmon, protein plum, carbs sage, fat Dijon (the readable `.macro-ink-*` shades).
 * A soft wash band and a round glyph carry the meal type's tint (globals.css `.plan-head`): breakfast
 * wheat, lunch sage, dinner olive, snack plum. Pure presentation, no state.
 */
import type { Macros } from "@/lib/types";
import { mealTypeAt, type MealType } from "@/lib/coach/meal-type";

const TITLES: Record<MealType, string> = {
  breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", other: "Late meal",
};

/** The meal a slot is for, by its clock time; a snack slot is always a snack. */
export function slotMealType(slot: string, time: string): MealType {
  return mealTypeAt(time, slot.startsWith("snack") ? "snack" : "meal");
}

export function mealTitle(type: MealType): string {
  return TITLES[type];
}

const GLYPH = {
  width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7,
  strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
} as const;

function MealGlyph({ type }: { type: MealType }) {
  // Sunrise, full sun, moon, a leaf; a plate for an untimed meal.
  if (type === "breakfast") return <svg {...GLYPH}><path d="M4 18h16" /><path d="M7.5 18a4.5 4.5 0 0 1 9 0" />
    <path d="M12 6v3M5.6 10.6l1.6 1.6M18.4 10.6l-1.6 1.6" /></svg>;
  if (type === "lunch") return <svg {...GLYPH}><circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></svg>;
  if (type === "dinner") return <svg {...GLYPH}><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" /></svg>;
  if (type === "snack") return <svg {...GLYPH}><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z" /><path d="M5 19 13 11" /></svg>;
  return <svg {...GLYPH}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /></svg>;
}

/** Short labels so the four targets sit on one line on a phone (owner, 2026-10-04); the list's spoken
 *  names stay whole. */
const CHIPS: { key: keyof Macros; unit: string; label: string; spoken: string; ink: string }[] = [
  { key: "kcal", unit: "", label: "kcal", spoken: "calories", ink: "kcal" },
  { key: "protein", unit: "g", label: "PRO", spoken: "grams protein", ink: "macro-ink-protein" },
  { key: "carbs", unit: "g", label: "CAR", spoken: "grams carbs", ink: "macro-ink-carbs" },
  { key: "fat", unit: "g", label: "FAT", spoken: "grams fat", ink: "macro-ink-fat" },
];

export default function PlanSheetHeader({ mode, label, slot, time, clock, target }: {
  mode: "plan" | "log";
  /** "Meal 1" */
  label: string;
  /** The slot id ("meal-1", "snack-1") and its 24 h time ("08:00"). */
  slot: string; time: string;
  /** The time as shown ("8:00 am"). */
  clock: string;
  target: Macros | undefined;
}) {
  const type = slotMealType(slot, time);
  return <div data-meal={type} className="plan-head flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5">
    <span className="plan-head-glyph mt-0.5"><MealGlyph type={type} /></span>
    <div className="flex min-w-0 flex-col gap-1">
      <p className="m-0 text-overline uppercase text-section">{mode === "log" ? "Log" : "Plan"} · {label}</p>
      <h2 className="m-0 flex min-w-0 items-baseline gap-2 font-display text-heading leading-none text-charcoal">
        <span className="truncate">{mealTitle(type)}</span>
        <span className="shrink-0 font-sans text-caption font-medium tracking-normal text-muted">{clock}</span>
      </h2>
      {target ? <ul aria-label="Target for this meal" className="m-0 mt-1 flex list-none flex-wrap gap-1 p-0">
        {CHIPS.map(({ key, unit, label: name, spoken, ink }) => <li key={key}
          className="plan-chip inline-flex h-6 shrink-0 items-center gap-0.5 px-1.5 text-tiny tabular-nums text-muted">
          <span className="sr-only">{Math.round(target[key])} {spoken}</span>
          <span aria-hidden="true" className={`font-semibold ${ink}`}>{Math.round(target[key])}{unit}</span>
          <span aria-hidden="true" className={unit ? "text-overline tracking-[0.08em]" : undefined}>{name}</span>
        </li>)}
      </ul> : <p className="m-0 text-tiny text-muted">Your targets will appear after your profile is ready</p>}
    </div>
  </div>;
}
