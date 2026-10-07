/**
 * The named checks of the W1b artifacts (spec D10, hard rules H1–H5, acceptance 5 and 7):
 *
 *   pnpm exec tsx scripts/priors/check-artifact.ts [--no-respondent-rows] [--min-effective-n 30]
 *     [--aggregate-schema] [--no-sensitive-axes] [--licences] [--dir <artifact dir>]
 *
 * With no check flag every check runs. Exit 1 on any finding. build.ts runs the same checks before
 * it writes, so a failing artifact is never emitted. tests/foods/priors-check-artifact.test.ts
 * proves each one catches its fault.
 *
 * H1 is fail-closed: every artifact must parse under its strict allowlist schema
 * (lib/foods/universe/artifact-schema.ts), so an unknown key at any depth fails whatever it is
 * called. The field-name scan is a second net, not the rule.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  graphRuleIssues, ManifestSchema, PriorTableSchema, schemaIssues, SubstituteGraphSchema,
} from "@/lib/foods/universe/artifact-schema";
import {
  ARTIFACT_DIR, GRAPH_FILE, MANIFEST_FILE, NHANES_RULING_PATH, NHANES_RULING_SHA256, PRIOR_FILE,
} from "@/lib/foods/universe/prior";
import { SUBSTITUTE_TERMS } from "@/lib/foods/universe/substitutes";
import { CLEARED_LICENCES, licenceFindings } from "@/scripts/priors/sources";

export type Artifacts = { prior: unknown; graph: unknown; manifest: unknown };

/** Respondent-level field names of the NHANES files (H1, H2). */
export const MICRODATA_FIELDS = /\b(SEQN|RIAGENDR|RIDAGEYR|RIDAGEMN|RIDRETH[0-9]|DMDEDUC[0-9]|INDFMPIR|SDMVPSU|SDMVSTRA|WTDRD1(?:PP)?|WTDR2D(?:PP)?|WTINT2YR|WTMEC2YR|DR[12]IFDCD|DR[12]IGRMS|DR[12]DRSTZ|DR[12]_0[0-9]{2}Z?|DR[12]DAY)\b/;
export const SENSITIVE = /RIDRETH|\brace\b|\bracial\b|ethnic|hispanic|latino|non-hispanic/i;

export function walk(value: unknown, visit: (key: string | null, leaf: unknown) => void, key: string | null = null): void {
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit, key));
  else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) { visit(name, undefined); walk(item, visit, name); }
  } else visit(key, value);
}

const rowsOf = (prior: unknown): Record<string, unknown>[] =>
  (Array.isArray(prior) ? prior : []).filter((row): row is Record<string, unknown> => !!row && typeof row === "object");

/** Strict allowlist parse of every artifact present (the prior may be absent: gate shut). */
function strictIssues(a: Artifacts): string[] {
  const out = [...schemaIssues("manifest", ManifestSchema, a.manifest), ...schemaIssues("graph", SubstituteGraphSchema, a.graph)];
  const graph = SubstituteGraphSchema.safeParse(a.graph);
  if (graph.success) out.push(...graphRuleIssues(graph.data));
  if (a.prior !== null) out.push(...schemaIssues("prior", PriorTableSchema, a.prior));
  return out;
}

/** H1: every artifact is exactly its allowlist schema; no respondent-level name anywhere. */
export function checkNoRespondentRows(a: Artifacts): string[] {
  const out = strictIssues(a);
  for (const [name, value] of Object.entries(a)) {
    walk(value, (key, leaf) => {
      if (key !== null && leaf === undefined && MICRODATA_FIELDS.test(key)) out.push(`${name}: respondent-level key ${key}`);
      if (typeof leaf === "string" && MICRODATA_FIELDS.test(leaf)) out.push(`${name}: microdata field named in ${key}: ${leaf.slice(0, 60)}`);
    });
  }
  return out;
}

/** H3: every shipped cell has at least `floor` effective respondents. */
export function checkMinEffectiveN(a: Artifacts, floor = 30): string[] {
  return rowsOf(a.prior).filter((row) => !(typeof row.n_eff === "number" && row.n_eff >= floor))
    .map((row) => `prior: ${row.cohort}/${row.food_key} has n_eff ${String(row.n_eff)} < ${floor}`);
}

/** H4: aggregate rows only; a shipped table needs a manifest naming the ruling's path and approved hash. */
export function checkAggregateSchema(a: Artifacts): string[] {
  const out = strictIssues(a);
  const manifest = (a.manifest ?? {}) as { ruling?: { path?: unknown; sha256?: unknown } | null; nhanes?: unknown;
    sources?: { kind?: unknown }[] };
  const derived = a.prior !== null || (manifest.nhanes !== null && manifest.nhanes !== undefined);
  if (derived && (manifest.ruling?.path !== NHANES_RULING_PATH || manifest.ruling?.sha256 !== NHANES_RULING_SHA256)) {
    out.push(`manifest: NHANES-derived output without ${NHANES_RULING_PATH} at its approved hash`);
  }
  if (derived && (manifest.sources ?? []).filter((source) => source.kind === "nhanes").length < 2) out.push("manifest: source releases missing");
  return out;
}

/** H5: no race or ethnicity field, value or cohort in any artifact. */
export function checkNoSensitiveAxes(a: Artifacts): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(a)) {
    walk(value, (key, leaf) => {
      if (key !== null && leaf === undefined && SENSITIVE.test(key)) out.push(`${name}: sensitive key ${key}`);
      if (typeof leaf === "string" && SENSITIVE.test(leaf)) out.push(`${name}: sensitive value in ${key}: ${leaf.slice(0, 60)}`);
    });
  }
  return out;
}

type TermSources = Record<string, { sources?: string[]; licences?: string[] } | undefined>;

/**
 * W4 acceptance 4: every substitute term the graph carries names its sources and their licences
 * in the manifest, each a listed, allowlisted source; an absent term names none; and the NCHS
 * agreement never feeds the graph (it is not NHANES-derived).
 */
function graphTermFindings(manifest: { sources?: { id: string; licence: string }[]; graph?: { absent?: string[];
  terms?: TermSources } }): string[] {
  const out: string[] = [];
  const licenceOf = new Map((manifest.sources ?? []).map((source) => [source.id, source.licence]));
  const absent = new Set(manifest.graph?.absent ?? []);
  const terms = manifest.graph?.terms ?? {};
  for (const term of SUBSTITUTE_TERMS) {
    const entry = terms[term];
    if (absent.has(term)) {
      if (entry) out.push(`licence: graph term ${term} is absent but names sources`);
      continue;
    }
    if (!entry?.sources?.length) { out.push(`licence: graph term ${term} names no source`); continue; }
    const licences = entry.sources.map((id) => licenceOf.get(id));
    if (licences.some((licence) => licence === undefined)) out.push(`licence: graph term ${term} names an unlisted source`);
    if (licences.some((licence) => licence === "nchs-dua")) out.push(`licence: graph term ${term} uses NHANES data`);
    const named = [...new Set(licences.filter((licence): licence is string => !!licence))].sort();
    if (named.join() !== [...new Set(entry.licences ?? [])].sort().join()) {
      out.push(`licence: graph term ${term} licences ${JSON.stringify(entry.licences)} differ from its sources'`);
    }
    for (const licence of entry.licences ?? []) {
      if (!(CLEARED_LICENCES as readonly string[]).includes(licence)) out.push(`licence: graph term ${term}: ${licence} not cleared`);
    }
  }
  return out;
}

/** Acceptance 5: allowlisted licences only; the NCHS agreement only with the ruling at its approved hash. */
export function checkLicences(a: Artifacts): string[] {
  const manifest = (a.manifest ?? {}) as { sources?: { id: string; name: string; url: string; licence: string }[];
    ruling?: { sha256?: unknown } | null; graph?: { absent?: string[]; terms?: TermSources } };
  const sources = manifest.sources ?? [];
  if (!sources.length) return ["manifest: no sources"];
  return [...licenceFindings(sources, manifest.ruling?.sha256 === NHANES_RULING_SHA256)
    .map((finding) => `licence: ${finding.source}: ${finding.problem}`), ...graphTermFindings(manifest)];
}

export const CHECKS = {
  "--no-respondent-rows": checkNoRespondentRows,
  "--min-effective-n": checkMinEffectiveN,
  "--aggregate-schema": checkAggregateSchema,
  "--no-sensitive-axes": checkNoSensitiveAxes,
  "--licences": checkLicences,
} as const;

export function runChecks(a: Artifacts, flags: readonly string[] = Object.keys(CHECKS), floor = 30): string[] {
  const findings = flags.flatMap((flag) => flag === "--min-effective-n" ? checkMinEffectiveN(a, floor)
    : CHECKS[flag as keyof typeof CHECKS](a));
  return [...new Set(findings)];
}

export function readArtifacts(dir: string): Artifacts {
  const read = (file: string) => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), "utf8")) : null);
  return { prior: read(PRIOR_FILE), graph: read(GRAPH_FILE), manifest: read(MANIFEST_FILE) };
}

function main(argv: readonly string[]): number {
  const dirAt = argv.indexOf("--dir");
  const dir = dirAt >= 0 ? argv[dirAt + 1] : ARTIFACT_DIR;
  const floorAt = argv.indexOf("--min-effective-n");
  const floor = floorAt >= 0 && /^\d+$/.test(argv[floorAt + 1] ?? "") ? Number(argv[floorAt + 1]) : 30;
  const flags = argv.filter((arg) => arg in CHECKS);
  const findings = runChecks(readArtifacts(dir), flags.length ? flags : Object.keys(CHECKS), floor);
  for (const finding of findings) console.error(finding);
  console.log(findings.length ? `FAIL: ${findings.length} finding(s)` : `PASS: ${(flags.length ? flags : Object.keys(CHECKS)).join(" ")}`);
  return findings.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
