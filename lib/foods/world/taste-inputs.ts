/**
 * The `pref-2` inputs for an open account's admitted pool (Phase 18 D8, slice W8): the bridge from
 * the account's taste evidence, keyed by taste identity (`u:<universe id>` or `f:<family>`,
 * lib/meals/taste-identity.ts) and by universe id (the prior, the substitute graph, the cuisine
 * tiers, the sensory tags), to the plate ranking's food NAME keys (lib/meals/parts.ts `foodKey`).
 * lib/meals/preference.ts does the arithmetic; this module only assembles its input.
 *
 *   F  an admitted Favored (Eats) food carries the name key
 *   L  a confirmed taste dislike (the stored taste dislikes, W5): `f:<family>` matches a food of that
 *      name family; `t:<tag>` matches a universe item reviewed with that sensory tag
 *   H, Q  the account's admitted eaten history and choices (lib/meals/taste.ts), by the identity
 *      each pool food stands for: a universe item its own `u:` identity; an account food every
 *      identity the history resolved its refs to (a `catalog:` key and an account copy of the
 *      same catalog food resolve to the same identity, lib/server/taste-resolve.ts), else its
 *      name's identity. Several identities on one name key take the largest value, never a sum.
 *   M  the account's weighted episodes (`TasteResult.m`), which fade the prior
 *   P  the U.S. prior of the key's universe item, centred within its part over the WHOLE universe
 *      (so it never depends on which foods this account's rules admit); 0 when neutral
 *   C  the key's universe tiers in the account's stated cuisines
 *   neighbours  the substitute graph's edges from the key's universe items to universe items
 *      IN THE POOL, by their name keys: no edge reaches a food the rules excluded. No edge is a
 *      reviewed sensory edge yet (the W1b graph has no sensory review), so a taste dislike never
 *      spreads to a neighbour; it lowers only the foods it names.
 *   R  not supplied: confirmed soft-rule scores are a follow-up (condition packs stay off).
 *
 * Every input is for admitted foods only (D5): the caller passes the pool the D4 admission order
 * produced and the history `admitHistory` kept. Nothing here can add a food or touch a verdict.
 *
 * Pure. No I/O.
 */

import { baseFoodName } from "@/lib/foods/base-name";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { priorScores, type AccountPrior } from "@/lib/foods/universe/prior";
import type { SubstituteGraph } from "@/lib/foods/universe/substitutes";
import type { CuisineKey } from "@/lib/foods/universe/vocabulary";
import type { Part } from "@/lib/meals/parts";
import type { FoodSignals, PreferenceFood, PreferenceInput, SubstituteNeighbour, Tier } from "@/lib/meals/preference";
import type { TasteResult } from "@/lib/meals/taste";
import { identityOf } from "@/lib/meals/taste-identity";
import type { TasteDislike } from "@/lib/profile/taste";

/** One admitted pool food, as the snapshot builder knows it. */
export type PoolFact = {
  /** The snapshot food id (an account food id, `catalog:<id>` or `universe:<bundled id>`). */
  id: string;
  name: string;
  /** The ranking's name key (`foodKey`). */
  key: string;
  /** Set for a universe item. */
  universeId: string | null;
  /** The account refs an account food stands for (none for a universe item). */
  refIds: readonly string[];
  /** An admitted Favored (Eats) mark. */
  favored: boolean;
};

/** What the history read resolved each identity's refs to (lib/server/taste-history.ts `IdentityReps`). */
export type IdentityRefs = ReadonlyMap<string, { refIds: ReadonlySet<string>; favoredRefIds: ReadonlySet<string>;
  universeId: string | null }>;

export type TasteContext = {
  /** The admitted taste profile (`tasteProfile` over `admitHistory`'s rows). */
  profile: Pick<TasteResult, "m" | "identities">;
  identities: IdentityRefs;
  dislikes: readonly TasteDislike[];
  cuisines: readonly CuisineKey[];
  prior: AccountPrior;
  /** Parts of every universe item, by universe id: the prior's centring group. */
  universeParts: Readonly<Record<string, readonly Part[]>>;
  graph: SubstituteGraph | null;
};

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The taste identities one pool food stands for. */
function identitiesOf(food: PoolFact, identities: IdentityRefs): string[] {
  if (food.universeId) return [`u:${food.universeId}`];
  const out = new Set<string>();
  for (const [key, reps] of identities) {
    if (food.refIds.some((ref) => reps.refIds.has(ref) || reps.favoredRefIds.has(ref))) out.add(key);
  }
  const named = identityOf({ name: food.name });
  if (named) out.add(named.key);
  return [...out].sort(byCode);
}

/** The universe items a pool food stands for: its own id, or the universe identities it resolved to. */
function universeIdsOf(food: PoolFact, keys: readonly string[]): string[] {
  if (food.universeId) return [food.universeId];
  return keys.filter((key) => key.startsWith("u:")).map((key) => key.slice(2));
}

function dislikedBy(dislikes: readonly TasteDislike[], names: readonly string[], universeIds: readonly string[]): boolean {
  const families = new Set(names.map(baseFoodName).filter(Boolean));
  const tags = new Set(universeIds.flatMap((id) => universeEntry(id)?.sensory ?? []));
  return dislikes.some((key) => (key.startsWith("f:") ? families.has(baseFoodName(key.slice(2)))
    : tags.has(key.slice(2) as never)));
}

/** The best tier per stated cuisine across the key's universe items. */
function tiersOf(universeIds: readonly string[], cuisines: readonly CuisineKey[]): Tier[] {
  const tiers = new Set<Tier>();
  for (const id of universeIds) {
    const entry = universeEntry(id);
    for (const cuisine of cuisines) {
      const tier = entry?.tiers[cuisine];
      if (tier) tiers.add(tier);
    }
  }
  return [...tiers].sort(byCode);
}

/**
 * The `pref-2` input for the pool: one PreferenceFood per name key, in key order, plus M. The same
 * pool and context give the same input on every runtime.
 */
export function preferenceInputFor(pool: readonly PoolFact[], context: TasteContext): PreferenceInput {
  const byIdentity = new Map(context.profile.identities.map((row) => [row.key, row]));
  const priors = priorScores(context.prior.prior, context.prior.cohort, context.universeParts);
  const groups = new Map<string, PoolFact[]>();
  for (const food of [...pool].sort((a, b) => byCode(a.key, b.key) || byCode(a.id, b.id))) {
    groups.set(food.key, [...(groups.get(food.key) ?? []), food]);
  }
  // The name keys each universe item in the pool goes by: where a neighbour edge lands.
  const keyOfUniverse = new Map<string, string>();
  for (const food of pool) if (food.universeId && !keyOfUniverse.has(food.universeId)) keyOfUniverse.set(food.universeId, food.key);
  const edgesFrom = new Map<string, { to: string; sub: number }[]>();
  for (const edge of context.graph?.edges ?? []) {
    edgesFrom.set(edge.from, [...(edgesFrom.get(edge.from) ?? []), { to: edge.to, sub: edge.sub }]);
  }
  const foods: PreferenceFood[] = [];
  for (const [key, members] of groups) {
    const identityKeys = [...new Set(members.flatMap((food) => identitiesOf(food, context.identities)))].sort(byCode);
    const universeIds = [...new Set(members.flatMap((food) => universeIdsOf(food, identitiesOf(food, context.identities))))]
      .sort(byCode);
    const counted = identityKeys.map((identity) => byIdentity.get(identity)).filter((row) => row !== undefined);
    const signals: FoodSignals = {};
    if (members.some((food) => food.favored)) signals.favored = true;
    if (dislikedBy(context.dislikes, members.map((food) => food.name), universeIds)) signals.disliked = true;
    const eaten = Math.max(0, ...counted.map((row) => row.h));
    const chosen = Math.max(0, ...counted.map((row) => row.q));
    if (eaten > 0) signals.eaten = eaten;
    if (chosen > 0) signals.chosen = chosen;
    const prior = universeIds.map((id) => priors[id]).find((value) => typeof value === "number" && value !== 0);
    const neighbours: SubstituteNeighbour[] = universeIds.flatMap((id) => (edgesFrom.get(id) ?? [])
      .flatMap((edge) => {
        const to = keyOfUniverse.get(edge.to);
        return to && to !== key ? [{ key: to, k: edge.sub }] : [];
      }));
    const cuisineTiers = tiersOf(universeIds, context.cuisines);
    foods.push({ key, ...(prior !== undefined ? { prior } : {}),
      ...(Object.keys(signals).length ? { signals } : {}),
      ...(cuisineTiers.length ? { cuisineTiers } : {}),
      ...(neighbours.length ? { neighbours } : {}) });
  }
  return { episodes: context.profile.m, foods };
}
