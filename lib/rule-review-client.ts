import {
  accountHandle, accountFetch, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import type { RuleChoices } from "@/lib/rule-review";
import { noteFoodRulesChanged, noteRulesRevision } from "@/lib/foods/rules-epoch";

type Options = { account?: AccountHandle; fetchImpl?: typeof fetch };
export type RuleReview = {
  required: boolean; candidateAllergens: string[]; candidateCategories: string[]; rev: number;
};

/** Null means the account's review state could not be verified; suggestions stay gated. */
export async function loadRuleReview(opts: Options = {}): Promise<RuleReview | null> {
  const h = opts.account ?? accountHandle();
  try {
    const res = await accountFetch(h, "/api/constraints/review", {}, { fetchImpl: opts.fetchImpl });
    if (!res.ok) return null;
    const body = await accountJson<RuleReview>(h, res);
    const valid = typeof body.required === "boolean" && Number.isInteger(body.rev)
      && Array.isArray(body.candidateAllergens) && Array.isArray(body.candidateCategories);
    // A revision first seen here is a rules change like any other constraint read (F3).
    if (valid) noteRulesRevision(body.rev, h.userId);
    return valid ? body : null;
  } catch (error) {
    rethrowAccountChanged(error);
    return null;
  }
}

export async function submitRuleReview(
  choices: RuleChoices, baseRev: number, opts: Options = {},
): Promise<{ status: "ok"; review: RuleReview } | { status: "conflict" | "error" }> {
  const h = opts.account ?? accountHandle();
  try {
    const res = await accountFetch(h, "/api/constraints/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ choices, baseRev }),
    }, { fetchImpl: opts.fetchImpl });
    // A conflict means the rules moved under this phone: revoke exactly as a success does (F3).
    if (res.status === 409) { noteFoodRulesChanged(undefined, h.userId); return { status: "conflict" }; }
    if (!res.ok) return { status: "error" };
    const body = await accountJson<{ status?: string; review?: RuleReview }>(h, res);
    if (body.status !== "ok" || !body.review || body.review.required !== false) return { status: "error" };
    noteFoodRulesChanged(Number.isInteger(body.review.rev) ? body.review.rev : undefined, h.userId);
    return { status: "ok", review: body.review };
  } catch (error) {
    rethrowAccountChanged(error);
    return { status: "error" };
  }
}
