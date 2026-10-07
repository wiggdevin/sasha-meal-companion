import "server-only";

/** UI-NEEDS SPROUT-CARE item 2: the shop catalog, inventory, equipped map and purchase/equip. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";
import type {
  CareEquipResult, CarePurchaseResult, CareShopItem, CareShopResponse, CareSlot,
} from "@/lib/care/contract";

type ItemRow = { id: string; slot: string; tier: string; price: number; asset_key: string; mascots: string[] };

export async function readCareShop(client: SupabaseClient, userId: string): Promise<CareShopResponse> {
  const [items, owned, equipped, points] = await Promise.all([
    client.from("care_items").select("id, slot, tier, price, asset_key, mascots").eq("active", true),
    client.from("care_inventory").select("item_id").eq("user_id", userId),
    client.from("care_equipped").select("equipped, rev").eq("user_id", userId).maybeSingle(),
    client.from("care_points_ledger").select("delta, status").eq("user_id", userId).eq("status", "settled"),
  ]);
  if (items.error) throw new HttpError(502, "care_shop_read_failed", "The shop could not be read.", { cause: items.error });
  if (owned.error) throw new HttpError(502, "care_shop_read_failed", "The shop could not be read.", { cause: owned.error });
  if (equipped.error) throw new HttpError(502, "care_shop_read_failed", "The shop could not be read.", { cause: equipped.error });
  if (points.error) throw new HttpError(502, "care_shop_read_failed", "The shop could not be read.", { cause: points.error });
  const list: CareShopItem[] = (items.data as ItemRow[] ?? []).map((r) => ({
    id: r.id, slot: r.slot as CareSlot, tier: r.tier as CareShopItem["tier"], price: r.price,
    assetKey: r.asset_key, mascots: r.mascots,
  }));
  const ownedIds = (owned.data as { item_id: string }[] ?? []).map((r) => r.item_id);
  const equippedRow = equipped.data as { equipped: Record<string, string>; rev: number } | null;
  const balance = (points.data as { delta: number }[] ?? []).reduce((sum, r) => sum + r.delta, 0);
  return { items: list, owned: ownedIds, equipped: equippedRow?.equipped ?? {}, rev: equippedRow?.rev ?? 0, balance };
}

type PurchaseRpcAnswer = {
  status?: string; short?: number;
  receipt?: { actionId?: string; itemId?: string; price?: number; balance?: number };
};

export async function purchaseCareItem(
  client: SupabaseClient, userId: string, itemId: string, actionId: string,
  localDate: string, zone: string,
): Promise<CarePurchaseResult> {
  const { data, error } = await client.rpc("care_purchase",
    { p_user_id: userId, p_item_id: itemId, p_action_id: actionId, p_local_date: localDate, p_zone: zone });
  if (error) {
    if (error.code === "22023") throw new HttpError(400, "bad_request", "That purchase could not be made.");
    throw new HttpError(502, "care_purchase_failed", "That purchase did not go through. Try again.", { cause: error });
  }
  const answer = data as PurchaseRpcAnswer | null;
  switch (answer?.status) {
    case "applied":
    case "existing": {
      const r = answer.receipt;
      if (!r || typeof r.actionId !== "string" || typeof r.itemId !== "string"
        || typeof r.price !== "number" || typeof r.balance !== "number") {
        throw new HttpError(502, "care_purchase_failed", "That purchase did not go through. Try again.", { cause: answer });
      }
      return { status: answer.status, receipt: { actionId: r.actionId, itemId: r.itemId, price: r.price, balance: r.balance } };
    }
    case "unknown_item": return { status: "unknown_item" };
    case "owned": return { status: "owned" };
    case "action_conflict": return { status: "action_conflict" };
    case "insufficient":
      return { status: "insufficient", short: typeof answer.short === "number" ? answer.short : 0 };
    default:
      throw new HttpError(502, "care_purchase_failed", "That purchase did not go through. Try again.", { cause: answer });
  }
}

type EquipRpcAnswer = { status?: string; equipped?: Record<string, string>; rev?: number };

export async function equipCareItem(
  client: SupabaseClient, userId: string, slot: CareSlot, itemId: string | null, rev: number | null,
): Promise<CareEquipResult> {
  const { data, error } = await client.rpc("care_equip",
    { p_user_id: userId, p_slot: slot, p_item_id: itemId, p_rev: rev });
  if (error) {
    if (error.code === "22023") throw new HttpError(400, "bad_request", "That could not be worn.");
    throw new HttpError(502, "care_equip_failed", "That did not save. Try again.", { cause: error });
  }
  const answer = data as EquipRpcAnswer | null;
  if (!answer || typeof answer.rev !== "number"
    || !["ok", "conflict", "not_owned", "wrong_slot"].includes(answer.status ?? "")) {
    throw new HttpError(502, "care_equip_failed", "That did not save. Try again.", { cause: answer });
  }
  return { status: answer.status as CareEquipResult["status"], equipped: answer.equipped ?? {}, rev: answer.rev };
}
