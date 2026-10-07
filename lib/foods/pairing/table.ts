/**
 * The pairing table (Phase 18 D8 part 5, D10, slice W1c): how well a side goes with an anchor
 * family on one plate, as the curated Phase 17 score `B` adjusted by offline evidence.
 *
 *   pair = clip( B + w_co·(co − B) + w_jev·(jev − B) + w_comp·(comp − B), PAIR_FLOOR, 1 )
 *
 *   B     the curated score (lib/meals/affinity.ts `pairScore`), raised to at least 0.85 by the
 *         account's own history (an anchor and side eaten together on 3 distinct days in 180; W8).
 *   co    co-consumption: NHANES same-occasion recalls (NCHS gate), as lift / (1 + lift). The Ahn
 *         ingredient lists are withheld (CC BY-NC-SA, non-commercial), so co is NHANES-only or
 *         absent. Its weight ships at 0 (W1c round 2): the transform is an unvalidated starting
 *         value that lowered curated pairs (lamb with couscous 1 → 0.8). co weight > 0 requires the
 *         human holdout and the W8 replay (PAIR_CO_TARGET_WEIGHT is the spec's 0.20). The aggregate
 *         rows stay in the server-only co-consumption artifact.
 *   jev   Jev's calibrated offline pair probability (D9 item 2). Its weight ships at 0 and leaves 0
 *         only when the §5 holdout gate and the replay lift pass (PAIR_JEV_TARGET_WEIGHT is 0.15).
 *   comp  Ahn compound pairing: withheld with the Ahn data, so always absent (target weight 0.05).
 *
 * An absent feature adds zero; the others are not renormalised. A pair the curated table rules out
 * (B below the floor, e.g. tuna with fruit at 0.1) is excluded before the formula: it is returned
 * unchanged, so no feature ever lifts it. Every scored pair stays at or above the floor.
 *
 * The bundled table holds only features whose weight is above 0, so with the co and Jev weights at
 * 0 it is byte-for-byte the table built with no co term and no Jev labels (W1c acceptance 5): it has
 * no rows, and every pair scores its curated B.
 *
 * Pure. No I/O. Reachable from lib/meals; it must never import scripts/ or the Jev transport
 * (tests/foods/pairing-import-graph.test.ts).
 */
import { sha256Hex } from "@/lib/foods/sha256";
import type { TemplateKey } from "@/lib/meals/templates";

/** lib/meals/affinity.ts PAIR_FLOOR (asserted equal in tests; not imported, to keep this module light). */
export const PAIR_FLOOR = 0.3;

export const PAIR_FEATURES = ["co", "jev", "comp"] as const;
export type PairFeature = (typeof PAIR_FEATURES)[number];
export type PairWeights = Readonly<Record<PairFeature, number>>;
export type PairFeatures = Partial<Record<PairFeature, number>>;

/** The Jev weight once its held-out lift passes (spec §5). Fitted on training folds only. */
export const PAIR_JEV_TARGET_WEIGHT = 0.15;

/** The spec's co weight once the human holdout and the W8 replay justify it. */
export const PAIR_CO_TARGET_WEIGHT = 0.2;

/** The spec's comp weight, should a licence-safe compound source and its validation ever exist. */
export const PAIR_COMP_TARGET_WEIGHT = 0.05;

/**
 * The shipped weights: every non-curated term at exactly 0. A weight above 0 requires that term's
 * validation evidence in the manifest (the human holdout and the W8 replay); ./gate.ts
 * `activationViolations` enforces it in the build and the loader.
 */
export const PAIR_WEIGHTS: PairWeights = { co: 0, jev: 0, comp: 0 };

/**
 * sha256 of the curated B of every fixed pair (scripts/pairing/pairs.ts `curatedHash`), as the
 * current table was built on. The build refuses, and the loader rejects a manifest, that names any
 * other value; a curated-table change needs a rebuild and a reviewed move of this pin.
 */
export const PAIRING_CURATED_SHA256 = "ecf63656125ac83060ec99b991ad113547beca87bd9553c4b864ed88664f049e";

export const PAIRING_TABLE_VERSION = "pairing-1.0.0";

/** Where the W1c artifacts live, beside the W1b ones. */
export const PAIRING_DIR = "lib/foods/pairing/artifacts";
export const CO_FILE = "co-consumption.json";
export const TABLE_FILE = "pairing-table.json";
export const PAIRING_MANIFEST_FILE = "pairing-manifest.json";

export const PAIR_TEMPLATES: readonly TemplateKey[] = ["breakfast", "main", "snack"];
export const SIDE_PARTS = ["starch", "veg", "fat", "fruit"] as const;
export type SidePart = (typeof SIDE_PARTS)[number];

/** The side parts a template may carry (lib/meals/templates.ts). */
export const TEMPLATE_SIDE_PARTS: Readonly<Record<TemplateKey, readonly SidePart[]>> = {
  breakfast: ["starch", "fruit", "veg", "fat"],
  main: ["starch", "veg", "fat"],
  snack: ["fruit", "starch", "fat"],
};

export type PairRow = {
  /** Anchor family key (lib/meals/data/pairings.ts, cuisine.ts). */
  anchor: string;
  /** Universe food key of the side. */
  side: string;
  template: TemplateKey;
  part: SidePart;
  /** The curated score with no account history. */
  b: number;
  /** `pair` at `b`. */
  pair: number;
} & PairFeatures;

export type PairingTable = {
  type: "pairing";
  version: string;
  weights: PairWeights;
  floor: number;
  /** Features with no shipped value in this build (each adds nothing). */
  absent: PairFeature[];
  rows: PairRow[];
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** D8 part 5. `b` below the floor is a curated exclusion and comes back unchanged. */
export function pairWithFeatures(b: number, features: PairFeatures, weights: PairWeights = PAIR_WEIGHTS): number {
  if (!(b >= PAIR_FLOOR)) return b;
  let raw = b;
  for (const feature of PAIR_FEATURES) {
    const value = features[feature];
    if (value !== undefined && weights[feature] !== 0) raw += weights[feature] * (value - b);
  }
  return round3(Math.min(1, Math.max(PAIR_FLOOR, raw)));
}

export const pairKey = (anchor: string, side: string, template: TemplateKey) => `${anchor}|${side}|${template}`;

/** One fixed pair with its curated score (scripts/pairing/pairs.ts makes the list). */
export type CuratedPair = { anchor: string; side: string; template: TemplateKey; part: SidePart; b: number };

/**
 * The bundled table from the fixed pairs and per-feature values keyed by `pairKey`. A feature whose
 * weight is 0 is never written; a curated exclusion never gets a row; a pair with no shipped
 * feature has no row (its score is `B`). Rows sort by key, so equal inputs give equal bytes.
 */
export function buildPairingTable(pairs: readonly CuratedPair[],
  features: Partial<Record<PairFeature, ReadonlyMap<string, number> | null>>, weights: PairWeights = PAIR_WEIGHTS,
  version = PAIRING_TABLE_VERSION): PairingTable {
  const shipped = PAIR_FEATURES.filter((feature) => weights[feature] !== 0 && (features[feature]?.size ?? 0) > 0);
  const rows: PairRow[] = [];
  for (const pair of pairs) {
    if (!(pair.b >= PAIR_FLOOR)) continue;
    const key = pairKey(pair.anchor, pair.side, pair.template);
    const own: PairFeatures = {};
    for (const feature of shipped) {
      const value = features[feature]!.get(key);
      if (value !== undefined) own[feature] = round3(value);
    }
    if (!Object.keys(own).length) continue;
    rows.push({ anchor: pair.anchor, side: pair.side, template: pair.template, part: pair.part, b: round3(pair.b),
      ...own, pair: pairWithFeatures(round3(pair.b), own, weights) });
  }
  rows.sort((a, b) => (pairKey(a.anchor, a.side, a.template) < pairKey(b.anchor, b.side, b.template) ? -1 : 1));
  return { type: "pairing", version, weights: { ...weights }, floor: PAIR_FLOOR,
    absent: PAIR_FEATURES.filter((feature) => !shipped.includes(feature)), rows };
}

/** Lookup by anchor family, side key and template. */
export function pairingIndex(table: PairingTable): ReadonlyMap<string, PairRow> {
  return new Map(table.rows.map((row) => [pairKey(row.anchor, row.side, row.template), row]));
}

/**
 * The adjusted score for a pair at the account's `B` (curated, or raised by history). A pair with no
 * row, or a table that is null, scores `B`.
 */
export function adjustedPair(index: ReadonlyMap<string, PairRow> | null, table: PairingTable | null,
  anchor: string, side: string, template: TemplateKey, b: number): number {
  const row = index?.get(pairKey(anchor, side, template));
  if (!row || !table) return b;
  const features: PairFeatures = {};
  for (const feature of PAIR_FEATURES) if (row[feature] !== undefined) features[feature] = row[feature];
  return pairWithFeatures(b, features, table.weights);
}

/** sha256 of the rows' curated B (`anchor|side|template=b`, row order): ties a table to its build. */
export function rowsCuratedHash(rows: readonly Pick<PairRow, "anchor" | "side" | "template" | "b">[]): string {
  return sha256Hex(rows.map((row) => `${pairKey(row.anchor, row.side, row.template)}=${row.b}`).join("\n"));
}
