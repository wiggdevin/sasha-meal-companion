/**
 * The D4 admission order's pure core (Phase 18 W2b): which foods a generator may use, decided
 * before any score exists. lib/server/candidate-foods.ts reads the account's rules, Avoid list and
 * evidence (step 1) and hands them here; this module applies family Avoid and `evaluatePolicy` to
 * every candidate and admits only `allowed` with usable nutrition (step 2). The admitted set is
 * explicit and positive: omission always means unavailable.
 *
 * Step 4 (the prior, the personal score, similarity, Jev's short-list check) runs only on what
 * this returns: `rankAdmitted` and `admittedGraph` take any scores or edges and can only order or
 * connect admitted foods, never add one. A ranking signal never becomes safety evidence.
 *
 * Pure. No I/O.
 */
import { baseFoodName } from "@/lib/foods/base-name";
import { ALLERGEN_KEYS, universePolicyEvidence, type UniverseItem } from "@/lib/foods/universe/derive";
import { usableForGeneration } from "@/lib/meals/pool";
import { macroKcal } from "@/lib/scaling";
import { evaluatePolicy, type ConstraintProfile, type PolicyVerdict } from "@/lib/policy/constraints";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";

export type AdmissionRules = Readonly<{
  /** The account's constraint profile, with its confirmed profile hard rules in `profileRules`. */
  profile: ConstraintProfile;
  /** The account's confirmed diet flags (user_settings.diet_prefs.flags, normalized). */
  preferenceFlags: readonly PolicyPreferenceFlag[];
  /** Normalized family keys of every Avoid mark (`avoidFamilies`). */
  avoidFamilies: ReadonlySet<string>;
}>;

export type ExcludedCandidate = Readonly<{ id: string; verdict: "blocked" | "unverified"; reason: string }>;

/** The family key every name of an Avoid mark stands for (set_food_membership's normalization). */
export function avoidFamilies(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const name of names) {
    const key = baseFoodName(name);
    if (key) out.add(key);
  }
  return out;
}

/** Whether any of a food's names falls in an avoided family. */
export function inAvoidFamily(names: readonly (string | null | undefined)[],
  families: ReadonlySet<string>): boolean {
  return names.some((name) => {
    const key = baseFoodName(name ?? "");
    return key.length > 0 && families.has(key);
  });
}

/**
 * An item's policy inputs (step 1 for the universe). W1 derives a deterministic state for every
 * allergen key from the bundled row (lib/foods/universe/derive.ts: listed, clear or unknown). When
 * every key is known, that state IS a complete tag list: the listed keys, nothing else. It is passed
 * as `allergenTags` so `evaluatePolicy` sees the evidence the item carries, instead of reading "no
 * tags" as no evidence. When any key is unknown the tags stay null: an incomplete list would read
 * as absence (a preference rule's ingredient key, D4 fail-closed), so the item is judged with no
 * tags and the policy's own no-evidence gate keeps it out. The verdict is never adjusted after.
 */
export function admissionEvidence(item: UniverseItem): ReturnType<typeof universePolicyEvidence> {
  const states = ALLERGEN_KEYS.map((key) => [key, item.allergens[key]] as const);
  const complete = states.every(([, state]) => state === "listed" || state === "clear");
  return { ...universePolicyEvidence(item),
    allergenTags: complete ? states.filter(([, state]) => state === "listed").map(([key]) => key) : null };
}

const EVIDENCE = new WeakMap<UniverseItem, ReturnType<typeof universePolicyEvidence>>();
function evidenceOf(item: UniverseItem): ReturnType<typeof universePolicyEvidence> {
  let evidence = EVIDENCE.get(item);
  if (!evidence) {
    evidence = admissionEvidence(item);
    EVIDENCE.set(item, evidence);
  }
  return evidence;
}

/**
 * The raw policy verdict for one universe item under these rules (no Eats mark, no Jev facet).
 * Admitted means exactly `allowed`: nothing here turns `unverified` into `allowed`.
 */
export function universeVerdict(rules: AdmissionRules, item: UniverseItem):
  { verdict: PolicyVerdict["verdict"]; reason?: string } {
  if (inAvoidFamily([item.row.name, item.row.sr], rules.avoidFamilies)) {
    return { verdict: "blocked", reason: "avoid_family" };
  }
  const verdict = evaluatePolicy(rules.profile, {
    ...evidenceOf(item), preferenceFlags: rules.preferenceFlags,
    profileRules: rules.profile.profileRules,
  });
  return { verdict: verdict.verdict, ...(verdict.reason ? { reason: verdict.reason } : {}) };
}

export type UniverseAdmission = { admitted: string[]; excluded: ExcludedCandidate[] };

/** Step 2 for the universe: admit only `allowed` items with usable nutrition, in id order. */
export function admitUniverse(items: readonly UniverseItem[], rules: AdmissionRules): UniverseAdmission {
  const admitted: string[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const item of [...items].sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))) {
    const judged = universeVerdict(rules, item);
    if (judged.verdict === "allowed" && usableForGeneration(item.food)) {
      admitted.push(item.entry.id);
    } else {
      excluded.push({ id: item.entry.id, verdict: judged.verdict === "blocked" ? "blocked" : "unverified",
        reason: judged.verdict === "allowed" ? "nutrition_unusable" : judged.reason ?? "unverified" });
    }
  }
  return { admitted, excluded };
}

export type RefFacts = Readonly<{
  refId: string;
  /** The account's own food name or the catalog's active description; null when unmapped. */
  name: string | null;
  /** Per 100 g, from the same row; null when the row carries none. */
  nutrition: Readonly<{ protein: number; carbs: number; fat: number }> | null;
}>;

/** Finite, non-negative macros with positive energy: unknown is never read as 0 (D4). */
export function usableNutrition(nutrition: RefFacts["nutrition"]): boolean {
  if (!nutrition) return false;
  const { protein, carbs, fat } = nutrition;
  if (![protein, carbs, fat].every((value) => Number.isFinite(value) && value >= 0)) return false;
  return macroKcal(nutrition) > 0;
}

/**
 * Step 2 for the account's own refs: the server-verified Eats set, less every avoided family.
 * A ref with no readable name (an unmapped identity) or no usable nutrition is unavailable.
 */
export function admitRefs(refs: readonly RefFacts[], eligibleRefIds: ReadonlySet<string>,
  families: ReadonlySet<string>): { admitted: string[]; excluded: ExcludedCandidate[] } {
  const admitted: string[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const ref of refs) {
    if (!eligibleRefIds.has(ref.refId)) continue;
    const name = ref.name?.trim() ?? "";
    if (!name) excluded.push({ id: ref.refId, verdict: "unverified", reason: "unmapped" });
    else if (inAvoidFamily([name], families)) excluded.push({ id: ref.refId, verdict: "blocked", reason: "avoid_family" });
    else if (!usableNutrition(ref.nutrition)) excluded.push({ id: ref.refId, verdict: "unverified", reason: "nutrition_unknown" });
    else admitted.push(ref.refId);
  }
  return { admitted: admitted.sort(), excluded };
}

export type GraphEdge = Readonly<{ from: string; to: string; weight: number }>;

/** Similarity edges with both ends admitted: no neighbour path reaches an excluded food. */
export function admittedGraph(edges: readonly GraphEdge[], admitted: ReadonlySet<string>): GraphEdge[] {
  return edges.filter((edge) => admitted.has(edge.from) && admitted.has(edge.to));
}

/**
 * Step 4's ordering over the admitted set only: any score (prior, personal, graph, Jev) orders the
 * admitted ids and nothing else. A missing or non-finite score ranks last; ties keep id order.
 */
export function rankAdmitted(admitted: readonly string[], scores: Readonly<Record<string, number>>): string[] {
  const score = (id: string) => (Number.isFinite(scores[id]) ? scores[id] : Number.NEGATIVE_INFINITY);
  return [...new Set(admitted)].sort((a, b) => score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0));
}
