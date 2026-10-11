"use client";

import { getFoodDetail } from "@/lib/catalog-client";
import { accountFoodKcalPer100g, accountFoodPer100g } from "@/lib/catalog/account-food-nutrients";
import type { Food } from "@/lib/foods";
import { inferFoodRole } from "@/lib/foods/role";
import { setFoodMembership } from "@/lib/foods/prefs-client";
import { uuidV5 } from "@/lib/foods/uuid5";
import { accountHandle, assertCurrent } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { browserClient } from "@/lib/supabase/client";
import { putRow } from "@/lib/sync/idb";
import { enqueue } from "@/lib/sync/outbox";
import type { OpResult } from "@/lib/sync/types";

const CATALOG_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

export async function addCatalogFood(
  catalogFoodId: number,
  revisionId: number,
  targetStatus: "eats" | "avoid" = "eats",
): Promise<Food> {
  // Phase 9 §0.1: the account that tapped Add; every write below carries it as the owner, and
  // every answer is checked against it (audit plan r3 finding 3).
  const h = accountHandle();
  const userId = h.userId;
  const detail = await getFoodDetail(catalogFoodId, { revisionId });
  assertCurrent(h);
  if (detail.kind !== "ok") throw new Error("Food details are unavailable.");
  const client = browserClient();
  const id = await uuidV5(CATALOG_NAMESPACE, `catalog-food:${userId}:${catalogFoodId}`);
  // Only what the revision measured (W004, audit A154): an unmeasured nutrient stays absent, never
  // a stored 0, and calculated-only energy keeps its own `energy_kcal_calc` code.
  const per100g = accountFoodPer100g(detail.detail.per100g);
  const protein = per100g.protein ?? 0;
  const carbs = per100g.carbohydrate ?? 0;
  const fat = per100g.fat_total ?? 0;
  const kcalPer100g = accountFoodKcalPer100g(per100g);
  const now = new Date().toISOString();
  const row = { id, user_id: userId, kind: "custom", name: detail.detail.description,
    catalog_food_id: catalogFoodId, per_100g: per100g, allergen_tags: [], deleted_at: null };
  const written = await withAccount(h, () => client.from("user_foods")
    .upsert(row, { onConflict: "id" }).select("rev").single());
  if (written.error || typeof written.data?.rev !== "number") throw new Error("Could not add that food.");
  await putRow(h, "user_foods", id, { ...row, rev: written.data.rev, updated_at: now });
  await enqueue(h, { op_id: crypto.randomUUID(), entity: "user_foods", entity_id: id,
    kind: "update", base_rev: written.data.rev, payload: row, client_ts: now });
  const role = inferFoodRole(row.name, { protein, carbs, fat });
  const food: Food = { id, name: row.name, role, unit: "g",
    perUnit: { protein: protein / 100, carbs: carbs / 100, fat: fat / 100 },
    ...(kcalPer100g === null ? {} : { kcalPerUnit: kcalPer100g / 100 }),
    ...(Object.keys(per100g).length === 0 ? { nutritionUnknown: true } : {}),
    status: targetStatus, updatedAt: now, catalogFoodId };
  await setFoodMembership(food.name, targetStatus, { food, acknowledge: true, account: h });
  const ref = await withAccount(h, () => client.from("food_refs").select("id")
    .eq("kind", "user").eq("user_food_id", id).single());
  if (ref.error) throw new Error("Could not finish adding that food.");
  const pref = await withAccount(h, (owner) => client.from("user_food_prefs")
    .select("rev,status,note,no_cook").eq("user_id", owner).eq("food_ref_id", ref.data.id).single());
  if (pref.error) throw new Error("Could not finish adding that food.");
  const prefPayload = { status: targetStatus, role, no_cook: pref.data.no_cook ?? false,
    note: pref.data.note ?? null };
  const applied = await withAccount(h, (owner) => client.rpc("apply_sync_op", {
    p_user_id: owner, p_op: {
      op_id: crypto.randomUUID(), entity: "user_food_prefs", entity_id: ref.data.id,
      kind: "update", base_rev: pref.data.rev, payload: prefPayload, client_ts: now,
    } }));
  const result = applied.data as OpResult | null;
  if (applied.error || result?.status !== "applied") {
    throw new Error("Could not finish adding that food.");
  }
  await Promise.all([
    putRow(h, "user_foods", id, { ...row, food_ref_id: ref.data.id, rev: written.data.rev,
      updated_at: now }),
    putRow(h, "user_food_prefs", ref.data.id, { ...prefPayload, user_id: userId,
      food_ref_id: ref.data.id, rev: result.rev, updated_at: now }),
  ]);
  return food;
}
