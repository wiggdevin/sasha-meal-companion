/**
 * The NCHS gate on the bundled pairing table (Phase 18 D10, W1c acceptance 6). The NHANES part of
 * `co` is used only when the pairing manifest names the owner's ruling at its approved hash; the
 * server loader (./artifacts.ts) also requires the ruling file itself. Otherwise every `co` value
 * is dropped and each row's score is recomputed from what remains — with the Ahn lists withheld,
 * that leaves the curated B. The rest of the model still works.
 *
 * The activation gate (W1c round 3): ONE invariant, enforced by the build and the loader alike.
 * Every non-curated term (co, jev, comp, and any other weight the table carries) must have weight 0
 * and contribute no row, unless the manifest carries that term's validation evidence: a passed
 * calibration on the human holdout meeting the §5 numbers AND a W8 replay-lift record. Today no
 * term has evidence, so every non-curated weight is exactly 0 and the table has 0 rows.
 *
 * Pure. No I/O. Safe for the phone bundle.
 */
import type { ActivationEvidence, PairingManifest } from "@/lib/foods/pairing/schema";
import { pairWithFeatures, type PairingTable, type PairRow } from "@/lib/foods/pairing/table";
import { NHANES_RULING_PATH, NHANES_RULING_SHA256 } from "@/lib/foods/universe/prior";

/** True when the manifest names the ruling at its approved hash. */
export function manifestNamesRuling(manifest: Pick<PairingManifest, "ruling"> | null): boolean {
  return manifest?.ruling?.path === NHANES_RULING_PATH && manifest.ruling.sha256 === NHANES_RULING_SHA256;
}

/** The table with every NHANES-derived `co` removed, rows left without a feature dropped. */
export function withoutCo(table: PairingTable): PairingTable {
  const rows: PairRow[] = [];
  for (const row of table.rows) {
    const { anchor, side, template, part, b, jev, comp } = row;
    if (jev === undefined && comp === undefined) continue;
    rows.push({ anchor, side, template, part, b, ...(jev === undefined ? {} : { jev }), ...(comp === undefined ? {} : { comp }),
      pair: pairWithFeatures(b, { jev, comp }, table.weights) });
  }
  return { ...table, absent: [...new Set([...table.absent, "co" as const])], rows };
}

/** The table the model may read: `co` kept only while the gate is open. */
export function gatedPairingTable(table: PairingTable, manifest: Pick<PairingManifest, "ruling"> | null, rulingOk = true): PairingTable {
  return rulingOk && manifestNamesRuling(manifest) ? table : withoutCo(table);
}

/** §5 "Jev pair labels" numbers, applied to every term's holdout calibration. */
export const ACTIVATION_GATE = { brier: 0.18, ece: 0.05, gain: 0.01, holdoutPairs: 400 } as const;

/** Why `evidence` does not authorize a term, or none. */
export function evidenceGaps(evidence: ActivationEvidence | undefined): string[] {
  if (!evidence) return ["no validation evidence"];
  const out: string[] = [];
  const c = evidence.calibration;
  if (!c) out.push("no holdout calibration");
  else {
    if (c.status !== "passed") out.push(`holdout calibration ${c.status}`);
    if (c.holdoutPairs < ACTIVATION_GATE.holdoutPairs) out.push(`holdout of ${c.holdoutPairs} pairs < ${ACTIVATION_GATE.holdoutPairs}`);
    if (c.brier > ACTIVATION_GATE.brier) out.push(`Brier ${c.brier} > ${ACTIVATION_GATE.brier}`);
    if (c.ece > ACTIVATION_GATE.ece) out.push(`ECE ${c.ece} > ${ACTIVATION_GATE.ece}`);
    if (c.rawBrier - c.brier < ACTIVATION_GATE.gain) out.push(`gain over raw < ${ACTIVATION_GATE.gain}`);
  }
  const r = evidence.replay;
  if (!r) out.push("no W8 replay-lift record");
  else {
    if (!(r.ndcg5GainLo > 0)) out.push("replay NDCG@5 gain lower bound not above 0");
    if (r.implausibleRateDelta > 0) out.push("replay implausible-plate rate rose");
  }
  return out;
}

/**
 * Every violation of the activation invariant, or none. A term is any weight key of the table (not
 * only the known three), so a future term is held by the same rule.
 */
export function activationViolations(table: Pick<PairingTable, "weights" | "rows">,
  manifest: Pick<PairingManifest, "activation"> | null): string[] {
  const out: string[] = [];
  const evidence = (manifest?.activation ?? {}) as Record<string, ActivationEvidence | undefined>;
  const terms = new Set([...Object.keys(table.weights), ...Object.keys(evidence)]);
  for (const row of table.rows) {
    for (const key of Object.keys(row)) {
      if (!["anchor", "side", "template", "part", "b", "pair"].includes(key)) terms.add(key);
    }
  }
  const authorized = new Set<string>();
  for (const term of terms) {
    const weight = (table.weights as Record<string, number>)[term] ?? 0;
    const used = table.rows.some((row) => (row as Record<string, unknown>)[term] !== undefined);
    if (weight === 0 && !used) continue;
    const gaps = evidenceGaps(evidence[term]);
    if (gaps.length) out.push(`${term}: weight ${weight}${used ? " with rows" : ""} without authorization (${gaps.join("; ")})`);
    else authorized.add(term);
  }
  for (const row of table.rows) {
    const terms = Object.keys(row).filter((key) => !["anchor", "side", "template", "part", "b", "pair"].includes(key));
    if (!terms.some((term) => authorized.has(term))) out.push(`row ${row.anchor}|${row.side}|${row.template} carries no authorized term`);
  }
  return [...new Set(out)];
}

/** Throws on any violation: the build calls it before it emits anything. */
export function assertActivationAuthorized(table: Pick<PairingTable, "weights" | "rows">,
  manifest: Pick<PairingManifest, "activation"> | null): void {
  const violations = activationViolations(table, manifest);
  if (violations.length) throw new Error(`activation refused: ${violations.slice(0, 5).join("; ")}`);
}
