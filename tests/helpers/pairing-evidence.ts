/**
 * Test-only validation evidence for the W1c activation gate (lib/foods/pairing/gate.ts): a passed
 * holdout calibration with the §5 numbers and a W8 replay-lift record. No such evidence exists for
 * any real term; fixtures use it to show what the gate would accept, and that it refuses less.
 */
import type { ActivationEvidence } from "@/lib/foods/pairing/schema";

export const PASSING_EVIDENCE: ActivationEvidence = {
  calibration: { status: "passed", holdoutPairs: 412, brier: 0.15, ece: 0.03, rawBrier: 0.19, report: "test-only" },
  replay: { ndcg5Gain: 0.02, ndcg5GainLo: 0.004, implausibleRateDelta: 0, days: 60, report: "test-only" },
};
