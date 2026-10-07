/**
 * The two admission-input versions (Phase 18 D11, W2b; migration 20261213090200), read on the caller's
 * own RLS client: the account's `account_rules_clock` row (owner-only) and the global
 * `evidence_clock` row. No account row yet means no rule write yet: 0. A failed read throws; it is
 * never read as 0, because a token of 0 would match a stale admission.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import { parseRulesToken, type RulesToken } from "@/lib/foods/world/freshness";

export async function readRulesToken(client: SupabaseClient, userId: string): Promise<RulesToken> {
  const [rules, evidence] = await Promise.all([
    client.from("account_rules_clock").select("rules_rev").eq("user_id", userId).maybeSingle(),
    client.from("evidence_clock").select("evidence_rev").eq("id", 1).maybeSingle(),
  ]);
  const token = rules.error || evidence.error || !evidence.data ? null : parseRulesToken({
    rulesVersion: Number((rules.data as { rules_rev?: unknown } | null)?.rules_rev ?? 0),
    evidenceVersion: Number((evidence.data as { evidence_rev?: unknown }).evidence_rev),
  });
  if (!token) {
    throw new HttpError(503, "rules_version_unavailable", "Your food rules could not be checked right now.",
      { cause: rules.error ?? evidence.error });
  }
  return token;
}
