/**
 * What the Plan panel shows after a photo of a plate or a menu. The model's numbers and words are
 * untrusted: every field is re-bounded here before it reaches the phone, names pass the same food
 * vocabulary screen as the inspire foods (lib/plan/inspire-types.ts), and a menu tip is display
 * text only, never sent on to the coach. Pure, no I/O.
 */
import { dishTitle, foodName } from "@/lib/plan/inspire-types";
import type { Macros } from "@/lib/types";

export type PlateItem = { name: string; grams: number };
export type PlateEstimate = Macros & { title: string | null; items: PlateItem[] };

export type MenuPick = Macros & {
  name: string;
  /** One short ordering tip ("dressing on the side"), or null. */
  tip: string | null;
  /** The account's rules could not clear this dish: what to ask the server about. Never "safe". */
  check: string | null;
};

export const MAX_PLATE_ITEMS = 8;
export const MAX_MENU_PICKS = 3;

/** ½×, 1×, 1½×: the plate as photographed, scaled. */
export const PORTIONS = [
  { factor: 0.5, label: "½×" }, { factor: 1, label: "1×" }, { factor: 1.5, label: "1½×" },
] as const;

const clamp = (value: unknown, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;

type RawMacros = { kcal?: unknown; protein?: unknown; carbs?: unknown; fat?: unknown };

function macros(raw: RawMacros): Macros {
  return { kcal: clamp(raw.kcal, 4000), protein: clamp(raw.protein, 300),
    carbs: clamp(raw.carbs, 500), fat: clamp(raw.fat, 300) };
}

export function scaleMacros(m: Macros, factor: number): Macros {
  return { kcal: Math.round(m.kcal * factor), protein: Math.round(m.protein * factor),
    carbs: Math.round(m.carbs * factor), fat: Math.round(m.fat * factor) };
}

/** A plate estimate, bounded; null when nothing on it reads as food. */
export function cleanPlate(raw: (RawMacros & { title?: string | null;
  items?: { name: string; grams: number }[] }) | null | undefined): PlateEstimate | null {
  if (!raw) return null;
  const items: PlateItem[] = [];
  for (const item of raw.items ?? []) {
    const name = foodName(item.name);
    const grams = clamp(item.grams, 2000);
    if (name && grams > 0 && !items.some((kept) => kept.name.toLowerCase() === name.toLowerCase())) {
      items.push({ name, grams });
    }
    if (items.length === MAX_PLATE_ITEMS) break;
  }
  const totals = macros(raw);
  if (items.length === 0 || totals.kcal === 0) return null;
  return { title: dishTitle(raw.title), items, ...totals };
}

/** Words a tip never needs and a planted instruction does, checked as letters-only substrings. */
const TIP_REFUSED = ["ignore", "instruction", "previous", "system", "prompt", "assistant", "disregard",
  "override", "target", "allerg", "safe"];

/**
 * A short ordering tip from a menu read, or null: plain words, at most 80 characters and 14 words.
 * It may not talk about the model, targets or allergens (those claims are the app's, not the
 * menu's), and it may never call a dish safe.
 */
export function cleanTip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.normalize("NFKC").replace(/[^\p{L}\p{N} '&,.()-]/gu, " ").replace(/\s+/g, " ").trim();
  if (text.length < 4 || text.length > 80 || text.split(" ").length > 14) return null;
  const letters = text.toLowerCase().replace(/[^\p{L}]/gu, "");
  return TIP_REFUSED.some((word) => letters.includes(word)) ? null : text;
}

export type RawMenuItem = RawMacros & { name: string; tip?: string | null; ingredients?: string[] };

/** A menu dish with its screened name, ingredient names (for the rules) and bounded numbers. */
export type MenuCandidate = MenuPick & { ingredients: string[] };

export function cleanMenu(raw: readonly RawMenuItem[] | null | undefined): MenuCandidate[] {
  const out: MenuCandidate[] = [];
  for (const item of raw ?? []) {
    const name = dishTitle(item.name);
    const numbers = macros(item);
    if (!name || numbers.kcal === 0 || out.some((kept) => kept.name.toLowerCase() === name.toLowerCase())) continue;
    const ingredients = (item.ingredients ?? []).map(foodName).filter((n): n is string => n !== null).slice(0, 12);
    out.push({ name, ...numbers, tip: cleanTip(item.tip), check: null, ingredients });
  }
  return out;
}

/** The rules' verdict on one dish: blocked dishes go, an unclear one carries what to ask about. */
export type MenuVerdict = { blocked: boolean; check: string | null };

/**
 * The best three for the slot: blocked dishes removed, then nearest the slot's kcal (protein
 * breaks a tie). With no target the menu's own order stands.
 */
export function pickFromMenu(candidates: readonly MenuCandidate[], targetKcal: number | undefined,
  verdict: (dish: MenuCandidate) => MenuVerdict): MenuPick[] {
  const kept = candidates.map((dish) => ({ dish, judged: verdict(dish) }))
    .filter(({ judged }) => !judged.blocked);
  const ranked = targetKcal ? [...kept].sort((a, b) =>
    Math.abs(a.dish.kcal - targetKcal) - Math.abs(b.dish.kcal - targetKcal)
    || b.dish.protein - a.dish.protein) : kept;
  return ranked.slice(0, MAX_MENU_PICKS).map(({ dish, judged }) => ({
    name: dish.name, kcal: dish.kcal, protein: dish.protein, carbs: dish.carbs, fat: dish.fat,
    tip: dish.tip, check: judged.check,
  }));
}
