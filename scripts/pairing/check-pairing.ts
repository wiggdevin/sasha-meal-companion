/**
 * The named hard-rule checks of the W1c pairing artifacts (Phase 18 D10, W1c acceptance 7): the
 * same H1–H5 rules and licence check as W1b (scripts/priors/check-artifact.ts), run on the
 * co-consumption table, the bundled pairing table and the pairing manifest.
 *
 *   pnpm exec tsx scripts/pairing/check-pairing.ts [--no-respondent-rows] [--min-effective-n 30]
 *     [--aggregate-schema] [--no-sensitive-axes] [--licences] [--activation] [--dir <artifact dir>]
 *
 * With no flag every check runs; exit 1 on any finding. build.ts runs them before it writes.
 *   H1  every artifact parses under its strict allowlist schema; no respondent-level name anywhere.
 *   H3  every co-consumption row, and so every shipped `co`, has n_eff ≥ 30.
 *   H4  pair rates only ({ anchor, side, template, rate, base_rate, n_eff }); any NHANES-derived
 *       output (a co row, a table row with `co`, an NHANES summary) needs the manifest to name the
 *       ruling at its approved hash; a table `co` must come from a shipped co row.
 *   H5  no race or ethnicity key, value or cohort anywhere.
 *   licences  W1b's allowlist; excluded sources fail.
 *   activation  no non-curated term carries a weight or a row without its validation evidence.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CoTableSchema, PairingManifestSchema, PairingTableSchema,
} from "@/lib/foods/pairing/schema";
import { CO_FILE, pairKey, PAIRING_DIR, PAIRING_MANIFEST_FILE, pairWithFeatures, TABLE_FILE, type PairRow } from "@/lib/foods/pairing/table";
import { MIN_EFFECTIVE_N, NHANES_RULING_PATH, NHANES_RULING_SHA256 } from "@/lib/foods/universe/prior";
import { schemaIssues } from "@/lib/foods/universe/artifact-schema";
import { activationViolations } from "@/lib/foods/pairing/gate";
import { coFeature } from "@/scripts/pairing/co-consumption";
import { MICRODATA_FIELDS, SENSITIVE, walk } from "@/scripts/priors/check-artifact";
import { licenceFindings } from "@/scripts/priors/sources";

export type PairingArtifacts = { co: unknown; table: unknown; manifest: unknown };

const rowsOf = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
const tableRows = (table: unknown) => rowsOf((table as { rows?: unknown } | null)?.rows);

function strictIssues(a: PairingArtifacts): string[] {
  const out = [...schemaIssues("manifest", PairingManifestSchema, a.manifest), ...schemaIssues("table", PairingTableSchema, a.table)];
  if (a.co !== null) out.push(...schemaIssues("co", CoTableSchema, a.co));
  return out;
}

function scan(a: PairingArtifacts, pattern: RegExp, what: string): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(a)) {
    walk(value, (key, leaf) => {
      if (key !== null && leaf === undefined && pattern.test(key)) out.push(`${name}: ${what} key ${key}`);
      if (typeof leaf === "string" && pattern.test(leaf)) out.push(`${name}: ${what} value in ${key}: ${leaf.slice(0, 60)}`);
    });
  }
  return out;
}

/** H1: strict allowlist schemas; no respondent-level field name as a key or a value. */
export function checkNoRespondentRows(a: PairingArtifacts): string[] {
  return [...strictIssues(a), ...scan(a, MICRODATA_FIELDS, "respondent-level")];
}

/** H3: every co-consumption row has at least `floor` effective respondents. */
export function checkMinEffectiveN(a: PairingArtifacts, floor = MIN_EFFECTIVE_N): string[] {
  return rowsOf(a.co).filter((row) => !(typeof row.n_eff === "number" && row.n_eff >= floor))
    .map((row) => `co: ${String(row.anchor)}/${String(row.side)}/${String(row.template)} has n_eff ${String(row.n_eff)} < ${floor}`);
}

/** H4: aggregate pair rates only; NHANES-derived output only under the named ruling; table co from co rows. */
export function checkAggregateSchema(a: PairingArtifacts): string[] {
  const out = strictIssues(a);
  const manifest = (a.manifest ?? {}) as { ruling?: { path?: unknown; sha256?: unknown } | null; nhanes?: unknown;
    sources?: { kind?: unknown }[] };
  const rows = tableRows(a.table) as Partial<PairRow>[];
  const derived = a.co !== null || rows.some((row) => row.co !== undefined) || (manifest.nhanes !== null && manifest.nhanes !== undefined);
  if (derived && (manifest.ruling?.path !== NHANES_RULING_PATH || manifest.ruling?.sha256 !== NHANES_RULING_SHA256)) {
    out.push(`manifest: NHANES-derived output without ${NHANES_RULING_PATH} at its approved hash`);
  }
  if (derived && (manifest.sources ?? []).filter((source) => source.kind === "nhanes").length < 2) out.push("manifest: source releases missing");
  const co = new Map(rowsOf(a.co).map((row) => [pairKey(String(row.anchor), String(row.side), row.template as "main"),
    coFeature(row as { rate: number; base_rate: number })]));
  const weights = (a.table as { weights?: { co: number; jev: number; comp: number } } | null)?.weights;
  for (const row of rows) {
    const key = pairKey(String(row.anchor), String(row.side), row.template as "main");
    const shipped = co.get(key);
    if (row.co !== undefined && (shipped === undefined || Math.abs(shipped - row.co) > 0.0005)) out.push(`table: ${key} co has no matching co-consumption row`);
    if (weights && typeof row.b === "number" && row.pair !== pairWithFeatures(row.b, { co: row.co, jev: row.jev, comp: row.comp }, weights)) {
      out.push(`table: ${key} pair does not follow the formula`);
    }
  }
  return out;
}

/** H5: no race or ethnicity anywhere. */
export function checkNoSensitiveAxes(a: PairingArtifacts): string[] {
  return scan(a, SENSITIVE, "sensitive");
}

/** W1b's licence allowlist on the manifest sources; the NCHS agreement only with the ruling at its hash. */
export function checkLicences(a: PairingArtifacts): string[] {
  const manifest = (a.manifest ?? {}) as { sources?: { id: string; name: string; url: string; licence: string }[];
    ruling?: { sha256?: unknown } | null };
  return licenceFindings(manifest.sources ?? [], manifest.ruling?.sha256 === NHANES_RULING_SHA256)
    .map((finding) => `licence: ${finding.source}: ${finding.problem}`);
}

/** The activation invariant (round 3): no non-curated weight or row without validation evidence. */
export function checkActivation(a: PairingArtifacts): string[] {
  const table = a.table as Parameters<typeof activationViolations>[0] | null;
  if (!table || !Array.isArray(table.rows) || !table.weights) return ["table: missing"];
  return activationViolations(table, a.manifest as Parameters<typeof activationViolations>[1]).map((issue) => `activation: ${issue}`);
}

export const PAIRING_CHECKS = {
  "--activation": checkActivation,
  "--no-respondent-rows": checkNoRespondentRows,
  "--min-effective-n": checkMinEffectiveN,
  "--aggregate-schema": checkAggregateSchema,
  "--no-sensitive-axes": checkNoSensitiveAxes,
  "--licences": checkLicences,
} as const;

export function runPairingChecks(a: PairingArtifacts, flags: readonly string[] = Object.keys(PAIRING_CHECKS)): string[] {
  return [...new Set(flags.flatMap((flag) => PAIRING_CHECKS[flag as keyof typeof PAIRING_CHECKS](a)))];
}

export function readPairingArtifacts(dir: string = PAIRING_DIR): PairingArtifacts {
  const read = (file: string) => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : null);
  return { co: read(CO_FILE), table: read(TABLE_FILE), manifest: read(PAIRING_MANIFEST_FILE) };
}

function main(argv: readonly string[]): number {
  const dirAt = argv.indexOf("--dir");
  const flags = argv.filter((arg) => arg in PAIRING_CHECKS);
  const findings = runPairingChecks(readPairingArtifacts(dirAt >= 0 ? argv[dirAt + 1] : PAIRING_DIR), flags.length ? flags : undefined);
  for (const finding of findings) console.error(finding);
  console.log(findings.length ? `FAIL: ${findings.length} finding(s)` : `PASS: ${(flags.length ? flags : Object.keys(PAIRING_CHECKS)).join(" ")}`);
  return findings.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
