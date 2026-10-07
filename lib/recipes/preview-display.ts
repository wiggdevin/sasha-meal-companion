import type { AdaptationIssue } from "@/lib/recipes/adapt";

export function displayAmount(value: number, digits = 1): string {
  return Number(value.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Keep the original evidence available, but show each repeated ingredient problem once. */
export function distinctEvidenceIssues(issues: readonly AdaptationIssue[]): AdaptationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issue.code === "retention_unknown" || issue.code === "nutrition_unknown"
      ? `${issue.code}:${issue.ingredientSeq ?? issue.message}`
      : `${issue.code}:${issue.ingredientSeq ?? ""}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evidenceSummary(issues: readonly AdaptationIssue[]): string {
  const codes = new Set(issues.map((issue) => issue.code));
  const parts: string[] = [];
  if (codes.has("retention_unknown")) parts.push("Cooked nutrient retention is not measured");
  if (codes.has("purchase_conversion")) parts.push("raw grocery amounts are not measured");
  if (codes.has("yield_unknown")) parts.push("finished yield is not measured");
  if (codes.has("nutrition_unknown")) parts.push("some nutrient values are missing");
  if (codes.has("mass_unknown")) parts.push("some ingredient masses are missing");
  if (codes.has("food_identity")) parts.push("some ingredients lack a verified food identity");
  if (codes.has("ingredient_quantity")) parts.push("some ingredient quantities are unusable");
  return parts.length ? `${parts.join("; ")}.` : "Evidence needs review.";
}

/** A recipe time as people say it: "25 min", "1 hr 15 min", "8 hr" (an overnight soak is not 488 min). */
export function displayMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
