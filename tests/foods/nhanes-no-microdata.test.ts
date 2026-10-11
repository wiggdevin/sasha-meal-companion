/**
 * Phase 18 W1b hard rule H2 (docs/specs/phase-18-open-world-foods.md D10; ruling
 * docs/decisions/2026-10-05-nhanes-aggregate-use.md rule 2): no code path joins NHANES microdata or
 * the respondent sequence number to an account. The shipped artifacts and every file under app/,
 * lib/, components/ and supabase/ are scanned for the survey's respondent-level field names; any
 * hit fails. The offline builds (scripts/priors/, and W1c's scripts/pairing/) are the only places
 * they may appear, and nothing the app ships imports them.
 *
 * Audit A057: the scan once read only source extensions, so a `dr1iff.csv` or a `.parquet` under
 * lib/ passed it. Now every file is read (names included), except a short list of media types,
 * and a binary file of any other type fails outright: a survey extract (xpt, parquet, sqlite,
 * gzip) cannot be read for field names, so it may not sit in a shipped tree at all.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_DIR } from "@/lib/foods/universe/prior";
import { MICRODATA_FIELDS } from "@/scripts/priors/check-artifact";

const SCANNED = ["app", "lib", "components", "supabase"];
/** Media the app ships as files: never a data extract, so not read for field names. */
const MEDIA = /\.(ico|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|mp3|mp4|webm)$/i;
/** Data and archive formats a survey extract travels in. Refused by name, whatever the content. */
const DATA_BINARY = /\.(xpt|sas7bdat|parquet|feather|arrow|orc|avro|db|sqlite3?|duckdb|dta|sav|rds|rda|rdata|h5|hdf5|npy|npz|pkl|pickle|gz|zip|bz2|xz|zst|7z|tar)$/i;

/** Local state that is gitignored and never ships: Finder metadata and the Supabase CLI's own. */
const LOCAL_ONLY = new Set([".DS_Store", path.join("supabase", ".temp"), path.join("supabase", ".branches")]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (LOCAL_ONLY.has(name) || LOCAL_ONLY.has(full)) return [];
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

/** Every reason one file breaks H2: a refused data format, an unreadable binary, or a field name. */
function microdataViolations(file: string): string[] {
  const name = path.basename(file);
  if (MEDIA.test(name)) return [];
  if (DATA_BINARY.test(name)) return [`${file}: data or archive format`];
  const bytes = readFileSync(file);
  // A NUL byte marks a binary file this scan cannot read (a parquet or sqlite under another name).
  if (bytes.includes(0)) return [`${file}: binary file`];
  return MICRODATA_FIELDS.test(name) || MICRODATA_FIELDS.test(bytes.toString("latin1"))
    ? [`${file}: respondent-level field name`] : [];
}

const scanned = SCANNED.flatMap(files);
const SOURCE = /\.(ts|tsx|js|mjs|cjs|json|sql|md|css)$/;

describe("H2: no NHANES microdata in the app", () => {
  it("scans a real tree", () => {
    expect(scanned.length).toBeGreaterThan(500);
    expect(scanned.some((file) => file.startsWith(ARTIFACT_DIR))).toBe(true);
  });

  it("finds no respondent-level field name, data extract or unreadable binary in app/, lib/, components/, supabase/ or the artifacts", () => {
    expect(scanned.flatMap(microdataViolations)).toEqual([]);
  });

  it("catches an extract in any data format (csv, tsv, txt, json, xpt, parquet, sqlite, gzip, no extension)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "h2-"));
    try {
      const rows = "SEQN,DR1IFDCD,DR1IGRMS\n109263,11111000,244\n";
      const cases: Record<string, string | Buffer> = {
        "dr1iff.csv": rows, "dr1iff.tsv": rows.replace(/,/g, "\t"), "notes.txt": rows,
        "cells.json": JSON.stringify([{ SEQN: 109263, rate: 0.1 }]), "extract": rows,
        "DR1IFF_L.xpt": "HEADER RECORD*******LIBRARY", "dr1iff.parquet": "PAR1", "survey.db": "SQLite format 3",
        "survey.sqlite": "x", "dr1iff.csv.gz": "x", "rows.bin": Buffer.from([0x50, 0x41, 0x52, 0x31, 0, 1, 2]),
        "SEQN-map.ts": "export const x = 1;\n",
      };
      for (const [name, body] of Object.entries(cases)) writeFileSync(path.join(dir, name), body);
      const flagged = files(dir).filter((file) => microdataViolations(file).length > 0).map((file) => path.basename(file));
      expect(flagged.sort()).toEqual(Object.keys(cases).sort());
      // And a clean tree stays clean: media, plain source and an aggregate cell pass.
      writeFileSync(path.join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
      writeFileSync(path.join(dir, "cells.csv"), "cohort,food_key,rate,n_eff\nadult,apple,0.12,410\n");
      expect(microdataViolations(path.join(dir, "icon.png"))).toEqual([]);
      expect(microdataViolations(path.join(dir, "cells.csv"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the pattern does catch the survey's own names", () => {
    for (const name of ["SEQN", "RIAGENDR", "RIDAGEYR", "RIDRETH3", "DR1IFDCD", "DR2IGRMS", "WTDRD1PP", "SDMVPSU"]) {
      expect(MICRODATA_FIELDS.test(`select ${name} from x`)).toBe(true);
    }
  });

  it("no shipped module imports the offline build", () => {
    const hits = scanned.filter((file) => SOURCE.test(file)
      && /(?:from|import)\s*\(?\s*["'][^"']*scripts\/(?:priors|pairing)/.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });
});
