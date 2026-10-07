/**
 * Phase 13 §6 row 5: the production I/O behind the reply check (lib/server/reply-check.ts). Each
 * port loads its module on first use, so a turn for an account with no hard rule pays one
 * profile read and nothing else.
 *
 * - `profileRules`: the account's confirmed profile instances (stored rows and legacy-flag
 *   synthesis) reduced to the rules `isActiveHardRule` accepts now. The turn read them once
 *   (lib/server/policy-profile.ts's `instances`); this port never reads them again.
 * - `foodEvidence`: each named food's deterministic evidence, from the same read suggestions use
 *   (lib/coach/suggest-policy.ts). Phase 18 W2c: no Jev facet and no Jev tag reach the rule check.
 */
import type { DietEvidence } from "@/lib/policy/diet-evidence";
import { activeHardRulesFor } from "@/lib/policy/profiles/account-rules";
import type { ProfileInstance } from "@/lib/policy/profiles/types";
import type { ReplyCheckPorts } from "@/lib/server/reply-check";

export function replyCheckPorts(
  searchFoods: ReplyCheckPorts["searchFoods"],
  instances: readonly ProfileInstance[],
): ReplyCheckPorts {
  return {
    searchFoods,
    profileRules: async () => {
      const rules = activeHardRulesFor(instances, new Date());
      return rules.items.length > 0 ? rules : null;
    },
    foodEvidence: async (userId, foods) => {
      const { loadSuggestionEvidence, suggestionFoodIdentity } =
        await import("@/lib/coach/suggest-policy");
      const evidence = await loadSuggestionEvidence(userId, foods, { needsNoCook: false });
      if (evidence.status !== "ready") throw new Error("food evidence unavailable");
      const out = new Map<string, DietEvidence>();
      for (const food of foods) {
        const found = evidence.byIdentity[suggestionFoodIdentity(food)];
        if (!found) continue;
        out.set(food.foodRefId, {
          foodName: found.foodName, foodBrand: found.foodBrand, packaged: found.packaged,
          ingredientsText: found.ingredientsText, ingredientsTextIsLabel: found.ingredientsTextIsLabel,
          allergenTags: found.allergenTags, allergenEvidence: found.allergenEvidence,
          checkedAllergens: found.checkedAllergens, category: found.policyCategories,
          attestedFacets: found.attestedFacets,
        });
      }
      return out;
    },
  };
}
