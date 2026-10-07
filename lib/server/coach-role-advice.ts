import "server-only";

import { refusePlanBlocked } from "@/lib/coach/plan-policy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoachAction, GroundedRoleAdvice } from "@/lib/coach/actions";
import {
  adviseMealComponentRole,
  MEAL_COMPONENT_ROLES,
  type RolePort,
  type StoredMealRole,
} from "@/lib/coach/role-advice";
import { systemOne } from "@/lib/ai/typesafe";
import { markLoggedActions } from "@/lib/coach/log-policy";
import { filterRecipeActions } from "@/lib/coach/recipe-policy";
import type { ConstraintProfile } from "@/lib/policy/constraints";

export type RoleAdvicePorts = {
  storedRoles: (foodRefIds: string[]) => Promise<Map<string, StoredMealRole | null>>;
  systemOne: RolePort;
};

type AddListAction = CoachAction & {
  kind: "add_to_eats" | "add_to_avoid";
  foodRefId: string;
  name: string;
  proteinPer100g: number | null;
  carbsPer100g: number | null;
  fatPer100g: number | null;
};

function isAddListAction(action: CoachAction): action is AddListAction {
  return action.kind === "add_to_eats" || action.kind === "add_to_avoid";
}

function confirmationFallback(action: AddListAction): GroundedRoleAdvice {
  return {
    foodRefId: action.foodRefId,
    // mixed_dish is deliberately non-storable in confirmMealComponentRole. Confidence zero makes
    // this a schema-safe confirmation sentinel, not a guessed meal-component role.
    suggestedRole: "mixed_dish",
    proposedRole: null,
    currentRole: null,
    reason: `No role was saved. ${MEAL_COMPONENT_ROLES.mixed_dish}`,
    confidence: 0,
    requiresConfirmation: true,
  };
}

export async function adviseGroundedListActions(
  userId: string,
  actions: readonly CoachAction[],
  ports: RoleAdvicePorts,
): Promise<CoachAction[]> {
  const candidates = actions.filter(isAddListAction);
  if (candidates.length === 0) return [...actions];
  try {
    const roles = await ports.storedRoles(candidates.map((action) => action.foodRefId));
    const output: CoachAction[] = [];
    for (const action of actions) {
      if (!isAddListAction(action)) {
        output.push(action);
        continue;
      }
      const storedRole = roles.get(action.foodRefId) ?? null;
      const advice = await adviseMealComponentRole({
        foodRefId: action.foodRefId,
        name: action.name,
        description: null,
        prepState: null,
        proteinPer100g: action.proteinPer100g,
        carbsPer100g: action.carbsPer100g,
        fatPer100g: action.fatPer100g,
        storedRole,
      }, { userId, systemOne: ports.systemOne });
      if (advice) {
        output.push({ ...action, roleAdvice: advice });
      } else if (storedRole === null) {
        console.warn("[coach-role-advice] advice unavailable; requiring confirmation");
        output.push({ ...action, roleAdvice: confirmationFallback(action) });
      } else {
        output.push(action);
      }
    }
    return output;
  } catch (error) {
    console.warn("[coach-role-advice] advice failed; requiring confirmation", {
      error: { name: error instanceof Error ? error.name : "UnknownError" },
    });
    return actions.map((action) => isAddListAction(action)
      ? { ...action, roleAdvice: confirmationFallback(action) }
      : action);
  }
}

export function roleAdvicePorts(admin: SupabaseClient, userId: string): RoleAdvicePorts {
  return {
    storedRoles: async (foodRefIds) => {
      const rows = await admin.from("user_food_prefs").select("food_ref_id,role")
        .eq("user_id", userId).in("food_ref_id", foodRefIds);
      if (rows.error) throw rows.error;
      return new Map((rows.data ?? []).map((row) => [
        String(row.food_ref_id),
        row.role === "protein" || row.role === "carb" || row.role === "fat" ? row.role : null,
      ]));
    },
    systemOne,
  };
}

export async function applyGroundedActionPolicies(
  admin: SupabaseClient,
  userId: string,
  actions: readonly CoachAction[],
  profile: ConstraintProfile,
): Promise<{ actions: CoachAction[]; logNotices: string[]; recipeRefusals: string[] }> {
  const marked = await markLoggedActions(userId, actions, profile);
  const advised = await adviseGroundedListActions(
    userId, marked.actions, roleAdvicePorts(admin, userId),
  );
  const recipes = await filterRecipeActions(userId, advised, profile);
  // A plan write with a blocked item is refused whole (lib/coach/plan-policy.ts); its reason rides
  // with the recipe refusals, which both action paths already show as clarifications.
  const plans = refusePlanBlocked(recipes.actions);
  return { actions: plans.actions, logNotices: marked.notices,
    recipeRefusals: [...recipes.refusals, ...plans.refusals] };
}
