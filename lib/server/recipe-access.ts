import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError, requireUser } from "@/lib/server/auth";

type AccessEnv = { RECIPE_PLANNING_USER_IDS?: string; SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string; NODE_ENV?: string };

/** Production is closed unless an account UUID, or an explicit '*', is allowlisted. */
export function recipeAccessEnabled(userId: string, env: AccessEnv = process.env): boolean {
  const selected = (env.RECIPE_PLANNING_USER_IDS ?? "").split(",").map((id) => id.trim());
  if (selected.includes("*") || selected.includes(userId)) return true;
  if (selected.some(Boolean)) return false;
  if (env.NODE_ENV === "production") return false;
  const raw = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return false;
  try { return ["127.0.0.1", "localhost"].includes(new URL(raw).hostname); }
  catch { return false; }
}

export async function requireRecipeUser(req: Request): Promise<{ client: SupabaseClient; userId: string }> {
  const account = await requireUser(req);
  if (!recipeAccessEnabled(account.userId)) {
    throw new HttpError(404, "recipe_pilot_unavailable", "Recipes are not available for this account yet.");
  }
  return account;
}
