/**
 * Floor checking for any proposed target change — architecture §3.4 "authored floors > approved
 * proposal > engine". Every floor is the account's own, read from its active revision
 * (`kcal_min`, `protein_g_min`, `fat_g_min`, `carb_g_min`). No first-client number is a default
 * (audit 2026-10-10 W008: the old first-client calorie and protein constants are gone).
 *
 * The calorie floor is the revision's `kcal_min`, never below that revision's own macro minimum
 * (4·protein + 9·fat + 4·carbs minimums). Fat keeps the product-wide 50 g floor every derived
 * revision uses (lib/profile/derive.ts).
 *
 * The coach never writes a target. This module exists so a suggestion that implies one is caught
 * and named before it reaches them.
 *
 * Pure. No I/O, no Supabase import.
 */
import { macroMinimumKcal } from "@/lib/profile/rate-goal";

export type FloorTargets = {
  kcal_train: number; kcal_rest: number;
  protein_g: number | null; fat_g: number | null; carb_g: number | null;
  kcal_min: number; protein_g_min: number; fat_g_min: number; carb_g_min: number;
};

export const FAT_G_FLOOR = 50;

/** A stored minimum: a finite number ≥ 0, else no recorded minimum (0), never a pass. */
const minimum = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** The first violation, naming the floor, or null. Order is protein, fat, carbs, then calories. */
export function violatesFloors(proposed: Partial<FloorTargets>, active: FloorTargets): string | null {
  const proteinMin = minimum(active.protein_g_min);
  const fatMin = Math.max(minimum(active.fat_g_min), FAT_G_FLOOR);
  const carbMin = minimum(active.carb_g_min);
  const kcalMin = Math.max(minimum(active.kcal_min),
    macroMinimumKcal({ proteinGMin: proteinMin, fatGMin: fatMin, carbGMin: carbMin }));

  if (proposed.protein_g != null && proposed.protein_g < proteinMin) {
    return `protein_g ${proposed.protein_g} is below the floor of ${proteinMin} g`;
  }
  if (proposed.fat_g != null && proposed.fat_g < fatMin) {
    return `fat_g ${proposed.fat_g} is below the floor of ${fatMin} g`;
  }
  if (proposed.carb_g != null && proposed.carb_g < carbMin) {
    return `carb_g ${proposed.carb_g} is below the floor of ${carbMin} g`;
  }
  if (proposed.kcal_train != null && proposed.kcal_train < kcalMin) {
    return `kcal_train ${proposed.kcal_train} is below the floor of ${kcalMin} kcal`;
  }
  if (proposed.kcal_rest != null && proposed.kcal_rest < kcalMin) {
    return `kcal_rest ${proposed.kcal_rest} is below the floor of ${kcalMin} kcal`;
  }
  return null;
}
