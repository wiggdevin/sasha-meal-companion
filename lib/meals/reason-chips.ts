/**
 * The reason chips a generated open-world meal, swap row or composed card may carry (Phase 18 W8,
 * W099): why it was offered, never a verdict and never an instruction to eat. Dependency-free so a
 * phone component can name them without pulling the open-world builder into its bundle.
 */
import type { Meal } from "@/lib/types";

export type MealReasonChip = NonNullable<Meal["reasons"]>[number];
export const REASON_CHIPS: readonly MealReasonChip[] = ["eaten_often", "on_list"];
export const REASON_CHIP_COPY: Readonly<Record<MealReasonChip, string>> = {
  eaten_often: "You eat this often",
  on_list: "Favorite",
};

/** Known chips only, once each, in chip order: anything else a stored row carries is dropped. */
export function shownReasonChips(reasons: readonly unknown[] | null | undefined): MealReasonChip[] {
  if (!reasons?.length) return [];
  const held = new Set(reasons);
  return REASON_CHIPS.filter((chip) => held.has(chip));
}
