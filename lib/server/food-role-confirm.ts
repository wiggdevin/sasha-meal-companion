import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoredMealRole } from "@/lib/coach/role-advice";
import { HttpError } from "@/lib/server/auth";

type Confirmation = {
  foodRefId: string; proposedRole: StoredMealRole; currentRole: StoredMealRole | null;
};
type Pref = {
  status: string; role: string | null; rev: number;
};

async function ownedPref(client: SupabaseClient, userId: string, foodRefId: string): Promise<Pref> {
  const { data, error } = await client.from("user_food_prefs")
    .select("status,role,rev")
    .eq("user_id", userId).eq("food_ref_id", foodRefId).maybeSingle();
  if (error) throw new HttpError(500, "role_read_failed", "Could not read the food role.", { cause: error });
  if (!data) throw new HttpError(404, "not_found", "Food preference not found for this account.");
  return data as Pref;
}

/** One explicit tap, through the same compare-and-swap and change feed as food sync. */
export async function confirmFoodRole(
  client: SupabaseClient, userId: string, { foodRefId, proposedRole, currentRole }: Confirmation,
): Promise<{ status: "persisted" | "unchanged"; role: StoredMealRole }> {
  const current = await ownedPref(client, userId, foodRefId);
  if (current.status !== "eats" && current.status !== "avoid") {
    throw new HttpError(409, "membership_required", "Add this food to Eats or Avoids first.");
  }
  if (current.role === proposedRole) return { status: "unchanged", role: proposedRole };
  if (current.role !== currentRole) {
    throw new HttpError(409, "role_changed", "This food's role changed. Review it before confirming.");
  }
  const { data, error } = await client.rpc("apply_sync_op", {
    p_user_id: userId,
    p_op: {
      op_id: crypto.randomUUID(), entity: "user_food_prefs", entity_id: foodRefId,
      kind: "update", base_rev: current.rev,
      payload: { role: proposedRole },
      client_ts: new Date().toISOString(),
    },
  });
  if (error?.message?.includes("food_role_conflict")) {
    throw new HttpError(409, "role_changed", "The food changed. Review it before confirming.");
  }
  if (error) throw new HttpError(500, "role_write_failed", "Could not save the food role.", { cause: error });
  if (data?.status === "applied") return { status: "persisted", role: proposedRole };
  // A retry or another tab may have completed the same confirmation while this request ran.
  const latest = await ownedPref(client, userId, foodRefId);
  if ((latest.status === "eats" || latest.status === "avoid") && latest.role === proposedRole) {
    return { status: "unchanged", role: proposedRole };
  }
  throw new HttpError(409, "role_changed", "The food changed. Review it before confirming.");
}
