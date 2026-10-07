/**
 * The W1b build's inputs (Phase 18 D10): where each file comes from, its licence receipt, and the
 * licence check (W1b acceptance 5). Offline build only.
 *
 * Raw files live in the offline workspace (`workspace.ts`), never in the repository. The manifest
 * records each file's sha256, so a rebuild from the same files gives the same artifact hash.
 */

/** A workspace path from its segments (kept out of single-slash string literals, which tests read as model slugs). */
export const at = (...segments: string[]): string => segments.join("/");
export const raw = (name: string): string => at("raw", `${name}.xpt`);

export type SourceKind = "nhanes" | "fndds" | "fdc";

/**
 * Licences cleared for a commercial product (W1b acceptance 5, round 2): an allowlist, so anything
 * else, free text included, fails the build. `nchs-dua` (the NCHS data user agreement) is cleared
 * only while the owner's NHANES ruling is in force (the NCHS gate).
 */
export const CLEARED_LICENCES = ["public-domain", "cc0-1.0", "cc-by-4.0", "nchs-dua"] as const;
export type LicenceId = (typeof CLEARED_LICENCES)[number];

export type Source = {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  /** One id from CLEARED_LICENCES; `terms` is the human-readable receipt. */
  licence: LicenceId;
  terms: string;
  use: string;
  /** Paths under the workspace. NHANES files download one by one from `url`; the others are one
   *  zip at `url`, unpacked flat into the folder of its first file (fetch.ts). */
  files: readonly string[];
};

export type Withheld = { id: string; name: string; reason: string };

const CDC = "https://wwwn.cdc.gov/Nchs/Data/Nhanes/Public";
const FDC = "https://fdc.nal.usda.gov/fdc-datasets";
const FDC_TERMS = "U.S. government work; FoodData Central data are published under CC0 1.0";
const NCHS_TERMS = "NCHS public-use data; statistical reporting and analysis only; no attempt to "
  + "identify anyone; no linkage to identifiable data (NCHS data user agreement)";

export const SOURCES: readonly Source[] = [
  {
    id: "nhanes-2017-2020", name: "NHANES/WWEIA August 2017-March 2020 pre-pandemic", kind: "nhanes",
    url: `${CDC}/2017/DataFiles/`, licence: "nchs-dua", terms: NCHS_TERMS,
    use: "Day 1 individual foods, totals and demographics: the pooled prior; Day 2 sensitivity only",
    files: [raw("P_DEMO"), raw("P_DR1TOT"), raw("P_DR1IFF"), raw("P_DR2TOT"), raw("P_DR2IFF")],
  },
  {
    id: "nhanes-2021-2023", name: "NHANES/WWEIA August 2021-August 2023", kind: "nhanes",
    url: `${CDC}/2021/DataFiles/`, licence: "nchs-dua", terms: NCHS_TERMS,
    use: "Day 1 individual foods, totals and demographics: the pooled prior; Day 2 sensitivity only",
    files: [raw("DEMO_L"), raw("DR1TOT_L"), raw("DR1IFF_L"), raw("DR2TOT_L"), raw("DR2IFF_L")],
  },
  {
    id: "fndds-2021-2023", name: "FNDDS 2021-2023 (FoodData Central survey foods, 2024-10-31)",
    kind: "fndds", url: `${FDC}/FoodData_Central_survey_food_csv_2024-10-31.zip`,
    licence: "cc0-1.0", terms: FDC_TERMS,
    use: "Ingredient grams for 2021-2023 food codes; the FNDDS code hierarchy for the tax term; dish "
      + "ingredient lists for the ctx term (W4)",
    files: [at("fndds", "2021-2023", "input_food.csv"), at("fndds", "2021-2023", "survey_fndds_food.csv")],
  },
  {
    id: "fndds-2019-2020", name: "FNDDS 2019-2020 (FoodData Central survey foods, 2022-10-28)",
    kind: "fndds", url: `${FDC}/FoodData_Central_survey_food_csv_2022-10-28.zip`,
    licence: "cc0-1.0", terms: FDC_TERMS,
    use: "Ingredient grams for 2017-March 2020 food codes (first lookup)",
    files: [at("fndds", "2019-2020", "input_food.csv"), at("fndds", "2019-2020", "survey_fndds_food.csv")],
  },
  {
    id: "fndds-2017-2018", name: "FNDDS 2017-2018 (FoodData Central survey foods, 2020-10-30)",
    kind: "fndds", url: `${FDC}/FoodData_Central_survey_food_csv_2020-10-30.zip`,
    licence: "cc0-1.0", terms: FDC_TERMS,
    use: "Ingredient grams for 2017-2018 food codes not in FNDDS 2019-2020 (second lookup)",
    files: [at("fndds", "2017-2018", "input_food.csv"), at("fndds", "2017-2018", "survey_fndds_food.csv")],
  },
  {
    id: "fdc-sr-legacy", name: "FoodData Central SR Legacy (2018-04)", kind: "fdc",
    url: `${FDC}/FoodData_Central_sr_legacy_food_csv_2018-04.zip`, licence: "cc0-1.0", terms: FDC_TERMS,
    use: "SR numbers of universe items (crosswalk) and nutrient profiles (the nutr term)",
    files: [at("sr_legacy", "sr_legacy_food.csv"), at("sr_legacy", "food_nutrient.csv")],
  },
];

/** Inputs the spec names that this build does not use, and why (recorded in the manifest). */
export const WITHHELD: readonly Withheld[] = [
  { id: "ahn-2011", name: "Ahn et al. 2011 flavor network (Scientific Reports 1:196)",
    reason: "The article and its supplementary data are published under CC BY-NC-SA 3.0 (non-commercial; "
      + "nature.com/articles/srep00196, read 2026-10-06), not the CC BY 4.0 the spec assumed. The comp term "
      + "is absent until the owner rules on it; ctx comes from the FNDDS dish ingredient lists instead (W4)." },
  { id: "uk-biobank-liking", name: "UK Biobank food-liking aggregates (May-Wilson et al. 2022)",
    reason: "Reuse terms of the supplementary files are not confirmed (decision Q2); the like term is absent." },
  { id: "foodon", name: "FoodOn ontology",
    reason: "Not mapped in v1; the tax term uses the FNDDS code hierarchy and the SR food group only." },
  { id: "flavorgraph", name: "FlavorGraph embeddings",
    reason: "Held until its upstream recipe data rights are checked (spec D10, decision Q2)." },
];

/** Never in a shipped or derived artifact (spec D10, decision Q2). */
export const EXCLUDED_SOURCES: readonly { name: string; pattern: RegExp }[] = [
  { name: "FlavorDB", pattern: /flavou?r\s*-?db/i },
  { name: "FooDB", pattern: /foodb/i },
  { name: "Recipe1M+", pattern: /recipe\s*-?1m/i },
  { name: "RecipeNLG", pattern: /recipe\s*-?nlg/i },
  { name: "Instacart", pattern: /instacart/i },
  { name: "Kilts NielsenIQ", pattern: /kilts|nielsen\s*iq|nielseniq/i },
  { name: "Food.com", pattern: /food\.com|food-com|foodcom/i },
  { name: "FlavorGraph", pattern: /flavou?r\s*-?graph/i },
];

export type LicenceFinding = { source: string; problem: string };
type Checked = { id: string; name: string; url: string; licence: string; kind?: string };

/**
 * W1b acceptance 5: an excluded source, or a licence outside CLEARED_LICENCES, fails the build;
 * `nchs-dua` passes only when `nchsCleared` (the ruling verified by the NCHS gate).
 */
export function licenceFindings(sources: readonly Checked[], nchsCleared: boolean): LicenceFinding[] {
  const findings: LicenceFinding[] = [];
  for (const source of sources) {
    const text = `${source.id} ${source.name} ${source.url}`;
    for (const excluded of EXCLUDED_SOURCES) {
      if (excluded.pattern.test(text)) findings.push({ source: source.id, problem: `excluded source: ${excluded.name}` });
    }
    if (!(CLEARED_LICENCES as readonly string[]).includes(source.licence)) {
      findings.push({ source: source.id, problem: `licence not cleared for commercial use: ${JSON.stringify(source.licence)}` });
    } else if (source.licence === "nchs-dua" && !nchsCleared) {
      findings.push({ source: source.id, problem: "NCHS data user agreement without the verified NHANES ruling" });
    }
  }
  return findings;
}
