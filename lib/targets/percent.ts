/** Pure conversion and floor helpers. The active revision supplies the authoritative floor values. */
import type { Macros } from "@/lib/types";

export const KCAL_MIN = 1650;
export const FAT_G_MIN = 50;
export const CARB_G_MIN = 100;
export const KCAL_PER_G_PROTEIN = 4;
export const KCAL_PER_G_FAT = 9;
export const KCAL_PER_G_CARB = 4;
export const PCT_SUM = 100;
export const PCT_DECIMALS = 2;

export type MacroPercents = { proteinPct: number; fatPct: number; carbPct: number };
export type GramTargets = { proteinG: number; fatG: number; carbG: number };
export type MacroFloors = { kcalMin: number; proteinGMin: number; fatGMin: number; carbGMin: number };

const round2 = (n: number) => Math.round(n * 10 ** PCT_DECIMALS) / 10 ** PCT_DECIMALS;
const ceil2 = (n: number) => Math.ceil(n * 10 ** PCT_DECIMALS) / 10 ** PCT_DECIMALS;

/** §3.4: grams = kcal × pct ÷ 100 ÷ factor; protein and fat to the nearest gram, carbs the
 *  remainder, so the set reconstructs the calorie target within ±10 kcal. */
export function percentToGrams(kcal: number, pct: MacroPercents): GramTargets {
  const proteinG = Math.round((kcal * pct.proteinPct) / 100 / KCAL_PER_G_PROTEIN);
  const fatG = Math.round((kcal * pct.fatPct) / 100 / KCAL_PER_G_FAT);
  const carbG = Math.round(
    (kcal - KCAL_PER_G_PROTEIN * proteinG - KCAL_PER_G_FAT * fatG) / KCAL_PER_G_CARB);
  return { proteinG, fatG, carbG };
}

/**
 * §3.4's six numbered steps, in this order and no other:
 * (1) protein to its floor; (2) fat to its floor; (3) carbs are the floored remainder;
 * (4) kcal_required; (5) if it exceeds the day's calories, RAISE the calories — never cut protein
 * or fat to fit a number; (6) kcal is at least kcal_min.
 * `raisedToFloor` reports step 5 only, which is what `ProposedTargets.raisedToFloor` means.
 */
export function applyFloors(
  kcal: number, grams: GramTargets, floors: MacroFloors,
): { kcal: number; grams: GramTargets; raisedToFloor: boolean } {
  const proteinG = Math.max(grams.proteinG, floors.proteinGMin);
  const fatG = Math.max(grams.fatG, floors.fatGMin);
  // Step 3 floors the remainder in grams; step 4 checks it before the display rounding so a
  // half-gram of carbs cannot masquerade as a step-5 calorie raise.
  const carbExact = Math.max(floors.carbGMin, (
    kcal - KCAL_PER_G_PROTEIN * proteinG - KCAL_PER_G_FAT * fatG) / KCAL_PER_G_CARB);
  const carbG = Math.round(carbExact);
  const kcalRequired = KCAL_PER_G_PROTEIN * proteinG + KCAL_PER_G_FAT * fatG + KCAL_PER_G_CARB * carbExact;
  const raisedToFloor = kcalRequired > kcal;
  const afterStep5 = raisedToFloor ? kcalRequired : kcal;
  return { kcal: Math.max(afterStep5, floors.kcalMin), grams: { proteinG, fatG, carbG }, raisedToFloor };
}

/** §3.4: reject when, at either day type, a converted macro falls below its floor; the
 *  error names the minimum percentage that satisfies it. The smaller day type binds. */
export function validatePercentProfile(
  pct: MacroPercents, kcalTrain: number, kcalRest: number, floors: MacroFloors,
): { ok: true } | { ok: false; error: string; minProteinPct: number; minFatPct: number } {
  const binding = Math.min(kcalTrain, kcalRest);
  const minProteinPct = ceil2((floors.proteinGMin * KCAL_PER_G_PROTEIN * 100) / binding);
  const minFatPct = ceil2((floors.fatGMin * KCAL_PER_G_FAT * 100) / binding);
  const reject = (error: string) => ({ ok: false as const, error, minProteinPct, minFatPct });

  if (round2(pct.proteinPct + pct.fatPct + pct.carbPct) !== PCT_SUM) return reject("percent_sum");
  for (const kcal of [kcalTrain, kcalRest]) {
    const grams = percentToGrams(kcal, pct);
    if (grams.proteinG < floors.proteinGMin) return reject("protein_below_floor");
    if (grams.fatG < floors.fatGMin) return reject("fat_below_floor");
    if (grams.carbG < floors.carbGMin) return reject("carbs_below_floor");
  }
  return { ok: true };
}

/**
 * A stored profile carries ONE gram set plus two calorie numbers (§3.4's DDL), so protein and fat
 * are held across day types and carbohydrate carries the difference. Each day type then runs the
 * floor sequence on its own.
 */
export function resolveProfileMacros(
  profile: { kcalTrain: number; kcalRest: number; proteinG: number; fatG: number; carbG: number },
  floors: MacroFloors,
): { training: Macros; rest: Macros; raisedToFloor: boolean } {
  const day = (kcal: number, carbG: number): Macros & { raised: boolean } => {
    const out = applyFloors(kcal, { proteinG: profile.proteinG, fatG: profile.fatG, carbG }, floors);
    return { kcal: out.kcal, protein: out.grams.proteinG, carbs: out.grams.carbG,
      fat: out.grams.fatG, raised: out.raisedToFloor };
  };
  const training = day(profile.kcalTrain, profile.carbG);
  const restCarbs = Math.round(
    (profile.kcalRest - KCAL_PER_G_PROTEIN * profile.proteinG - KCAL_PER_G_FAT * profile.fatG)
    / KCAL_PER_G_CARB);
  const rest = day(profile.kcalRest, restCarbs);
  return {
    training: { kcal: training.kcal, protein: training.protein, carbs: training.carbs, fat: training.fat },
    rest: { kcal: rest.kcal, protein: rest.protein, carbs: rest.carbs, fat: rest.fat },
    raisedToFloor: training.raised || rest.raised,
  };
}
