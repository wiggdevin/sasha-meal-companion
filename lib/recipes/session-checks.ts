/**
 * The ticked ingredients of one recipe revision, kept for the tab's session (components/RecipeDetails
 * .tsx). A catalog revision is shared by every account, so the key carries the bound account
 * (`smc:u:<id>:recipe-checks:<revision>`, W056): sign-out replaces the page and keeps
 * sessionStorage, and the next account must not see the last one's ticks. With no bound account
 * nothing is read or written. Blocked storage (private browsing) reads as empty and loses the write.
 */
import { accountKey, currentAccountOrNull } from "@/lib/device/account";

export function recipeChecksKey(revisionId: string): string | null {
  const h = currentAccountOrNull();
  return h === null ? null : accountKey(h, `recipe-checks:${revisionId}`);
}

export function readRecipeChecks(revisionId: string): number[] {
  const key = recipeChecksKey(revisionId);
  if (key === null) return [];
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    return Array.isArray(stored) ? stored.filter((value): value is number => typeof value === "number") : [];
  } catch {
    return [];
  }
}

export function writeRecipeChecks(revisionId: string, checked: readonly number[]): void {
  const key = recipeChecksKey(revisionId);
  if (key === null) return;
  try { sessionStorage.setItem(key, JSON.stringify(checked)); } catch { /* storage is optional */ }
}
