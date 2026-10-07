import type { SanityAnnotation } from "@/lib/log/sanity-types";

export type PolicyNotice = {
  verdict: "allowed" | "blocked" | "unverified";
  marks?: readonly { facet: string; source?: string; outcome: "present" | "absent" | "unknown" }[];
};

/** When SanityNotices shows its "could not verify for your preferences" line. */
export function preferenceNotVerified(
  sanity: SanityAnnotation | undefined, policy: PolicyNotice,
): boolean {
  const activePreferenceNeedsEvidence = policy.marks?.some((mark) =>
    mark.outcome === "unknown" && mark.facet !== "allergens") === true;
  return sanity?.status === "unknown" && policy.verdict === "unverified"
    && activePreferenceNeedsEvidence;
}

/**
 * §5's "Check the label" mark, for a CHECKABLE allergen gap only (sol FIX, t2b): an unknown
 * allergen floor mark (never tuna_mercury, which no label check clears) or the no-evidence
 * `allergens` mark. No marks at all is an unexplained verdict, so it still says to check.
 */
export function labelCheckNeeded(policy: PolicyNotice) {
  if (policy.verdict !== "unverified") return false;
  return policy.marks?.some((mark) => mark.outcome === "unknown" && (mark.facet === "allergens"
    || (mark.source === "floor" && mark.facet !== "tuna_mercury"))) ?? true;
}
