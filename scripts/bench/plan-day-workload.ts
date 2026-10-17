/**
 * W107: the `planDay` workload the plan-day benchmark times (scripts/bench/plan-day.ts). Pure: no
 * Node API, so the same code runs under Node and, bundled, inside a CPU-throttled Chromium page.
 *
 * The pool is an open food-world account's, built the way the phone builds it: a v3 snapshot from
 * the D4 admission over the whole bundled universe (tests/helpers/open-snapshot.ts, the builder the
 * W8 acceptance tests use), through JSON and the strict parse, into `openWorldInputs`, plus N
 * Favored foods taken in order from the bundled USDA list (lib/food-db.json). No account data, and
 * nothing here changes `lib/meals/day.ts` or `plate.ts`: it only calls them.
 */
import type { Food } from "@/lib/foods";
import { FOOD_DB } from "@/lib/food-db";
import { inferFoodRole } from "@/lib/foods/role";
import { planDay, type DaySlot } from "@/lib/meals/day";
import { livePool } from "@/lib/meals/open-world";
import { sizePlateStats } from "@/lib/meals/size";
import { device, inputsFor, openSnapshot, overTheWire, type OwnFood } from "@/tests/helpers/open-snapshot";

/** 2,000 kcal and 140 g protein over 4 meals (the W8 acceptance day). */
const FOUR: DaySlot[] = ["08:00", "12:30", "15:30", "19:00"].map((clock, i) => ({
  id: `meal-${i + 1}` as DaySlot["id"], clock, target: { kcal: 500, protein: 35, carbs: 52.5, fat: 16.7 } }));
/** 2,400 kcal and 160 g protein over 6 meals (the W8 acceptance 5 day). */
const SIX: DaySlot[] = ["07:30", "10:00", "12:30", "15:30", "18:30", "21:00"].map((clock, i) => ({
  id: `meal-${i + 1}` as DaySlot["id"], clock, target: { kcal: 400, protein: 26.7, carbs: 42, fat: 13.3 } }));

export const SLOT_SETS = { 4: FOUR, 6: SIX } as const;
export type SlotCount = keyof typeof SLOT_SETS;

/** Food-db categories a person plausibly marks Favored; drinks, sweets and supplements are left out. */
const FAVORABLE = new Set(["protein", "dairy", "fat", "carb", "meal", "vegetable", "fruit"]);

/** The first `count` Favored foods, deterministic, with uuid-shaped ids and their refs. */
export function favoredFoods(count: number): OwnFood[] {
  const source = FOOD_DB.filter((food) => FAVORABLE.has(food.category));
  if (count > source.length) throw new Error(`at most ${source.length} Favored foods`);
  return source.slice(0, count).map((db, i) => {
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    const per = db.per100g;
    const food: Food = { id, name: db.name, role: inferFoodRole(db.name, per), unit: "g",
      perUnit: { protein: per.protein / 100, carbs: per.carbs / 100, fat: per.fat / 100 },
      kcalPerUnit: per.kcal / 100, status: "eats", updatedAt: "2026-10-01" };
    return { food, userRefId: `ref-${id}` };
  });
}

export type CaseResult = {
  favored: number;
  slots: SlotCount;
  /** Admitted pool size the search saw. */
  pool: number;
  /** One-off phone cost before any day: JSON parse of the body and `openWorldInputs`. */
  prepareMs: number;
  /** Snapshot body size for this pool, UTF-8 JSON bytes. */
  bodyBytes: number;
  /** One `planDay` per date, in milliseconds. */
  times: number[];
  /** The most `sizePlate` calls any one day made (W8 bound: 20,000). */
  maxSizePlate: number;
  /** Days that left a slot without a plate. */
  shortDays: number;
};

const START = Date.parse("2026-10-06T00:00:00Z");

/** Times `planDay` over `dates` consecutive dates after `warmup` untimed ones. */
export function runCase(favored: number, slots: SlotCount, dates: number, warmup = 5): CaseResult {
  const own = favoredFoods(favored);
  const body = JSON.stringify(openSnapshot({ favored: own }));
  const prepStarted = performance.now();
  const open = inputsFor(overTheWire(JSON.parse(body)), own);
  const pool = livePool(open, device(own).foods);
  const prepareMs = performance.now() - prepStarted;
  const day = SLOT_SETS[slots];
  const dateOf = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < warmup; i += 1) planDay(dateOf(1000 + i), day, pool, undefined, open.evidence, open.taste, open.ranking);
  const times: number[] = [];
  let maxSizePlate = 0;
  let shortDays = 0;
  for (let i = 0; i < dates; i += 1) {
    sizePlateStats.calls = 0;
    const started = performance.now();
    const plan = planDay(dateOf(i), day, pool, undefined, open.evidence, open.taste, open.ranking);
    times.push(performance.now() - started);
    maxSizePlate = Math.max(maxSizePlate, sizePlateStats.calls);
    if (plan.shortages.length) shortDays += 1;
  }
  return { favored, slots, pool: Object.keys(pool).length, prepareMs, bodyBytes: new TextEncoder().encode(body).length,
    times, maxSizePlate, shortDays };
}

export type BenchOptions = { favored: number[]; slots: SlotCount[]; dates: number; warmup?: number };

export function runBench(options: BenchOptions): CaseResult[] {
  return options.favored.flatMap((favored) => options.slots.map((slots) =>
    runCase(favored, slots, options.dates, options.warmup)));
}
