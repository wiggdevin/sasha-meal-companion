/**
 * Suggestion candidates for an open food-world account (Phase 18 W10): `rankPlates`' best plate
 * per anchor over the SAME admitted pool the layout and the swap sheet read
 * (`lib/meals/open-world.ts`'s `openWorldInputs`, D11's one fresh admission read). Split out of
 * `lib/coach/suggest-candidates.ts` so that file's closed-world (Eats-anchor) search stays
 * unchanged: an account with 0 Favored foods has nothing on that search, but a nonempty admitted
 * pool (D1, universe items included) still has plates to offer (W10 acceptance 1).
 *
 * A pool-filled row is already admitted — the fresh read that built `open` already ran every
 * policy check (D4) — so every item here carries `verdict: "allowed"` without a second check,
 * exactly as `lib/coach/compose-pinned.ts`'s own pool-filled branch and
 * `lib/today/swap-alternatives.ts` already do for the same pool. Callers skip the Eats-era
 * allergen/evidence recheck (`lib/coach/suggest-policy.ts`) for these candidates for the same
 * reason (`lib/coach/suggest.ts`, `CandidateBuild.openWorld`).
 *
 * Port-driven and otherwise pure: no I/O, no Supabase import.
 */
import { per100gOf } from "@/lib/coach/compose-pinned";
import { itemFoodKey, sum, type ComposedItem, type ComposedMeal } from "@/lib/coach/compose";
import { fitNote, fitsTarget, NOTHING_LEFT, snackTarget, type MealMacros } from "@/lib/coach/compose-size";
import type { MealClockPorts } from "@/lib/coach/meal-type";
import { isUntimed, mealTypeAt, resolveMealClock } from "@/lib/coach/meal-type";
import type { SuggestInput } from "@/lib/coach/executors";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import type { OpenWorldInputs } from "@/lib/meals/open-world";
import { bestPerAnchor, rankPlates, type Plate } from "@/lib/meals/plate";
// A deferred, function-body-only circular import: `suggest-candidates.ts` calls
// `buildPoolCandidates` below, and this module reads `fitScore`/`NO_TARGET`/`CandidateBuild` from
// it — never at module top level on either side, so both modules finish initializing first.
import {
  fitScore, NO_TARGET, type CandidateBuild, type SuggestionCandidate,
} from "@/lib/coach/suggest-candidates";
import type { SuggestPorts } from "@/lib/coach/suggest";

/** The same cap `suggest-candidates.ts` keeps on its own Eats-anchor search. */
const MAX_CANDIDATES = 12;

/** Today, in the server's own clock — a suggestion run's rotation only, never a stored date
 *  (the same fallback `lib/coach/compose-pinned.ts` uses for a direct wish). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One admitted plate (already sized and policy-clean) as a suggestion card. */
function plateToComposedMeal(
  plate: Plate, poolRefs: Readonly<Record<string, string>>, target: MealMacros,
  wish: string, slot: string | null, mealType: ComposedMeal["mealType"], mealClock: string | null,
): ComposedMeal {
  const items: ComposedItem[] = plate.rows.map((row) => {
    const grams = row.qty * (accountUnitGrams(row.food) ?? 1);
    const macros = row.component.macros;
    // A pool-filled row's `Food.id` is an account-food id or a universe pool id, neither a
    // `food_refs.id` a logged/slotted/saved item needs — `poolRefs` resolves the real one for an
    // account food; a universe-sourced fill keeps the pool id as a last resort (the same
    // documented gap `compose-pinned.ts` carries, dark behind `OPEN_WORLD_ENABLED`).
    return {
      name: row.food.name, foodRefId: poolRefs[row.food.id] ?? row.food.id, catalogFoodRevisionId: null,
      grams, ...per100gOf(row.food), macros, verdict: "allowed" as const, part: row.part,
      ...itemFoodKey({ foodKey: row.component.foodKey }),
    };
  });
  const totals = sum(items);
  const fits = fitsTarget(totals, target);
  return {
    wish, slot, items, totals, target, flagged: [],
    fitsTarget: fits, fitNote: fits ? null : fitNote(totals, target),
    mealType, mealClock,
    allItemsOnEats: plate.rows.every((row) => row.food.status === "eats"),
  };
}

/**
 * `rankPlates` over the admitted pool, best plate per anchor (`bestPerAnchor`, best score first —
 * the open account's taste term already ranks a Favored ingredient's plate ahead of an otherwise
 * identical one, W10 acceptance 7's same mechanism `lib/today/swap-alternatives.ts` relies on).
 */
export async function buildPoolCandidates<T extends SuggestPorts & MealClockPorts>(
  input: SuggestInput, ports: T, open: OpenWorldInputs, requested: number, cap: number | null,
  signal: AbortSignal, abortable: <V>(promise: Promise<V>, signal: AbortSignal) => Promise<V>,
): Promise<CandidateBuild | typeof NOTHING_LEFT | typeof NO_TARGET> {
  const mealClock = await abortable(resolveMealClock(input.slot, ports, signal), signal);
  const mealType = mealTypeAt(mealClock, input.kind);
  const available = await abortable(ports.target(input), signal);
  if (available === null) return NO_TARGET;
  const snack = input.kind === "snack" ? snackTarget(available, cap) : null;
  if (snack === NOTHING_LEFT) return NOTHING_LEFT;
  const target = snack ?? available;
  const poolRefs = (await abortable(ports.poolRefs?.(ports.userId) ?? Promise.resolve({}), signal));
  const untimed = isUntimed(mealType, mealClock);
  const { plates } = rankPlates({
    date: todayUtc(), slot: input.slot ?? "", occasion: mealType, untimed, target,
    foods: open.foods, evidence: open.evidence, taste: open.taste, open: open.ranking,
  });
  const wish = input.wish?.trim() || input.kind;
  const best = bestPerAnchor(plates).slice(0, MAX_CANDIDATES);
  const candidates: SuggestionCandidate[] = best.map((plate, index) => ({
    meal: plateToComposedMeal(plate, poolRefs, target, wish, input.slot ?? null, mealType, mealClock),
    fit: fitScore(plate.macros, target),
    index,
    pairing: plate.pairing,
  }));
  return {
    candidates, requested, pendingSlots: undefined, hiddenUnverified: 0, interrupted: signal.aborted,
    openWorld: true,
  };
}
