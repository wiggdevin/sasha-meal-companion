import type { SanityDraft, SanityResult, SanityWarning } from "@/lib/log/sanity-types";

/** Pure per-serving checks that are safe to run before persistence and in client import graphs. */
export function deterministicSanity(draft: SanityDraft): SanityResult {
  const { gramsPerServing, kcalPerServing } = draft.amounts;
  const warnings: SanityWarning[] = [];
  if (finite(gramsPerServing) && gramsPerServing < 2) {
    warnings.push(portionWarning(draft.itemId, "tiny", "This serving is under 2 g."));
  }
  if (finite(gramsPerServing) && gramsPerServing >= 2_000) {
    warnings.push(portionWarning(
      draft.itemId,
      "implausible",
      "This serving is 2,000 g or more.",
    ));
  }
  if (finite(kcalPerServing) && kcalPerServing >= 3_000) {
    warnings.push(portionWarning(
      draft.itemId,
      "implausible",
      "This serving is 3,000 kcal or more.",
    ));
  }
  return { sanityStatus: warnings.length > 0 ? "warn" : "pending", warnings };
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function portionWarning(
  itemId: string,
  level: "tiny" | "implausible",
  message: string,
): SanityWarning {
  return { itemId, kind: "portion", level, message };
}
