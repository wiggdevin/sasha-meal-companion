/**
 * The FNDDS-inputs plan (Phase 18 W4, D5, D10): every documented recipe input of every FNDDS
 * 2021-2023 food, resolved to the catalog food it names. Offline import only; the writer is
 * scripts/import-fndds-inputs.ts.
 *
 * Inputs come only from the documented FNDDS recipes (`input_food.csv`). No model decomposes a
 * dish, and Jev is never called. A recipe input names an SR code, which is resolved in this order:
 *   fndds        an 8-digit FNDDS food code: a sub-recipe (read recursively at runtime);
 *   sr_legacy    an SR Legacy NDB number;
 *   foundation   a Foundation Foods NDB number (the newer USDA rows FNDDS 2021-2023 names);
 *   sr_modified  FNDDS's own modified SR item ("REDUCED SODIUM: <SR description>", code
 *                9 + the SR number): resolved to that SR item only when its SR description
 *                starts with the text after the prefix;
 *   fortificant  a nutrient added as an ingredient (999xxx, "Vitamin D as ingredient"): not a
 *                food, so it is not an input; counted and reported, never stored.
 * Anything else is UNRESOLVED and refuses the import (W4 acceptance 1: 0 unresolved codes).
 */
import { join } from "node:path";
import { readCsv } from "@/scripts/priors/csv";
import { FNDDS_FILES, FOUNDATION_SOURCE, SR_FILES } from "@/scripts/priors/input-sources";

export type CatalogSource = "fdc_fndds" | "fdc_sr_legacy" | "fdc_foundation";
export type InputKind = "fndds" | "sr_legacy" | "foundation" | "sr_modified";
export type CodeResolution =
  | { kind: InputKind; source: CatalogSource; fdcId: string }
  | { kind: "fortificant" }
  | null;

export type CodeMaps = {
  /** FNDDS food code → its FoodData Central id. */
  fnddsByCode: ReadonlyMap<string, string>;
  /** SR Legacy NDB number → { FoodData Central id, SR description }. */
  srByNdb: ReadonlyMap<string, { fdcId: string; description: string }>;
  /** Foundation NDB number → FoodData Central id. */
  foundationByNdb: ReadonlyMap<string, string>;
};

const FORTIFICANT_CODE = /^999\d{3}$/;
const FORTIFICANT_TEXT = /\bas ingredient\b|\bcomposite\b/i;
const MODIFIED_CODE = /^9\d{5}$/;
const MODIFIED_TEXT = /^(?:REDUCED SODIUM|LOW SODIUM|LOW FAT|REDUCED FAT|NO SALT ADDED|UNSALTED):\s*(.+)$/;

export function resolveCode(code: string, description: string, maps: CodeMaps): CodeResolution {
  if (/^\d{8}$/.test(code)) {
    const fdcId = maps.fnddsByCode.get(code);
    return fdcId ? { kind: "fndds", source: "fdc_fndds", fdcId } : null;
  }
  const sr = maps.srByNdb.get(code);
  if (sr) return { kind: "sr_legacy", source: "fdc_sr_legacy", fdcId: sr.fdcId };
  const foundation = maps.foundationByNdb.get(code);
  if (foundation) return { kind: "foundation", source: "fdc_foundation", fdcId: foundation };
  if (FORTIFICANT_CODE.test(code) && FORTIFICANT_TEXT.test(description)) return { kind: "fortificant" };
  const modified = MODIFIED_CODE.test(code) ? MODIFIED_TEXT.exec(description.trim()) : null;
  if (modified) {
    const base = maps.srByNdb.get(String(Number(code.slice(1))));
    if (base && base.description.toLowerCase().startsWith(modified[1].toLowerCase())) {
      return { kind: "sr_modified", source: "fdc_sr_legacy", fdcId: base.fdcId };
    }
  }
  return null;
}

/** One documented input row of a dish, as the source file has it. */
export type SourceInput = { seq: number; code: string; description: string; grams: number };
export type PlannedInput = SourceInput & { source: CatalogSource; fdcId: string; kind: InputKind };
export type Unresolved = { dishFdcId: string; seq: number; code: string; description: string };

export type InputPlan = {
  /** Dish FoodData Central id → its stored inputs, in `seq` order. */
  dishes: Map<string, PlannedInput[]>;
  report: {
    fnddsFoods: number; dishesListingInputs: number; dishesWithStoredInputs: number;
    sourceRows: number; storedRows: number; fortificantRows: number;
    byKind: Record<InputKind, number>; fortificantCodes: string[]; unresolved: Unresolved[];
    singleInputDishes: number;
  };
};

/** Builds the plan from the parsed files; pure. */
export function planInputs(rows: readonly Record<string, string>[], fnddsFoods: readonly Record<string, string>[],
  maps: CodeMaps): InputPlan {
  const byDish = new Map<string, SourceInput[]>();
  for (const row of rows) {
    const grams = Number(row.gram_weight);
    const seq = Number(row.seq_num);
    if (!Number.isFinite(grams) || grams <= 0 || !Number.isInteger(seq) || seq <= 0) {
      throw new Error(`input_food row ${row.id}: gram_weight ${row.gram_weight} / seq_num ${row.seq_num} out of range`);
    }
    const list = byDish.get(row.fdc_id) ?? [];
    if (list.some((item) => item.seq === seq)) throw new Error(`dish ${row.fdc_id}: seq ${seq} listed twice`);
    list.push({ seq, code: row.sr_code, description: row.sr_description, grams });
    byDish.set(row.fdc_id, list);
  }
  const plan: InputPlan = { dishes: new Map(), report: {
    fnddsFoods: fnddsFoods.length, dishesListingInputs: 0, dishesWithStoredInputs: 0, sourceRows: rows.length,
    storedRows: 0, fortificantRows: 0, byKind: { fndds: 0, sr_legacy: 0, foundation: 0, sr_modified: 0 },
    fortificantCodes: [], unresolved: [], singleInputDishes: 0,
  } };
  const fortificants = new Set<string>();
  const known = new Set(fnddsFoods.map((food) => food.fdc_id));
  for (const dishFdcId of [...byDish.keys()].sort((a, b) => Number(a) - Number(b))) {
    if (!known.has(dishFdcId)) throw new Error(`input_food names dish ${dishFdcId}, which survey_fndds_food does not list`);
    const inputs = byDish.get(dishFdcId)!.sort((a, b) => a.seq - b.seq);
    plan.report.dishesListingInputs += 1;
    const stored: PlannedInput[] = [];
    for (const input of inputs) {
      const resolved = resolveCode(input.code, input.description, maps);
      if (resolved === null) {
        plan.report.unresolved.push({ dishFdcId, seq: input.seq, code: input.code, description: input.description });
      } else if (resolved.kind === "fortificant") {
        plan.report.fortificantRows += 1;
        fortificants.add(input.code);
      } else {
        stored.push({ ...input, ...resolved });
        plan.report.byKind[resolved.kind] += 1;
      }
    }
    if (stored.length) {
      plan.dishes.set(dishFdcId, stored);
      plan.report.dishesWithStoredInputs += 1;
      plan.report.storedRows += stored.length;
      if (stored.length === 1) plan.report.singleInputDishes += 1;
    }
  }
  plan.report.fortificantCodes = [...fortificants].sort();
  return plan;
}

/** Reads the source files from the offline workspace and builds the plan. */
export function loadInputPlan(workspace: string): InputPlan {
  const read = (path: string) => readCsv(join(workspace, path));
  const fnddsFoods = read(FNDDS_FILES.codes);
  const srDescriptions = new Map(read(SR_FILES.descriptions).map((row) => [row.fdc_id, row.description]));
  const maps: CodeMaps = {
    fnddsByCode: new Map(fnddsFoods.map((row) => [row.food_code, row.fdc_id])),
    srByNdb: new Map(read(SR_FILES.foods).map((row) => [row.NDB_number,
      { fdcId: row.fdc_id, description: srDescriptions.get(row.fdc_id) ?? "" }])),
    foundationByNdb: new Map(read(FOUNDATION_SOURCE.files[0]).map((row) => [row.NDB_number, row.fdc_id])),
  };
  return planInputs(read(FNDDS_FILES.inputs), fnddsFoods, maps);
}
