import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { HAS_BRANCH } from "../helpers/supabase";
import { HAS_DB } from "./fixtures";

/** Shared by the recall suites: the synonyms file, the miss list and the branch gates. */
const CSV_PATH = "docs/catalog/synonyms.csv";
const CSV_HEADER = "term,expansion,source";

/** The 14 ranking misses in docs/catalog/relevance.md (2026-09-11). */
export const MISS_QUERIES = [
  "canned albacore", "eggs", "white rice", "sweet potato", "salmon", "scallops", "carrot",
  "pumpkin puree", "rotisserie chicken", "chicken thigh roasted", "white rice cooked",
  "chkn brst", "sweet potatoe", "salmom",
];

export function readSynonymsCsv(): { term: string; expansion: string; source: string }[] {
  const lines = readFileSync(CSV_PATH, "utf8").trim().split("\n");
  expect(lines[0]).toBe(CSV_HEADER);
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    expect(cells).toHaveLength(3);
    return { term: cells[0], expansion: cells[1], source: cells[2] };
  });
}

export function synonymMap(): Map<string, string> {
  return new Map(readSynonymsCsv().map((r) => [r.term, r.expansion]));
}

export const HAS_SQL = HAS_BRANCH && HAS_DB;
export const RUN_CATALOG = HAS_BRANCH && HAS_DB && process.env.CATALOG_ACTIVE === "1";

export type Hit = { catalog_food_id: number; description: string; source: string; score: number;
  f_lexical: number; f_trigram: number; f_brand: number; f_prep: number;
  f_prior: number; f_quality: number; f_eats: number };
