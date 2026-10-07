/**
 * Floor checking for any proposed target change — architecture §3.4 "authored floors > approved
 * proposal > engine". Numbers are targets.md §3, transcribed, not recomputed: fat 50 g, protein
 * the active ramp value (115 / 125 / 135 g), kcal_min 1,650 (their lowest authored day).
 *
 * The coach never writes a target. This module exists so a suggestion that implies one is caught
 * and named before it reaches them.
 *
 * Pure. No I/O, no Supabase import.
 */

export type FloorTargets = {
  kcal_train: number; kcal_rest: number;
  protein_g: number | null; fat_g: number | null; carb_g: number | null;
  kcal_min: number; protein_g_min: number; fat_g_min: number; carb_g_min: number;
};

export const FAT_G_FLOOR = 50;
export const KCAL_MIN_FLOOR = 1650;
export const PROTEIN_G_FLOOR_BY_STAGE = { 1: 115, 2: 125, 3: 135 } as const;

/** The first violation, naming the floor, or null. Order is protein, fat, carbs, then calories. */
export function violatesFloors(proposed: Partial<FloorTargets>, active: FloorTargets): string | null {
  const proteinMin = Math.max(active.protein_g_min, 0);
  const fatMin = Math.max(active.fat_g_min, FAT_G_FLOOR);
  const kcalMin = Math.max(active.kcal_min, KCAL_MIN_FLOOR);

  if (proposed.protein_g != null && proposed.protein_g < proteinMin) {
    return `protein_g ${proposed.protein_g} is below the floor of ${proteinMin} g`;
  }
  if (proposed.fat_g != null && proposed.fat_g < fatMin) {
    return `fat_g ${proposed.fat_g} is below the floor of ${fatMin} g`;
  }
  if (proposed.carb_g != null && proposed.carb_g < active.carb_g_min) {
    return `carb_g ${proposed.carb_g} is below the floor of ${active.carb_g_min} g`;
  }
  if (proposed.kcal_train != null && proposed.kcal_train < kcalMin) {
    return `kcal_train ${proposed.kcal_train} is below the floor of ${kcalMin} kcal`;
  }
  if (proposed.kcal_rest != null && proposed.kcal_rest < kcalMin) {
    return `kcal_rest ${proposed.kcal_rest} is below the floor of ${kcalMin} kcal`;
  }
  return null;
}
