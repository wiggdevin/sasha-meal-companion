import { z } from "zod";
import { fetchWithDeadline } from "@/lib/fetch-with-deadline";
import { SHOP_ITEMS, itemById, type LedgerRow, type Slot } from "@/components/today/care/shop/catalog";
import type { EquipOutcome, PurchaseOutcome, ShopState } from "@/components/today/care/shop/shop-state";

/**
 * The phone's side of the care routes (app/api/care/*, contract lib/care/contract.ts, #5): Seeds,
 * the shop, equipment and the message inbox. Every answer is checked at this boundary; anything that
 * does not match is "failed", never a guess. Items the server sells but the phone has no art for are
 * left out, and items the phone draws but the server does not sell are not offered.
 */

const SLOTS = ["head", "eyes", "hands", "legs", "pin", "care"] as const;
const ledgerRow = z.object({
  id: z.string(), kind: z.enum(["day_recorded", "day_complete", "protein_goal", "water_goal", "five_day_week",
    "weigh_in_week", "purchase", "reversal"]),
  delta: z.number().int(), localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(["pending", "settled", "reversed"]), itemId: z.string().nullish(),
});
const pointsBody = z.object({ balance: z.number().int(), pending: z.number().int(), recent: z.array(ledgerRow) });
const shopBody = z.object({
  items: z.array(z.object({ id: z.string(), slot: z.string(), price: z.number().int().min(0) })),
  owned: z.array(z.string()), equipped: z.record(z.string(), z.string()), rev: z.number().int().min(0),
  balance: z.number().int(),
});
const receipt = z.object({ actionId: z.string(), itemId: z.string(), price: z.number().int(), balance: z.number().int() });
const purchaseBody = z.union([
  z.object({ status: z.enum(["applied", "existing"]), receipt }),
  z.object({ status: z.enum(["unknown_item", "owned", "action_conflict"]) }),
  z.object({ status: z.literal("insufficient"), short: z.number().int() }),
]);
const equipBody = z.object({
  status: z.enum(["ok", "conflict", "not_owned", "wrong_slot"]),
  equipped: z.record(z.string(), z.string()), rev: z.number().int().min(0),
});
const messagesBody = z.object({ messages: z.array(z.object({
  id: z.string(), type: z.string(), payload: z.unknown(), createdAt: z.string(),
})) });

export type CareShopSnapshot = { state: ShopState; prices: Record<string, number> };
export type CareMessageRow = z.infer<typeof messagesBody>["messages"][number];

async function getJson<T>(url: string, schema: z.ZodType<T>): Promise<T | "failed"> {
  try {
    const res = await fetchWithDeadline("prefs", url, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return "failed";
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : "failed";
  } catch { return "failed"; }
}

async function postJson<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T | "failed"> {
  try {
    const res = await fetchWithDeadline("commit", url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body) });
    if (!res.ok) return "failed";
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : "failed";
  } catch { return "failed"; }
}

/** Equipped slots the phone knows, holding items it owns art for. */
function knownEquipped(equipped: Record<string, string>): Partial<Record<Slot, string>> {
  const out: Partial<Record<Slot, string>> = {};
  for (const [slot, id] of Object.entries(equipped)) {
    if ((SLOTS as readonly string[]).includes(slot) && itemById(id)?.slot === slot) out[slot as Slot] = id;
  }
  return out;
}

/** The shop and recent Seeds as the phone draws them, or "failed". */
export async function readCareShop(): Promise<CareShopSnapshot | "failed"> {
  const [shop, points] = await Promise.all([getJson("/api/care/shop", shopBody), getJson("/api/care/points", pointsBody)]);
  if (shop === "failed" || points === "failed") return "failed";
  const prices = Object.fromEntries(shop.items.filter((item) => itemById(item.id)?.slot === item.slot)
    .map((item) => [item.id, item.price]));
  const ledger: LedgerRow[] = points.recent.map((row) => ({ id: row.id, kind: row.kind, delta: row.delta,
    localDate: row.localDate, status: row.status, itemId: row.itemId ?? undefined }));
  return {
    prices,
    state: { balance: shop.balance, owned: shop.owned.filter((id) => itemById(id)), equipped: knownEquipped(shop.equipped),
      rev: shop.rev, receipts: {}, ledger },
  };
}

/** Buys one item; the same action id on a retry answers the first receipt (the server is idempotent). */
export async function purchaseCareItem(state: ShopState, itemId: string, actionId: string): Promise<PurchaseOutcome | "failed"> {
  const answer = await postJson("/api/care/purchase", { itemId, actionId }, purchaseBody);
  if (answer === "failed") return "failed";
  if (answer.status === "insufficient") return { ok: false, code: "insufficient", short: answer.short };
  if (answer.status !== "applied" && answer.status !== "existing") return { ok: false, code: answer.status };
  const r = answer.receipt;
  return { ok: true, replay: answer.status === "existing", receipt: r,
    state: { ...state, balance: r.balance, owned: state.owned.includes(r.itemId) ? state.owned : [...state.owned, r.itemId],
      receipts: { ...state.receipts, [r.actionId]: r } } };
}

/** Wears an owned item in its slot, or clears the slot, against the revision the phone last saw. */
export async function equipCareItem(state: ShopState, slot: Slot, itemId: string | null): Promise<EquipOutcome | "failed" | "conflict"> {
  const answer = await postJson("/api/care/equip", { slot, itemId, rev: state.rev }, equipBody);
  if (answer === "failed") return "failed";
  if (answer.status === "conflict") return "conflict";
  if (answer.status !== "ok") return { ok: false, code: answer.status };
  return { ok: true, state: { ...state, equipped: knownEquipped(answer.equipped), rev: answer.rev } };
}

/** The unread, undismissed inbox, newest first, or "failed". */
export async function readCareMessages(): Promise<CareMessageRow[] | "failed"> {
  const answer = await getJson("/api/care/messages?unread=1", messagesBody);
  return answer === "failed" ? answer : answer.messages;
}

/** Marks a message read or dismissed; best effort (a failure leaves it for next time). */
export async function markCareMessage(id: string, action: "read" | "dismiss"): Promise<void> {
  await postJson(`/api/care/messages/${encodeURIComponent(id)}/${action}`, {}, z.unknown());
}

/** Tells the server these awards were watched; best effort. */
export async function markAccoladesSeen(keys: string[]): Promise<void> {
  if (keys.length) await postJson("/api/care/accolades/seen", { keys }, z.unknown());
}

/** Items the phone can offer: drawn here and sold there, at the server's price. */
export const offeredItems = (prices: Record<string, number>) =>
  SHOP_ITEMS.filter((item) => prices[item.id] !== undefined).map((item) => ({ ...item, price: prices[item.id] }));
