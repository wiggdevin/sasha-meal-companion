import {
  COMPLEMENT_TRIES, fillsRole, NOTHING_LEFT, snackTarget, type ComposedMeal,
} from "@/lib/coach/compose";
import { composeTemplateMeal } from "@/lib/coach/compose-template";
import { familyKey, pairingFamily } from "@/lib/coach/meal-pairings";
import { isUntimed, mealTypeAt, resolveMealClock } from "@/lib/coach/meal-type";
import { sidePartOf } from "@/lib/coach/portion-bands";
import { familyRotation, orderAnchors } from "@/lib/coach/suggest-anchors";
import { fitNote, fitsTarget, macroSources, macrosFor, roleOf, type MealMacros }
  from "@/lib/coach/compose-size";
import type { FoodHit, SuggestInput } from "@/lib/coach/executors";
import { checkItem, allergenFacts } from "@/lib/coach/policy";
import type { SuggestPorts } from "@/lib/coach/suggest";
import { fitNamedMealPortions } from "@/lib/coach/fit-portions";
import { buildPoolCandidates } from "@/lib/coach/suggest-pool";

export { fitNamedMealPortions } from "@/lib/coach/fit-portions";

const MAX_CANDIDATES = 12;
/**
 * Only a food already on Eats can anchor a card, and compose searches the same name at 3, so
 * anchor discovery asks for no more. A wider search paid a food-ref RPC and a detail read for
 * every extra hit: twelve per Eats food made a 40-food list miss the budget on 2026-09-29/30.
 */
const ANCHOR_SEARCH_LIMIT = 3;
const MAX_PARALLEL_SEARCHES = 4;
/**
 * Searches fetched up front, and how many at once. Production grounding took 2–12 s on a phone
 * (client_timings, 2026-09-24..10-01) because each card searched its anchor, then each filler, one
 * after another. Every name the build can need is known before it composes anything.
 */
const PREFETCH_ANCHORS = 12;
const PREFETCH_PARALLEL = 8;
const SNACK_KCAL_CAP = 300;
const SMALL_SNACK_KCAL_CAP = 200;
const KCAL_SIZE = /\b(\d{1,4}(?:\.\d+)?)\s*(?:kcal|calories?)\b/i;
const GRAM_SIZE = /\b\d+(?:\.\d+)?\s*(?:g|grams?)\b(?!\s*(?:protein|carbs?|fat|fibre|fiber)\b)/i;
const SMALL_SIZE = /\b(?:small|light)\b/i;

/** `pairing` (0–1) is how usual the card's foods are together for its meal type. */
export type SuggestionCandidate = {
  meal: ComposedMeal; fit: number; index: number; pairing?: number;
  /**
   * Phase 18 W10 acceptance 3: false means this candidate stays out of the Jev shortlist
   * entirely — a pool food this builder could not cheaply prove is a bundled, generic identity
   * (`lib/coach/suggest-pool.ts`'s own check). Absent/true: eligible (every closed-world
   * candidate; a per-item name still never reaches Jev untyped unless it is catalog-pinned,
   * `lib/coach/suggest-rank.ts`'s `jevSafeName`).
   */
  jevEligible?: boolean;
};
export type CandidateBuild = {
  candidates: SuggestionCandidate[];
  requested: number;
  pendingSlots: { slot: string; label: string }[] | undefined;
  /** Phase 13 §5: candidates left out because a food's allergen evidence is missing or unchecked. */
  hiddenUnverified: number;
  /** The build budget ran out before every Eats food was tried; `candidates` is what was built. */
  interrupted: boolean;
  /**
   * Phase 18 W10: these candidates came from the open-world admitted pool
   * (`lib/coach/suggest-pool.ts`), already policy-clean from D11's fresh admission read. The
   * caller (`lib/coach/suggest.ts`) skips the Eats-era allergen/evidence recheck
   * (`lib/coach/suggest-policy.ts`) for them — that check reads `food_refs` rows a universe pool
   * id is not one of.
   */
  openWorld?: boolean;
};
/**
 * A card anchors on a name from the Eats list, so an account with none has nothing to build from,
 * and a day with no target has nothing to size against. Both are states of the account and the day
 * rather than failures: the caller answers each with its own sentence
 * (lib/coach/suggest-messages.ts) instead of the retry line.
 */
export const NO_SAVED_FOODS = "no-saved-foods" as const;
export const NO_TARGET = "no-target" as const;

export function fitScore(actual: MealMacros, target: MealMacros): number {
  const keys = ["kcal", "protein", "carbs", "fat"] as const;
  const misses = keys.map((key) => {
    if (target[key] <= 0) return actual[key] <= 0 ? 0 : 1;
    return Math.abs(actual[key] - target[key]) / target[key];
  });
  return Math.max(0, Math.min(1, 1 - misses.reduce((sum, miss) => sum + miss, 0) / 4));
}

export async function buildCandidates(
  input: SuggestInput,
  ports: SuggestPorts,
  signal: AbortSignal,
  abortable: <T>(promise: Promise<T>, signal: AbortSignal) => Promise<T>,
  isAbort: (error: unknown) => boolean,
): Promise<CandidateBuild | typeof NOTHING_LEFT | typeof NO_SAVED_FOODS | typeof NO_TARGET> {
  const requested = Math.max(1, Math.min(5, Math.trunc(input.count ?? 3)));
  const cap = snackCap(input);
  // Phase 18 W10, acceptance 1: an open food-world account's admitted pool (D1) can build cards
  // even with 0 Favored foods — checked first, before the Eats-emptiness answer below would
  // otherwise end the request on a brand-new open account.
  const open = await abortable(ports.openWorld?.(ports.userId) ?? Promise.resolve(null), signal);
  if (open) return buildPoolCandidates(input, ports, open, requested, cap, signal, abortable);
  // The Eats list first: an account with nothing saved is answered before the day's target is even
  // read, so a missing target cannot become an error on a brand-new account.
  const names = await abortable(ports.eatsNames?.(ports.userId) ?? Promise.resolve([]), signal);
  if (names.length === 0) return NO_SAVED_FOODS;
  const listed = ports.eatsAnchors
    ? await abortable(ports.eatsAnchors(ports.userId), signal) : names;
  // The meal type comes from the slot's clock (lib/coach/meal-type.ts): the anchors that suit it
  // go first, one per family, and the sides follow its template (lib/coach/compose-template.ts).
  const mealClock = await abortable(resolveMealClock(input.slot, ports, signal), signal);
  const mealType = mealTypeAt(mealClock, input.kind);
  const anchors = orderAnchors(listed, mealType, input.wish, isUntimed(mealType, mealClock));
  const rotation = familyRotation(anchors);
  const available = await abortable(ports.target(input), signal);
  if (available === null) return NO_TARGET;
  const snack = input.kind === "snack" ? snackTarget(available, cap) : null;
  if (snack === NOTHING_LEFT) return NOTHING_LEFT;
  const target = snack ?? available;
  const eatsNames = new Set(names.map(normalizedName));
  const searches = new Map<string, Promise<FoodHit[]>>();
  const cachedPorts: SuggestPorts = {
    ...ports,
    eatsNames: async () => names,
    searchFoods: async (userId, query, limit) => {
      const key = `${userId}\u0000${query.trim().toLowerCase()}`;
      let pending = searches.get(key);
      if (!pending) {
        pending = (async () => {
          if (ports.ownFood && eatsNames.has(normalizedName(query))) {
            const own = await ports.ownFood(userId, query, signal);
            if (own && normalizedName(own.name) === normalizedName(query)) return [own];
          }
          return ports.searchFoods(userId, query, Math.max(3, limit), signal);
        })();
        searches.set(key, pending);
      }
      return (await abortable(pending, signal)).slice(0, limit);
    },
  };
  // Warm the build's own search cache in parallel; the workers below read the same promises.
  // Only whole foods that read as a filler's role: any other name is still tried, lazily.
  const ofPart = (part: string) => names.filter((name) => sidePartOf(name) === part)
    .slice(0, COMPLEMENT_TRIES);
  const upFront = [...new Set([...anchors.slice(0, PREFETCH_ANCHORS),
    // Fats only as plain whole foods: a nut butter or shake mix is searched lazily, when needed.
    ...ofPart("starch"), ...ofPart("veg"), ...names.filter((name) => fillsRole(name, "fat"))
      .slice(0, COMPLEMENT_TRIES),
    ...(mealType === "breakfast" || mealType === "snack" ? ofPart("fruit") : [])])];
  let nextFetch = 0;
  const fetcher = async () => {
    while (!signal.aborted && nextFetch < upFront.length) {
      const name = upFront[nextFetch];
      nextFetch += 1;
      await cachedPorts.searchFoods(ports.userId, name, ANCHOR_SEARCH_LIMIT).catch(() => undefined);
    }
  };
  for (let i = 0; i < PREFETCH_PARALLEL; i += 1) void fetcher();
  const candidates: SuggestionCandidate[] = [];
  const seen = new Set<string>();
  // One card per anchor family: "Scallops, sea" and "Scallops, bay" are one choice, not two.
  const families = new Set<string>();
  let hiddenUnverified = 0;
  let nextName = 0;
  const worker = async () => {
    while (!signal.aborted && nextName < anchors.length && seen.size < MAX_CANDIDATES) {
      const nameIndex = nextName;
      nextName += 1;
      const name = anchors[nameIndex];
      try {
        const hits = await cachedPorts.searchFoods(ports.userId, name, ANCHOR_SEARCH_LIMIT);
        const ordered = [
          ...hits.filter((row) => normalizedName(row.name) === normalizedName(name)),
          ...hits.filter((row) => normalizedName(row.name) !== normalizedName(name)),
        ];
        for (let hitIndex = 0; hitIndex < ordered.length && seen.size < MAX_CANDIDATES; hitIndex++) {
          const anchor = ordered[hitIndex];
          const anchorVerdict = verdictOf(anchor, ports);
          if (anchorVerdict !== "allowed") {
            if (anchorVerdict === "unverified") hiddenUnverified += 1;
            continue;
          }
          const identity = canonicalIdentity(anchor);
          const family = familyKey(anchor.name);
          if (seen.has(identity) || families.has(family)) continue;
          seen.add(identity);
          families.add(family);
          // The anchor is already the card's protein. Its own name is not a wish (live trace
          // 2026-10-02): "Chicken breast, cooked" made "chicken" and "cooked" terms that pulled a
          // fried, coated chicken and a "pre-cooked" one onto the same card.
          const wish = input.wish?.trim() || input.kind;
          // A throw below must not leave this family claimed: the next hit of it is a real card.
          const release = (error: unknown): never => {
            families.delete(family);
            seen.delete(identity);
            throw error;
          };
          const composed = await abortable(composeTemplateMeal(cachedPorts.userId, {
            wish,
            slot: input.slot ?? null,
            target,
            anchorProtein: anchor.name,
            mealType,
            mealClock,
            rotation: rotation.get(family) ?? 0,
            userWish: input.wish?.trim() || null,
          }, cachedPorts.profile, {
            searchFoods: cachedPorts.searchFoods,
            eatsNames: cachedPorts.eatsNames,
          }), signal).catch(release);
          // The wish is also the card's title, its planned slot and a saved recipe's name.
          const titled = input.wish?.trim() ? composed : { ...composed, wish: anchor.name };
          const sized = input.kind === "snack" && cap !== null
            ? cappedSnack(titled, target.kcal) : titled;
          if (sized.items.length === 0 || sized.items.some((item) => item.verdict !== "allowed")) {
            if (sized.items.some((item) => item.verdict === "unverified")
              && !sized.items.some((item) => item.verdict === "blocked")) hiddenUnverified += 1;
            families.delete(family);
            continue;
          }
          // Named meal slots offer a save action only for cards that fit, and Plan hides the rest.
          // Resize each existing portion toward the slot FIRST (lib/coach/fit-portions.ts): a meal
          // over on carbs and under on protein is outside the broad admission window until then.
          // Never invent another food or loosen the 10 % bar. General suggestions and snacks keep
          // the broad admission window unchanged.
          const named = input.kind === "meal" && Boolean(input.slot);
          const fitted = named ? fitNamedMealPortions(sized) : sized;
          if (named ? !fitted.fitsTarget : !admitted(sized.totals, target)) {
            families.delete(family);
            continue;
          }
          // The verdicts were taken at the composed grams; the card carries these. A rule that
          // turns on the amount is checked at the amount served (2026-10-03 audit, BLOCKER 1).
          const regrammed = fitted.items.some((item, i) => item.grams !== composed.items[i]?.grams);
          const ready = regrammed
            ? await verdictsAt(fitted, cachedPorts.userId, cachedPorts).catch(release) : fitted;
          if (ready.items.some((item) => item.verdict !== "allowed")) {
            families.delete(family);
            continue;
          }
          candidates.push({
            meal: {
              ...ready,
              allItemsOnEats: ready.items.every((item) => eatsNames.has(normalizedName(item.name))),
            },
            fit: fitScore(ready.totals, target),
            index: nameIndex * MAX_CANDIDATES + hitIndex,
            pairing: ready.pairing ?? 1,
          });
        }
      } catch (error) {
        if (!isAbort(error)) throw error;
      }
    }
  };
  let pendingSlots: { slot: string; label: string }[] | undefined;
  const pendingTask = cachedPorts.pendingSlots
    ? abortable(cachedPorts.pendingSlots(), signal).then((value) => { pendingSlots = value; })
      .catch((error: unknown) => { if (!isAbort(error)) throw error; })
    : Promise.resolve();
  await Promise.all([
    ...Array.from({ length: Math.min(MAX_PARALLEL_SEARCHES, Math.max(1, anchors.length)) }, worker),
    pendingTask,
  ]);
  return { candidates, requested, pendingSlots, hiddenUnverified, interrupted: signal.aborted };
}

/**
 * Every item's verdict again, at the grams the card now carries. Each item is the account's own
 * row for its name (lib/coach/compose-template.ts), so its search is already in the build's cache;
 * an item whose row cannot be found again is "unverified", and the card is dropped.
 */
export async function verdictsAt(
  meal: ComposedMeal, userId: string, ports: Pick<SuggestPorts, "searchFoods" | "profile">,
): Promise<ComposedMeal> {
  const items = await Promise.all(meal.items.map(async (item) => {
    const hit = (await ports.searchFoods(userId, item.name, ANCHOR_SEARCH_LIMIT))
      .find((row) => row.foodRefId === item.foodRefId);
    const verdict = !hit ? "unverified" as const : checkItem({
      foodRefId: hit.foodRefId, name: hit.name, grams: item.grams,
      allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit), category: hit.category ?? null,
      onEatsList: hit.prefStatus === "eats", onAvoidList: hit.prefStatus === "avoid",
    }, ports.profile).verdict;
    return { ...item, verdict };
  }));
  return { ...meal, items, flagged: items.filter((item) => item.verdict === "blocked").map((item) => item.name) };
}

function snackCap(input: SuggestInput): number | null {
  if (input.kind !== "snack") return null;
  const wish = input.wish ?? "";
  const namedKcal = KCAL_SIZE.exec(wish)?.[1];
  if (namedKcal !== undefined) return Number(namedKcal);
  if (GRAM_SIZE.test(wish)) return null;
  return SMALL_SIZE.test(wish) ? SMALL_SNACK_KCAL_CAP : SNACK_KCAL_CAP;
}

function cappedSnack(meal: ComposedMeal, cap: number): ComposedMeal {
  if (meal.totals.kcal <= cap) return meal;
  const ratio = (cap - meal.items.length * 0.5) / meal.totals.kcal;
  const items = meal.items.map((item) => {
    // Whole grams: "Chicken breast 83.3 g" reads like a bug, not a portion.
    const grams = Math.max(1, Math.floor(item.grams * ratio));
    return { ...item, grams, macros: macrosFor(item, grams) };
  });
  const totals = items.reduce((sum, item) => ({
    kcal: sum.kcal + item.macros.kcal,
    protein: Math.round((sum.protein + item.macros.protein) * 10) / 10,
    carbs: Math.round((sum.carbs + item.macros.carbs) * 10) / 10,
    fat: Math.round((sum.fat + item.macros.fat) * 10) / 10,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const fits = fitsTarget(totals, meal.target);
  return { ...meal, items, totals, fitsTarget: fits,
    fitNote: fits ? null : fitNote(totals, meal.target) };
}

function admitted(actual: MealMacros, target: MealMacros): boolean {
  const withinKcal = target.kcal <= 0
    ? actual.kcal <= 0 : Math.abs(actual.kcal - target.kcal) <= target.kcal * 0.15;
  const notOver = (key: "protein" | "carbs" | "fat") => target[key] <= 0
    ? actual[key] <= 0 : actual[key] <= target[key] * 1.25;
  return withinKcal && (["protein", "carbs", "fat"] as const).every(notOver);
}

/**
 * An anchor's verdict; a food that is not an Eats-list protein is simply not an anchor. A known
 * protein family whose protein is a real source but not its largest share — whole eggs carry more
 * energy as fat — still anchors (2026-10-03: no breakfast card ever had eggs).
 */
function verdictOf(hit: FoodHit, ports: SuggestPorts): "allowed" | "blocked" | "unverified" | null {
  if (hit.prefStatus !== "eats") return null;
  const protein = roleOf(hit) === "protein"
    || (pairingFamily(hit.name) !== null && macroSources(hit).has("protein"));
  if (!protein) return null;
  return checkItem({
    foodRefId: hit.foodRefId, name: hit.name, grams: null,
    allergenTags: hit.allergenTags ?? null, ...allergenFacts(hit), category: hit.category ?? null,
    onEatsList: true, onAvoidList: false,
  }, ports.profile).verdict;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function canonicalIdentity(hit: FoodHit): string {
  return hit.foodRefId === null ? `name:${normalizedName(hit.name)}` : `ref:${hit.foodRefId}`;
}
