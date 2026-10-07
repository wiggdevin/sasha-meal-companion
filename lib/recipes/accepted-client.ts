"use client";

import { accountFetch, accountHandle, accountJson } from "@/lib/device/account";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import { foodRulesEpoch } from "@/lib/foods/rules-epoch";
import { foodRulesKey } from "@/lib/foods/rule-marks";

/** Load the server selection overlay before resolving a visible day or week. */
export async function loadAcceptedRecipeSelections(start: string,
  end: string): Promise<AcceptedRecipeSelection[]> {
  const h = accountHandle();
  // Stamped before the request: a rule change while it is in flight leaves its marks stale (F2).
  const ruleMarkEpoch = foodRulesEpoch();
  const params = new URLSearchParams({ start, end });
  const response = await accountFetch(h, `/api/recipes/plan?${params}`,
    { cache: "no-store" }, { budget: "prefs" });
  if (!response.ok) throw new Error(`Accepted recipes could not load (${response.status}).`);
  const body = await accountJson<{ selections: AcceptedRecipeSelection[]; ruleFlags?: unknown }>(h, response);
  // The verdicts hold only under the diet flags the server judged them with (round 3 BLOCK).
  const flags = Array.isArray(body.ruleFlags)
    ? body.ruleFlags.filter((flag): flag is string => typeof flag === "string") : null;
  const ruleMarkRulesKey = flags ? foodRulesKey({ dietPrefs: { flags } }) : undefined;
  // Both stamps are the phone's own: whatever the wire carries under those names is dropped.
  return body.selections.map(({ ruleMarkRulesKey: _wire, ...selection }) => {
    void _wire;
    return { ...selection, ruleMarkEpoch,
      ...(ruleMarkRulesKey !== undefined ? { ruleMarkRulesKey } : {}) };
  });
}
