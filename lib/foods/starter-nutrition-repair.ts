import type { SupabaseClient } from "@supabase/supabase-js";
import { type AccountHandle } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import {
  repairableLegacyStarterNutrition, type StarterUserFoodRow,
} from "@/lib/foods/starter-attestation";

type LegacyRow = StarterUserFoodRow & { rev: number };

/** Repair only the exact account-owned whey row written with {} by the old cup converter. */
export async function repairLegacyWheyNutrition(
  account: AccountHandle, row: LegacyRow, client: SupabaseClient,
): Promise<Record<string, number> | null> {
  if (!Number.isSafeInteger(row.rev) || row.rev < 1) return null;
  const expected = await repairableLegacyStarterNutrition(account.userId, row);
  if (!expected) return null;
  const { data, error } = await withAccount(account, (owner) => client.from("user_foods")
    .update({ per_100g: expected, rev: row.rev + 1 })
    .eq("user_id", owner).eq("id", row.id).eq("rev", row.rev)
    .eq("name", row.name).eq("kind", "custom")
    .is("brand", null).is("ingredients_text", null).is("catalog_food_id", null)
    .is("deleted_at", null).eq("allergen_tags", "{}")
    .eq("per_100g", "{}")
    .select("id,rev,per_100g").maybeSingle());
  if (error) throw error;
  return data?.id === row.id && data.rev === row.rev + 1 ? expected : null;
}
