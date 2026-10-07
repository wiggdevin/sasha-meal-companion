/**
 * The W4 FNDDS-inputs import's source files (Phase 18 W4, D10): the FNDDS 2021-2023 recipes and
 * the SR Legacy numbers from the W1b list (sources.ts), plus the FoodData Central Foundation list,
 * whose NDB numbers some 2021-2023 recipes name. The same allowlisted licence check as W1b runs on
 * every one before the import reads a byte. Offline import only.
 *
 * Foundation is the release the catalog carries (scripts/import-fdc.py pins 2026-04-30), so an
 * NDB number maps to the same FoodData Central id the catalog row was imported under.
 */
import { at, SOURCES, type Source } from "@/scripts/priors/sources";

const FDC = "https://fdc.nal.usda.gov/fdc-datasets";

export const FOUNDATION_SOURCE: Source = {
  id: "fdc-foundation-2026-04-30", name: "FoodData Central Foundation Foods (2026-04-30)", kind: "fdc",
  url: `${FDC}/FoodData_Central_foundation_food_csv_2026-04-30.zip`, licence: "cc0-1.0",
  terms: "U.S. government work; FoodData Central data are published under CC0 1.0",
  use: "NDB numbers of Foundation foods that FNDDS 2021-2023 recipes name as inputs (W4)",
  files: [at("foundation", "foundation_food.csv")],
};

function w1b(id: string): Source {
  const source = SOURCES.find((item) => item.id === id);
  if (!source) throw new Error(`W1b source ${id} is missing`);
  return source;
}

/** Every file the import reads, in the order the report lists them. */
export const INPUT_SOURCES: readonly Source[] = [w1b("fndds-2021-2023"), w1b("fdc-sr-legacy"), FOUNDATION_SOURCE];

/** The FNDDS release the inputs come from, and the files of it the import reads. */
export const FNDDS_DIR = at("fndds", "2021-2023");
export const FNDDS_FILES = {
  inputs: at(FNDDS_DIR, "input_food.csv"),
  codes: at(FNDDS_DIR, "survey_fndds_food.csv"),
  /** What the catalog import builds each `fdc_fndds` revision from (the release fingerprint). */
  foods: at(FNDDS_DIR, "food.csv"),
  nutrients: at(FNDDS_DIR, "food_nutrient.csv"),
  nutrientList: at(FNDDS_DIR, "nutrient.csv"),
  portions: at(FNDDS_DIR, "food_portion.csv"),
  units: at(FNDDS_DIR, "measure_unit.csv"),
} as const;

/**
 * The FNDDS release the inputs belong to (Sol W4 r1 BLOCK 1): the catalog's `fdc_fndds` version
 * that scripts/import-fdc.py imported under `versionLabel` from the zip with `zipSha256` (that
 * worker records it in `~/Backups/usda/fdc/<versionLabel>/checksums.json`). The import refuses the
 * whole run unless the workspace zip, the files read from it, the worker's ledger and the active
 * catalog version all name this release, and every dish revision belongs to that version. A new
 * FNDDS catalog label moves this pin in the same change.
 */
export const FNDDS_RELEASE = {
  catalogSource: "fdc_fndds",
  versionLabel: "2026-09-12",
  zip: at("downloads", "FoodData_Central_survey_food_csv_2024-10-31.zip"),
  zipSha256: "5ccc25ec2777a8982fbb61378a42f415316173eb11e48c9a8ba4cb19f5a4f29c",
} as const;
export const SR_FILES = { foods: at("sr_legacy", "sr_legacy_food.csv"), descriptions: at("sr_legacy", "food.csv") } as const;
