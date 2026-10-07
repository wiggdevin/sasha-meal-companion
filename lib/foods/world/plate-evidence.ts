/**
 * Each admitted food's deterministic meat and dairy evidence for the meal-level plate rule
 * (Phase 18 D4, W2b `checkPlateRules`; W8 sends it in snapshot v3 under `kosher_meat_dairy`).
 * Deterministic only, never Jev: a universe item reads its SR description, the whole-food class
 * name and its stored name evidence for dairy (the same inputs its admission read); an account
 * food reads its own name. Anything the evidence cannot settle is `unknown`, and a plate holding
 * an unknown food is not generated (fail-closed).
 *
 * Pure. No I/O.
 */
import { universePolicyEvidence, type UniverseItem } from "@/lib/foods/universe/derive";
import { plateFoodEvidence, type PlateFoodEvidence } from "@/lib/policy/plate-rules";

export function universePlateEvidence(item: UniverseItem): PlateFoodEvidence {
  const evidence = universePolicyEvidence(item);
  return plateFoodEvidence({ foodName: evidence.foodName, wholeFoodName: evidence.wholeFoodName,
    dairyEvidence: evidence.allergenEvidence?.dairy });
}

export function ownPlateEvidence(name: string): PlateFoodEvidence {
  return plateFoodEvidence({ foodName: name, wholeFoodName: name });
}
