/**
 * The W1c pairing build (Phase 18 D8 part 5, D10): the NHANES co-consumption table and the bundled
 * pairing table with its manifest.
 *
 *   pnpm exec tsx scripts/pairing/build.ts           build, check, write artifacts and the report
 *   pnpm exec tsx scripts/pairing/build.ts --check   rebuild in memory; exit 1 unless the artifact
 *                                                    hash equals the committed manifest's
 *
 * Order: fixed pairs with curated B (pairs.ts) → NCHS gate → [gate open only: licence check →
 * source checksums → FNDDS crosswalk → Day 1 occasions → co-consumption rows] → Jev feature (only a
 * passed calibration, and only when its weight is above 0) → table → named checks (H1–H5,
 * licences) → write. The gate shut (ruling missing or not at its approved hash), the build never
 * reads NHANES: no co-consumption file, no NHANES manifest field, no NHANES report section. The Ahn
 * lists are withheld (CC BY-NC-SA), so the `co` term is then empty and `comp` is always absent.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANES } from "@/lib/ai/lanes";
import { PAIR_PROMPT_VERSION, PAIR_RUBRIC_VERSION } from "@/lib/foods/pairing/questions";
import type { CoRow, PairingManifest } from "@/lib/foods/pairing/schema";
import {
  buildPairingTable, CO_FILE, PAIR_CO_TARGET_WEIGHT, PAIR_JEV_TARGET_WEIGHT, PAIRING_CURATED_SHA256, rowsCuratedHash, PAIR_WEIGHTS, pairKey, PAIRING_DIR, PAIRING_MANIFEST_FILE,
  PAIRING_TABLE_VERSION, TABLE_FILE, type PairingTable, type PairWeights,
} from "@/lib/foods/pairing/table";
import { UNIVERSE_HASH, UNIVERSE_VERSION } from "@/lib/foods/universe/manifest";
import { NHANES_RULING_PATH, NHANES_RULING_SHA256 } from "@/lib/foods/universe/prior";
import { assertActivationAuthorized } from "@/lib/foods/pairing/gate";
import { pairingText } from "@/scripts/pairing/artifact-io";
import { applyPlatt, CALIBRATION_FILE, CALIBRATION_REPORT, type Platt } from "@/scripts/pairing/calibrate";
import { runPairingChecks } from "@/scripts/pairing/check-pairing";
import { ANCHOR_GRAMS, CO_TRANSFORM, coConsumption, coFeature, FAT_GRAMS, SIDE_GRAMS } from "@/scripts/pairing/co-consumption";
import { labelsFor, readStore, type LabelStore } from "@/scripts/pairing/labels";
import { loadOccasions, OCCASION_RULE } from "@/scripts/pairing/occasions";
import { anchorFamilies, curatedHash, fixedPairs, toItem, universeItems, type FixedPair } from "@/scripts/pairing/pairs";
import { PAIRING_REPORT, pairingReport } from "@/scripts/pairing/report";
import { buildGateReason, canonical, gzipBytes, sha256 } from "@/scripts/priors/artifact-io";
import { loadCrosswalk, sha256File } from "@/scripts/priors/inputs";
import { licenceFindings, SOURCES, WITHHELD } from "@/scripts/priors/sources";
import { resolveWorkspace } from "@/scripts/priors/workspace";

type StoredCalibration = { status: "frozen" | "pass" | "fail"; reasons: string[]; model: string; platt: Platt | null };

export type PairingBuild = { co: CoRow[] | null; table: PairingTable; manifest: PairingManifest; texts: Record<string, string | null>;
  occasions: number | null; preview: PairingTable | null };

/** Round 2 (Sol W1c-r1, BLOCK): the co score ships at weight 0. */
export const CO_WEIGHT_REQUIRES = "co weight > 0 requires holdout + replay (the human pair holdout and the W8 replay)";

export function readCalibration(root: string): StoredCalibration {
  const path = join(root, CALIBRATION_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as StoredCalibration
    : { status: "frozen", reasons: ["no calibration run"], model: LANES.judge.model, platt: null };
}

/** Calibrated Jev probabilities by pair key: only from a passed calibration, for the same model id. */
export function jevFeature(pairs: readonly FixedPair[], store: LabelStore, calibration: StoredCalibration, model: string): Map<string, number> | null {
  if (calibration.status !== "pass" || !calibration.platt || calibration.model !== model) return null;
  const raw = labelsFor(store, pairs.map(toItem), model);
  return new Map(pairs.flatMap((pair) => {
    const p = raw.get(pair.id);
    return p === undefined ? [] : [[pairKey(pair.anchor, pair.side, pair.template), applyPlatt(calibration.platt!, p)] as const];
  }));
}

function nhanesCo(workspace: string, pairs: readonly FixedPair[]): { rows: CoRow[]; occasions: number } {
  const crosswalk = loadCrosswalk(workspace);
  const items = universeItems();
  const familyOf = new Map(anchorFamilies(items).flatMap((family) => family.members.map((key) => [key, family.key] as const)));
  const sideIsFat = new Map(items.filter((item) => item.entry.countable).flatMap((item) => {
    const part = item.parts.find((p) => p === "starch" || p === "veg" || p === "fat" || p === "fruit");
    return part ? [[item.entry.id, part === "fat"] as const] : [];
  }));
  const frame = loadOccasions(workspace);
  const rows = coConsumption({ occasions: frame.occasions, clusters: frame.clusters, familyOf, sideIsFat, pairs,
    expand: (release, code) => crosswalk.expanders[release].expand(code) });
  return { rows, occasions: frame.occasions.length };
}

export function buildPairing(root: string, options: { workspace?: string; weights?: PairWeights } = {}): PairingBuild {
  const weights = options.weights ?? PAIR_WEIGHTS;
  const model = LANES.judge.model;
  const pairs = fixedPairs();
  if (curatedHash(pairs) !== PAIRING_CURATED_SHA256) {
    throw new Error(`curated pair scores changed (${curatedHash(pairs)}); review them and move PAIRING_CURATED_SHA256`);
  }
  const gate = buildGateReason(root);
  const inputs = gate ? [] : SOURCES;
  const licence = licenceFindings(inputs, !gate);
  if (licence.length) throw new Error(licence.map((item) => `${item.source}: ${item.problem}`).join("; "));
  let co: CoRow[] | null = null;
  let occasions: number | null = null;
  let sources: PairingManifest["sources"] = [];
  if (!gate) {
    const workspace = resolveWorkspace(root, options.workspace);
    sources = inputs.map((source) => ({ id: source.id, name: source.name, kind: source.kind, url: source.url, licence: source.licence,
      terms: source.terms, use: source.kind === "nhanes" ? "Day 1 individual foods and occasions: the co-consumption pair rates" : source.use,
      files: source.files.map((file) => ({ path: file, sha256: sha256File(join(workspace, file)) })) }));
    ({ rows: co, occasions } = nhanesCo(workspace, pairs));
  }
  const store = readStore(join(root, "scripts/pairing/data/jev-pair-labels.json"));
  const calibration = readCalibration(root);
  const coMap = co ? new Map(co.map((row) => [pairKey(row.anchor, row.side, row.template), coFeature(row)])) : null;
  const table = buildPairingTable(pairs, { co: coMap, jev: jevFeature(pairs, store, calibration, model), comp: null }, weights);
  /** Not shipped: what co would do at its target weight, for the report only. */
  const preview = coMap ? buildPairingTable(pairs, { co: coMap, jev: null, comp: null }, { ...weights, co: PAIR_CO_TARGET_WEIGHT }) : null;
  const coText = co ? pairingText(co) : null;
  const tableText = pairingText(table);
  const scored = pairs.filter((pair) => pair.b >= table.floor).length;
  const manifest: PairingManifest = {
    schema: 1, version: PAIRING_TABLE_VERSION,
    artifactHash: sha256(`${co ? canonical(co) : "null"}\n${canonical(table)}`),
    ruling: gate ? null : { path: NHANES_RULING_PATH, sha256: NHANES_RULING_SHA256 },
    co: co ? { file: CO_FILE, sha256: sha256(coText!), rows: co.length } : null,
    table: { file: TABLE_FILE, sha256: sha256(tableText), rows: table.rows.length, rowsHash: rowsCuratedHash(table.rows),
      absent: table.absent },
    universe: { version: UNIVERSE_VERSION, hash: UNIVERSE_HASH },
    curated: { pairs: pairs.length, scored, excluded: pairs.length - scored, hash: curatedHash(pairs) },
    activation: {},
    sources, withheld: WITHHELD.filter((item) => item.id === "ahn-2011"), licenceCheck: "pass",
    nhanes: co ? { population: "U.S. adults 18 and over", day: 1, occasions: OCCASION_RULE,
      gramsThreshold: { anchor: ANCHOR_GRAMS, side: SIDE_GRAMS, fat: FAT_GRAMS }, minEffectiveN: 30, transform: CO_TRANSFORM,
      pairsConsidered: scored, pairsShipped: co.length, weight: weights.co, targetWeight: PAIR_CO_TARGET_WEIGHT,
      requires: CO_WEIGHT_REQUIRES, report: PAIRING_REPORT } : null,
    jev: { purpose: "pair_plausibility", model, promptVersion: PAIR_PROMPT_VERSION, rubricVersion: PAIR_RUBRIC_VERSION,
      labels: store.labels.length,
      calibration: { status: calibration.status, reason: calibration.reasons.length
        ? `${calibration.reasons[0]}${calibration.reasons.length > 1 ? ` (+${calibration.reasons.length - 1} more)` : ""}` : "passes",
      report: CALIBRATION_REPORT },
      weight: weights.jev, targetWeight: PAIR_JEV_TARGET_WEIGHT },
  };
  // W1c round 3: no non-curated term may carry a weight or a row without its validation evidence.
  // W8 adds the replay record; until then `activation` is empty and this refuses any active term.
  assertActivationAuthorized(table, manifest);
  const manifestText = pairingText(manifest);
  const findings = runPairingChecks({ co, table, manifest });
  if (findings.length) throw new Error(findings.join("; "));
  return { co, table, manifest, occasions, preview, texts: { [CO_FILE]: coText, [TABLE_FILE]: tableText, [PAIRING_MANIFEST_FILE]: manifestText } };
}

function main(): void {
  const root = process.cwd();
  const checkOnly = process.argv.includes("--check");
  let build: PairingBuild;
  try {
    build = buildPairing(root);
  } catch (error) {
    console.error(`build refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const dir = join(root, PAIRING_DIR);
  const previous = existsSync(join(dir, PAIRING_MANIFEST_FILE)) ? JSON.parse(readFileSync(join(dir, PAIRING_MANIFEST_FILE), "utf8")) : null;
  if (checkOnly) {
    const same = previous?.artifactHash === build.manifest.artifactHash;
    console.log(`${same ? "SAME" : "DIFFERENT"} artifact hash ${build.manifest.artifactHash} (committed ${previous?.artifactHash ?? "none"})`);
    process.exit(same ? 0 : 1);
  }
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(build.texts)) {
    if (text === null) rmSync(join(dir, file), { force: true });
    else writeFileSync(join(dir, file), text);
  }
  const sizes = Object.fromEntries(Object.entries(build.texts).map(([file, text]) => [file, text ? { raw: Buffer.byteLength(text), gzip: gzipBytes(text) } : null]));
  writeFileSync(join(root, PAIRING_REPORT), pairingReport({ ...build, sizes }));
  console.log(`artifact hash ${build.manifest.artifactHash}; co ${build.co?.length ?? 0} rows; table ${build.table.rows.length} rows; `
    + `absent ${build.table.absent.join(", ") || "none"}; sizes ${JSON.stringify(sizes)}`);
}

if (process.argv[1]?.endsWith("scripts/pairing/build.ts")) main();
