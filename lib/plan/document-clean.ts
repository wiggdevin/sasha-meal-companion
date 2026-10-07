/**
 * A document read, bounded and screened before anything else sees it, and the meal in it that
 * matches the slot the panel is open on. The model's words are untrusted: every name passes the
 * same food vocabulary screen as the photo reads (lib/plan/inspire-types.ts), an amount passes its
 * own narrow screen, and a clock time is re-parsed. Pure, no I/O.
 */
import type { DocumentReadOutput } from "@/lib/ai/document";
import type { DocumentDay, DocumentFood, DocumentMeal } from "@/lib/plan/document-types";
import { dishTitle, foodName } from "@/lib/plan/inspire-types";
import { occasionAt } from "@/lib/meals/occasion";

export const MAX_DOC_DAYS = 7;
export const MAX_DOC_MEALS = 8;
export const MAX_DOC_FOODS = 12;

/** An amount as written ("150 g", "1 ½ cups", "2"), or null: digits, fractions and unit words only. */
export function cleanAmount(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.normalize("NFKC").replace(/[^\p{L}\p{N} .,/½¼¾⅓⅔-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > 24 || text.split(" ").length > 4 || !/\d|½|¼|¾|⅓|⅔/.test(text)) return null;
  return text;
}

/** "7:30", "7:30 am", "1 pm", "13:00" as "HH:MM", or null. */
export function clockOf(raw: string | null | undefined): string | null {
  const m = raw?.trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const half = m[3]?.[0];
  if (half && (hour < 1 || hour > 12)) return null;
  if (half === "p" && hour < 12) hour += 12;
  if (half === "a" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cleanFoods(raw: readonly { name: string; amount: string | null }[]): DocumentFood[] {
  const out: DocumentFood[] = [];
  for (const item of raw) {
    const name = foodName(item.name);
    if (name) out.push({ name, amount: cleanAmount(item.amount) });
    if (out.length === MAX_DOC_FOODS) break;
  }
  return out;
}

/** The days and meals a meal-plan read named, screened; days or meals with nothing usable go. */
export function cleanDays(raw: DocumentReadOutput["days"]): DocumentDay[] {
  const days: DocumentDay[] = [];
  for (const [index, day] of raw.entries()) {
    const meals: DocumentMeal[] = day.meals.slice(0, MAX_DOC_MEALS).flatMap((meal, at) => {
      const foods = cleanFoods(meal.foods);
      return foods.length ? [{ name: dishTitle(meal.name) ?? `Meal ${at + 1}`, time: clockOf(meal.time), foods }] : [];
    });
    if (meals.length) days.push({ label: dishTitle(day.label) ?? `Day ${index + 1}`, meals });
    if (days.length === MAX_DOC_DAYS) break;
  }
  return days;
}

/** A recipe's ingredients with amounts, screened. */
export function cleanRecipeIngredients(raw: DocumentReadOutput["ingredients"]): DocumentFood[] {
  return cleanFoods(raw);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** The meal-time word for a slot clock, so "Lunch" can match a 12:30 slot (lib/meals/occasion.ts). */
function periodWords(slotTime: string): RegExp | null {
  const occasion = occasionAt(slotTime);
  if (occasion === "breakfast") return /\bbreakfast\b/i;
  if (occasion === "lunch") return /\blunch\b/i;
  if (occasion === "dinner") return /\b(dinner|supper)\b/i;
  return null;
}

/**
 * The meal for this slot: on the day named for the date's weekday (else the first day), the meal
 * named "Meal N" for slot meal-N, else the one timed within 90 minutes of the slot, else the one
 * named for the slot's time of day, else the Nth meal. Null when none fits; never a guess beyond these.
 */
export function matchMeal(days: readonly DocumentDay[], at: { slot: string; slotTime: string; localDate: string }):
  { day: number; meal: number } | null {
  if (days.length === 0) return null;
  const weekday = WEEKDAYS[new Date(`${at.localDate}T12:00:00Z`).getUTCDay()];
  const named = days.findIndex((day) => day.label.toLowerCase().includes(weekday));
  const day = named >= 0 ? named : 0;
  const meals = days[day].meals;
  const n = at.slot.match(/^meal-(\d)$/)?.[1];
  const find = (test: (meal: DocumentMeal) => boolean) => meals.findIndex(test);
  let meal = n ? find((m) => new RegExp(`\\bmeal\\s*${n}\\b`, "i").test(m.name)) : -1;
  if (meal < 0) {
    const slotAt = minutes(at.slotTime);
    const timed = meals.map((m, i) => ({ i, gap: m.time ? Math.abs(minutes(m.time) - slotAt) : Infinity }))
      .filter((m) => m.gap <= 90).sort((a, b) => a.gap - b.gap);
    meal = timed[0]?.i ?? -1;
  }
  const period = periodWords(at.slotTime);
  if (meal < 0 && period) meal = find((m) => period.test(m.name));
  if (meal < 0 && n && Number(n) <= meals.length) meal = Number(n) - 1;
  return meal >= 0 ? { day, meal } : null;
}

/** How an amount reads: a weight in grams, a count of household portions, or a measure word. */
export type ParsedAmount = { grams: number } | { count: number } | { measure: string; count: number };

const FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
/** Weight unit words (the whole word) and their grams. */
const WEIGHTS: [string, number][] = [
  ["g|gr|gram|grams", 1], ["kg|kilo|kilos|kilogram|kilograms", 1000],
  ["oz|ounce|ounces", 28.35], ["lb|lbs|pound|pounds", 453.6],
];
/** Household measure words (the whole word) and the measure they name. */
const MEASURES: [string, string][] = [
  ["cups?", "cup"], ["tbsps?|tablespoons?|tbs", "tbsp"], ["tsps?|teaspoons?", "tsp"],
  ["ml|millilitres?|milliliters?", "ml"], ["l|litres?|liters?", "l"], ["scoops?", "scoop"],
  ["handfuls?", "handful"], ["slices?", "slice"], ["pieces?", "piece"],
];
const whole = (words: string) => new RegExp(`^(?:${words})$`);

/** A unit word that is a weight ("g", "oz", "lb"), so a portion labelled with it is a weight. */
export function isWeightUnit(word: string): boolean {
  return WEIGHTS.some(([words]) => whole(words).test(word.toLowerCase()));
}

/**
 * Whether a catalog portion label is in this measure, as a whole word: "1 l" is litres, but
 * "1 large", "1 lb" and "1 loaf" are not, and "1 cupcake" is not a cup.
 */
export function labelHasMeasure(label: string, measure: string): boolean {
  const words = MEASURES.find(([, name]) => name === measure)?.[0];
  if (!words) return false;
  return new RegExp(`\\b(?:${words})\\b`, "i").test(label.toLowerCase().replace(/(\d)([a-z])/g, "$1 $2"));
}

/** A number as written: "1,500" is fifteen hundred, "1,5" and "1.5" are one and a half. */
function readNumber(text: string): number {
  return /^\d{1,3}(?:,\d{3})+$/.test(text) ? Number(text.replace(/,/g, "")) : Number(text.replace(",", "."));
}

/** "1 1/2", "1/2", "1½", "0.5", "1,500", "2" → a number, read from the front of the amount. */
function leadingNumber(text: string): { value: number; rest: string } | null {
  const slash = text.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)\s*(.*)$/);
  if (slash) {
    const denominator = Number(slash[3]);
    if (denominator === 0) return null;
    return { value: Number(slash[1] ?? 0) + Number(slash[2]) / denominator, rest: slash[4].trim() };
  }
  const m = text.match(/^(\d{1,3}(?:,\d{3})+(?![\d,.])|\d+(?:[.,]\d+)?)?\s*([½¼¾⅓⅔])?\s*(.*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  const value = m[1] ? readNumber(m[1]) : 0;
  return { value: value + (m[2] ? FRACTIONS[m[2]] : 0), rest: m[3].trim() };
}

/** The amount, parsed; null amount reads as one household portion, the set_slot_meal default. */
export function parseAmount(amount: string | null): ParsedAmount | null {
  if (!amount) return { count: 1 };
  const lead = leadingNumber(amount.toLowerCase().replace(/(\d)([a-z])/g, "$1 $2"));
  if (!lead || lead.value <= 0) return null;
  const unit = lead.rest.split(" ")[0] ?? "";
  const weight = WEIGHTS.find(([words]) => whole(words).test(unit));
  if (weight) return { grams: Math.round(lead.value * weight[1]) };
  const measure = MEASURES.find(([words]) => whole(words).test(unit));
  if (measure) return { measure: measure[1], count: lead.value };
  return lead.value <= 12 ? { count: lead.value } : null;
}
