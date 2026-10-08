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
import type { Food } from "@/lib/foods";
import {
  filterPlates, isShaped, lightTarget, onHandPlates, placeableRef, weighPlates, type PlateFilter,
  type ShapedPlates,
} from "@/lib/coach/suggest-shape";
import { NO_QUICK_MESSAGE } from "@/lib/plan/chips";
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
type UniverseRefs = Readonly<Record<string, { foodRefId: string; catalogFoodRevisionId: number }>>;

const isUniverseRow = (id: string) => id.startsWith("universe:");
/** One ref call per chip, inside lib/server/universe-refs.ts's own per-call limit. */
const UNIVERSE_REF_BATCH = 60;

function plateToComposedMeal(
  plate: Plate, poolRefs: Readonly<Record<string, string>>, universeRefs: UniverseRefs, target: MealMacros,
  wish: string, slot: string | null, mealType: ComposedMeal["mealType"], mealClock: string | null,
): ComposedMeal {
  const items: ComposedItem[] = plate.rows.map((row) => {
    const grams = row.qty * (accountUnitGrams(row.food) ?? 1);
    const macros = row.component.macros;
    // A pool-filled row's `Food.id` is an account-food id or a universe pool id, neither a
    // `food_refs.id` a logged/slotted/saved item needs — `poolRefs` resolves the real one for an
    // account food, `universeRefs` the catalog ref and active revision for a universe row (a plate
    // with an unresolved universe row never reaches here: `buildPoolCandidates` drops it).
    const universe = universeRefs[row.food.id];
    return {
      name: row.food.name, foodRefId: universe?.foodRefId ?? poolRefs[row.food.id] ?? row.food.id,
      catalogFoodRevisionId: universe?.catalogFoodRevisionId ?? null,
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
    // The account's own Favored rows only: an open pool stamps its universe rows `eats` so the
    // generator takes them, but they are not on the person's list ("from your Favorites" copy).
    allItemsOnEats: plate.rows.every((row) => row.food.status === "eats" && !isUniverseRow(row.food.id)),
  };
}

/**
 * `rankPlates` over the admitted pool, best plate per anchor (`bestPerAnchor`, best score first —
 * the open account's taste term already ranks a Favored ingredient's plate ahead of an otherwise
 * identical one, W10 acceptance 7's same mechanism `lib/today/swap-alternatives.ts` relies on).
 */
/**
 * What the pool build reads: an open account's `openWorldInputs`, or (a Plan-sheet chip) a closed
 * account's currently eligible Eats with its v2 evidence and no open ranking (`ranking` absent:
 * the Phase 17 search, exactly what Today's closed layout runs).
 */
export type PoolInputs = Pick<OpenWorldInputs, "foods"> & {
  evidence?: OpenWorldInputs["evidence"];
  taste?: OpenWorldInputs["taste"];
  ranking?: OpenWorldInputs["ranking"];
};

export async function buildPoolCandidates<T extends SuggestPorts & MealClockPorts>(
  input: SuggestInput, ports: T, open: PoolInputs, requested: number, cap: number | null,
  signal: AbortSignal, abortable: <V>(promise: Promise<V>, signal: AbortSignal) => Promise<V>,
): Promise<CandidateBuild | typeof NOTHING_LEFT | typeof NO_TARGET> {
  const mealClock = await abortable(resolveMealClock(input.slot, ports, signal), signal);
  const mealType = mealTypeAt(mealClock, input.kind);
  const available = await abortable(ports.target(input), signal);
  if (available === null) return NO_TARGET;
  const snack = input.kind === "snack" ? snackTarget(available, cap) : null;
  if (snack === NOTHING_LEFT) return NOTHING_LEFT;
  const shaped = isShaped(input);
  // "Something light": the chip's own smaller target; protein stays (lib/coach/suggest-shape.ts).
  const target = shaped ? lightTarget(snack ?? available, input.sizeScale) : snack ?? available;
  const poolRefs = (await abortable(ports.poolRefs?.(ports.userId) ?? Promise.resolve({}), signal));
  const untimed = isUntimed(mealType, mealClock);
  // W11 (D7): an active shopping focus (the turn's day) ranks by (fits, coverage, score).
  const focus = await abortable(ports.focus?.(ports.userId) ?? Promise.resolve(undefined), signal);
  const rank = (foods: PoolInputs["foods"] | readonly Food[]) => rankPlates({
    date: input.date ?? todayUtc(), slot: input.slot ?? "", occasion: mealType, untimed, target,
    foods, evidence: open.evidence, taste: open.taste, ...(open.ranking ? { open: open.ranking } : {}),
    ...(focus ? { focus } : {}),
  }).plates;
  const wish = input.wish?.trim() || input.kind;
  if (!shaped) {
    const ranked = bestPerAnchor(rank(open.foods)).slice(0, MAX_CANDIDATES);
    // One ref lookup for every universe row the shown plates hold; a plate with a row it could not
    // resolve is left out, so no card ever carries a pool id where an action needs a food ref.
    const universeIds = [...new Set(ranked.flatMap((plate) => plate.rows.map((row) => row.food.id)).filter(isUniverseRow))];
    const universeRefs: UniverseRefs = universeIds.length > 0 && ports.universeRefs
      ? await abortable(ports.universeRefs(ports.userId, universeIds), signal) : {};
    const best = ranked.filter((plate) => plate.rows.every((row) => !isUniverseRow(row.food.id) || universeRefs[row.food.id]));
    const candidates: SuggestionCandidate[] = best.map((plate, index) => ({
      meal: plateToComposedMeal(plate, poolRefs, universeRefs, target, wish, input.slot ?? null, mealType, mealClock),
      // `bestPerAnchor` already ranked these by the engine's own `plate.score` (macro fit × affinity
      // × pairing × variety × the account's taste term T, lib/meals/plate.ts). A pure macro
      // `fitScore` alone would drop that taste signal from every later sort (the shortlist cap,
      // the Jev payload's "fit" field, the formula-order fallback) — bounded here into the macro
      // fit itself so a Favored-leaning plate still ranks ahead of an equally-fitting one that
      // isn't, without letting taste alone override a real macro-fit difference.
      fit: tasteFit(plate, target),
      index,
      pairing: plate.pairing,
      // Acceptance 3: a universe pool id (`universe:<bundled id>`) is bundled catalog data, cheaply
      // provable generic. An account Favored row's own name might be the user's own custom text —
      // this builder cannot cheaply tell, so any plate holding one stays out of the Jev shortlist
      // entirely (it keeps its formula-order slot, `lib/coach/suggest.ts`).
      jevEligible: jevEligible(plate),
    }));
    return {
      candidates, requested, pendingSlots: undefined, hiddenUnverified: 0, interrupted: signal.aborted,
      openWorld: true,
    };
  }
  // A Plan-sheet chip (lib/plan/chips.ts): the on-hand pool, the chip's filters over every ranked
  // plate, THEN the best plate per anchor, then the chip's order.
  const foods = Object.values(open.foods);
  const filter: PlateFilter = { excludedAnchors: new Set(), noneQuick: false };
  // Universe foods have no account ref, and set_slot_meal needs a food_refs uuid. The universe ids
  // the ranked plates use, best plate first, resolve in ONE batched call (lib/server/universe-refs.ts
  // takes at most UNIVERSE_REF_LIMIT per call); the pool is then narrowed to placeable foods and
  // ranked again, so unplaceable plates never crowd out placeable ones in the per-anchor cut or
  // the cap. Without the port (or on its failure) every universe food drops.
  const universeIds = [...new Set(rank(open.foods).flatMap((plate) => plate.rows.map((row) => row.food.id))
    .filter(isUniverseRow))].slice(0, UNIVERSE_REF_BATCH);
  const universeRefs: UniverseRefs = universeIds.length && ports.universeRefs
    ? await abortable(ports.universeRefs(ports.userId, universeIds), signal).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") throw error;
      console.warn("[suggest] universe refs unavailable; universe cards dropped");
      return {};
    })
    : {};
  const ownRefs: Readonly<Record<string, string>> = poolRefs;
  const refOf = (id: string) => (isUniverseRow(id) ? universeRefs[id]?.foodRefId : ownRefs[id]);
  const placeableFoods = foods.filter((food) => placeableRef(refOf(food.id)));
  const placeable = (plate: Plate) => plate.rows.every((row) => placeableRef(refOf(row.food.id)));
  const ranked = (pool: readonly Food[]) =>
    bestPerAnchor(filterPlates(rank(pool.filter((food) => placeableRef(refOf(food.id)))), input, target, filter)
      .filter(placeable));
  const base: ShapedPlates = input.onHandOnly
    ? onHandPlates(placeableFoods, await abortable(ports.onHand?.(ports.userId) ?? Promise.resolve([]), signal), ranked)
    : { plates: ranked(placeableFoods) };
  const weighed = weighPlates(base.plates, input, filter,
    { occasion: mealType, evidence: open.evidence, taste: open.taste });
  const candidates: SuggestionCandidate[] = weighed.slice(0, MAX_CANDIDATES).flatMap(({ plate, weight }, index) => {
    const meal = plateToComposedMeal(plate, poolRefs, universeRefs, target,
      input.plateTitles ? plate.name : wish, input.slot ?? null, mealType, mealClock);
    // Belt and braces: `placeable` already kept only plates whose every item resolves.
    if (!meal.items.every((item) => placeableRef(item.foodRefId))) return [];
    const source = base.sources?.get(plate.key);
    const minutes = filter.minutes?.get(plate.key);
    return [{
      meal: { ...meal, ideaId: plate.key, ...(source ? { sourceNote: source } : {}),
        ...(minutes !== undefined ? { prepMinutes: minutes } : {}) },
      fit: Math.min(1, tasteFit(plate, target) * weight),
      index, pairing: plate.pairing, jevEligible: jevEligible(plate),
    }];
  });
  const notice = (filter.noneQuick && candidates.length === 0 ? NO_QUICK_MESSAGE : undefined) ?? base.notice;
  return {
    candidates, requested, pendingSlots: undefined, hiddenUnverified: 0, interrupted: signal.aborted,
    openWorld: true, ...(notice ? { notice } : {}), ...(base.offer ? { offer: base.offer } : {}),
  };
}

function tasteFit(plate: Plate, target: MealMacros): number {
  return Math.min(1, fitScore(plate.macros, target) * Math.min(1.2, Math.max(0.7, plate.taste ?? 1)));
}

function jevEligible(plate: Plate): boolean {
  return plate.rows.every((row) => isUniverseRow(row.food.id));
}
