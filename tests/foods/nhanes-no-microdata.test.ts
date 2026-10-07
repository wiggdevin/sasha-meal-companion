/**
 * Phase 18 W1b hard rule H2 (docs/specs/phase-18-open-world-foods.md D10; ruling
 * docs/decisions/2026-10-05-nhanes-aggregate-use.md rule 2): no code path joins NHANES microdata or
 * the respondent sequence number to an account. The shipped artifacts and every file under app/,
 * lib/, components/ and supabase/ are scanned for the survey's respondent-level field names; any
 * hit fails. The offline builds (scripts/priors/, and W1c's scripts/pairing/) are the only places
 * they may appear, and nothing the app ships imports them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ARTIFACT_DIR } from "@/lib/foods/universe/prior";
import { MICRODATA_FIELDS } from "@/scripts/priors/check-artifact";

const SCANNED = ["app", "lib", "components", "supabase"];
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|sql|md|css)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : TEXT.test(name) ? [full] : [];
  });
}

const scanned = SCANNED.flatMap(files);

describe("H2: no NHANES microdata in the app", () => {
  it("scans a real tree", () => {
    expect(scanned.length).toBeGreaterThan(500);
    expect(scanned.some((file) => file.startsWith(ARTIFACT_DIR))).toBe(true);
  });

  it("finds no respondent-level field name in app/, lib/, components/, supabase/ or the artifacts", () => {
    const hits = scanned.filter((file) => MICRODATA_FIELDS.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the pattern does catch the survey's own names", () => {
    for (const name of ["SEQN", "RIAGENDR", "RIDAGEYR", "RIDRETH3", "DR1IFDCD", "DR2IGRMS", "WTDRD1PP", "SDMVPSU"]) {
      expect(MICRODATA_FIELDS.test(`select ${name} from x`)).toBe(true);
    }
  });

  it("no shipped module imports the offline build", () => {
    const hits = scanned.filter((file) => /(?:from|import)\s*\(?\s*["'][^"']*scripts\/(?:priors|pairing)/.test(readFileSync(file, "utf8")));
    expect(hits).toEqual([]);
  });
});
