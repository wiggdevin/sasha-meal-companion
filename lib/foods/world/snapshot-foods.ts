/**
 * The `foods` map of snapshot v3 (Phase 18 D11, slice W8): one entry per admitted pool food, with
 * its quantized `pref-2` value, its reasons and, under a meal-level rule, its plate evidence. The
 * server builder (lib/server/meal-snapshot-v3.ts) is its caller; tests build bodies with it too, so
 * a synthetic snapshot and a served one carry the same numbers for the same inputs.
 *
 * Admission is decided before this runs (D4): an account food enters only when every ref it stands
 * for is in `admittedRefIds`, a universe item only when its id is in `admittedUniverseIds` and it is
 * countable. Nothing here can add a food.
 *
 * Pure. No I/O.
 */
import { deriveItem } from "@/lib/foods/universe/derive";
import { universePoolId } from "@/lib/foods/universe/food";
import { universeEntry } from "@/lib/foods/universe/manifest";
import { ownPlateEvidence, universePlateEvidence } from "@/lib/foods/world/plate-evidence";
import { preferenceInputFor, type PoolFact, type TasteContext } from "@/lib/foods/world/taste-inputs";
import type { Occasion } from "@/lib/meals/occasion";
import { foodKey, mealFamily, partsOf, type Part } from "@/lib/meals/parts";
import {
  preferenceScores, type FoodPreference, type PreferenceReasonCode, type TasteEntry,
} from "@/lib/meals/preference";
import type { PlateEvidence, PlateRuleKey, SnapshotFoodV3 } from "@/lib/meals/snapshot-v3";
import type { Food } from "@/lib/foods";

/** One of the account's own Eats foods, as the v2 parts read it. */
export type OwnSnapshotFood = {
  id: string;
  food: Food;
  parts: Part[];
  family: string | null;
  userRefId: string | null;
  catalogRefId: string | null;
  history?: Partial<Record<Occasion, number>>;
  facets?: Partial<Record<Occasion, number>>;
};

export type SnapshotFoodsInput = {
  own: readonly OwnSnapshotFood[];
  admittedRefIds: readonly string[];
  admittedUniverseIds: readonly string[];
  context: TasteContext;
  plateRules: readonly PlateRuleKey[];
};

/** The quantized value: `base`, plus the occasions whose z differs from it. */
export function tasteEntryOf(preference: FoodPreference | undefined): TasteEntry {
  if (!preference) return { base: 0 };
  const occasion: Partial<Record<Occasion, number>> = {};
  for (const [name, terms] of Object.entries(preference.byOccasion) as [Occasion, { z: number }][]) {
    if (terms.z !== preference.base.z) occasion[name] = terms.z;
  }
  return Object.keys(occasion).length ? { base: preference.base.z, occasion } : { base: preference.base.z };
}

const reasonCodes = (preference: FoodPreference | undefined): PreferenceReasonCode[] =>
  [...new Set((preference?.reasons ?? []).filter((reason) => reason.contribution !== 0).map((reason) => reason.code))];

type PoolRow = PoolFact & { parts: Part[]; family: string | null; plate: () => PlateEvidence;
  snapshot: Pick<SnapshotFoodV3, "userRefId" | "catalogRefId" | "universeId" | "source" | "history" | "facets"> };

export function snapshotFoodsV3(input: SnapshotFoodsInput): Record<string, SnapshotFoodV3> {
  const admittedRefs = new Set(input.admittedRefIds);
  const pool: PoolRow[] = [];
  for (const row of input.own) {
    const refs = [row.userRefId, row.catalogRefId].filter((ref): ref is string => ref !== null);
    if (!refs.length || !refs.every((ref) => admittedRefs.has(ref))) continue;
    pool.push({ id: row.id, name: row.food.name, key: foodKey(row.food), universeId: null, refIds: refs, favored: true,
      parts: [...row.parts], family: row.family, plate: () => ownPlateEvidence(row.food.name),
      snapshot: { userRefId: row.userRefId, catalogRefId: row.catalogRefId, universeId: null, source: "favored",
        ...(row.history && Object.keys(row.history).length ? { history: { ...row.history } } : {}),
        ...(row.facets && Object.keys(row.facets).length ? { facets: { ...row.facets } } : {}) } });
  }
  for (const id of input.admittedUniverseIds) {
    const entry = universeEntry(id);
    const item = entry?.countable ? deriveItem(entry) : null;
    if (!item) continue;
    pool.push({ id: universePoolId(id), name: item.food.name, key: foodKey(item.food), universeId: id, refIds: [],
      favored: false, parts: partsOf(item.food), family: mealFamily(item.food.name)?.key ?? null,
      plate: () => universePlateEvidence(item),
      snapshot: { userRefId: null, catalogRefId: null, universeId: id, source: "universe" } });
  }
  const scores = preferenceScores(preferenceInputFor(pool, input.context));
  const foods: Record<string, SnapshotFoodV3> = {};
  for (const food of [...pool].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const preference = scores[food.key];
    // `parts`/`family` never reach the wire (Sol re-plan): `openWorldInputs` never reads them off a
    // snapshot entry, only off the phone's own `Food`/`universeFood` row.
    foods[food.id] = { ...food.snapshot, z: tasteEntryOf(preference),
      reasons: reasonCodes(preference), ...(input.plateRules.length ? { plate: food.plate() } : {}) };
  }
  return foods;
}
