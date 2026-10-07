/**
 * Loads the non-survey W1b inputs from the offline workspace: the FNDDS releases (ingredients and
 * the code list), the universe items with their SR numbers, and SR nutrient profiles. Offline build
 * only.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveItem, type UniverseItem } from "@/lib/foods/universe/derive";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import { readCsv } from "@/scripts/priors/csv";
import {
  createExpander, createMatcher, type FnddsRelease, type Ingredient, type UniverseRef,
} from "@/scripts/priors/crosswalk";
import { at } from "@/scripts/priors/sources";

/** Lookup order: a 2021-2023 code reads 2021-2023; a 2017-2020 code reads 2019-2020, then 2017-2018. */
export const FNDDS_DIRS = {
  "2021-2023": at("fndds", "2021-2023"), "2019-2020": at("fndds", "2019-2020"), "2017-2018": at("fndds", "2017-2018"),
} as const;
export type FnddsLabel = keyof typeof FNDDS_DIRS;

export function loadFndds(workspace: string, label: FnddsLabel): FnddsRelease {
  const dir = join(workspace, FNDDS_DIRS[label]);
  const codeOf = new Map(readCsv(join(dir, "survey_fndds_food.csv")).map((row) => [row.fdc_id, row.food_code]));
  const ingredients = new Map<string, (Ingredient & { seq: number })[]>();
  for (const row of readCsv(join(dir, "input_food.csv"))) {
    const code = codeOf.get(row.fdc_id);
    const grams = Number(row.gram_weight);
    if (!code || !Number.isFinite(grams)) continue;
    const list = ingredients.get(code) ?? [];
    list.push({ code: row.sr_code, description: row.sr_description, grams, seq: Number(row.seq_num) });
    ingredients.set(code, list);
  }
  for (const list of ingredients.values()) list.sort((a, b) => a.seq - b.seq || a.code.localeCompare(b.code));
  return { label, ingredients };
}

export type UniverseInputs = { items: UniverseItem[]; refs: UniverseRef[] };

export function loadUniverse(workspace: string): UniverseInputs {
  const ndbOf = new Map(readCsv(join(workspace, at("sr_legacy", "sr_legacy_food.csv"))).map((row) => [row.fdc_id, row.NDB_number]));
  const items = UNIVERSE.map(deriveItem).filter((item): item is UniverseItem => item !== null);
  const refs = items.map((item, order) => ({ key: item.entry.id, ndb: ndbOf.get(String(item.entry.fdcId)) ?? null,
    sr: item.row.sr, order }));
  return { items, refs };
}

export type Crosswalk = {
  universe: UniverseInputs;
  match: ReturnType<typeof createMatcher>;
  fndds: Record<FnddsLabel, FnddsRelease>;
  /** Index = NHANES release (0: 2017-2020, 1: 2021-2023), each with its own FNDDS lookup order. */
  expanders: [ReturnType<typeof createExpander>, ReturnType<typeof createExpander>];
};

/** The universe and the FNDDS-to-universe crosswalk, as the W1b build and the W1c pairing build read them. */
export function loadCrosswalk(workspace: string): Crosswalk {
  const universe = loadUniverse(workspace);
  const match = createMatcher(universe.refs);
  const fndds = { "2021-2023": loadFndds(workspace, "2021-2023"), "2019-2020": loadFndds(workspace, "2019-2020"),
    "2017-2018": loadFndds(workspace, "2017-2018") };
  return { universe, match, fndds,
    expanders: [createExpander([fndds["2019-2020"], fndds["2017-2018"], fndds["2021-2023"]], match),
      createExpander([fndds["2021-2023"], fndds["2019-2020"], fndds["2017-2018"]], match)] };
}

/** SR nutrient ids of the `nutr` profile: energy, water, protein, fat, carbohydrate, fibre, sugars,
 *  saturated fat, cholesterol, sodium, potassium, calcium, iron, vitamin C, vitamin A (RAE). */
export const NUTRIENT_IDS = ["1008", "1051", "1003", "1004", "1005", "1079", "2000", "1258", "1253", "1093",
  "1092", "1087", "1089", "1162", "1106"] as const;

export function loadNutrients(workspace: string, fdcIds: ReadonlySet<string>): Map<string, number[]> {
  const index = new Map<string, number>(NUTRIENT_IDS.map((id, i) => [id, i]));
  const out = new Map<string, number[]>();
  for (const row of readCsv(join(workspace, at("sr_legacy", "food_nutrient.csv")))) {
    if (!fdcIds.has(row.fdc_id)) continue;
    const at = index.get(row.nutrient_id);
    if (at === undefined) continue;
    const vector = out.get(row.fdc_id) ?? NUTRIENT_IDS.map(() => 0);
    vector[at] = Number(row.amount) || 0;
    out.set(row.fdc_id, vector);
  }
  return out;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
