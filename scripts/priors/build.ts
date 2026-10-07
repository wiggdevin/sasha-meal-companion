/**
 * The W1b data build (Phase 18 D10): the U.S. adult population prior and the typed substitute graph.
 *
 *   pnpm exec tsx scripts/priors/fetch.ts      once: public files into the offline workspace
 *   pnpm exec tsx scripts/priors/build.ts      build, check, write artifacts and reports
 *   pnpm exec tsx scripts/priors/build.ts --check   rebuild in memory; exit 1 unless the artifact
 *                                                   hash equals the committed manifest's
 *
 * Order (D10): NCHS gate → licence check (allowlist) → source checksums → FNDDS crosswalk →
 * [gate open only: Day 1 panel → nested holdouts → fairness audit → Day 2 sensitivity → final adult
 * table] → substitute graph → named checks (H1–H5, licences) → regression check against the
 * committed manifest → write. Respondent-level frames stay in memory; only aggregates are written
 * (H1). With the gate shut (the ruling missing, or not at its approved hash), the build never reads
 * NHANES: it writes no prior table, no NHANES-derived manifest field and no NHANES-derived report,
 * and removes stale ones; the graph is still built.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UNIVERSE_HASH, UNIVERSE_VERSION } from "@/lib/foods/universe/manifest";
import type { PriorsManifest } from "@/lib/foods/universe/artifact-schema";
import {
  ARTIFACT_DIR, GRAPH_FILE, MANIFEST_FILE, NHANES_RULING_PATH, NHANES_RULING_SHA256, PRIOR_FILE,
} from "@/lib/foods/universe/prior";
import { artifactText, buildGateReason, canonical, gzipBytes, sha256 } from "@/scripts/priors/artifact-io";
import { buildNhanes } from "@/scripts/priors/build-nhanes";
import { runChecks } from "@/scripts/priors/check-artifact";
import { buildContext } from "@/scripts/priors/context";
import { buildSubstituteGraph, representativeCodes, TERM_SOURCES } from "@/scripts/priors/graph";
import { loadCrosswalk, loadNutrients, sha256File } from "@/scripts/priors/inputs";
import { REPORT_FILES, writeReports } from "@/scripts/priors/report";
import { licenceFindings, SOURCES, WITHHELD } from "@/scripts/priors/sources";
import { resolveWorkspace } from "@/scripts/priors/workspace";

export const COEFFICIENT_VERSION = "prior-2.0.0";
export const SIZE_BUDGET_GZIP = 150 * 1024;
const COVERAGE_DROP_MAX = 0.01;
const CALIBRATION_WORSEN_MAX = 0.005;

function fail(message: string): never {
  console.error(`build refused: ${message}`);
  process.exit(1);
}

/** Coverage and calibration may not regress against a previous build with the same metric definitions. */
function regressions(previous: unknown, next: PriorsManifest): string[] {
  const before = previous as { metricsVersion?: number; nhanes?: PriorsManifest["nhanes"] } | null;
  if (before?.metricsVersion !== next.metricsVersion || !before.nhanes || !next.nhanes) return [];
  const out: string[] = [];
  if (before.nhanes.mapping.coverageAllGrams - next.nhanes.mapping.coverageAllGrams > COVERAGE_DROP_MAX) out.push("mapping coverage fell");
  if (next.nhanes.calibration.brier - before.nhanes.calibration.brier > CALIBRATION_WORSEN_MAX) out.push("Brier worsened");
  if (next.nhanes.calibration.ece - before.nhanes.calibration.ece > CALIBRATION_WORSEN_MAX) out.push("ECE worsened");
  return out;
}

function main(): void {
  const root = process.cwd();
  const checkOnly = process.argv.includes("--check");
  const workspace = resolveWorkspace(root);
  const gate = buildGateReason(root);
  if (gate) console.warn(`NCHS gate shut (${gate}): no NHANES-derived output`);
  const inputs = SOURCES.filter((source) => !gate || source.kind !== "nhanes");
  const licence = licenceFindings(inputs, !gate);
  if (licence.length) fail(licence.map((item) => `${item.source}: ${item.problem}`).join("; "));
  const sources = inputs.map((source) => ({ id: source.id, name: source.name, kind: source.kind, url: source.url,
    licence: source.licence, terms: source.terms, use: source.use,
    files: source.files.map((file) => ({ path: file, sha256: sha256File(join(workspace, file)) })) }));

  const { universe, match, fndds, expanders } = loadCrosswalk(workspace);
  const foods = universe.refs.map((ref) => ref.key);
  const nhanes = gate ? null : buildNhanes(workspace, foods, expanders, match);

  const codes2021 = [...fndds["2021-2023"].ingredients.keys()];
  const representative = representativeCodes(codes2021, expanders[1].expand);
  const nutrients = loadNutrients(workspace, new Set(universe.items.map((item) => String(item.entry.fdcId))));
  const context = buildContext(codes2021, expanders[1].expand);
  const graph = buildSubstituteGraph(universe.items, nutrients, representative, context);
  const licenceOf = new Map(sources.map((source) => [source.id, source.licence]));
  const terms = Object.fromEntries(Object.entries(TERM_SOURCES).map(([term, ids]) =>
    [term, { sources: ids, licences: [...new Set(ids.map((id) => licenceOf.get(id) ?? "missing"))] }]));

  const rows = nhanes?.rows ?? null;
  const priorText = rows ? artifactText(rows) : null;
  const graphText = artifactText(graph);
  const manifest: PriorsManifest = {
    schema: 3, metricsVersion: 2, coefficientVersion: COEFFICIENT_VERSION,
    artifactHash: sha256(`${rows ? canonical(rows) : "null"}\n${canonical(graph)}`),
    ruling: gate ? null : { path: NHANES_RULING_PATH, sha256: NHANES_RULING_SHA256 },
    prior: rows ? { file: PRIOR_FILE, sha256: sha256(priorText!), rows: rows.length } : null,
    graph: { file: GRAPH_FILE, sha256: sha256(graphText), version: graph.version, edges: graph.edges.length, absent: graph.absent,
      terms, context: { dishes: context.dishes, foods: context.foods } },
    universe: { version: UNIVERSE_VERSION, hash: UNIVERSE_HASH },
    sources, withheld: [...WITHHELD], licenceCheck: "pass", nhanes: nhanes?.summary ?? null,
  };
  const manifestText = artifactText(manifest);
  const findings = runChecks({ prior: rows, graph, manifest });
  if (findings.length) fail(findings.join("; "));
  const sizes = { prior: priorText ? gzipBytes(priorText) : 0, graph: gzipBytes(graphText), manifest: gzipBytes(manifestText) };

  const dir = join(root, ARTIFACT_DIR);
  const previous = existsSync(join(dir, MANIFEST_FILE)) ? JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) : null;
  if (checkOnly) {
    const same = previous?.artifactHash === manifest.artifactHash;
    console.log(`${same ? "SAME" : "DIFFERENT"} artifact hash ${manifest.artifactHash} (committed ${previous?.artifactHash ?? "none"})`);
    process.exit(same ? 0 : 1);
  }
  const regressed = regressions(previous, manifest);
  if (regressed.length) fail(regressed.join("; "));

  mkdirSync(dir, { recursive: true });
  if (priorText) writeFileSync(join(dir, PRIOR_FILE), priorText);
  else rmSync(join(dir, PRIOR_FILE), { force: true });
  writeFileSync(join(dir, GRAPH_FILE), graphText);
  writeFileSync(join(dir, MANIFEST_FILE), manifestText);
  if (nhanes) {
    writeReports(root, { ...nhanes.report, manifest, sizes, budget: SIZE_BUDGET_GZIP, graph, representative: representative.size });
  } else {
    for (const file of REPORT_FILES) rmSync(join(root, file), { force: true });
  }
  console.log(`artifact hash ${manifest.artifactHash}; prior ${rows?.length ?? 0} rows; graph ${graph.edges.length} edges; `
    + `gzip ${sizes.prior + sizes.graph + sizes.manifest} bytes (graph ${sizes.graph}); ctx ${context.dishes} dishes, ${context.foods} foods; sex by age ${nhanes?.summary.coefficients.sexAgeEnabled ? "enabled" : "disabled"}`);
}

main();
