/**
 * Strict schemas of the W1c pairing artifacts (Phase 18 D10, hard rules H1 and H4, W1c
 * acceptance 7): the NHANES co-consumption table (server-only, aggregate pair rates), the bundled
 * pairing table and its manifest. Every object is an allowlist: an unknown key at any depth fails,
 * so nothing respondent-level can ride along under a new name. scripts/pairing/check-pairing.ts and
 * the loader (./artifacts.ts) both parse with these.
 *
 * Pure. No I/O.
 */
import { z } from "zod";
import { MIN_EFFECTIVE_N, NHANES_RULING_PATH } from "@/lib/foods/universe/prior";
import {
  CO_FILE, PAIR_FEATURES, PAIR_FLOOR, pairKey, PAIRING_TABLE_VERSION, pairWithFeatures, SIDE_PARTS, TABLE_FILE, type PairFeature,
  type PairingTable,
} from "@/lib/foods/pairing/table";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const unit = z.number().min(0).max(1);
const template = z.enum(["breakfast", "main", "snack"]);
const feature = z.enum(PAIR_FEATURES as unknown as [PairFeature, ...PairFeature[]]);
const key = z.string().regex(/^[a-z0-9][a-z0-9 -]{0,63}$/);

/** One NHANES aggregate: the weighted share of the anchor family's occasions that also held the side. */
export const CoRowSchema = z.strictObject({
  anchor: key, side: key, template,
  rate: unit,
  /** The side's weighted share of all occasions of the template (the independence baseline). */
  base_rate: z.number().gt(0).max(1),
  n_eff: z.number().int().min(MIN_EFFECTIVE_N),
});
export const CoTableSchema = z.array(CoRowSchema);
export type CoRow = z.infer<typeof CoRowSchema>;

export const PairRowSchema = z.strictObject({
  anchor: key, side: key, template, part: z.enum(SIDE_PARTS),
  b: z.number().min(PAIR_FLOOR).max(1), pair: z.number().min(PAIR_FLOOR).max(1),
  co: unit.optional(), jev: unit.optional(), comp: unit.optional(),
});

export const PairingTableSchema = z.strictObject({
  type: z.literal("pairing"),
  version: z.literal(PAIRING_TABLE_VERSION),
  weights: z.strictObject({ co: z.number(), jev: z.number(), comp: z.number() }),
  floor: z.literal(PAIR_FLOOR),
  absent: z.array(feature),
  rows: z.array(PairRowSchema),
});

const calibrationStatus = z.enum(["frozen", "pass", "fail"]);

/**
 * Validation evidence for one non-curated term (W1c round 3). Both parts are needed before the term
 * may carry a weight or a row (./gate.ts `activationViolations`): a passed calibration on the human
 * holdout with the §5 numbers, and the W8 replay-lift record. Either may be null; null means "not
 * yet", and the term stays at weight 0 with no rows.
 */
export const ActivationEvidenceSchema = z.strictObject({
  calibration: z.strictObject({
    status: z.enum(["passed", "failed"]), holdoutPairs: count, brier: unit, ece: unit, rawBrier: unit, report: z.string().min(1),
  }).nullable(),
  replay: z.strictObject({
    ndcg5Gain: z.number(), ndcg5GainLo: z.number(), implausibleRateDelta: z.number(), days: count, report: z.string().min(1),
  }).nullable(),
});
export type ActivationEvidence = z.infer<typeof ActivationEvidenceSchema>;

export const PairingManifestSchema = z.strictObject({
  schema: z.literal(1),
  artifactHash: hex64,
  version: z.literal(PAIRING_TABLE_VERSION),
  ruling: z.strictObject({ path: z.literal(NHANES_RULING_PATH), sha256: hex64 }).nullable(),
  co: z.strictObject({ file: z.literal(CO_FILE), sha256: hex64, rows: count }).nullable(),
  table: z.strictObject({ file: z.literal(TABLE_FILE), sha256: hex64, rows: count, rowsHash: hex64, absent: z.array(feature) }),
  universe: z.strictObject({ version: z.string(), hash: hex64 }),
  curated: z.strictObject({ pairs: count, scored: count, excluded: count, hash: hex64 }),
  sources: z.array(z.strictObject({
    id: z.string(), name: z.string(), kind: z.enum(["nhanes", "fndds", "fdc"]), url: z.string().url(),
    licence: z.string(), terms: z.string(), use: z.string(),
    files: z.array(z.strictObject({ path: z.string(), sha256: hex64 })).min(1),
  })),
  withheld: z.array(z.strictObject({ id: z.string(), name: z.string(), reason: z.string() })),
  licenceCheck: z.literal("pass"),
  nhanes: z.strictObject({
    population: z.literal("U.S. adults 18 and over"),
    day: z.literal(1),
    occasions: z.string(),
    gramsThreshold: z.strictObject({ anchor: z.number(), side: z.number(), fat: z.number() }),
    minEffectiveN: z.literal(MIN_EFFECTIVE_N),
    transform: z.string(),
    pairsConsidered: count, pairsShipped: count,
    weight: z.number(), targetWeight: z.number(), requires: z.string(),
    report: z.string(),
  }).nullable(),
  /** Per non-curated term; empty until a term has a passed holdout calibration and a W8 replay record. */
  activation: z.strictObject({ co: ActivationEvidenceSchema.optional(), jev: ActivationEvidenceSchema.optional(),
    comp: ActivationEvidenceSchema.optional() }),
  jev: z.strictObject({
    purpose: z.literal("pair_plausibility"),
    model: z.string(), promptVersion: z.string(), rubricVersion: z.string(),
    labels: count,
    calibration: z.strictObject({ status: calibrationStatus, reason: z.string(), report: z.string() }),
    weight: z.number(), targetWeight: z.number(),
  }),
});
export type PairingManifest = z.infer<typeof PairingManifestSchema>;

export function parseCoRows(value: unknown): CoRow[] | null {
  const parsed = CoTableSchema.safeParse(value);
  if (!parsed.success) return null;
  const cells = new Set(parsed.data.map((row) => `${row.anchor}|${row.side}|${row.template}`));
  return cells.size === parsed.data.length ? parsed.data : null;
}

/**
 * Strict table: null unless the schema holds, each (anchor, side, template) key appears once, and
 * every row's stored `pair` equals the D8 part 5 formula over its own `b`, features and the table's
 * weights (an edited `pair` is rejected, not recomputed).
 */
export function parsePairingTable(value: unknown): PairingTable | null {
  const parsed = PairingTableSchema.safeParse(value);
  if (!parsed.success) return null;
  const table = parsed.data as PairingTable;
  const cells = new Set(table.rows.map((row) => pairKey(row.anchor, row.side, row.template)));
  if (cells.size !== table.rows.length) return null;
  const formula = table.rows.every((row) =>
    row.pair === pairWithFeatures(row.b, { co: row.co, jev: row.jev, comp: row.comp }, table.weights));
  return formula ? table : null;
}

export function parsePairingManifest(value: unknown): PairingManifest | null {
  const parsed = PairingManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
