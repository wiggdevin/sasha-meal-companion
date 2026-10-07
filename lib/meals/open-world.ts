/**
 * The open food-world plate pool (Phase 18 D3, D4, D11, slice W8): what an open account's layout
 * and swap sheet generate from, built from a v3 snapshot (lib/meals/snapshot-v3.ts) and the
 * phone's own foods. The phone and the server call this one function, so identical inputs give
 * identical pools, taste values and plates.
 *
 * The admitted set is explicit and positive (D11):
 *   - an account food joins only when it is Favored (Eats) and EVERY ref it stands for is in
 *     `admittedRefIds` (or, with no ref known on this device, its own snapshot entry is admitted
 *     and it was not made from a catalog food, the v1 rule of lib/foods/eligible-client.ts);
 *   - a universe item joins only when its id is in `admittedUniverseIds`, it is countable (a herb
 *     seasons, it never fills a part) and the bundled list still has it. Its nutrition comes from
 *     the bundle (lib/foods/universe/food.ts); the bundle is never an admission source.
 * Anything else, a bundled item the server did not list or a local food whose ref it did not list,
 * is unavailable: there is no default-allow.
 *
 * A local Avoid mark written on this device after the snapshot was read is applied at once
 * (`livePool`): every pool food of that name family leaves (the `set_food_membership` family,
 * lib/foods/base-name.ts), universe items included, before the server has seen the mark. A
 * cleared Avoid mark returns nothing locally: a food comes back only through the next admission.
 *
 * Taste: each pool food carries the snapshot's quantized `z` (never recomputed here). Meal-level
 * rules: under `kosher_meat_dairy` every assembled plate runs `checkPlateRules` on the snapshot's
 * deterministic meat and dairy evidence; a food without evidence reads unknown and its plates are
 * not generated. Reason chips: "You eat this often" (`eaten`) and "On your list" (`on_list`).
 *
 * Pure. No I/O.
 */

import { dbFood } from "@/lib/food-db";
import type { Food } from "@/lib/foods";
import { baseFoodName } from "@/lib/foods/base-name";
import { universeFood, universeIdOf, universePoolId } from "@/lib/foods/universe/food";
import { universeEntry } from "@/lib/foods/universe/manifest";
import type { RulesToken } from "@/lib/foods/world/freshness";
import type { Occasion } from "@/lib/meals/occasion";
import { foodKey } from "@/lib/meals/parts";
import { generationPool } from "@/lib/meals/pool";
import { OPEN_ANCHOR_LIMIT, type OpenRanking, type Plate } from "@/lib/meals/plate";
import type { TasteEntry, TasteValues } from "@/lib/meals/preference";
import type { LocalRefs, MealEvidence } from "@/lib/meals/snapshot";
import { snapshotToken, type MealSnapshotV3, type SnapshotFoodV3 } from "@/lib/meals/snapshot-v3";
import { checkPlateRules, type PlateFoodEvidence } from "@/lib/policy/plate-rules";
import type { Meal } from "@/lib/types";

/** The reason chips a generated open-world meal may carry (lib/types.ts `Meal.reasons`). */
export type MealReasonChip = NonNullable<Meal["reasons"]>[number];
export const REASON_CHIPS: readonly MealReasonChip[] = ["eaten_often", "on_list"];
export const REASON_CHIP_COPY: Readonly<Record<MealReasonChip, string>> = {
  eaten_often: "You eat this often",
  on_list: "On your list",
};

export type OpenWorldInputs = {
  accountId: string;
  /** The admission token the snapshot was computed under. */
  token: RulesToken;
  computedAt: string;
  /** The admitted pool, by pool id: account foods, then `universe:<bundled id>` items. */
  foods: Record<string, Food>;
  evidence: MealEvidence;
  taste: TasteValues;
  ranking: OpenRanking;
  /** Reason chips per pool food id (only foods that earn one). */
  chips: Readonly<Record<string, MealReasonChip[]>>;
  /** A stable key for memoizing a plan on these inputs. */
  key: string;
};

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function entryFor(food: Food, refs: LocalRefs, snapshot: MealSnapshotV3,
  byRef: Map<string, SnapshotFoodV3>): SnapshotFoodV3 | undefined {
  const own = refs[food.id];
  return (own?.userRefId ? byRef.get(own.userRefId) : undefined)
    ?? (own?.catalogRefId ? byRef.get(own.catalogRefId) : undefined)
    ?? snapshot.foods[food.id]
    ?? (food.catalogFoodId !== undefined ? snapshot.foods[`catalog:${food.catalogFoodId}`] : undefined);
}

/** Whether an account food may join the pool under this snapshot's admitted refs (positive set). */
function admittedOwn(food: Food, refs: LocalRefs, snapshot: MealSnapshotV3, admittedRefs: ReadonlySet<string>): boolean {
  if (food.status !== "eats") return false;
  const mapped = [refs[food.id]?.userRefId, refs[food.id]?.catalogRefId]
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  if (mapped.length) return mapped.every((ref) => admittedRefs.has(ref));
  // No ref known on this device: only its own admitted entry vouches, and a food made from a
  // catalog food has two identities this device cannot prove both of (the v1 rule).
  const entry = snapshot.foods[food.id];
  return food.catalogFoodId === undefined && entry?.source === "favored" && entry.userRefId !== null
    && admittedRefs.has(entry.userRefId);
}

function chipsOf(entry: SnapshotFoodV3 | undefined): MealReasonChip[] {
  if (!entry) return [];
  const out: MealReasonChip[] = [];
  if (entry.reasons.includes("eaten")) out.push("eaten_often");
  if (entry.reasons.includes("on_list")) out.push("on_list");
  return out;
}

const UNKNOWN_PLATE: PlateFoodEvidence = { meat: "unknown", dairy: "unknown" };

/** The name families of every food this device holds on Avoid. */
export function localAvoidFamilies(foods: Readonly<Record<string, Food>> | readonly Food[]): Set<string> {
  const list = (Array.isArray(foods) ? foods : Object.values(foods)) as Food[];
  return new Set(list.filter((food) => food.status === "avoid").map((food) => baseFoodName(food.name)).filter(Boolean));
}

/** Whether a pool food falls in an avoided family: its own name, and a universe item's SR name too. */
function avoided(id: string, food: Food, families: ReadonlySet<string>): boolean {
  if (!families.size) return false;
  const universeId = universeIdOf(id);
  const names = [food.name, universeId ? dbFood(universeId)?.sr : undefined];
  return names.some((name) => {
    const key = baseFoodName(name ?? "");
    return key.length > 0 && families.has(key);
  });
}

/**
 * The pool as it stands NOW on this device: an account food still Favored here, a universe item,
 * and nothing in a family this device has since marked Avoid. Never adds a food.
 */
export function livePool(open: Pick<OpenWorldInputs, "foods">, foods: Readonly<Record<string, Food>>): Record<string, Food> {
  const families = localAvoidFamilies(foods);
  return Object.fromEntries(Object.entries(open.foods).filter(([id, food]) =>
    (universeIdOf(id) !== null || foods[id]?.status === "eats") && !avoided(id, food, families)));
}

/**
 * The open-world inputs for this account's v3 snapshot and the device's foods. The caller has
 * already checked the snapshot is this account's, usable and fresh (lib/foods/eligible-client.ts).
 */
export function openWorldInputs(snapshot: MealSnapshotV3, foods: Readonly<Record<string, Food>> | readonly Food[],
  refs: LocalRefs = {}): OpenWorldInputs {
  const admittedRefs = new Set(snapshot.admittedRefIds);
  const byRef = new Map<string, SnapshotFoodV3>();
  for (const id of Object.keys(snapshot.foods).sort(byCode)) {
    const entry = snapshot.foods[id];
    if (entry.source !== "favored") continue;
    if (entry.userRefId && !byRef.has(entry.userRefId)) byRef.set(entry.userRefId, entry);
    if (entry.catalogRefId && !byRef.has(entry.catalogRefId)) byRef.set(entry.catalogRefId, entry);
  }
  const list = (Array.isArray(foods) ? [...foods] : Object.values(foods)) as Food[];
  const families = localAvoidFamilies(list);
  const pool: Record<string, Food> = {};
  const entryOf = new Map<string, SnapshotFoodV3 | undefined>();
  for (const food of [...list].sort((a, b) => byCode(a.id, b.id))) {
    if (!admittedOwn(food, refs, snapshot, admittedRefs) || avoided(food.id, food, families)) continue;
    pool[food.id] = { ...food, perUnit: { ...food.perUnit } };
    entryOf.set(food.id, entryFor(food, refs, snapshot, byRef));
  }
  for (const id of [...snapshot.admittedUniverseIds].sort(byCode)) {
    const entry = universeEntry(id);
    const row = entry && entry.countable ? dbFood(id) : undefined;
    if (!row) continue;
    const poolId = universePoolId(id);
    const food: Food = { ...universeFood(row), id: poolId, status: "eats" };
    if (avoided(poolId, food, families)) continue;
    pool[poolId] = food;
    entryOf.set(poolId, snapshot.foods[poolId]);
  }
  // Taste, evidence and chips by the name key the ranking looks up: the food generationPool keeps
  // for a name (the first by name, then id) speaks for it.
  const taste: Record<string, TasteEntry> = {};
  const history: Record<string, Partial<Record<Occasion, number>>> = {};
  const facets: Record<string, Partial<Record<Occasion, number>>> = {};
  const chips: Record<string, MealReasonChip[]> = {};
  for (const food of generationPool(pool)) {
    const entry = entryOf.get(food.id);
    if (!entry) continue;
    const key = foodKey(food);
    if (entry.z.base !== 0 || (entry.z.occasion && Object.keys(entry.z.occasion).length)) {
      taste[key] = entry.z.occasion ? { base: entry.z.base, occasion: { ...entry.z.occasion } } : { base: entry.z.base };
    }
    if (entry.history && Object.keys(entry.history).length) history[key] = { ...entry.history };
    if (entry.facets && Object.keys(entry.facets).length) facets[key] = { ...entry.facets };
    const own = chipsOf(entry);
    if (own.length) chips[food.id] = own;
  }
  const kosher = snapshot.plateRules.includes("kosher_meat_dairy");
  const plateOk = kosher ? (rows: readonly Food[]) => checkPlateRules(["kosher"],
    rows.map((row) => entryOf.get(row.id)?.plate ?? UNKNOWN_PLATE)).ok : undefined;
  return {
    accountId: snapshot.accountId, token: snapshotToken(snapshot), computedAt: snapshot.computedAt,
    foods: pool,
    evidence: { accountId: snapshot.accountId, computedAt: snapshot.computedAt, history,
      ...(Object.keys(facets).length ? { facets } : {}) },
    taste,
    ranking: { anchorLimit: OPEN_ANCHOR_LIMIT, ...(plateOk ? { plateOk } : {}) },
    chips,
    key: JSON.stringify(["open", snapshot.accountId, snapshot.inputsHash, snapshot.rulesVersion,
      snapshot.evidenceVersion, snapshot.computedAt]),
  };
}

/** A plate's reason chips: every chip any of its foods earns, in chip order. */
export function plateChips(plate: Pick<Plate, "rows">, chips: Readonly<Record<string, MealReasonChip[]>>): MealReasonChip[] {
  const held = new Set(plate.rows.flatMap((row) => chips[row.food.id] ?? []));
  return REASON_CHIPS.filter((chip) => held.has(chip));
}
