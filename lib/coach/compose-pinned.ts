/**
 * The direct-wish rebuild (Phase 18 W9, D12, O4b): every named food is pinned into the SAME
 * plate search the daily layout uses (`rankPinnedPlates`), never a greedy fill of its own. Split
 * out of `lib/coach/compose.ts` to keep that file under the project's file-size budget — it is
 * `composeMeal`'s one DIRECT-wish branch, called from there and nowhere else.
 *
 * Port-driven and otherwise pure: no I/O, no Supabase import.
 */
import type { FoodHit } from "@/lib/coach/executors";
import { fitNote, fitsTarget, type MealMacros } from "@/lib/coach/compose-size";
import { itemFoodKey, isEatsRow, POUCH, sum, type ComposedItem, type ComposedMeal, type ComposePorts }
  from "@/lib/coach/compose";
import type { Verdict } from "@/lib/coach/policy";
import type { Food } from "@/lib/foods";
import { inferFoodRole } from "@/lib/foods/role";
import { accountUnitGrams } from "@/lib/foods/unit-grams";
import { macroKcal } from "@/lib/scaling";
import { rankPinnedPlates, SMALL_SNACK_KCAL, type PlateInput } from "@/lib/meals/plate";
import { partsOf } from "@/lib/meals/parts";
import { shownReasonChips, type MealReasonChip } from "@/lib/meals/reason-chips";
import { isUntimed, occasionAt, type Occasion } from "@/lib/meals/occasion";
import type { parseOccasionPhrase } from "@/lib/meals/occasion-phrase";

const ZERO_MACROS: MealMacros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

/** Today, in the server's own clock — a direct composition's rotation only, never a stored date. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A search hit as a plate-search `Food` (W9, D12): per-unit macros in whole grams, the same
 * shape the open-world universe pool's own food converter builds (its `universeFood` helper),
 * which already proves this shape works through the same engine for that pool. `role` falls
 * back to the hit's own macros when its name says nothing (never guesses fat for a food with no
 * readable nutrition).
 */
function hitToFood(hit: FoodHit): Food {
  const perUnit = {
    protein: (hit.proteinPer100g ?? 0) / 100, carbs: (hit.carbsPer100g ?? 0) / 100,
    fat: (hit.fatPer100g ?? 0) / 100,
  };
  const unknown = hit.kcalPer100g == null && hit.proteinPer100g == null
    && hit.carbsPer100g == null && hit.fatPer100g == null;
  // A catalog-only hit's own wire key survives as the pool `id`: `componentFoodKey` (lib/meals/
  // size.ts) reads a literal `catalog:<id>` id straight through, so a pool-filled plate row keeps
  // the SAME key the search hit carried (compose-food-key.test.ts). The account-row case needs no
  // such care: `hit.foodRefId` alone already reproduces `food:<uuid>` through that same function.
  const id = hit.foodKey?.startsWith("catalog:") ? hit.foodKey : hit.foodRefId as string;
  return {
    id, name: hit.name, role: inferFoodRole(hit.name, perUnit),
    unit: "g", perUnit, status: hit.prefStatus === "eats" ? "eats" : hit.prefStatus === "avoid" ? "avoid" : "neutral",
    updatedAt: "1970-01-01", ...(unknown ? { nutritionUnknown: true as const } : {}),
  };
}

/**
 * A pool-filled row's per-100 g rates, for the card's existing per-100g fields. Unknown stays
 * unknown. Exported (Phase 18 W10): `lib/coach/suggest-pool.ts` builds suggestion cards from the
 * same pool-filled rows and needs the same conversion.
 */
export function per100gOf(food: Food): Pick<ComposedItem, "kcalPer100g" | "proteinPer100g" | "carbsPer100g" | "fatPer100g"> {
  const gramsPerUnit = food.nutritionUnknown ? null : accountUnitGrams(food);
  if (!gramsPerUnit) return { kcalPer100g: null, proteinPer100g: null, carbsPer100g: null, fatPer100g: null };
  const scale = 100 / gramsPerUnit;
  return {
    kcalPer100g: macroKcal(food.perUnit) * scale, proteinPer100g: food.perUnit.protein * scale,
    carbsPer100g: food.perUnit.carbs * scale, fatPer100g: food.perUnit.fat * scale,
  };
}

/**
 * The pool a direct wish fills missing parts from, when the caller has not wired `ports.pool`
 * (W9's real server port — `coach-ports.ts`'s one fresh admission/`openWorldInputs` read). Every
 * name on the Eats list, resolved to the account's OWN row (`isEatsRow`, same test `pickComplement`
 * already used for a complement): a correct, if less efficient, default so an un-migrated or
 * minimal test caller still gets a working fill instead of a pool of nothing.
 */
async function defaultPool(userId: string, eats: readonly string[], ports: ComposePorts): Promise<Record<string, Food>> {
  const pool: Record<string, Food> = {};
  for (const name of eats) {
    const hits = await ports.searchFoods(userId, name, 1);
    const own = hits.find((hit) => isEatsRow(hit, name) && !POUCH.test(hit.name));
    if (own) { const food = hitToFood(own); pool[food.id] = food; }
  }
  return pool;
}

/**
 * `composeMeal`'s direct-wish branch: every named food is pinned into the SAME plate search the
 * daily layout uses (`rankPinnedPlates`). A pinned food still passes policy (never the shortlist
 * or coherence check) exactly as `chosen` already resolved it; a pool-filled side is already
 * admitted, so it reads `allowed` without a second check (precisely how `planMealsForDay` trusts
 * its pool, lib/foods/layout-plan.ts).
 */
export async function composeDirectPlate(
  userId: string,
  args: { wish: string; slot?: string | null; target: MealMacros; date?: string; slotClock?: string | null },
  occasionPhrase: ReturnType<typeof parseOccasionPhrase>,
  chosen: { hit: FoodHit; insteadOf?: string }[],
  eats: readonly string[],
  ports: ComposePorts,
  verdictOf: (hit: FoodHit) => Verdict["verdict"],
): Promise<ComposedMeal> {
  if (chosen.length === 0) {
    return { wish: args.wish, slot: args.slot ?? null, items: [], totals: ZERO_MACROS,
      target: args.target, flagged: [], fitsTarget: false, fitNote: null };
  }

  // A multi-word food ("peanut butter") splits into separate wish terms (`wishTerms` has no
  // phrase vocabulary, only a word cap), and each term is searched and resolved on its own —
  // without this, the SAME food pins twice under two different terms, which collides with
  // itself in `pinnedAssignments` (two rows wanting the one part it can play) and reports a
  // coherent plate as incomplete. One identity, one pin, first occurrence wins (`optioned`'s
  // own `selected` set already does the same thing for the suggestion-filler path).
  const pinnedById = new Map<string, { hit: FoodHit; insteadOf?: string }>();
  for (const entry of chosen) {
    const id = hitToFood(entry.hit).id;
    if (!pinnedById.has(id)) pinnedById.set(id, entry);
  }
  const pinned = [...pinnedById.values()].map(({ hit }) => hitToFood(hit));

  let occasion: Occasion = occasionPhrase.occasion
    ?? occasionAt(args.slotClock, { slot: args.slot ?? undefined });
  // An unscoped wish (no phrase, no slot, no clock) that names an explicit fruit-and-fat PAIR at
  // a snack-sized target reads as a snack (W9 re-plan, round 3): "apple with peanut butter" with
  // no stated meal is the anchorless template's own case, not a guess at "other". Narrower than
  // "names no anchor" (round 3 Sol finding): a lone starch like "oats" is not this case — it can
  // still take an anchor from the pool (below) — only a genuine fruit+fat pair infers snack. A
  // stated phrase, slot or clock always wins; this never overrides one.
  if (occasionPhrase.occasion === null && args.slotClock == null && !args.slot
    && args.target.kcal <= SMALL_SNACK_KCAL && pinned.length >= 2
    && pinned.every((food) => { const parts = partsOf(food); return parts.includes("fruit") || parts.includes("fat"); })
    && pinned.some((food) => partsOf(food).includes("fruit")) && pinned.some((food) => partsOf(food).includes("fat"))) {
    occasion = "snack";
  }
  const untimed = isUntimed(occasion, args.slotClock);

  const pool = ports.pool ? await ports.pool(userId) : await defaultPool(userId, eats, ports);
  const open = (await ports.openWorld?.(userId)) ?? null;
  const poolRefs = (await ports.poolRefs?.(userId)) ?? {};
  const date = args.date ?? todayUtc();
  // W11 (D7): an active shopping focus ranks the pinned plates by (fits, coverage, score).
  const focus = await ports.focus?.(userId, date);
  const input: PlateInput = {
    date, slot: args.slot ?? "", occasion, untimed, target: args.target,
    foods: open ? open.foods : pool,
    ...(open ? { evidence: open.evidence, taste: open.taste, open: open.ranking } : {}),
    ...(focus ? { focus } : {}),
  };
  const ranking = rankPinnedPlates(input, pinned);
  // W099: the same reason chips the daily layout and swap rows carry, from the open snapshot only.
  const reasonsOf = (ids: string[]): { reasons?: MealReasonChip[] } => {
    const reasons = open ? shownReasonChips(ids.flatMap((id) => open.chips[id] ?? [])) : [];
    return reasons.length ? { reasons } : {};
  };
  const best = ranking.plates[0];

  // Open pool rows that are universe items need the account's catalog ref before any card can log
  // or save them (lib/server/universe-refs.ts). One lookup, for the rows this plate holds only.
  const universeRows = best ? best.rows.map((row) => row.food.id)
    .filter((id) => !pinnedById.has(id) && id.startsWith("universe:")) : [];
  const universeRefs = universeRows.length > 0 && ports.universeRefs
    ? await ports.universeRefs(userId, universeRows) : {};
  const unresolved = universeRows.find((id) => !universeRefs[id]);

  if (!best || unresolved) {
    const items: ComposedItem[] = [...pinnedById.values()].map(({ hit, insteadOf }) => ({
      name: hit.name, foodRefId: hit.foodRefId as string,
      catalogFoodRevisionId: hit.catalogFoodRevisionId ?? null,
      grams: 0, kcalPer100g: hit.kcalPer100g, proteinPer100g: hit.proteinPer100g ?? null,
      carbsPer100g: hit.carbsPer100g ?? null, fatPer100g: hit.fatPer100g ?? null,
      macros: ZERO_MACROS, verdict: verdictOf(hit),
      ...(insteadOf ? { insteadOf } : {}), ...itemFoodKey(hit),
    }));
    return {
      wish: args.wish, slot: args.slot ?? null, items, totals: ZERO_MACROS, target: args.target,
      flagged: items.filter((item) => item.verdict === "blocked").map((item) => item.name),
      fitsTarget: false, fitNote: null,
      incomplete: { reason: !best ? ranking.shortage?.reason ?? "No coherent plate holds every named food"
        : `I couldn't look up ${best.rows.find((row) => row.food.id === unresolved)?.food.name ?? "one of the foods"} right now. Try again in a moment` },
      ...reasonsOf(pinned.map((food) => food.id)),
    };
  }

  const items: ComposedItem[] = best.rows.map((row) => {
    const grams = row.qty * (accountUnitGrams(row.food) ?? 1);
    const macros = row.component.macros;
    const named = pinnedById.get(row.food.id);
    if (named) {
      const { hit, insteadOf } = named;
      return {
        name: hit.name, foodRefId: hit.foodRefId as string,
        catalogFoodRevisionId: hit.catalogFoodRevisionId ?? null,
        grams, kcalPer100g: hit.kcalPer100g, proteinPer100g: hit.proteinPer100g ?? null,
        carbsPer100g: hit.carbsPer100g ?? null, fatPer100g: hit.fatPer100g ?? null,
        macros, verdict: verdictOf(hit),
        ...(insteadOf ? { insteadOf } : {}), ...itemFoodKey(hit), part: row.part,
      };
    }
    // A pool-filled row's `Food.id` is an account-food id (or a universe pool id), neither a
    // `food_refs.id` — the ONLY id a logged, slotted or saved item can use. `poolRefs` resolves
    // the real one for an account food; `universeRefs` (above) the catalog ref and active revision
    // for a universe row, and an unresolved universe row already returned the incomplete draft.
    const universe = universeRefs[row.food.id];
    return {
      name: row.food.name, foodRefId: universe?.foodRefId ?? poolRefs[row.food.id] ?? row.food.id,
      catalogFoodRevisionId: universe?.catalogFoodRevisionId ?? null,
      grams, ...per100gOf(row.food), macros, verdict: "allowed" as const, part: row.part,
      ...(row.component.foodKey ? { foodKey: row.component.foodKey } : {}),
    };
  });

  const totals = sum(items);
  const fits = fitsTarget(totals, args.target);
  return {
    wish: args.wish, slot: args.slot ?? null, items, totals, target: args.target,
    flagged: items.filter((item) => item.verdict === "blocked").map((item) => item.name),
    fitsTarget: fits, fitNote: fits ? null : fitNote(totals, args.target),
    mealType: occasion, mealClock: args.slotClock ?? null,
    ...reasonsOf(best.rows.map((row) => row.food.id)),
  };
}
