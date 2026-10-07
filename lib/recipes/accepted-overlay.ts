import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { FoodComponent, Macros, SlotId, Store, StoredDay } from "@/lib/types";

const macroKeys = ["kcal", "protein", "carbs", "fat"] as const;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function baselineMutationId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as { mutationId?: unknown }).mutationId;
  return typeof id === "string" ? id : null;
}
/** Projection-only fields: never part of the captured slot, so a re-projection still matches. */
const PROJECTION_KEYS = ["ruleMark", "ruleMarkEpoch", "ruleMarkRulesKey", "ruleIngredients"] as const;
function withoutProjection<T extends object>(value: T): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of PROJECTION_KEYS) delete copy[key];
  return copy as T;
}
function foodOverride(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { time: _time, mutationId: _mutationId, ...food } = withoutProjection(value as Record<string, unknown>);
  void _time; void _mutationId;
  return food;
}

/** Read-only phone projection. The separate server selection survives old full-row sync writes. */
export function withAcceptedRecipeSelections(store: Store,
  selections: readonly AcceptedRecipeSelection[]): Store {
  const days = { ...store.days };
  for (const selection of selections) {
    const slot = selection.slotId as SlotId;
    if (!/^meal-[1-6]$/.test(slot)) continue;
    const values = macroKeys.map((key) => selection.nutritionSnapshot[key]?.value);
    if (values.some((value) => value === null || value === undefined || !Number.isFinite(value))) {
      continue; // Never display a missing macro as zero.
    }
    const macros = Object.fromEntries(macroKeys.map((key, index) => [key, values[index]])) as Macros;
    const original: StoredDay = days[selection.localDate] ?? { date: selection.localDate };
    // An eaten snapshot is historical fact. A new plan does not rewrite it.
    if (original.eaten?.[slot]) continue;
    const prior = original.itemOverrides?.[slot];
    // A new identical clear or swap-clear has new intent, even if its meal
    // content matches the captured pre-accept slot byte for byte.
    if (prior?.mutationId && prior.mutationId !== baselineMutationId(selection.baselineOverride)) {
      continue;
    }
    // A changed local replacement, clear, or swap wins. Only the exact
    // pre-accept slot captured in the selection can be reconciled here.
    if (original.swaps?.[slot] || (prior && !prior.followPlan)) {
      const sameMarkedIntent = prior?.mutationId
        && prior.mutationId === baselineMutationId(selection.baselineOverride);
      const captured = selection.acceptedAt
        && (sameMarkedIntent || !original.updatedAt
          || Date.parse(original.updatedAt) <= Date.parse(selection.acceptedAt))
        && canonical(original.swaps?.[slot] ?? null) === canonical(selection.baselineSwap ?? null)
        && canonical(foodOverride(prior ?? null))
          === canonical(foodOverride(selection.baselineOverride ?? null));
      if (!captured) continue;
    }
    const components: FoodComponent[] = [
      { name: selection.recipeName, qty: selection.servingFraction,
        unit: "whole", role: "free", macros },
    ];
    // The server's current-rules verdict rides on the projection (F2); a prior mark never does.
    const base = withoutProjection(prior ?? {});
    // Every ingredient name, so resolveDay can apply a live Avoid mark at once (F2, round 2).
    const ruleIngredients = Array.isArray(selection.ingredientSnapshot)
      ? selection.ingredientSnapshot.map((line) => line?.name)
        .filter((name): name is string => typeof name === "string") : undefined;
    days[selection.localDate] = { ...original, itemOverrides: {
      ...original.itemOverrides, [slot]: { ...base,
        baseMealId: `recipe:${selection.recipeRevisionId}`, title: selection.recipeName,
        components, followPlan: false, cleared: false, removed: false,
        ...(selection.ruleMark !== undefined ? { ruleMark: selection.ruleMark } : {}),
        ...(selection.ruleMarkEpoch !== undefined ? { ruleMarkEpoch: selection.ruleMarkEpoch } : {}),
        ...(selection.ruleMarkRulesKey !== undefined
          ? { ruleMarkRulesKey: selection.ruleMarkRulesKey } : {}),
        ...(ruleIngredients ? { ruleIngredients } : {}) },
    } };
  }
  return { ...store, days };
}
